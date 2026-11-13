#!/usr/bin/env bash
# Upgrade xbloom-web on the BLE host safely:
#   - Aborts if the BLE bridge reports an active workflow, activity, or pending recovery.
#   - Atomically swaps /opt/xbloom-studio/current without restarting xbloom-bridge.service.
#   - Verifies local /api/health and automatically rolls back if health fails.

set -euo pipefail

APP_ROOT="${XBLOOM_APP_ROOT:-/opt/xbloom-studio}"
ENV_FILE="${XBLOOM_ENV_FILE:-/etc/xbloom-studio/environment}"
VENV_PYTHON="${XBLOOM_VENV_PYTHON:-${APP_ROOT}/venv/bin/python}"
WEB_SERVICE="${XBLOOM_WEB_SERVICE:-xbloom-web.service}"
BRIDGE_SERVICE="${XBLOOM_BRIDGE_SERVICE:-xbloom-bridge.service}"
TARBALL=""
RELEASE_ID=""
HEALTH_URL="${XBLOOM_HEALTH_URL:-}"
HEALTH_TIMEOUT="${XBLOOM_HEALTH_TIMEOUT:-20}"

usage() {
  cat <<'EOF'
Usage: upgrade-host.sh --tarball <path.tar.gz> [--release-id <id>] [--health-url <url>]
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tarball)
      TARBALL="${2:-}"
      shift 2
      ;;
    --release-id)
      RELEASE_ID="${2:-}"
      shift 2
      ;;
    --health-url)
      HEALTH_URL="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "${TARBALL}" || ! -f "${TARBALL}" ]]; then
  echo "Missing or unreadable --tarball: ${TARBALL}" >&2
  exit 2
fi

if [[ -z "${RELEASE_ID}" ]]; then
  RELEASE_ID="$(date -u +%Y%m%d-%H%M%S)"
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "upgrade-host.sh must run as root" >&2
  exit 1
fi

if [[ ! -x "${VENV_PYTHON}" ]]; then
  echo "Python venv not found at ${VENV_PYTHON}" >&2
  exit 1
fi

CURRENT_LINK="${APP_ROOT}/current"
RELEASES_DIR="${APP_ROOT}/releases"
NEW_RELEASE="${RELEASES_DIR}/${RELEASE_ID}"
PREV_RELEASE=""
if [[ -L "${CURRENT_LINK}" || -d "${CURRENT_LINK}" ]]; then
  PREV_RELEASE="$(readlink -f "${CURRENT_LINK}")"
fi

if [[ -e "${NEW_RELEASE}" ]]; then
  echo "Target release already exists: ${NEW_RELEASE}" >&2
  exit 1
fi

echo "[1/5] Checking BLE bridge idle state..."
"${VENV_PYTHON}" - "${CURRENT_LINK}" "${ENV_FILE}" <<'PY'
import json
import os
import sys
from pathlib import Path

current_link = Path(sys.argv[1])
env_file = Path(sys.argv[2])

if env_file.is_file():
    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

sys.path.insert(0, str(current_link / "backend"))
import bridge_client  # noqa: E402

st = bridge_client.status()
if not isinstance(st, dict):
    raise SystemExit(f"Unexpected bridge status type: {type(st).__name__}")

phase = st.get("phase")
activity = st.get("activity")
workflow_id = st.get("active_workflow_id")
recovery = st.get("recovery_required")

print("Bridge status:", json.dumps(st, ensure_ascii=False))
if workflow_id or activity or recovery or phase not in (None, "", "disconnected", "idle"):
    raise SystemExit(
        f"Refusing upgrade while bridge is busy (phase={phase!r}, activity={activity!r}, "
        f"active_workflow_id={workflow_id!r}, recovery_required={recovery!r})"
    )
PY

if [[ -z "${HEALTH_URL}" ]]; then
  BIND_PORT="$("${VENV_PYTHON}" - "${ENV_FILE}" <<'PY'
from pathlib import Path
import sys
port = "18765"
env_file = Path(sys.argv[1])
if env_file.is_file():
    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line.startswith("XBLOOM_BIND_PORT="):
            port = line.split("=", 1)[1].strip().strip('"').strip("'") or port
            break
