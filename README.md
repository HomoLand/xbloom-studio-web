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
- wheel SHA-256: `1ef153ba4ca6633527d30a97eb03ef5383207e5bbe763d0d53a0b8e433f008d4`
- knowledge: `knowledge-1.2.0.zip`
- knowledge SHA-256: `6dc140917ab54ef4c8a0a6a64b79eeea7566434f6a00c62651a5e0fc3f3260eb`

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
# 推荐：python -m serve（监听端口与安全 Origin 白名单同源自 XBLOOM_BIND_PORT）
python -m serve
# 或显式对齐端口（二者必须一致；仅改 uvicorn --port 而不设 XBLOOM_BIND_PORT 会导致 SPA 静态资源 403）：
# $env:XBLOOM_BIND_PORT = "8000"
# uvicorn main:app --host 127.0.0.1 --port 8000
```

浏览器打开 `http://127.0.0.1:8000`（非默认端口时设置 `$env:XBLOOM_BIND_PORT` 并打开对应地址）。

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

## AI 配方设计（Phase B）

`POST /api/design` 接受文字（`application/json`）或文字+可选图片（`multipart/form-data`），经 provider adapter 生成结构化配方候选，再经 JSON Schema 与 core 校验后返回。本阶段**不会**把候选写入 catalog 或发给 bridge/BLE。

### 配置

| 变量 | 用途 | 默认 |
|---|---|---|
| `XBLOOM_KNOWLEDGE_DIR` | 已校验的版本化 knowledge bundle 根目录（含 `manifest.json`） | 无（必需，或见开发覆盖） |
| `XBLOOM_KNOWLEDGE_DEV_ROOT` | **显式**开发覆盖根目录（绝不静默扫描 sibling checkout） | 无 |
| `XBLOOM_LLM_PROVIDER` | adapter 类型（当前仅 `openai-compatible`） | `openai-compatible` |
| `XBLOOM_LLM_BASE_URL` | OpenAI-compatible 端点根 URL（**不要**在文档中写入真实地址） | 无，**必需** |
| `XBLOOM_LLM_MODEL` | 模型名 | `grok-4.5` |
| `XBLOOM_LLM_API_KEY` | 模型密钥（secret；不进日志/响应） | 无 |
| `XBLOOM_DESIGN_MODE` | `vision`（默认，图片发给模型）或 `text`（本地 OCR，只发文字） | `vision` |
| `XBLOOM_DESIGN_MAX_IMAGE_BYTES` | 图片字节上限 | `5242880`（5 MiB） |
| `XBLOOM_DESIGN_MAX_IMAGE_PIXELS` | 解码后像素上限 | `20000000` |
| `XBLOOM_DESIGN_TIMEOUT_S` | 单次设计请求总超时 | `60` |
| `XBLOOM_DESIGN_PROVIDER_TIMEOUT_S` | 单次 LLM provider 调用超时 | `45` |
| `XBLOOM_DESIGN_OCR_TIMEOUT_S` | 本地 OCR（text 模式+图片）超时 | `15` |

```powershell
# 示例：本地开发（请换成你自己的 knowledge 与 LLM 端点，勿提交真实密钥）
$env:XBLOOM_KNOWLEDGE_DIR = "C:\path\to\knowledge-1.2.0"
# 或显式开发覆盖（无 manifest 时会内存构建并校验）：
# $env:XBLOOM_KNOWLEDGE_DEV_ROOT = "C:\path\to\xbloom-studio-brew\skills\xbloom-studio-brew"
$env:XBLOOM_LLM_BASE_URL = "http://127.0.0.1:PORT/v1"   # 占位，按本机 proxy 配置
$env:XBLOOM_LLM_MODEL = "grok-4.5"
$env:XBLOOM_LLM_API_KEY = "sk-..."   # 仅进程环境；勿写入仓库
$env:XBLOOM_DESIGN_MODE = "vision"
```

### 隐私与安全行为

