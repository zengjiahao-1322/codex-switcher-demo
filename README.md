# Codex Switcher Demo

为 Codex 管理官方账号和自定义 API 的本机工具，支持 Windows 和 macOS。当前版本：**0.1 Demo**。

[下载 Windows / macOS 版本](https://github.com/zengjiahao-1322/codex-switcher-demo/releases/latest)

[Windows 安装包](https://github.com/zengjiahao-1322/codex-switcher-demo/releases/download/v0.1/codex-switcher-windows-x64.zip) · [Mac 通用安装包](https://github.com/zengjiahao-1322/codex-switcher-demo/releases/download/v0.1/codex-switcher-macos-universal.zip)

## 下载即用

先安装 [Codex 桌面版](https://developers.openai.com/codex/app/)或 OpenAI 官方 Codex 编辑器扩展，任选一种。本工具随包携带 Node.js 和依赖，不需要另外安装 Node、npm 或 Python。

| 系统 | 下载文件 | 启动方式 |
| --- | --- | --- |
| Windows 10/11 x64 | `codex-switcher-windows-x64.zip` | 完整解压，双击 `Codex Switcher/Start.cmd` |
| macOS 12+，Apple Silicon / Intel | `codex-switcher-macos-universal.zip` | 解压，将 `Codex Switcher.app` 放入用户的 Applications 文件夹，双击打开；也可运行同包 `Install.command` |

Windows 可选双击 `install.cmd`，安装到当前用户目录并创建桌面及开始菜单快捷方式，不需要管理员权限。直接运行解压版时，不要只取出启动脚本，整个文件夹需要保留。

macOS Demo 尚无 Apple Developer 签名和公证。首次打开可能需要用户在 Finder 或“系统设置 → 隐私与安全性”中手动允许；本项目不自动关闭 Gatekeeper。应用默认没有 Dock 图标，启动后会打开浏览器中的本机界面。

两个安装包均不携带发布者的账号、API 密钥、聊天记录或测试数据。首次使用需要添加自己的官方登录或 API 配置。

## 能做什么

- **统一应用**：官方账号和 API 使用同一入口。桌面版重启，已连接且共用此目录的插件窗口重载；只安装插件也可添加账号、读取额度和应用配置。
- **官方多账号**：通过 OpenAI 官方授权页添加账号，在列表中切换；添加账号不会自动启用。额度按账号独立查询，批量刷新逐个返回结果，不锁定顶部来源选择器。查询失败时保留并标注上次成功数据。
- **API 配置**：Responses、Chat Completions、Anthropic Messages；支持直连检测和受限的本机协议转换。检测和实际使用会产生供应商费用。
- **编辑器窗口**：安装随包提供的伴随扩展后，识别本机配置归属，仅向已确认共用配置的窗口发送重载请求。独立目录、WSL、SSH、容器环境不自动切换。
- **旧会话诊断**：搜索本机会话、查看模型/供应商/账号差异和关联错误，导出可见对话给新会话继续。

切换会中断目标客户端的运行任务，请先保存工作。已有会话可能继续使用原供应商和模型；切换默认配置不等于重写全部历史，也不会让所有云端 ChatGPT 对话迁移到本机。额度是 Codex 的服务端额度，不代表 ChatGPT 网页聊天次数或 API 余额。

## VS Code / Cursor

在切换器的“影响范围与其他客户端”点击“接入 VS Code / Cursor”，或下载伴随扩展 VSIX，在编辑器的扩展菜单中选择“从 VSIX 安装”。还需安装 OpenAI 官方 Codex 扩展。重载只会发送给已经连接且可确认配置归属的本机窗口。

## 数据与配置

- 默认 Codex 配置目录为 `~/.codex`，尊重 `CODEX_HOME`；“影响范围与其他客户端”可选择实际配置目录、填写自定义程序路径，选择会保存。`BRIDGE_CODEX_HOME` 仍可强制指定管理目录。
- Windows 数据存放在工具目录的 `private/`；安装版在 `%LOCALAPPDATA%/CodexApiSwitcher/private/`。
- macOS 数据存放在 `~/Library/Application Support/CodexApiSwitcher/`，更新 `.app` 不会清空账号。
- `BRIDGE_HOME` 可指定独立数据目录；每个 Codex home 应使用自己的数据目录。
- 官方授权信息由官方 Codex 写入，工具保存登录副本供切换使用，不要求提供邮箱密码。
- 应用保存的官方账号时使用 Codex 的 `file` 凭据存储，避免系统钥匙串中的另一账号覆盖选择；不删除原钥匙串条目。
- macOS 的 `keyring` / `auto` 配置会尝试读取对应 Codex home 的 `Codex Auth` 钥匙串条目；读取失败会提示。官方登录与额度子进程继承显式代理，未设置时采用系统手动 HTTP / SOCKS 代理；PAC 脚本不自动解析。
- 首次修改前保留配置快照，不修改 Codex 的程序文件。
- 仅监听 `127.0.0.1`。这是基础 Demo，未进行正式安全审计。

macOS 如将 Codex 放在非标准目录，可设置 `CODEX_DESKTOP_APP` 指向 `.app`；`CODEX_EXE` 可指定内置或独立 CLI 的可执行文件。用户自行设置的启动参数、项目配置和系统凭据存储可能影响实际配置，界面会尽可能展示可核对信息。

## 验证范围

Windows 已在开发机实测真实官方扩展启动、指定窗口重载及独立配置隔离。两个真实官方账号与 API 的切换、后端进程重启、短消息回复、重启后继续人工验证会话均已通过。没有对全部历史会话作恢复保证。

GitHub Actions 会在 Windows 与 macOS 上安装固定版本的官方 Codex，运行回归检查、构建发行包，再从发行包解压启动服务，验证客户端列表和伴随扩展下载。macOS 原生进程助手也在 macOS 上编译并读取真实进程验证。CI 不使用任何个人账号；macOS 的 Finder 首次授权、真实账号切换和日常桌面交互仍需真实 Mac 用户验收。

本版修复已在 macOS 15 Apple Silicon / Intel 环境验证，每种架构 78 项回归检查全部通过、无跳过。实际下载官方 VSIX，验证不依赖桌面版或 `CODEX_EXE` 的程序发现、真实 Codex 进程归属、默认/自定义配置目录、钥匙串读取、登录启动/取消，以及官方运行程序的额度 RPC 并发。打包后的 `.app` 入口也在最小环境中启动通过。额度测试使用合成账号与本机响应，未上传个人凭据，个人账号完整登录和真实额度仍需在用户 Mac 上复核。

[macOS 验证记录](https://github.com/zengjiahao-1322/codex-switcher-demo/actions/runs/39261196550)。两种架构另通过真实浏览器的额度独立刷新检查、切换时钥匙串最新登录保存，以及真实后端进程树的配置隔离/定向重载命令检查；实际 VS Code 窗口的重载交互仍需用户 Mac 复核。原生助手已固定最低编译目标 macOS 12，二进制两个架构的版本标记均已检查；本次执行系统为 macOS 15，没有实际运行 macOS 12。

## 开发与发布

需要 Node.js 22.22+。安装依赖后运行：

```sh
npm install --ignore-scripts
npm test
```

本次涉及的源码按 `.prettierrc.json` 统一缩进、换行，并在账号并发、程序发现、配置归属等关键流程添加中文注释。后续修改可运行 `npx prettier --write <文件>`；格式化工具不打入运行包。

需要安装官方 Codex CLI、桌面应用或官方编辑器扩展；非标准安装可设置 `CODEX_EXE`。macOS 测试原生进程助手前执行 `clang -O2 -mmacosx-version-min=12.0 mac-process-context.c -o bin/mac-process-context`（先创建 `bin/`）。

```sh
node scripts/build-release.cjs win32
# 在 macOS 上构建 Apple Silicon + Intel 通用包
node scripts/build-release.cjs darwin
```

打包文件由 `release-files.json` 明确列出；`private/`、本机运行时、验证目录和研究记录不会提交。发布 `v*` 标签后，CI 仅在两平台检查和发行包启动检查均通过时创建 GitHub Release，附带两个压缩包及 SHA-256。

## 卸载

Windows 安装版运行 `uninstall.ps1`，按提示处理使用中的配置。macOS 先在界面关闭自启动、切回需要保留的来源并关闭服务，然后移除应用；用户数据目录单独保留，避免误删账号和历史。本工具不会卸载 Codex 或官方扩展。

MIT License。独立第三方 Demo，与 OpenAI 无隶属关系。
