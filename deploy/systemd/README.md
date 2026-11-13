# Linux host deployment

Run the Web backend and bridge on the same Linux host with working BlueZ/D-Bus.
The bridge's authenticated RPC remains loopback-only. An existing trusted HTTPS
gateway forwards to the Web backend; browsers select the **bridge** machine driver.

For an unprivileged PVE LXC, keep BlueZ on the PVE host and bind its `/run/dbus`
directory read-only at `/mnt/host-dbus` in the container. Do not mount below the
container's `/run`: its boot-time tmpfs hides that mount. Set
`DBUS_SYSTEM_BUS_ADDRESS=unix:path=/mnt/host-dbus/system_bus_socket` and
`BLEAK_DBUS_AUTH_UID` to the app user's mapped host UID (verify `/proc/self/uid_map`;
UID 999 maps to 100999 with the default 100000 offset). This keeps USB/HCI
ownership on the host while the Web/bridge processes run as an unprivileged
container user. Do not expose the D-Bus socket over TCP or disable AppArmor.
Create a no-login host account `xbloom-lxc` with that mapped UID: D-Bus accepts
EXTERNAL authentication but closes the connection at Hello when NSS cannot
resolve the UID. Install `host-xbloom-dbus.conf` in the host's
`/etc/dbus-1/system.d/` and reload D-Bus configuration (do not restart the bus).
This account can call BlueZ and bus metadata methods, not other host services.

Use the `xbloom` system user, a root-owned application/virtualenv under
`/opt/xbloom-studio`, and `xbloom`-owned private state at `/var/lib/xbloom-studio`.
`current` points to a release directory containing `backend/`, `frontend/dist/`,
`knowledge/`, and optionally the released `skill/` for remote CLI use. Install the
matching core wheel and `backend/requirements-runtime.txt` in `venv/`; do not
implicitly install the older core wheel from `backend/requirements.txt`.

Create `/etc/xbloom-studio/environment` as a root-owned mode-0600 systemd
EnvironmentFile. Configure at least:

```ini
XBLOOM_STATE_DIR=/var/lib/xbloom-studio
XBLOOM_ASSETS_DIR=/opt/xbloom-studio/current/knowledge/assets
XBLOOM_FRONTEND_DIR=/opt/xbloom-studio/current/frontend/dist
XBLOOM_WEB_MODE=lan
XBLOOM_PUBLIC_ORIGIN=https://xbloom.example.net
XBLOOM_TRUSTED_PROXIES=192.0.2.10/32
XBLOOM_BIND_HOST=0.0.0.0
XBLOOM_BIND_PORT=18765
```

Replace the example origin and proxy with the actual gateway. Keep existing
pairing/session/CSRF enforcement; never trust all network peers. Carry over only
explicitly enabled physical-action gates; deployment
does not enable starts or dispense water.

Copy these units into `/etc/systemd/system/`, run `systemd-analyze verify` on
them, then `systemctl daemon-reload` and enable/start both units. The Web unit
sets `XBLOOM_BRIDGE_MANAGED=1`, disabling both startup and per-operation bridge
autospawning. The bridge unit alone owns its process; restarting Web preserves
the bridge PID, state and connection.

Before replacing a release or restarting the bridge, verify that there is no
loaded/active/recovery workflow. Explicit service shutdown uses the core's
guarded stop/cancel path; do not use service restarts as a routine recovery for
an uncertain hardware action. Do not run a second bridge against this machine.

Migrate SQLite with `xbloom-state backup` and the SQLite backup API for
`web/web_auth.sqlite3`, after stopping the previous owner. Preserve those backups;
do not copy Windows virtualenvs, `bridge.json`, locks or a database without its
live WAL. Verify database integrity and counts before activating the new owner.

Acceptance: non-root scan and read-only probe/release/reconnect; HTTPS page and
API auth; rejection of direct untrusted peers; Web restart preserving bridge PID;
and a fresh unauthenticated browser reaching the pairing screen. Physical starts
remain a separate readiness-confirmed operation.

## AI design without a Windows proxy

Create root-owned mode-0600 `/etc/xbloom-studio/design.env` with the existing
provider settings. For the verified official DeepSeek deployment:

```ini
XBLOOM_LLM_PROVIDER=openai-compatible
XBLOOM_LLM_BASE_URL=https://api.deepseek.com
XBLOOM_LLM_MODEL=deepseek-flash
XBLOOM_LLM_REASONING_EFFORT=max
XBLOOM_LLM_API_KEY=<private DeepSeek key>
XBLOOM_DESIGN_WEB_SEARCH=1
XBLOOM_DESIGN_MODE=vision
XBLOOM_KNOWLEDGE_DIR=/opt/xbloom-studio/current/knowledge
XBLOOM_DESIGN_PROVIDER_TIMEOUT_S=140
XBLOOM_DESIGN_TIMEOUT_S=300
```

Install `xbloom-web-ai.conf` as
`/etc/systemd/system/xbloom-web.service.d/design.conf`, reload systemd and
restart only `xbloom-web`. The bridge needs no provider credentials or restart.
The adapter calls the official Search API before generation and reuses those
sources during repair. Search and model usage charge the official account balance.
DeepSeek requests explicitly enable thinking and send `reasoning_effort=max`;
temperature is omitted because DeepSeek ignores it in thinking mode. The longer
timeouts leave room for Max reasoning and the existing single repair attempt.

Verify authenticated text and image design through the public HTTPS origin,
including strict validation, image provenance and unchanged catalog/history.
Revoke temporary acceptance sessions and confirm that the bridge process stays
unchanged. See the official [Search API](https://api-docs.deepseek.com/guides/search/).
DeepSeek's [thinking parameters](https://api-docs.deepseek.com/guides/thinking_mode/)
define `max` as the maximum effort, distinct from the default `high`.
