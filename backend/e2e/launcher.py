"""Test-owned E2E application factory and process entrypoint (Phase C9).

Production ``main:app`` / ``python -m serve`` never import this module.
Fakes and ``/__e2e__/*`` control routes exist only on apps created here.

Run (from backend/ with frontend already built):

    python -m e2e.launcher --port 18901 --state-dir %TEMP%\\xbloom-e2e-1

Environment (set by Playwright harness; not production knobs for fakes):

- ``XBLOOM_E2E_STATE_DIR`` - isolated state root
- ``XBLOOM_E2E_PORT`` - bind port
- ``XBLOOM_E2E_TOKEN`` - required header for control routes
- ``XBLOOM_E2E_PUBLIC_ORIGIN`` - simulated HTTPS public origin
- ``XBLOOM_E2E_FRONTEND_DIR`` - optional SPA dist override
- Knowledge/assets via normal ``XBLOOM_KNOWLEDGE_DEV_ROOT`` / ``XBLOOM_ASSETS_DIR``
"""

from __future__ import annotations

import argparse
import logging
import os
import secrets
import sys
import tempfile
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import APIRouter, FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from design.config import DesignConfig
from design.routes import set_design_service
from design.service import DesignService
from e2e.fake_bridge import FakeBridge, install_fake_bridge
from e2e.fake_provider import FakeOpenAICompatibleProvider
from web_security import AuthStore, WebSecurityConfig
from web_security.config import parse_trusted_proxies

logger = logging.getLogger(__name__)

E2E_PUBLIC_HOST_DEFAULT = "studio.e2e.local"
E2E_TOKEN_HEADER = "x-xbloom-e2e-token"
# Outside /api so production LAN session gate does not apply; token is the only key.
# Production main:app never mounts these routes.
E2E_CONTROL_PREFIX = "/__e2e__"


@dataclass
class E2ERuntime:
    """Holds process-local fakes and config for one E2E server process."""

    bridge: FakeBridge
    provider: FakeOpenAICompatibleProvider
    token: str
    public_origin: str
    public_host: str
    state_dir: Path
    auth_store: AuthStore
    web_config: WebSecurityConfig
    port: int


_RUNTIME: E2ERuntime | None = None


def get_runtime() -> E2ERuntime:
    if _RUNTIME is None:
        raise RuntimeError("E2E runtime is not initialized")
    return _RUNTIME


class PhaseBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    phase: str = Field(min_length=1, max_length=64)
    telemetry: dict[str, Any] | None = None
    machine_state: str | None = None


class TelemetryBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    telemetry: dict[str, Any]


class CompleteBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    result: str = "completed"
    release: bool = True
    release_error: str | None = None
    disconnect_reason: str = "workflow_terminal"


class PriorDisconnectBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    error: str = Field(min_length=1, max_length=400)
    disconnect_time: float | None = None


class ActiveWorkflowBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    recipe_revision_id: str = Field(min_length=1)
    kind: str = "coffee"


def _require_e2e_token(
    x_xbloom_e2e_token: str | None = Header(default=None, alias=E2E_TOKEN_HEADER),
) -> None:
    runtime = get_runtime()
    if not x_xbloom_e2e_token or not secrets.compare_digest(
        x_xbloom_e2e_token, runtime.token
    ):
        raise HTTPException(status_code=404, detail="not found")


