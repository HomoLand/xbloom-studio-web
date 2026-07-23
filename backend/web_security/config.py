"""Strict web network/auth configuration (Phase C1).

Defaults to loopback-only. LAN mode requires an exact HTTPS public origin and
an exact trusted-proxy IP/CIDR list. No wildcards, no public-internet mode,
no certificate issuance.
"""

from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass, field
from typing import Mapping
from urllib.parse import urlparse

# ---------------------------------------------------------------------------
# Defaults (bounded)
# ---------------------------------------------------------------------------

MODE_LOOPBACK = "loopback"
MODE_LAN = "lan"
ALLOWED_MODES = frozenset({MODE_LOOPBACK, MODE_LAN})

DEFAULT_MODE = MODE_LOOPBACK
DEFAULT_SESSION_TTL_S = 7 * 24 * 60 * 60  # 7 days
DEFAULT_PAIRING_TTL_S = 5 * 60  # 5 minutes
DEFAULT_PAIRING_RATE_LIMIT_MAX = 10
DEFAULT_PAIRING_RATE_LIMIT_WINDOW_S = 15 * 60  # 15 minutes
DEFAULT_BIND_HOST_LOOPBACK = "127.0.0.1"
DEFAULT_BIND_HOST_LAN = "127.0.0.1"
DEFAULT_BIND_PORT = 8000

SESSION_TTL_MIN_S = 60
SESSION_TTL_MAX_S = 30 * 24 * 60 * 60  # 30 days
PAIRING_TTL_MIN_S = 30
PAIRING_TTL_MAX_S = 60 * 60  # 1 hour
RATE_LIMIT_MAX_MIN = 1
RATE_LIMIT_MAX_MAX = 10_000
RATE_LIMIT_WINDOW_MIN_S = 10
RATE_LIMIT_WINDOW_MAX_S = 24 * 60 * 60

SESSION_COOKIE_NAME = "xbloom_session"
CSRF_COOKIE_NAME = "xbloom_csrf"
CSRF_HEADER_NAME = "x-csrf-token"

# Exact loopback frontend origins (no wildcards). Fixed dev/preview ports only;
# the configured server bind_port is merged in via loopback_origins_for_bind_port.
LOOPBACK_DEV_ORIGINS: tuple[str, ...] = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5174",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
)


def loopback_origins_for_bind_port(bind_port: int) -> tuple[str, ...]:
    """Exact loopback origins for a validated bind port plus fixed dev origins.

    Returns a deduplicated tuple of LOOPBACK_DEV_ORIGINS and
    ``http://localhost:{bind_port}`` / ``http://127.0.0.1:{bind_port}``.

    No wildcards, no arbitrary ports, no Host-header trust: only the fixed
    dev list and the single configured bind_port.
    """

    if not isinstance(bind_port, int) or isinstance(bind_port, bool):
        raise ValueError(f"bind_port must be an int 1..65535, got {bind_port!r}")
    if bind_port < 1 or bind_port > 65535:
        raise ValueError(f"bind_port must be between 1 and 65535, got {bind_port}")
    bind_origins = (
        f"http://localhost:{bind_port}",
        f"http://127.0.0.1:{bind_port}",
    )
    return tuple(dict.fromkeys((*LOOPBACK_DEV_ORIGINS, *bind_origins)))

# Explicit CORS surface (never "*").
CORS_ALLOW_METHODS: tuple[str, ...] = (
    "GET",
    "HEAD",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
)
CORS_ALLOW_HEADERS: tuple[str, ...] = (
    "Accept",
    "Accept-Language",
    "Content-Type",
    "X-CSRF-Token",
    "X-Request-Id",
)

# Starlette TestClient synthetic peer host (never a real socket peer).
TESTCLIENT_PEER_HOST = "testclient"

def _env(name: str, default: str | None = None, environ: Mapping[str, str] | None = None) -> str | None:
    raw = (environ if environ is not None else os.environ).get(name)
    if raw is None:
        return default
    stripped = raw.strip()
    return stripped if stripped else default