- **图片**：请求内解码，校正方向后重编码以剥离 EXIF/元数据；原始与净化后的字节**均不落盘**，也不进入 catalog/历史。
- **vision 模式**：净化后的图片字节仅用于当次 provider 调用；响应不含图片。
- **text 模式**：若上传了图片，只做本地 OCR，**从不**把图片字节发给模型；缺少 OCR 能力时返回明确配置错误。Python 包 `pytesseract` 已列入 runtime 依赖；**外部 Tesseract OCR 二进制**仅在 text 模式且请求带图片时需要（vision 模式不需要）。
- **密钥**：`XBLOOM_LLM_API_KEY` 只从环境读取，不出现在日志、HTTP 响应或 provenance。
- **不可信输入**：用户文字、OCR 文本与**附件图片内容**均按不可信数据进入提示词（文字进 UNTRUSTED 围栏；图片像素/读出文字同策略），不能覆盖 system/knowledge，也不能请求密钥、本机路径或机器动作。`beverage` 仅接受规范化的 `coffee` / `tea`（或省略）。
- **启动校验**：若显式配置了任一设计相关环境变量（`XBLOOM_LLM_BASE_URL`、`XBLOOM_KNOWLEDGE_DIR` / `XBLOOM_KNOWLEDGE_DEV_ROOT`、`XBLOOM_LLM_PROVIDER`、`XBLOOM_DESIGN_MODE`），进程启动时校验配置、provider 能力与 knowledge bundle（**不**发起 LLM 网络请求、**不**连接 BLE）；未配置设计 env 时设计服务保持懒加载，控制面可单独启动。
- **输出**：最多一次受约束的结构修复；仍非法时返回可编辑候选 + 字段级错误 + `valid=false`，不保存。
- **provenance**：含 provider/model、knowledge version/hash、prompt template version、candidate hash；不含 API key、原始图片、思维链或任意本机路径。

## 网络安全与配对（Phase C1）

默认 **loopback 模式**：只接受本机环回客户端（`127.0.0.0/8` / `::1`）。应用层拒绝非 loopback 对端；**不**对公网开放。

可选 **LAN 模式**（显式配置）：仅允许已信任的 HTTPS 反向代理作为直连对端，固定唯一 `XBLOOM_PUBLIC_ORIGIN`，一次性配对 + 可撤销会话 + CSRF + 精确 CORS。不做证书签发，不做公网模式。配对/会话路径**不**触碰 BLE。

### 配置

| 变量 | 用途 | 默认 |
|---|---|---|
| `XBLOOM_WEB_MODE` | `loopback` 或 `lan` | `loopback` |
| `XBLOOM_PUBLIC_ORIGIN` | LAN 必需：唯一精确 `https` origin（无 path/query/fragment/通配/userinfo） | 无 |
| `XBLOOM_TRUSTED_PROXIES` | LAN 必需：精确 IP/CIDR 列表（逗号分隔） | 无 |
| `XBLOOM_SESSION_TTL_S` | 会话 TTL（秒，有上下界） | `604800`（7 天） |
| `XBLOOM_PAIRING_TTL_S` | 配对 token TTL（秒） | `300` |
| `XBLOOM_PAIRING_RATE_LIMIT_MAX` | 无效配对尝试次数上限（按客户端 IP，持久化） | `10` |
| `XBLOOM_PAIRING_RATE_LIMIT_WINDOW_S` | 配对限速窗口（秒） | `900` |
| `XBLOOM_BIND_HOST` | 监听地址（middleware 仍是策略边界） | loopback/`lan` 默认 `127.0.0.1` |
| `XBLOOM_BIND_PORT` | 监听端口；loopback 精确 Origin 白名单会并入 `http://localhost:{port}` 与 `http://127.0.0.1:{port}`（无通配） | `8000` |

