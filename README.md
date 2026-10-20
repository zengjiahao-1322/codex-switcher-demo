# Codex Switcher Demo

为 Codex 管理官方账号和自定义 API 的本机工具，支持 Windows 和 macOS。当前版本：**0.1.3 Demo**。

[下载 Windows / macOS 版本](https://github.com/zengjiahao-1322/codex-switcher-demo/releases/latest)

[Windows 安装包](https://github.com/zengjiahao-1322/codex-switcher-demo/releases/download/v0.1.3/codex-switcher-windows-x64.zip) · [Mac M 系列安装包](https://github.com/zengjiahao-1322/codex-switcher-demo/releases/download/v0.1.3/codex-switcher-macos-arm64.zip) · [Mac Intel 安装包](https://github.com/zengjiahao-1322/codex-switcher-demo/releases/download/v0.1.3/codex-switcher-macos-x64.zip)

## 下载即用

先安装 [Codex 桌面版](https://developers.openai.com/codex/app/)或 OpenAI 官方 Codex 编辑器扩展，任选一种。本工具随包携带 Node.js 和依赖，不需要另外安装 Node、npm 或 Python。

| 系统 | 下载文件 | 启动方式 |
| --- | --- | --- |
| Windows 10/11 x64 | `codex-switcher-windows-x64.zip` | 完整解压，双击 `Codex Switcher/Start.cmd` |
| macOS 12+，Apple Silicon（M 系列） | `codex-switcher-macos-arm64.zip` | 解压并运行 `Install.command`，或打开同包 `.app` |
| macOS 12+，Intel | `codex-switcher-macos-x64.zip` | 解压并运行 `Install.command`，或打开同包 `.app` |

Windows 可选双击 `install.cmd`，安装到当前用户目录并创建桌面及开始菜单快捷方式，不需要管理员权限。直接运行解压版时，不要只取出启动脚本，整个文件夹需要保留。

服务运行后，也可直接访问 `http://127.0.0.1:47831/` 或 `http://localhost:47831/`，支持新标签页、刷新和浏览器书签。网页自动建立本机会话，后台重启后自动恢复访问；服务未运行时仍需先启动程序。

macOS Demo 使用 ad-hoc 签名校验应用完整性，尚无 Apple Developer ID 签名和公证。首次打开可能需要在“系统设置 → 隐私与安全性”中手动允许；本项目不自动关闭 Gatekeeper。应用默认没有 Dock 图标，启动后会打开浏览器中的本机界面。

安装包不携带发布者的账号、API 密钥、聊天记录或测试数据。首次使用需要添加自己的官方登录或 API 配置。

Mac 包按芯片拆分，只携带一套 Node.js，避免原通用包同时下载两套运行时。运行时占主要体积；应用代码和依赖压缩后约 0.3 MiB。

## 能做什么

- **统一应用**：官方账号和 API 使用同一入口。桌面版重启，已连接且共用此目录的插件窗口重载；只安装插件也可添加账号、读取额度和应用配置。
- **官方多账号**：通过 OpenAI 官方授权页添加账号，在列表中切换；添加账号不会自动启用。额度按账号独立查询，批量刷新逐个返回结果，不锁定顶部来源选择器。查询失败时保留并标注上次成功数据。
- **API 配置**：Responses、Chat Completions、Anthropic Messages；支持直连检测和受限的本机协议转换。检测和实际使用会产生供应商费用。
- **编辑器窗口**：安装随包提供的伴随扩展后，识别本机配置归属，仅向已确认共用配置的窗口发送重载请求。独立目录、WSL、SSH、容器环境不自动切换。
- **旧会话诊断**：搜索本机会话、查看模型/供应商/账号差异和关联错误，导出可见对话给新会话继续。

切换来源会中断目标客户端的运行任务，请先保存工作。统一应用会同步未归档旧对话的来源和模型，保留各对话原有速度；它不会迁移云端 ChatGPT 对话。额度是 Codex 的服务端额度，不代表 ChatGPT 网页聊天次数或 API 余额。

来源下方提供“检测 API”，检测不修改配置、不应用来源、不重启。切换器不提供独立加速功能，也不额外生成标准／Fast 模型；已有的 Codex 速度设置保留，Chat Completions 转换继续传递请求中的服务档位参数。

## VS Code / Cursor / Windsurf / Insiders

在切换器的“影响范围与其他客户端”点击“接入 VS Code / Cursor”，或下载伴随扩展 VSIX，在编辑器的扩展菜单中选择“从 VSIX 安装”。还需安装 OpenAI 官方 Codex 扩展。重载只会发送给已经连接且可确认配置归属的本机窗口。

更新切换器后，也需要重新接入最新版伴随扩展。每个窗口的状态栏应显示“Codex Switcher · 已连接”；已有窗口可能需要先手动重载一次才能启用新扩展。客户端列表会显示扩展版本、配置归属，以及请求待接收、已接收或重载失败等状态。

也可单独下载 [0.1.3 伴随扩展 VSIX](https://github.com/zengjiahao-1322/codex-switcher-demo/releases/download/v0.1.3/codex-switcher-companion.vsix)，在各编辑器选择“从 VSIX 安装”，无需为了更新扩展重新下载 Node 运行时。

多个窗口共用 `CODEX_HOME` 时，一次切换会更新默认配置和未归档旧对话的供应商、模型。通过官方会话接口保存并冷启动核对后，再重新打开桌面端、请求编辑器窗口重载；原消息、工具记录和项目目录保留。重载会中断正在执行的任务，请等任务结束再切换，或使用独立配置目录。无法同步的会话会报告失败，不会把部分切换显示为完成；未落盘内容和正在执行的任务不保证自动恢复。

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

[本次功能修复验证](https://github.com/zengjiahao-1322/codex-switcher-demo/actions/runs/39418411775)覆盖 Windows、macOS 15 Apple Silicon 与 Intel 的回归检查、真实浏览器普通 API 检测与独立额度刷新、打包解压启动，以及真实 VS Code 多窗口重载。VS Code 检查使用安装的伴随扩展和官方 Codex 后端，确认两个共享配置窗口重载，独立配置窗口不受影响；测试使用合成数据，不证明执行中任务能自动恢复。Cursor、Windsurf、Insiders 的接入路径已支持，尚未逐款完成同样的 GUI 验收。

macOS CI 另覆盖系统 Bash 安装脚本、首次与重复安装、数据保留、ad-hoc 签名完整性和 LaunchServices 启动。尚未完成浏览器下载后的 Gatekeeper 首次授权、个人账号完整登录与真实额度的真机验收。原生助手最低编译目标为 macOS 12，但实际执行系统为 macOS 15，macOS 12 尚无实机结果。

## 开发与发布

当前源码另有尚未再次打包的多窗口修复：按扩展宿主进程关联同一 VS Code 实例的窗口；账号变化不再因模型未变而跳过后端停止；访问令牌过期先尝试官方刷新，网络异常不直接要求重新登录。验证覆盖普通安装扩展后的同实例双窗口，但不代替使用者 Mac 上的官方 Codex 面板验收。

0.1.3 已于 2026-10-20 修订，替换原版本下载文件，包含切换进度、步骤耗时、逐窗口重载回报和低额度提醒。低额度提醒仅使用十分钟内成功读取、尚未重置的订阅窗口，阈值为 20%；备用账号按钮只改变选中项，仍需手动应用。窗口“扩展已重载”需使用本次修订的伴随扩展，旧扩展最多回报“已接收”；它不证明实际模型请求已切换。

本版同时修复空闲桌面与 IDE 并存时跳过桌面重启的问题，重开后等待同目录的新主进程。自动重载所需的连接状态显示在勾选框旁；已确认共用目录的 Codex 插件未接入伴随扩展时，应用前会提示先接入，也可取消“同时重载”后自行重载。伴随扩展首次安装或更新后，已有窗口可能需手动重载一次才能激活，之后的来源切换由它接收重载请求。已安装旧 0.1.3 的用户也需重新接入伴随扩展，才能使用新增的重载完成回报。编辑器检查走完整后台切换接口，使用真实 VS Code、伴随扩展和测试扩展启动的官方 Codex 后端，并覆盖同步失败后的真实后端恢复；没有把它表述为 Mac 官方 Codex 面板的实机验收。

需要 Node.js 22.22+。安装依赖后运行：

```sh
npm install --ignore-scripts
npm test
```

本次涉及的源码按 `.prettierrc.json` 统一缩进、换行，并在账号并发、程序发现、配置归属等关键流程添加中文注释。后续修改可运行 `npx prettier --write <文件>`；格式化工具不打入运行包。

需要安装官方 Codex CLI、桌面应用或官方编辑器扩展；非标准安装可设置 `CODEX_EXE`。macOS 测试原生进程助手前执行 `clang -O2 -mmacosx-version-min=12.0 mac-process-context.c -o bin/mac-process-context`（先创建 `bin/`）。

```sh
node scripts/build-release.cjs win32
# 在 macOS 上按芯片构建（不传 --arch 时仍可生成开发用通用包）
node scripts/build-release.cjs darwin --arch=arm64
node scripts/build-release.cjs darwin --arch=x64
```

打包文件由 `release-files.json` 明确列出；`private/`、本机运行时、验证目录和研究记录不会提交。发布 `v*` 标签后，CI 仅在 Windows 与两种 Mac 芯片的检查通过时创建 GitHub Release，附带各平台压缩包及 SHA-256。Mac 还会实际执行系统 Bash 安装脚本、验证安装后签名，并通过 LaunchServices 启动应用。发布前另外启动真实 VS Code 的三个隔离窗口，验证伴随扩展安装、共享目录窗口重载和独立目录隔离；该检查同时在 Windows、Mac M 系列和 Mac Intel 执行。测试编辑器不会放入发行包。

## 卸载

Windows 安装版运行 `uninstall.ps1`，按提示处理使用中的配置。macOS 先在界面关闭自启动、切回需要保留的来源并关闭服务，然后移除应用；用户数据目录单独保留，避免误删账号和历史。本工具不会卸载 Codex 或官方扩展。

MIT License。独立第三方 Demo，与 OpenAI 无隶属关系。