def _env_int(
    name: str,
    default: int,
    *,
    minimum: int,
    maximum: int,
    environ: Mapping[str, str] | None = None,
) -> int:
    raw = _env(name, environ=environ)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from exc
    if value < minimum or value > maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}, got {value}")
    return value


def parse_public_origin(raw: str) -> str:
    """Parse and normalize one exact HTTPS origin.

    Rejects non-https, path/query/fragment, userinfo, wildcards, and empty host.
    """

    text = raw.strip()
    if not text:
        raise ValueError("XBLOOM_PUBLIC_ORIGIN must be a non-empty https origin")
    if "*" in text:
        raise ValueError("XBLOOM_PUBLIC_ORIGIN must not contain wildcards")
    if "\\" in text or " " in text or text.count("://") != 1:
        raise ValueError("XBLOOM_PUBLIC_ORIGIN is malformed")

    parsed = urlparse(text)
    if parsed.scheme.lower() != "https":
        raise ValueError("XBLOOM_PUBLIC_ORIGIN must use https")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("XBLOOM_PUBLIC_ORIGIN must not include userinfo")
    if parsed.query or parsed.fragment:
        raise ValueError("XBLOOM_PUBLIC_ORIGIN must not include query or fragment")
    if parsed.path not in ("", "/"):
        raise ValueError("XBLOOM_PUBLIC_ORIGIN must not include a path")
    if not parsed.hostname:
        raise ValueError("XBLOOM_PUBLIC_ORIGIN must include a host")
    host_l = parsed.hostname.lower()
    if host_l in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("XBLOOM_PUBLIC_ORIGIN must not be a loopback host")

    # Rebuild origin from validated components (lowercase host).
    if parsed.port is not None:
        if ":" in host_l:
            netloc = f"[{host_l}]:{parsed.port}"
        else:
            netloc = f"{host_l}:{parsed.port}"
    else:
        if ":" in host_l:
            netloc = f"[{host_l}]"
        else:
            netloc = host_l

    return f"https://{netloc}"


def parse_trusted_proxies(raw: str) -> tuple[ipaddress._BaseNetwork, ...]:  # type: ignore[name-defined]
    """Parse comma-separated exact IP or CIDR entries into networks."""

    text = raw.strip()
    if not text:
        raise ValueError("XBLOOM_TRUSTED_PROXIES must be a non-empty IP/CIDR list")
    if "*" in text:
        raise ValueError("XBLOOM_TRUSTED_PROXIES must not contain wildcards")

    networks: list[ipaddress._BaseNetwork] = []  # type: ignore[name-defined]
    for part in text.split(","):
        item = part.strip()
        if not item:
            continue
        try:
            if "/" in item:
                network = ipaddress.ip_network(item, strict=False)
            else:
                addr = ipaddress.ip_address(item)
                network = ipaddress.ip_network(
                    f"{addr}/{addr.max_prefixlen}", strict=False
                )
        except ValueError as exc:
            raise ValueError(f"invalid trusted proxy entry: {item!r}") from exc
        if network.is_global:
            raise ValueError(
                f"trusted proxy entry must be local/non-global: {item!r}"
            )
        networks.append(network)
    if not networks:
        raise ValueError("XBLOOM_TRUSTED_PROXIES must list at least one IP or CIDR")
    return tuple(networks)


def is_loopback_host(host: str | None) -> bool:
    """True for IPv4/IPv6 loopback addresses (not the synthetic testclient host)."""

    if not host:
        return False
    # Strip IPv6 zone / brackets
    h = host.strip().lower()
    if h.startswith("[") and h.endswith("]"):
        h = h[1:-1]
    if "%" in h:
        h = h.split("%", 1)[0]
    try:
        return ipaddress.ip_address(h).is_loopback
    except ValueError:
        return False


def is_testclient_peer(host: str | None) -> bool:
    """True only for Starlette TestClient's synthetic peer host."""

    return host == TESTCLIENT_PEER_HOST


def is_local_bootstrap_peer(host: str | None) -> bool:
    """Direct loopback or TestClient synthetic peer (never a real remote socket)."""

    return is_loopback_host(host) or is_testclient_peer(host)


