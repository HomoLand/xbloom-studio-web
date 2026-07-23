"""Mode-aware HTTP launcher for xBloom Studio Web.

Derives a safe bind host/port from web security config:
- loopback mode -> 127.0.0.1 (default)
- LAN mode -> configured bind address for the trusted reverse proxy hop;
  middleware remains the enforcement boundary (no public-internet mode).

Usage (from backend/):

    python -m serve
    python serve.py
"""

from __future__ import annotations

import argparse
import logging
import os
import sys

import uvicorn

from web_security import load_web_security_config


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="xBloom Studio Web HTTP server")
    parser.add_argument(
        "--host",
        default=None,
        help="Override bind host (default derived from XBLOOM_WEB_MODE / XBLOOM_BIND_HOST)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help=(
            "Override bind port (sets XBLOOM_BIND_PORT so listen address and "
            "security origin allowlist stay consistent; default XBLOOM_BIND_PORT or 8000)"
        ),
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable auto-reload (development only)",
    )
    args = parser.parse_args(argv)

    # Keep uvicorn listen address and WebSecurityConfig.bind_port aligned so
    # SPA same-origin asset Origins (Vite crossorigin) match the allowlist.
    if args.port is not None:
        os.environ["XBLOOM_BIND_PORT"] = str(args.port)
    if args.host is not None:
        os.environ["XBLOOM_BIND_HOST"] = args.host

    try:
        config = load_web_security_config()
    except ValueError as exc:
        print(f"web security configuration error: {exc}", file=sys.stderr)
        return 2

    host = config.bind_host
    port = config.bind_port

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger(__name__).info(
        "starting xBloom Studio Web mode=%s bind=%s:%s public_origin=%s",
        config.mode,
        host,
        port,
        config.public_origin or "-",
    )

    uvicorn.run(
        "main:app",
        host=host,
        port=port,
        reload=args.reload,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
