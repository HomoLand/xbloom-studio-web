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

启动/ensure 本身不连接 BLE。经 bridge 的硬件操作（connect / load / start 等）由 daemon 持有连接。Web 在 Phase 0.6 仍另有被动 scan 与一次性 direct probe（见下方「Bridge 共存模型」）。Phase A 目标是更广的 bridge 客户端收敛与经确认的终端/workflow 断开语义；本阶段不改这些 Web 侧语义。

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

## Bridge 共存模型

BLE bridge 是抢占式的单实例守护进程。OS 锁作用域是 **一个规范化后的 state root + 当前 OS 用户**（由 `XBLOOM_STATE_DIR` 解析）：谁先持有该 scope 上的锁，谁就是该 scope 上的唯一 bridge 守护进程。**不同 state root 在 Phase 0 不做协调**——各自可独立运行自己的 daemon，彼此互不感知。

### Phase 0.6 已实现的保证

- 当客户端共享同一 `XBLOOM_STATE_DIR`（同一规范化 state root）时，**经 bridge 的操作**会复用同一个 daemon。
- 后端启动与 MCP 的 `ensure_bridge_daemon()` **只**拉起或复用独立守护进程，**不会**连接 BLE。
- `bridge.lock` 是 OS 生命周期的单实例锁（按规范化 state root + OS user 占位）。
- `bridge.json` 是认证后的 loopback 发现文件（identity/port/token/protocol/config）；它不是单实例锁。
- bridge 作为独立子进程运行；后端与 MCP 通过 `ensure_bridge_daemon()` 确保进程存在，**不负责**在 shutdown 时停止它。后端重启不会连坐正在进行的冲煮。
- 同一 daemon 内部用 `asyncio.Lock` 串行化状态变更；并发请求会被安全排队或返回 `busy`。

### 与 Phase A 目标的区分

**Phase A 目标**（架构方向，尚未在本阶段实现）：Web UI、Skill、MCP 等全部作为 bridge 客户端，经 loopback JSON-line RPC 发指令，没有人直接持有 BLE 连接；更广的 active-operation 收敛，以及经确认的终端/workflow 断开语义，亦归 Phase A。

**Phase 0.6 现状**：Web 仍保留 **被动 BLE scan** 与 **一次性 direct probe**（直连读机后断开）。更广的主动操作收敛、以及 workflow/terminal disconnect，均推迟到 Phase A。本阶段不改变这些 Web 侧语义。

## 安全约束

- Backend 只监听 `127.0.0.1`，不暴露到公网或局域网。
- 涉及加热/电机的操作遵循 Skill 的安全模型（owner gate + 确认短语）。
- 不做内网穿透、端口映射、公网暴露。

## MCP Server

后端包含一个 MCP server（`backend/mcp_server.py`），把 xBloom 能力暴露为 MCP 工具，供 AI Agent（Cursor、Claude 等）直接调用，不需要 Skill CLI 当中间人。

### 工具一览

| 类别 | 工具 |
|---|---|
| 发现/状态 | `xbloom_scan`, `xbloom_status`, `xbloom_events` |
| 连接 | `xbloom_connect`, `xbloom_disconnect` |
| 咖啡 | `xbloom_coffee_load`, `xbloom_coffee_start` |
| 茶 | `xbloom_tea_load`, `xbloom_tea_start` |
| 流程控制 | `xbloom_pause`, `xbloom_resume`, `xbloom_stop` |
| 热水 | `xbloom_water_start` |
| 目录 | `xbloom_catalog_list`, `xbloom_catalog_show` |
| 配方 | `xbloom_recipe_templates`, `xbloom_recipe_validate` |
| 历史 | `xbloom_history_list` |

安全关键工具（coffee_start / tea_start / water_start）需要确认短语参数，bridge daemon 会强制校验。

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

BLE 相关工具（`xbloom_scan` 除外）在首次使用时会通过 `ensure_bridge_daemon()` 拉起或复用持久 bridge 进程（不连接 BLE）。若 daemon 处于 `upgrade_pending` / 非 `client_ready`，工具返回明确错误，不会强制打断进行中的活动。

## 状态

Stage 1 MVP：只读浏览（templates / catalog / history）+ 设备扫描/probe + 桥接状态。
Stage 2：配方详情查看、JSON 导入、实时遥测面板、受控冲煮操作（加载/开始/暂停/恢复/停止，带安全确认短语）。
Stage 3：依赖重整（core 抽出为独立包）+ MCP server（18 个工具，Agent 直接调用，带安全确认短语）。
Stage 4（Phase 0.6）：Web 切到 core 拥有的 `ensure_bridge_daemon()`；发布安装 pin GitHub wheel v1.2.0，无需 sibling checkout。