def ip_in_networks(host: str, networks: tuple[ipaddress._BaseNetwork, ...]) -> bool:  # type: ignore[name-defined]
    try:
        addr = ipaddress.ip_address(host.strip())
    except ValueError:
        return False
    return any(addr in net for net in networks)


@dataclass(frozen=True)
class WebSecurityConfig:
    """Resolved web security configuration (no secrets)."""

    mode: str = DEFAULT_MODE
    public_origin: str | None = None
    trusted_proxies: tuple[ipaddress._BaseNetwork, ...] = field(default_factory=tuple)  # type: ignore[name-defined]
    session_ttl_s: int = DEFAULT_SESSION_TTL_S
    pairing_ttl_s: int = DEFAULT_PAIRING_TTL_S
    pairing_rate_limit_max: int = DEFAULT_PAIRING_RATE_LIMIT_MAX
    pairing_rate_limit_window_s: int = DEFAULT_PAIRING_RATE_LIMIT_WINDOW_S
    bind_host: str = DEFAULT_BIND_HOST_LOOPBACK
    bind_port: int = DEFAULT_BIND_PORT
    loopback_origins: tuple[str, ...] = LOOPBACK_DEV_ORIGINS
    session_cookie_name: str = SESSION_COOKIE_NAME
    csrf_cookie_name: str = CSRF_COOKIE_NAME
    csrf_header_name: str = CSRF_HEADER_NAME

    def __post_init__(self) -> None:
        # Always include exact origins for the configured bind_port so SPA
        # assets served from the same process (Vite adds crossorigin) are not
        # rejected when XBLOOM_BIND_PORT is non-default. Deduped; never widens
        # beyond fixed dev ports + this single bind_port.
        bind_exact = (
            f"http://localhost:{self.bind_port}",
            f"http://127.0.0.1:{self.bind_port}",
        )
        merged = tuple(dict.fromkeys((*self.loopback_origins, *bind_exact)))
        if merged != self.loopback_origins:
            object.__setattr__(self, "loopback_origins", merged)

    @property
    def is_lan(self) -> bool:
        return self.mode == MODE_LAN

    @property
    def is_loopback(self) -> bool:
        return self.mode == MODE_LOOPBACK

    @property
    def cors_origins(self) -> list[str]:
        # LAN public CORS stays exactly [public_origin]. Loopback-origin set
        # (including configured bind_port) is used only via allowed_origin for
        # direct local bootstrap, not reflected as public CORS.
        if self.is_lan:
            assert self.public_origin is not None
            return [self.public_origin]
        return list(self.loopback_origins)

    @property
    def cors_allow_credentials(self) -> bool:
        return self.is_lan

    @property
    def cookie_secure(self) -> bool:
        """Secure cookies in LAN (HTTPS via reverse proxy); plain HTTP in loopback."""

        return self.is_lan

    def allowed_origin(self, origin: str | None, *, peer_host: str | None) -> bool:
        """Whether a browser Origin is acceptable for this request."""

        if origin is None:
            return True
        origin = origin.strip()
        if not origin or "*" in origin:
            return False
        if origin in self.cors_origins:
            return True
        # Local bootstrap on the machine itself: allow exact loopback origins
        # only when the direct peer is loopback/testclient (not via proxy).
        if self.is_lan and is_local_bootstrap_peer(peer_host):
            return origin in self.loopback_origins
        return False

    def redacted_dict(self) -> dict[str, object]:
        return {
            "mode": self.mode,
            "public_origin": self.public_origin,
            "trusted_proxies": [str(n) for n in self.trusted_proxies],
            "session_ttl_s": self.session_ttl_s,
            "pairing_ttl_s": self.pairing_ttl_s,
            "pairing_rate_limit_max": self.pairing_rate_limit_max,
            "pairing_rate_limit_window_s": self.pairing_rate_limit_window_s,
            "bind_host": self.bind_host,
            "bind_port": self.bind_port,
            "cors_origins": self.cors_origins,
            "cors_allow_credentials": self.cors_allow_credentials,
            "cookie_secure": self.cookie_secure,
        }