```powershell
# 默认 loopback（本机）
cd backend
.venv\Scripts\Activate.ps1
python -m serve
# 非默认端口：先设 XBLOOM_BIND_PORT，或 `python -m serve --port 8010`（会同步该 env）
# 直接 uvicorn 时必须同时设 env 与 --port，否则 Vite 带 crossorigin 的 /assets 会被 Origin 校验拒绝：
# $env:XBLOOM_BIND_PORT = "8010"
# uvicorn main:app --host 127.0.0.1 --port 8010

# LAN（仅示例占位：换成你自己的本地域名与反向代理 IP；勿提交真实域名）
$env:XBLOOM_WEB_MODE = "lan"
$env:XBLOOM_PUBLIC_ORIGIN = "https://YOUR_LOCAL_HOSTNAME"
$env:XBLOOM_TRUSTED_PROXIES = "127.0.0.1/32,YOUR_PROXY_IP/32"
python -m serve
```

### 行为摘要

- **loopback**：正常 `/api/*` 无需配对；`GET /api/auth/config` 如实报告 `mode=loopback`。CORS 仅为精确的本机开发 origin（无通配）。
- **LAN**：直连对端必须是 loopback（本机引导）或 `XBLOOM_TRUSTED_PROXIES` 中的代理。仅信任来自该代理的 `X-Forwarded-*`；要求 `X-Forwarded-Proto: https` 与精确的 `X-Forwarded-Host`。浏览器 `Origin` 必须匹配 public origin。
- **配对**：`POST /api/auth/pairing/new` 仅允许本机 loopback 引导，或已认证 + CSRF 的 LAN 会话。`POST /api/auth/pair` 是唯一的未认证 LAN 写操作（一次性 token → 会话 cookie）。
- **会话**：HttpOnly + Secure（LAN）+ SameSite=Strict 的会话 cookie；可变请求需会话绑定的 `X-CSRF-Token` 双提交。支持列表 / 撤销 / 登出。
- **存储**：SQLite（WAL）位于解析后的 xBloom state 目录下 `web/web_auth.sqlite3`，只存 hash，不记 secret。

### 安全约束

- 默认只绑定 loopback；LAN 仍要求受信 HTTPS 反向代理，**不做**内网穿透、端口映射或公网暴露。
- 不把 `client_name`、`Origin`、`Host` 或单独 cookie 当作授权。
- 涉及加热/电机的操作仍遵循 Skill 的安全模型（owner gate + 确认短语）。

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

## Playwright E2E（Phase C9）

确定性端到端测试：对**生产构建的 React SPA** + **真实 FastAPI / 安全中间件 / SQLite 路由**做浏览器集成；**只伪造 design provider 与类型化 bridge**。不用浏览器 `route` 拦截冒充后端集成，不启动真实 xBloom bridge、不扫描 BLE、不触碰硬件、不调用真实 CLP/LLM。

### 命令

```powershell
# 前置：backend venv 已装 requirements-dev.txt（含 core）；sibling knowledge 可用
cd frontend
pnpm install
pnpm build
pnpm exec playwright install chromium   # 首次或浏览器缺失时
pnpm test:e2e
```

可选环境变量（均由 `playwright.config.ts` 提供默认值）：

| 变量 | 含义 | 默认 |
|---|---|---|
| `XBLOOM_E2E_PORT` | E2E 服务端口 | `18901` |
| `XBLOOM_E2E_TOKEN` | 控制面 header `X-XBloom-E2E-Token` | 本地固定测试 token |
| `XBLOOM_E2E_PUBLIC_HOST` | 模拟 LAN public host | `studio.e2e.local` |
| `XBLOOM_E2E_STATE_DIR` | 隔离 `XBLOOM_STATE_DIR` | OS temp 下 `xbloom-studio-web-e2e-<pid>-<timestamp>`（每次 run 独立；可显式覆盖） |
| `XBLOOM_E2E_PYTHON` | 后端解释器 | `backend/.venv/Scripts/python.exe` |
| `XBLOOM_KNOWLEDGE_DEV_ROOT` | knowledge 开发根 | sibling brew skill 路径 |