def _build_control_router() -> APIRouter:
    """Control/ledger routes - only mounted by the E2E launcher."""

    router = APIRouter(
        prefix=E2E_CONTROL_PREFIX,
        tags=["e2e-control"],
    )

    @router.get("/health")
    def e2e_health(
        x_xbloom_e2e_token: str | None = Header(default=None, alias=E2E_TOKEN_HEADER),
    ):
        _require_e2e_token(x_xbloom_e2e_token)
        rt = get_runtime()
        return {
            "ok": True,
            "public_origin": rt.public_origin,
            "instance_id": rt.bridge.instance_id,
            "state_dir": str(rt.state_dir),
        }

    @router.get("/ledger")
    def e2e_ledger(
        x_xbloom_e2e_token: str | None = Header(default=None, alias=E2E_TOKEN_HEADER),
    ):
        _require_e2e_token(x_xbloom_e2e_token)
        bridge = get_runtime().bridge
        provider = get_runtime().provider
        return {
            "ledger": bridge.ledger_snapshot(),
            "counts": bridge.ledger_counts(),
            "provider_calls": provider.call_snapshot(),
        }

    @router.post("/ledger/reset")
    def e2e_ledger_reset(
        x_xbloom_e2e_token: str | None = Header(default=None, alias=E2E_TOKEN_HEADER),
    ):
        _require_e2e_token(x_xbloom_e2e_token)
        get_runtime().bridge.reset_ledger()
        return {"ok": True}

    @router.post("/bridge/reset")
    def e2e_bridge_reset(
        x_xbloom_e2e_token: str | None = Header(default=None, alias=E2E_TOKEN_HEADER),
    ):
        """Full fake-bridge state reset (workflows, connection, ledger)."""

        _require_e2e_token(x_xbloom_e2e_token)
        get_runtime().bridge.control_reset()
        return {"ok": True, "instance_id": get_runtime().bridge.instance_id}

    @router.post("/bridge/phase")
    def e2e_bridge_phase(
        payload: PhaseBody,
        x_xbloom_e2e_token: str | None = Header(default=None, alias=E2E_TOKEN_HEADER),
    ):
        _require_e2e_token(x_xbloom_e2e_token)
        return get_runtime().bridge.control_set_phase(
            phase=payload.phase,
            telemetry=payload.telemetry,
            machine_state=payload.machine_state,
        )

    @router.post("/bridge/telemetry")
    def e2e_bridge_telemetry(
        payload: TelemetryBody,
        x_xbloom_e2e_token: str | None = Header(default=None, alias=E2E_TOKEN_HEADER),
    ):
        _require_e2e_token(x_xbloom_e2e_token)
        return get_runtime().bridge.control_emit_telemetry(payload.telemetry)

    @router.post("/bridge/complete")
    def e2e_bridge_complete(
        payload: CompleteBody,
        x_xbloom_e2e_token: str | None = Header(default=None, alias=E2E_TOKEN_HEADER),
    ):
        _require_e2e_token(x_xbloom_e2e_token)
        return get_runtime().bridge.control_complete(
            result=payload.result,
            release=payload.release,
            release_error=payload.release_error,
            disconnect_reason=payload.disconnect_reason,
        )

    @router.post("/bridge/prior-disconnect-error")
    def e2e_prior_disconnect(
        payload: PriorDisconnectBody,
        x_xbloom_e2e_token: str | None = Header(default=None, alias=E2E_TOKEN_HEADER),
    ):
        _require_e2e_token(x_xbloom_e2e_token)
        get_runtime().bridge.control_inject_prior_disconnect_error(
            error=payload.error,
            disconnect_time=payload.disconnect_time,
        )
        return {"ok": True, "status": get_runtime().bridge.status()}

    @router.post("/bridge/set-active-workflow")
    def e2e_set_active(
        payload: ActiveWorkflowBody,
        x_xbloom_e2e_token: str | None = Header(default=None, alias=E2E_TOKEN_HEADER),
    ):
        _require_e2e_token(x_xbloom_e2e_token)
        return get_runtime().bridge.control_set_active_workflow(
            recipe_revision_id=payload.recipe_revision_id,
            kind=payload.kind,
        )

    @router.get("/bridge/status")
    def e2e_bridge_status(
        x_xbloom_e2e_token: str | None = Header(default=None, alias=E2E_TOKEN_HEADER),
    ):
        _require_e2e_token(x_xbloom_e2e_token)
        return get_runtime().bridge.status()

    return router