def load_web_security_config(
    environ: Mapping[str, str] | None = None,
) -> WebSecurityConfig:
    """Load and strictly validate web security config from environment."""

    env = environ if environ is not None else os.environ
    mode = (_env("XBLOOM_WEB_MODE", DEFAULT_MODE, environ=env) or DEFAULT_MODE).lower()
    if mode not in ALLOWED_MODES:
        raise ValueError(
            f"XBLOOM_WEB_MODE must be one of {sorted(ALLOWED_MODES)}, got {mode!r}"
        )

    session_ttl = _env_int(
        "XBLOOM_SESSION_TTL_S",
        DEFAULT_SESSION_TTL_S,
        minimum=SESSION_TTL_MIN_S,
        maximum=SESSION_TTL_MAX_S,
        environ=env,
    )
    pairing_ttl = _env_int(
        "XBLOOM_PAIRING_TTL_S",
        DEFAULT_PAIRING_TTL_S,
        minimum=PAIRING_TTL_MIN_S,
        maximum=PAIRING_TTL_MAX_S,
        environ=env,
    )
    rate_max = _env_int(
        "XBLOOM_PAIRING_RATE_LIMIT_MAX",
        DEFAULT_PAIRING_RATE_LIMIT_MAX,
        minimum=RATE_LIMIT_MAX_MIN,
        maximum=RATE_LIMIT_MAX_MAX,
        environ=env,
    )
    rate_window = _env_int(
        "XBLOOM_PAIRING_RATE_LIMIT_WINDOW_S",
        DEFAULT_PAIRING_RATE_LIMIT_WINDOW_S,
        minimum=RATE_LIMIT_WINDOW_MIN_S,
        maximum=RATE_LIMIT_WINDOW_MAX_S,
        environ=env,
    )
    bind_port = _env_int(
        "XBLOOM_BIND_PORT",
        DEFAULT_BIND_PORT,
        minimum=1,
        maximum=65535,
        environ=env,
    )

    public_origin: str | None = None
    trusted: tuple[ipaddress._BaseNetwork, ...] = ()  # type: ignore[name-defined]

    if mode == MODE_LAN:
        origin_raw = _env("XBLOOM_PUBLIC_ORIGIN", environ=env)
        if not origin_raw:
            raise ValueError("XBLOOM_PUBLIC_ORIGIN is required when XBLOOM_WEB_MODE=lan")
        public_origin = parse_public_origin(origin_raw)

        proxies_raw = _env("XBLOOM_TRUSTED_PROXIES", environ=env)
        if not proxies_raw:
            raise ValueError("XBLOOM_TRUSTED_PROXIES is required when XBLOOM_WEB_MODE=lan")
        trusted = parse_trusted_proxies(proxies_raw)

        bind_default = DEFAULT_BIND_HOST_LAN
    else:
        # Reject LAN-only knobs that would imply misconfiguration in loopback.
        if _env("XBLOOM_PUBLIC_ORIGIN", environ=env):
            # Allowed but ignored in loopback (dev may leave vars set); do not fail.
            pass
        bind_default = DEFAULT_BIND_HOST_LOOPBACK

    bind_host = _env("XBLOOM_BIND_HOST", bind_default, environ=env) or bind_default
    if mode == MODE_LOOPBACK:
        # Default loopback mode must not silently bind a non-loopback interface
        # unless the operator explicitly set XBLOOM_BIND_HOST (still middleware-
        # enforced). Empty already handled.
        if not _env("XBLOOM_BIND_HOST", environ=env):
            bind_host = DEFAULT_BIND_HOST_LOOPBACK

    return WebSecurityConfig(
        mode=mode,
        public_origin=public_origin,
        trusted_proxies=trusted,
        session_ttl_s=session_ttl,
        pairing_ttl_s=pairing_ttl,
        pairing_rate_limit_max=rate_max,
        pairing_rate_limit_window_s=rate_window,
        bind_host=bind_host,
        bind_port=bind_port,
        loopback_origins=loopback_origins_for_bind_port(bind_port),
    )