工件目录（已在 `.gitignore`）：`frontend/test-results/`、`frontend/playwright-report/`。

### 假边界架构

```
Playwright (Chromium)
  |  HTTPS + host-resolver-rules(MAP studio.e2e.local -> 127.0.0.1)
  v
python -m e2e.launcher   # 仅测试入口；生产 main:app / python -m serve 永不 import
  |
  +-- create_app(web_config=LAN, auth_store=temp SQLite)
  +-- 注入 FakeOpenAICompatibleProvider -> DesignService
  |     （收 normalized ProviderRequest；记录配置 model + 图片字节/mime；固定候选）
  |     不走 OpenAICompatibleProvider，也不断言其 HTTP image_url body（那是 B10 单测）
  +-- 替换 bridge_client 模块函数 -> FakeBridge（instance_id / workflow / events / release 合同）
  +-- 挂载 /__e2e__/* 控制与 ledger（X-XBloom-E2E-Token；生产 app 不存在这些路由；不在 /api 下以免走会话门）
  +-- 反向代理语义中间件：Host=public_host 时注入 X-Forwarded-*；Host=127.0.0.1 保持 loopback 配对引导
  +-- 生产 frontend/dist 静态资源由 FastAPI 同进程 serve
```

约束摘要：

- 每次 run 使用独立 temp `XBLOOM_STATE_DIR`（auth + recipe SQLite）。
- 假硬件**不能**通过普通生产启动环境变量打开；必须 import 测试 launcher。
- Fake design provider：只替换 DesignService 注入点；边界是 `ProviderRequest`（规范化后的 prompt/image bytes），**不是**真实 LLM HTTP 适配器的 wire format。
- Fake bridge：workflow 连接跨 load/start/telemetry；确认终态后立即 release；**无**五分钟 loaded 过期；`status`/`events` 不 connect/load/start。
- 覆盖：desktop/mobile 视口、LAN 配对、multipart 上传、领域编辑与校验、OCC 冲突、完整冲煮终态与 BLE released、刷新恢复、陈旧 workflow 确认、历史链路。

手动只起 E2E 服务（调试）：

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
$env:XBLOOM_E2E_STATE_DIR = "$env:TEMP\xbloom-e2e-debug"
python -m e2e.launcher --port 18901 --token e2e-local-token-phase-c9
```

## 状态

- Stage 1–3：只读浏览、配方详情/导入、遥测与受控冲煮、MCP 工具面。
- Stage 4（Phase 0.6）：Web 使用 core `ensure_bridge_daemon()`；发布 pin GitHub wheel v1.2.0。
- **Stage 5（Phase A9）**：HTTP/MCP 收敛到类型化 bridge 客户端；删除通用 `/api/device/call`；显式 `workflow_id` / `request_id`；probe 走 bridge；仅被动 scan 直连 discovery；无五分钟 loaded 过期；观察路径零 BLE/ensure 副作用。
- **Stage 6（Phase B batch 1）**：`backend/design/` + `POST /api/design`（JSON/multipart）、knowledge 校验加载、OpenAI-compatible provider adapter、vision EXIF 净化 / text OCR、严格 schema + core 校验与单次 repair、provenance；未接 catalog 保存（B8/B9 后续）。
- **Stage 7（Phase C1）**：`backend/web_security/` 网络/认证边界 — loopback 默认拒绝非本机；显式 LAN + 受信 HTTPS 反代 + 一次性配对 + 持久会话/CSRF/精确 CORS；`python -m serve` 模式感知绑定；前端配对 UI 后续阶段。
- **Stage 8（Phase C9）**：Playwright E2E — 生产 SPA + 真实 FastAPI/安全/SQLite；仅假 design provider 与 typed bridge；desktop/mobile、LAN 配对、上传编辑 OCC、冲煮终态与恢复路径。