print(port)
PY
)"
  HEALTH_URL="http://127.0.0.1:${BIND_PORT}/api/health"
fi

OLD_BRIDGE_PID="$(systemctl show -p MainPID --value "${BRIDGE_SERVICE}" 2>/dev/null || true)"
echo "Bridge PID before upgrade: ${OLD_BRIDGE_PID:-unknown}"

echo "[2/5] Extracting release into ${NEW_RELEASE}..."
mkdir -p "${NEW_RELEASE}"
cleanup_on_stage_fail() {
  rm -rf "${NEW_RELEASE}" "${CURRENT_LINK}.tmp"
}
trap cleanup_on_stage_fail ERR

tar -xzf "${TARBALL}" -C "${NEW_RELEASE}"

if [[ -n "${PREV_RELEASE}" && -d "${PREV_RELEASE}" ]]; then
  for keep_dir in knowledge skill wheels; do
    if [[ ! -e "${NEW_RELEASE}/${keep_dir}" && -e "${PREV_RELEASE}/${keep_dir}" ]]; then
      cp -a "${PREV_RELEASE}/${keep_dir}" "${NEW_RELEASE}/${keep_dir}"
    fi
  done
fi

chown -R root:root "${NEW_RELEASE}"
chmod -R u+rwX,go+rX,go-w "${NEW_RELEASE}"

trap - ERR

check_health() {
  "${VENV_PYTHON}" - "${HEALTH_URL}" "${HEALTH_TIMEOUT}" <<'PY'
import json
import sys
import time
import urllib.error
import urllib.request

url = sys.argv[1]
timeout = int(sys.argv[2])
deadline = time.monotonic() + timeout
last_err = "unknown"

while time.monotonic() < deadline:
    try:
        with urllib.request.urlopen(url, timeout=2.0) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            if resp.status == 200 and body.get("status") == "ok":
                print(f"Health OK: {body}")
                raise SystemExit(0)
            last_err = f"status={resp.status} body={body}"
    except (urllib.error.URLError, OSError, ValueError) as exc:
        last_err = str(exc)
    time.sleep(0.5)

raise SystemExit(f"Health check timed out for {url}: {last_err}")
PY
}

rollback() {
  echo "Rolling back ${CURRENT_LINK} -> ${PREV_RELEASE}..." >&2
  if [[ -n "${PREV_RELEASE}" && -d "${PREV_RELEASE}" ]]; then
    ln -sfn "${PREV_RELEASE}" "${CURRENT_LINK}.rollback"
    mv -Tf "${CURRENT_LINK}.rollback" "${CURRENT_LINK}"
    systemctl restart "${WEB_SERVICE}" || true
    check_health || true
  fi
}

echo "[3/5] Swapping ${CURRENT_LINK} -> ${NEW_RELEASE}..."
ln -sfn "${NEW_RELEASE}" "${CURRENT_LINK}.tmp"
mv -Tf "${CURRENT_LINK}.tmp" "${CURRENT_LINK}"

echo "[4/5] Restarting ${WEB_SERVICE} (leaving ${BRIDGE_SERVICE} untouched)..."
if ! systemctl restart "${WEB_SERVICE}" || ! check_health; then
  rollback
  echo "Upgrade failed; rolled back to ${PREV_RELEASE}" >&2
  exit 1
fi

echo "[5/5] Verifying ${BRIDGE_SERVICE} continuity..."
NEW_BRIDGE_PID="$(systemctl show -p MainPID --value "${BRIDGE_SERVICE}" 2>/dev/null || true)"
if [[ -n "${OLD_BRIDGE_PID}" && "${OLD_BRIDGE_PID}" != "0" && "${NEW_BRIDGE_PID}" != "${OLD_BRIDGE_PID}" ]]; then
  echo "WARNING: Bridge PID changed (${OLD_BRIDGE_PID} -> ${NEW_BRIDGE_PID})" >&2
  exit 1
fi

echo "Upgrade succeeded: ${CURRENT_LINK} -> $(readlink -f "${CURRENT_LINK}") (bridge PID=${NEW_BRIDGE_PID:-unknown})"