class _ProxySemanticsASGI:
    """Simulate a trusted HTTPS reverse proxy in front of the FastAPI app.

    Browser traffic uses Host=public_host (mapped to 127.0.0.1 via Chromium
    host-resolver-rules). Direct bootstrap uses Host=127.0.0.1 / localhost
    without X-Forwarded-* so local pairing creation stays loopback-only.
    """

    def __init__(self, app: Any, *, public_host: str, client_ip: str = "192.168.1.50") -> None:
        self.app = app
        self.public_host = public_host.lower()
        self.client_ip = client_ip

    async def __call__(self, scope, receive, send):
        if scope.get("type") == "http":
            headers = [
                (k, v) for (k, v) in scope.get("headers", []) if isinstance(k, (bytes, bytearray))
            ]
            host = _header_value(headers, b"host") or ""
            host_no_port = host.split(":", 1)[0].lower()
            if host_no_port == self.public_host:
                # Trusted reverse-proxy hop: peer remains loopback (server bind),
                # but production middleware trusts 127.0.0.1 as proxy and reads
                # X-Forwarded-*.
                headers = _set_header(headers, b"x-forwarded-proto", b"https")
                headers = _set_header(headers, b"x-forwarded-host", host.encode("ascii"))
                headers = _set_header(
                    headers, b"x-forwarded-for", self.client_ip.encode("ascii")
                )
                # Force Origin to public origin when the browser is on public host.
                origin = _header_value(headers, b"origin")
                if origin is None:
                    # Same-origin navigations may omit Origin; mutations send it.
                    pass
                scope = dict(scope)
                scope["headers"] = headers
                # scheme https so Secure cookies are accepted by Starlette test
                # utilities if used; Playwright uses real HTTPS baseURL.
                scope["scheme"] = "https"
        await self.app(scope, receive, send)


def _header_value(headers: list[tuple[bytes, bytes]], name: bytes) -> str | None:
    name_l = name.lower()
    for k, v in headers:
        if k.lower() == name_l:
            try:
                return v.decode("latin-1").strip()
            except Exception:
                return None
    return None


def _set_header(
    headers: list[tuple[bytes, bytes]], name: bytes, value: bytes
) -> list[tuple[bytes, bytes]]:
    name_l = name.lower()
    out = [(k, v) for (k, v) in headers if k.lower() != name_l]
    out.append((name, value))
    return out


def _resolve_knowledge_dev_root() -> Path:
    env = os.environ.get("XBLOOM_KNOWLEDGE_DEV_ROOT", "").strip()
    if env:
        return Path(env).expanduser().resolve()
    # Sibling brew checkout (local development layout).
    sibling = (
        Path(__file__).resolve().parents[2].parent
        / "xbloom-studio-brew"
        / "skills"
        / "xbloom-studio-brew"
    )
    if sibling.is_dir():
        return sibling
    raise RuntimeError(
        "XBLOOM_KNOWLEDGE_DEV_ROOT is required for E2E when sibling brew skill is absent"
    )


def _resolve_assets_dir(knowledge_root: Path) -> Path:
    env = os.environ.get("XBLOOM_ASSETS_DIR", "").strip()
    if env:
        return Path(env).expanduser().resolve()
    assets = knowledge_root / "assets"
    if assets.is_dir():
        return assets
    raise RuntimeError("XBLOOM_ASSETS_DIR not set and knowledge assets/ missing")


def _prefer_e2e_routes_before_spa(app: FastAPI) -> None:
    """Move ``/__e2e__`` routes ahead of the SPA catch-all."""

    routes = list(app.router.routes)
    e2e: list[Any] = []
    spa: list[Any] = []
    other: list[Any] = []
    for route in routes:
        path = getattr(route, "path", "") or ""
        if path.startswith(E2E_CONTROL_PREFIX):
            e2e.append(route)
        elif path == "/{path:path}":
            spa.append(route)
        else:
            other.append(route)
    app.router.routes = other + e2e + spa


