# xbloom-studio-web

独立 Web UI，用于通过浏览器操作 xBloom Studio 咖啡/茶冲煮设备。与 [xbloom-studio-brew](../xbloom-studio-brew) 的 Agent Skill 共享核心逻辑，但作为独立子项目存在。

## 架构

- **backend/** — FastAPI HTTP API + MCP server，复用 `xbloom-studio-core`（BLE 协议、配方校验、目录、历史）和桥接守护进程。
- **frontend/** — React + Vite + TypeScript + Tailwind，提供类官方 App 的浏览/控制体验。

## 与 Skill 的关系

Web UI 不直接依赖 Skill 源码路径，而是通过 `xbloom-studio-core` 包复用核心模块（BLE 协议、配方校验、catalog、history）。`core` 已从 Skill 的 `scripts/` 抽到主仓 `packages/core/`，作为独立包存在，Skill CLI 和 Web UI backend 都依赖它。配方模板资源通过 `XBLOOM_ASSETS_DIR` 环境变量定位，避免硬编码主仓库路径。生产安装通过 GitHub Release 的 wheel + 版本化 knowledge bundle 完成，**不要求** sibling checkout。

## 前置条件

1. Python ≥ 3.11。
2. Node.js + pnpm（仅开发前端时需要）。
3. 蓝牙环境（Windows 原生支持；Linux 需 `dbus` / `bluez`）。
4. **发布安装**：可访问 GitHub Release `v1.2.0` 的 wheel 与 knowledge bundle。
5. **本地开发**：可选 sibling [xbloom-studio-brew](../xbloom-studio-brew) 仓库（editable core + assets）。

## 安装

### 发布安装（无 sibling checkout）

从 GitHub Release **v1.2.0** 安装 pinned core wheel，并下载版本化 knowledge bundle：

- wheel: `xbloom_studio_core-1.2.0-py3-none-any.whl`
- wheel SHA-256: `9a90c781e4a9bd756f60103ef4f51d1966b83ef5be466c5cf88e7d8264b5b918`
- knowledge: `knowledge-1.2.0.zip`
- knowledge SHA-256: `42406b5e0a2e643b2ad19dc8e5b916c3592fd58f3cdeb10b19a090a809ddf7f0`

```powershell
# 1) backend 依赖（requirements.txt 已 pin 到 v1.2.0 wheel URL + #sha256=）
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt

# 2) 下载并校验 knowledge bundle（发布后从同一 Release 获取）
#    验证 SHA-256 / manifest 与上方发布哈希一致后再解压
#    设 XBLOOM_ASSETS_DIR 为解压后 bundle 内的 assets 目录，例如：
# $env:XBLOOM_ASSETS_DIR = "C:\path\to\knowledge-1.2.0\assets"

# 3) 安装 frontend 依赖（需要改 UI 时）
cd ..\frontend
pnpm install
```

`pip` 会按 `requirements.txt` 中的 `#sha256=` 校验 wheel 完整性。请同时校验 knowledge zip 的已发布哈希，勿混用其它版本的 assets。

### 本地开发（sibling checkout + editable core）

```powershell
# 在 backend 目录执行，以便相对路径 ../../xbloom-studio-brew/packages/core 正确解析
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt

# frontend
cd ..\frontend
pnpm install
```

`requirements-dev.txt` 安装 editable core 与测试依赖，**不会**安装 GitHub release wheel。若 brew 不在 sibling 路径，先手动：

```powershell
pip install -e "C:\path\to\xbloom-studio-brew\packages\core"
pip install -r requirements-runtime.txt
pip install pytest==8.3.5
```

## 运行

### 日常使用（后端一站式）

前端 build 后，后端一个进程同时 serve API 和页面：

```powershell
# 1) build 前端（只需在代码变动后重新执行）
cd frontend
pnpm build

# 2) 启动后端
cd ..\backend
.venv\Scripts\Activate.ps1
# 发布安装：指向 knowledge bundle 的 assets
# $env:XBLOOM_ASSETS_DIR = "C:\path\to\knowledge-1.2.0\assets"
# 本地开发示例（sibling brew assets）：
$env:XBLOOM_ASSETS_DIR = "C:\Users\SajoL\Documents\Code\xbloom-studio-brew\skills\xbloom-studio-brew\assets"
uvicorn main:app --host 127.0.0.1 --port 8000
```

浏览器打开 `http://127.0.0.1:8000`。

后端启动时调用 core 的 `ensure_bridge_daemon()`，在独立进程中拉起或复用 BLE bridge 守护进程（**不会**搜索 Skill 的 `xbloom.py` 脚本，也**不会**为启动而连接 BLE）。bridge 与后端进程解耦：后端 `--reload` / 崩溃 / 主动停止都不会中断 bridge，正在进行的冲煮会继续跑完。停止 bridge 使用 core CLI，例如 `xbloom-bridge stop` 或 `python -m xbloom_ble.bridge stop`（需已安装 `xbloom-studio-core`）。

**Phase A9 连接语义**：仅**被动 scan** 直接使用 BLE discovery（`xbloom_ble.client.scan`）。**probe** 与全部主动硬件操作（load / start / pause / resume / stop / cancel / water / debug connect 等）经 Web 适配层 `bridge_client` → core `TypedBridgeClient` → 常驻 bridge daemon。HTTP/MCP **没有**通用 `call(method, params)` 透传。`status` / `events` 为**纯观察**：不 ensure daemon、不连接 BLE。`load` 返回不可变 `workflow_id`；绑定的 start / 控制 / events 必须携带该 ID。一次 load 到确认终态/取消只持有一条 BLE 链路，**无五分钟 loaded 过期**；确认终态或确认 cancel 后 bridge 立即释放 BLE。页面关闭、刷新或 MCP 进程退出**不会** cancel 或 release 连接。

### 开发模式（前后端分离，HMR）

需要前端热更新时，分别启动：

```powershell
# 终端 1：backend
cd backend
.venv\Scripts\Activate.ps1
$env:XBLOOM_ASSETS_DIR = "C:\Users\SajoL\Documents\Code\xbloom-studio-brew\skills\xbloom-studio-brew\assets"
uvicorn main:app --reload --host 127.0.0.1 --port 8000

# 终端 2：frontend dev server（HMR）
cd frontend
pnpm dev
```

浏览器打开 `http://localhost:5173`（Vite 自动代理 `/api` 到后端）。

## Bridge 共存模型（Phase A9）

BLE bridge 是抢占式的单实例守护进程。OS 锁作用域是 **一个规范化后的 state root + 当前 OS 用户**（由 `XBLOOM_STATE_DIR` 解析）：谁先持有该 scope 上的锁，谁就是该 scope 上的唯一 bridge 守护进程。**不同 state root 不做协调**——各自可独立运行自己的 daemon，彼此互不感知。

### 已实现的保证

- 共享同一 `XBLOOM_STATE_DIR` 时，Web HTTP、MCP 与 Skill CLI 经类型化 bridge RPC 复用**同一个** daemon。
- **后端 lifespan 启动**可 `ensure_bridge_daemon()` 拉起/复用守护进程，**不**连接 BLE；shutdown **从不**停止 daemon。
- **硬件方法**（load/start/…）由 `TypedBridgeClient` 在每次调用时 ensure daemon 进程（仍不自动为 status/events 建联）；BLE 仅在 bridge 执行硬件操作时按需建立。
- **观察**（`GET /api/device/bridge`、`GET /api/device/events?workflow_id=…`、MCP `xbloom_status` / `xbloom_events`）不 ensure、不触碰 BLE。
- **被动 scan** 是唯一可直用 discovery 的路径；**probe** 是 bridge one-shot 读-only（redacted 机信息后释放）。
- **debug connect** 显式持有 BLE 直到 **debug disconnect**；disconnect **从不**为缺失 daemon 做 ensure/start。
- 一次 workflow：load → start → pause/resume → events 复用同一 BLE 连接与同一 `workflow_id`；loaded **无**时间驱动过期；确认终态/cancel 后 promptly release。
- 变更 RPC 携带幂等 `request_id`（调用方传入则原样保留，禁止对不确定结果自动重试）；绑定控制必须带匹配的 `workflow_id`，紧急 stop/cancel 仅在显式 `emergency=true` 时可省略。
- `bridge.lock` 是 OS 生命周期单实例锁；`bridge.json` 是认证后的 loopback 发现文件（非锁）。
- 页面/MCP 进程退出只停止观察轮询，**不** cancel workflow、**不** release BLE。

## 安全约束

- Backend 只监听 `127.0.0.1`，不暴露到公网或局域网。
- 涉及加热/电机的操作遵循 Skill 的安全模型（owner gate + 确认短语）。
- 不做内网穿透、端口映射、公网暴露。

## MCP Server

后端包含一个 MCP server（`backend/mcp_server.py`），把 xBloom 能力暴露为 MCP 工具，供 AI Agent（Cursor、Claude 等）直接调用，不需要 Skill CLI 当中间人。

### 工具一览

| 类别 | 工具 |
|---|---|
| 发现/观察 | `xbloom_scan`（被动 discovery）, `xbloom_probe`（bridge one-shot）, `xbloom_status`, `xbloom_events`（需 `workflow_id`） |
| Debug 连接 | `xbloom_connect`, `xbloom_disconnect`（显式 hold；disconnect 不 start 缺失 daemon） |
| 咖啡 | `xbloom_coffee_load`（返回 `workflow_id`）, `xbloom_coffee_start`（需 `workflow_id`） |
| 茶 | `xbloom_tea_load`, `xbloom_tea_start` |
| 流程控制 | `xbloom_pause`, `xbloom_resume`, `xbloom_stop`, `xbloom_cancel`（正常路径需 `workflow_id`；紧急路径显式 `emergency=true`） |
| 恢复 | `xbloom_recovery_reconcile`（需 `workflow_id`，只查询对账） |
| 热水 | `xbloom_water_start` |
| 目录 | `xbloom_catalog_list`, `xbloom_catalog_show` |
| 配方 | `xbloom_recipe_templates`, `xbloom_recipe_validate` |
| 历史 | `xbloom_history_list` |

安全关键工具（coffee_start / tea_start / water_start）需要确认短语；start/pause/resume/stop/cancel 等变更可带 `request_id`。结构化错误保留 `category`。

### 运行

MCP server 用 stdio 传输，由 Agent 客户端 spawn：

```powershell
cd backend
.venv\Scripts\Activate.ps1
$env:XBLOOM_ASSETS_DIR = "C:\Users\SajoL\Documents\Code\xbloom-studio-brew\skills\xbloom-studio-brew\assets"
python mcp_server.py
```

### Cursor 配置

在 Cursor 的 MCP 设置（`~/.cursor/mcp.json` 或项目级 `.cursor/mcp.json`）中添加：

```json
{
  "mcpServers": {
    "xbloom-studio": {
      "command": "C:\\Users\\SajoL\\Documents\\Code\\xbloom-studio-web\\backend\\.venv\\Scripts\\python.exe",
      "args": ["C:\\Users\\SajoL\\Documents\\Code\\xbloom-studio-web\\backend\\mcp_server.py"],
      "env": {
        "XBLOOM_ASSETS_DIR": "C:\\Users\\SajoL\\Documents\\Code\\xbloom-studio-brew\\skills\\xbloom-studio-brew\\assets"
      }
    }
  }
}
```

硬件类 MCP 工具经 `TypedBridgeClient` 在调用时 ensure 兼容的 bridge 进程（不连接 BLE）；`xbloom_status` / `xbloom_events` **不** ensure。被动 `xbloom_scan` 不依赖 daemon。若 daemon 非 `client_ready` / 协议不兼容，工具返回带 `category` 的错误，不强制打断进行中的活动。

## 状态

- Stage 1–3：只读浏览、配方详情/导入、遥测与受控冲煮、MCP 工具面。
- Stage 4（Phase 0.6）：Web 使用 core `ensure_bridge_daemon()`；发布 pin GitHub wheel v1.2.0。
- **Stage 5（Phase A9）**：HTTP/MCP 收敛到类型化 bridge 客户端；删除通用 `/api/device/call`；显式 `workflow_id` / `request_id`；probe 走 bridge；仅被动 scan 直连 discovery；无五分钟 loaded 过期；观察路径零 BLE/ensure 副作用。
