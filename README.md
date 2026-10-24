# Codex Switcher

管理 Codex 官方账号、自定义 API 和 VS Code 窗口的本机工具，支持 Windows 与 macOS。

**0.1.4 Demo · 官方账号与 API 的 Remote-SSH 切换**。本机和服务器分别应用来源，同一官方账号的文件登录按刷新时间同步；修复 Windows 更新检查，补充远端代理更新识别与诊断。远程功能尚待真实服务器验收。

[发布说明与全部下载](https://github.com/zengjiahao-1322/codex-switcher-demo/releases/tag/v0.1.4)

## 下载和安装

需要 Codex 桌面版或 OpenAI 官方 Codex 编辑器扩展，任选一种。桌面包自带 Node.js 和依赖，无需另装开发环境。

| 平台              | 下载                                                                                                                            | 启动                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Windows x64       | [Windows 包](https://github.com/zengjiahao-1322/codex-switcher-demo/releases/download/v0.1.4/codex-switcher-windows-x64.zip)    | 完整解压，双击 `Start.cmd`；可运行 `install.cmd`    |
| Mac Apple Silicon | [Mac M 系列包](https://github.com/zengjiahao-1322/codex-switcher-demo/releases/download/v0.1.4/codex-switcher-macos-arm64.zip)  | 运行 `Install.command`，或打开 `Codex Switcher.app` |
| Mac Intel         | [Mac Intel 包](https://github.com/zengjiahao-1322/codex-switcher-demo/releases/download/v0.1.4/codex-switcher-macos-x64.zip)    | 同上                                                |
| 本机伴随扩展      | [Companion VSIX](https://github.com/zengjiahao-1322/codex-switcher-demo/releases/download/v0.1.4/codex-switcher-companion.vsix) | 在本机编辑器安装并重载已有窗口                      |
| 远端代理          | [Remote Agent VSIX](https://github.com/zengjiahao-1322/codex-switcher-demo/releases/download/v0.1.4/codex-switcher-remote.vsix) | 通过远程页安装，或在 SSH 服务器侧安装               |

五个下载均附 SHA-256 校验文件。不要只取出启动脚本；运行时需保留完整目录。Mac 使用 ad-hoc 签名，首次打开可能需在“系统设置 → 隐私与安全性”允许，尚无 Apple Developer ID 签名或公证。

## 本机使用

1. 通过官方授权页添加账号，或填写 API 地址、密钥和模型。添加来源后选择并应用。
2. 如需切换已打开的编辑器窗口，安装本版伴随扩展并重载。关联由实际后端 PID 与配置目录确认；状态栏“已接入”表示可以自动重载，“后端未关联”表示还未确认对应后端。
3. 切换时重启或重载共用当前配置目录的客户端，独立目录保持原样。旧对话默认跟随新来源，保留目标支持的原模型；部分失败可继续同步。
4. 额度按账号独立刷新，也可全部刷新。套餐与可用的订阅日期来自最新保存的登录信息；失败不显示旧额度数字。

请使用 `Start.cmd`、快捷方式或 Mac 应用打开的地址。默认端口为 47831；端口被占用时使用启动器实际打开的地址。关闭标签页不会停止服务。后台重启后需重新从启动器建立会话。

## 远程服务器

“远程服务器”分页提供接入步骤。在本机安装伴随扩展，在服务器侧安装远端代理，然后选择已保存的官方账号或可直连且有密钥的 API，确认后单独应用。本机与远程互不跟随；服务器可以使用不同来源。

按服务器与 Codex 配置目录分组，同目录只写一次，并请求相关窗口重载。API 配置写入 `config.toml`，官方登录写入 `auth.json`；经 VS Code SSH 通道传输，权限为 `0600`，首次分别保留 `.switcher-backup`；读取后文件被改动则拒绝覆盖。

同一官方账号以 `last_refresh` 最新的文件登录为准，同步到已使用该账号的本机和在线服务器；同步登录不重载窗口。仅支持文件凭证存储，服务器显式使用 `keyring` 或 `ephemeral` 时会拒绝应用。不同步经本机转换的 API 或远端聊天，不配置服务器网络。WSL、容器及 SSH 到一台本身运行切换器的机器的方式暂不支持。

伴随扩展固定在本机 UI 宿主，代理在远端 workspace 宿主；版本必须一致，远端代理还需支持协议号 2。页面会提示更新同为 `0.1.4` 的旧代理。同窗口其他扩展也能调用代理命令，遵循 VS Code 扩展信任边界。

**远程功能尚待真实 Remote-SSH Linux 验收。** 自动化读写与安装检查不能代替服务器上的实际 API 请求和聊天恢复验证。

## 升级与数据

**0.1.3 的更新地址固定在旧版本，需手动下载并安装 0.1.4 一次。** 0.1.4 起检查本仓库最新 Release；只接受更大的发行序号，同时校验 SHA-256、包内构建号与序号。保留旧版备份，启动检查失败恢复；开发目录通过 Git 更新。

已安装早先 `0.1.4` 可通过“检查更新”获取本次替换构建。若 Windows 提示证书吊销检查无法完成、无法检查更新，请手动下载安装本次构建一次；本版已修正此问题，保留 TLS 校验。升级后在“编辑器与诊断”点击“一键更新扩展”，再到“远程服务器”页按提示更新远端代理。

更新时保留原数据目录，并同时更新伴随扩展及远端代理。Windows 解压版请保留 `private/`，安装版运行新安装器；Mac 使用 `Install.command`。自定义数据目录继续沿用原路径。

| 内容               | 默认位置                                          |
| ------------------ | ------------------------------------------------- |
| Codex 配置与登录   | `~/.codex`，尊重 `CODEX_HOME`，界面可选目录       |
| Windows 解压版数据 | 工具目录的 `private/`                             |
| Windows 安装版数据 | `%LOCALAPPDATA%/CodexApiSwitcher/private/`        |
| Mac 数据           | `~/Library/Application Support/CodexApiSwitcher/` |

`BRIDGE_HOME` 指定工具数据目录，`BRIDGE_CODEX_HOME` 强制指定 Codex 目录，`CODEX_EXE` 指定官方运行时。发布包不包含个人账号、密钥或聊天。诊断日志仅本机保存，导出时脱敏，不自动上传。

## 验证与开发

发布流水线在 Windows、macOS 15 Apple Silicon 和 Intel 验证回归、浏览器、包解压启动、两份 VSIX 安装及真实 VS Code 多窗口；六项通过后上传下载。Mac 另检查安装脚本、签名与 LaunchServices。自动化使用隔离配置，不能替代具体设备的登录、额度和 Remote-SSH 实测。Cursor、Windsurf、Insiders 仍需人工验证。

重载可能中断任务，请先保存工作。已保存聊天文件保留，运行中任务和未保存状态不能保证恢复。“进程已启动”“已请求重载”均不表示实际模型请求已验证。切换耗时受账号网络、历史规模和客户端退出速度影响。

源码按 `src/`、`web/`、`platform/`、`tests/`、`scripts/` 和两个 VS Code 扩展目录组织，见 [架构说明](docs/ARCHITECTURE.md)。安装 Node.js 22+ 后运行 `npm install --ignore-scripts`、`npm test`；Windows 测试会构建 C# 进程助手。