def create_e2e_app(
    *,
    state_dir: Path,
    port: int,
    token: str,
    public_host: str = E2E_PUBLIC_HOST_DEFAULT,
    frontend_dir: Path | None = None,
) -> tuple[Any, E2ERuntime]:
    """Build a production-shaped FastAPI app with fakes injected."""

    global _RUNTIME

    state_dir = Path(state_dir).resolve()
    state_dir.mkdir(parents=True, exist_ok=True)
    os.environ["XBLOOM_STATE_DIR"] = str(state_dir)

    knowledge_root = _resolve_knowledge_dev_root()
    assets_dir = _resolve_assets_dir(knowledge_root)
    os.environ["XBLOOM_ASSETS_DIR"] = str(assets_dir)
    # Design knowledge: use explicit dev root (validated by design service).
    os.environ["XBLOOM_KNOWLEDGE_DEV_ROOT"] = str(knowledge_root)
    os.environ.pop("XBLOOM_KNOWLEDGE_DIR", None)

    # Design env for public config surface; provider is injected, not remote.
    os.environ["XBLOOM_LLM_PROVIDER"] = "openai-compatible"
    os.environ["XBLOOM_LLM_BASE_URL"] = "http://127.0.0.1:9/v1"  # never dialed
    os.environ["XBLOOM_LLM_MODEL"] = "grok-4.5"
    os.environ["XBLOOM_LLM_API_KEY"] = "e2e-not-a-real-key"
    os.environ["XBLOOM_DESIGN_MODE"] = "vision"

    public_origin = f"https://{public_host}:{port}"
    os.environ["XBLOOM_WEB_MODE"] = "lan"
    os.environ["XBLOOM_PUBLIC_ORIGIN"] = public_origin
    os.environ["XBLOOM_TRUSTED_PROXIES"] = "127.0.0.1/32,::1/128"
    os.environ["XBLOOM_BIND_HOST"] = "127.0.0.1"
    os.environ["XBLOOM_BIND_PORT"] = str(port)

    if frontend_dir is not None:
        os.environ["XBLOOM_FRONTEND_DIR"] = str(Path(frontend_dir).resolve())
    else:
        default_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
        os.environ["XBLOOM_FRONTEND_DIR"] = str(default_dist)

    web_config = WebSecurityConfig(
        mode="lan",
        public_origin=public_origin,
        trusted_proxies=parse_trusted_proxies("127.0.0.1/32,::1/128"),
        session_ttl_s=3600,
        pairing_ttl_s=600,
        pairing_rate_limit_max=50,
        pairing_rate_limit_window_s=600,
        bind_host="127.0.0.1",
        bind_port=port,
    )
    auth_store = AuthStore(db_path=state_dir / "web" / "web_auth.sqlite3")

    bridge = FakeBridge()
    provider = FakeOpenAICompatibleProvider(model="grok-4.5", expected_model="grok-4.5")

    design_config = DesignConfig(
        provider="openai-compatible",
        base_url="http://127.0.0.1:9/v1",
        model="grok-4.5",
        api_key="e2e-not-a-real-key",
        design_mode="vision",
        knowledge_dir=None,
        knowledge_dev_root=str(knowledge_root),
    )
    design_service = DesignService(design_config, provider=provider)
    design_service.initialize()
    set_design_service(design_service)

    # Import main after env is set so SPA path and config resolve correctly.
    import bridge_client as bridge_client_mod
    import main as main_mod

    install_fake_bridge(bridge, bridge_client_mod)

    @asynccontextmanager
    async def e2e_lifespan(_app: FastAPI) -> AsyncIterator[None]:
        # No ensure_bridge_daemon, no real design network, no BLE.
        set_design_service(design_service)
        try:
            yield
        finally:
            await design_service.aclose()
            set_design_service(None)

    app = main_mod.create_app(
        web_config=web_config,
        auth_store=auth_store,
        lifespan_handler=e2e_lifespan,
    )
    app.include_router(_build_control_router())
    # SPA catch-all ``/{path:path}`` is registered in create_app; keep fixed
    # ``/__e2e__`` routes ahead of it so control GETs are not served as index.html.
    _prefer_e2e_routes_before_spa(app)

    # Defense in depth: production main:app must not grow these routes by accident
    # in ordinary imports - they are only attached on this factory's instance.
    runtime = E2ERuntime(
        bridge=bridge,
        provider=provider,
        token=token,
        public_origin=public_origin,
        public_host=public_host,
        state_dir=state_dir,
        auth_store=auth_store,
        web_config=web_config,
        port=port,
    )
    _RUNTIME = runtime
    app.state.e2e_runtime = runtime

    wrapped = _ProxySemanticsASGI(app, public_host=public_host)
    return wrapped, runtime


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="xBloom Studio Web E2E launcher")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("XBLOOM_E2E_PORT", "18901")))
    parser.add_argument(
        "--state-dir",
        default=os.environ.get("XBLOOM_E2E_STATE_DIR")
        or str(Path(tempfile.gettempdir()) / "xbloom-e2e-state"),
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("XBLOOM_E2E_TOKEN") or secrets.token_urlsafe(24),
    )
    parser.add_argument(
        "--public-host",
        default=os.environ.get("XBLOOM_E2E_PUBLIC_HOST", E2E_PUBLIC_HOST_DEFAULT),
    )
    parser.add_argument(
        "--frontend-dir",
        default=os.environ.get("XBLOOM_E2E_FRONTEND_DIR"),
    )
    parser.add_argument(
        "--print-config",
        action="store_true",
        help="Print JSON config line for the Playwright harness and exit",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    frontend = Path(args.frontend_dir) if args.frontend_dir else None
    asgi_app, runtime = create_e2e_app(
        state_dir=Path(args.state_dir),
        port=args.port,
        token=args.token,
        public_host=args.public_host,
        frontend_dir=frontend,
    )

    # Write config for harness discovery.
    config_path = Path(args.state_dir) / "e2e-server.json"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    import json

    config_payload = {
        "port": runtime.port,
        "token": runtime.token,
        "public_origin": runtime.public_origin,
        "public_host": runtime.public_host,
        "state_dir": str(runtime.state_dir),
        "bootstrap_origin": f"https://127.0.0.1:{runtime.port}",
        "control_prefix": E2E_CONTROL_PREFIX,
        "instance_id": runtime.bridge.instance_id,
    }
    config_path.write_text(json.dumps(config_payload, indent=2), encoding="utf-8")
    # Always emit one line for Playwright webServer stdout readiness.
    print(f"E2E_SERVER_READY {json.dumps(config_payload)}", flush=True)

    if args.print_config:
        print(json.dumps(config_payload), flush=True)
        return 0

    import uvicorn

    # Real TLS is required: Chromium only stores Secure session cookies on HTTPS.
    # Proxy middleware sets scheme=https for Host=public_host, but the browser
    # still needs a TLS listener. Use a short-lived self-signed cert covering
    # the public host, 127.0.0.1, and localhost.
    cert_file, key_file = _ensure_self_signed_cert(
        Path(args.state_dir) / "certs",
        hosts=[runtime.public_host, "127.0.0.1", "localhost"],
    )

    logger.info(
        "E2E server mode=lan public_origin=%s bind=%s:%s state=%s",
        runtime.public_origin,
        args.host,
        args.port,
        runtime.state_dir,
    )
    uvicorn.run(
        asgi_app,
        host=args.host,
        port=args.port,
        ssl_certfile=str(cert_file),
        ssl_keyfile=str(key_file),
        log_level="info",
    )
    return 0


def _ensure_self_signed_cert(cert_dir: Path, *, hosts: list[str]) -> tuple[Path, Path]:
    """Create a local self-signed cert if missing (stdlib only)."""

    cert_dir.mkdir(parents=True, exist_ok=True)
    cert_file = cert_dir / "e2e.pem"
    key_file = cert_dir / "e2e-key.pem"
    if cert_file.is_file() and key_file.is_file():
        return cert_file, key_file

    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
        import datetime
        import ipaddress
    except ImportError:
        # Fallback: openssl CLI if cryptography is absent.
        return _openssl_self_signed(cert_dir, hosts=hosts)

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name(
        [x509.NameAttribute(NameOID.COMMON_NAME, hosts[0])]
    )
    alt_names: list[x509.GeneralName] = []
    for h in hosts:
        try:
            alt_names.append(x509.IPAddress(ipaddress.ip_address(h)))
        except ValueError:
            alt_names.append(x509.DNSName(h))
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime.utcnow() - datetime.timedelta(minutes=1))
        .not_valid_after(datetime.datetime.utcnow() + datetime.timedelta(days=7))
        .add_extension(x509.SubjectAlternativeName(alt_names), critical=False)
        .sign(key, hashes.SHA256())
    )
    key_file.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    cert_file.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return cert_file, key_file


def _openssl_self_signed(cert_dir: Path, *, hosts: list[str]) -> tuple[Path, Path]:
    import subprocess

    cert_file = cert_dir / "e2e.pem"
    key_file = cert_dir / "e2e-key.pem"
    cert_dir.mkdir(parents=True, exist_ok=True)
    cn = hosts[0]
    # Minimal openssl req without SAN if needed.
    cmd = [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-keyout",
        str(key_file),
        "-out",
        str(cert_file),
        "-days",
        "7",
        "-nodes",
        "-subj",
        f"/CN={cn}",
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    return cert_file, key_file


if __name__ == "__main__":
    raise SystemExit(main())
