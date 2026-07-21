# xbloom-studio-web

独立 Web UI，用于通过浏览器操作 xBloom Studio 咖啡/茶冲煮设备。与 [xbloom-studio-brew](../xbloom-studio-brew) 的 Agent Skill 共享核心逻辑，但作为独立子项目存在。

## 架构

- **backend/** — FastAPI，复用 Skill 的 `xbloom-studio-core`（BLE 协议、配方校验、目录、历史）和桥接守护进程。
- **frontend/** — React + Vite + TypeScript + Tailwind，提供类官方 App 的浏览/控制体验。

## 与 Skill 的关系

Web UI 不直接依赖 Skill 源码路径，而是通过 `xbloom-studio-core` 包（在 Skill 的 `scripts/` 目录内做 editable 安装）复用核心模块。配方模板资源通过 `XBLOOM_ASSETS_DIR` 环境变量定位，避免硬编码主仓库路径。

## 前置条件

1. 本机已有 [xbloom-studio-brew](../xbloom-studio-brew) 仓库（提供 core 包和 assets）。
2. Python ≥ 3.11。
3. Node.js + pnpm。
4. 蓝牙环境（Windows 原生支持；Linux 需 `dbus` / `bluez`）。

## 安装

```powershell
# 1) 安装共享 core 包（editable，来自 Skill scripts 目录）
pip install -e "C:\Users\SajoL\Documents\Code\xbloom-studio-brew\skills\xbloom-studio-brew\scripts"

# 2) 安装 backend 依赖
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt

# 3) 安装 frontend 依赖
cd ..\frontend
pnpm install
```

## 运行

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
$env:XBLOOM_ASSETS_DIR = "C:\Users\SajoL\Documents\Code\xbloom-studio-brew\skills\xbloom-studio-brew\assets"
uvicorn main:app --host 127.0.0.1 --port 8000
```

浏览器打开 `http://127.0.0.1:8000`。

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

## 安全约束

- Backend 只监听 `127.0.0.1`，不暴露到公网或局域网。
- 涉及加热/电机的操作遵循 Skill 的安全模型（owner gate + 确认短语）。
- 不做内网穿透、端口映射、公网暴露。

## 状态

Stage 1 MVP：只读浏览（templates / catalog / history）+ 设备扫描/probe + 桥接状态。
Stage 2：配方详情查看、JSON 导入、实时遥测面板、受控冲煮操作（加载/开始/暂停/恢复/停止，带安全确认短语）。
