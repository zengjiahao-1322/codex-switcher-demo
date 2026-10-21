# Codex Switcher

管理 Codex 官方账号和自定义 API 的本机工具，支持 Windows 与 macOS。

**0.1.3 Demo · 2026-10-21 替换构建**。版本号不变，旧压缩包不会自动更新，请重新下载。

[查看发布说明与全部下载](https://github.com/zengjiahao-1322/codex-switcher-demo/releases/tag/v0.1.3)

## 下载和安装

需要先安装 Codex 桌面版或 OpenAI 官方 Codex 编辑器扩展，任选一种。安装包自带 Node.js 和运行依赖，无需另外安装开发环境。

| 平台 | 下载 | 启动 |
| --- | --- | --- |
| Windows x64 | [Windows 安装包](https://github.com/zengjiahao-1322/codex-switcher-demo/releases/download/v0.1.3/codex-switcher-windows-x64.zip) | 完整解压，双击文件夹中的 `Start.cmd`；可运行 `install.cmd` 创建快捷方式 |
| Mac Apple Silicon（M 系列） | [Mac M 系列安装包](https://github.com/zengjiahao-1322/codex-switcher-demo/releases/download/v0.1.3/codex-switcher-macos-arm64.zip) | 解压并运行 `Install.command`，或打开 `Codex Switcher.app` |
| Mac Intel | [Mac Intel 安装包](https://github.com/zengjiahao-1322/codex-switcher-demo/releases/download/v0.1.3/codex-switcher-macos-x64.zip) | 同上 |
| 编辑器伴随扩展 | [通用 VSIX](https://github.com/zengjiahao-1322/codex-switcher-demo/releases/download/v0.1.3/codex-switcher-companion.vsix) | 在编辑器扩展菜单选择“从 VSIX 安装”，或通过切换器接入 |

不要只取出启动脚本，运行时需要保留完整目录。Windows 安装版默认安装到当前用户目录，无需管理员权限。

Mac 应用使用 ad-hoc 签名，尚未使用 Apple Developer ID 签名或公证。首次打开可能需要在“系统设置 → 隐私与安全性”中手动允许。应用没有 Dock 图标，启动后打开本机网页界面。

服务启动后，使用它打开的浏览器地址；默认地址为 `http://127.0.0.1:47831/`。如果端口被占用，请使用启动时实际打开的地址。关闭浏览器标签页不会停止后台服务。

## 基本使用

1. **添加来源**：通过官方授权页添加账号，或填写自定义 API 的地址、密钥和模型。添加账号不会立即启用它，也不需要把邮箱密码交给本工具。
2. **接入编辑器**：如需切换已打开的 VS Code 窗口，先在“影响范围与其他客户端”接入伴随扩展。各窗口状态栏应显示“Codex Switcher · 已连接”。
3. **应用来源**：选择账号或 API，点击“应用”。工具先完成检查，再更新配置、同步需要更新的旧对话设置，并重新打开目标桌面端或请求编辑器重载。
4. **查看结果**：切换区显示每一步耗时和逐窗口重载状态。额度可按账号单独刷新，批量刷新也分别显示结果。

切换或重载会中断目标客户端正在执行的任务，请先保存工作并等任务结束。已保存的消息和工具记录保留；运行中的任务及未落盘状态不能保证恢复。

## 功能和边界

- **官方多账号**：保存官方登录副本、切换账号、查看 Codex 服务端额度。额度查询失败时显示原因与上次成功时间，不把缓存数字当作当前额度。
- **自定义 API**：支持 Responses 检测，以及受限的 Chat Completions／Anthropic Messages 本机转换。检测和实际使用可能产生上游费用；转换模式需要后台持续运行，不保证支持全部 Codex 特性，例如内置网页搜索。
- **多窗口切换**：重载已经连接、可确认共用当前配置目录的编辑器窗口；独立目录不跟随。SSH、WSL、容器等远程环境不自动切换。
- **旧对话跟随**：通过官方接口更新未归档用户对话的供应商与模型，保留各对话速度设置并核对持久结果。不会迁移 ChatGPT 网页的云端聊天。
- **诊断与导出**：查看本机会话的来源差异和关联错误，导出可见上下文供新会话继续。

“桌面进程已启动”和“扩展已重载”分别表示进程、扩展已恢复，不等于已经通过一次真实模型请求确认额度来源。切换速度受账号服务、客户端退出和历史规模影响，不承诺每次都低于 10 秒。

切换器不提供独立 Fast 开关，也不生成额外的标准／Fast 模型；已有的 Codex 速度设置会保留。

## 更新现有安装

本次替换了同名 `v0.1.3` 下载文件，请以 Release 中的 **2026-10-21** 构建说明区分旧包。

- **Windows 安装版**：完整解压新包后运行 `install.cmd`，安装器会停止所管理的旧后台并保留安装目录下的 `private/`。
- **Windows 解压版**：保留原目录下的 `private/`，停止旧切换器后台后更新程序文件。直接在另一个空目录启动会使用那里的新数据目录。
- **Mac**：运行新包的 `Install.command`，默认安装到 `~/Applications/`；账号数据单独保存在 Application Support 中。
- **编辑器**：旧 0.1.3 用户也应通过切换器重新接入伴随扩展，或安装本次 VSIX。已有窗口可能需先手动执行一次“重载窗口”激活新代码。

使用自定义 `BRIDGE_HOME`／`CODEX_HOME` 的用户应继续沿用原目录。只更新切换器程序不需要切换账号；点击“应用”才会触发目标客户端的重启或重载。

## 配置与数据位置

| 内容 | 默认位置 |
| --- | --- |
| Codex 配置与登录 | `~/.codex`，尊重 `CODEX_HOME`；可在界面指定管理目录 |
| Windows 解压版账号数据 | 工具目录的 `private/` |
| Windows 安装版账号数据 | `%LOCALAPPDATA%/CodexApiSwitcher/private/` |
| Mac 账号数据 | `~/Library/Application Support/CodexApiSwitcher/` |

`BRIDGE_HOME` 可指定工具数据目录，`BRIDGE_CODEX_HOME` 可强制指定管理的 Codex 目录，`CODEX_EXE` 可指定官方运行时。首次修改前保留配置快照，不修改 Codex 程序文件。发布包不包含个人账号、API 密钥、聊天记录或测试数据。

## 兼容性与验证

发布流水线在 **Windows、macOS 15 Apple Silicon 和 macOS 15 Intel** 上运行回归、浏览器、安装包和真实 VS Code 多窗口检查；三平台的六项检查全部通过才上传下载文件。查看[本次发布验证](https://github.com/zengjiahao-1322/codex-switcher-demo/actions/runs/39583255448)。

Mac 还检查系统 Bash 安装脚本、首次与重复安装、数据保留、签名完整性和 LaunchServices 启动。编译目标为 macOS 12+，实际 CI 运行系统为 macOS 15；macOS 12 没有实机结果。CI 使用隔离配置和合成数据，不代替使用者 Mac 上的首次 Gatekeeper 授权、个人账号登录与真实额度验收。

VS Code 已进行多窗口验证。Cursor、Windsurf、Insiders 提供接入路径，尚未逐款完成同样的 GUI 验收。本项目为基础 Demo，仅监听本机地址，未进行正式安全审计。

## 开发与文档

推荐使用与发行包一致的 **Node.js 22.22.0**：

```sh
npm install --ignore-scripts
node scripts/test-all.cjs
node main.cjs
```

后端在 `src/`，页面在 `web/`，正式测试在 `tests/`，系统脚本在 `platform/`，伴随扩展在 `vscode-companion/`。根目录的启动与安装入口保留兼容。

- [架构与切换流程](docs/ARCHITECTURE.md)
- [发布说明](docs/RELEASE.md)
- [更新记录](CHANGELOG.md)

## 卸载

Windows 安装版运行 `uninstall.ps1`。Mac 先关闭自启动和切换器后台，再移除应用；用户数据目录单独保留。本工具不会卸载 Codex 或官方扩展。

MIT License。独立第三方工具，与 OpenAI 无隶属关系。