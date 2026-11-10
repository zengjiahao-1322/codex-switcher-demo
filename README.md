# Codex Switcher

管理 Codex 和 Claude Code 所用账号与 API 的本机工具，支持 Windows 与 macOS。

**0.1.7 测试版**：
- Codex 可以在官方账号和自定义 API 之间一键切换，覆盖桌面版、编辑器扩展和 SSH 服务器；
- Claude Code 可以切到 Anthropic 协议的 API 直连，或经本机转换使用 OpenAI 协议的 API；
- 用量页按来源统计 token 和费用，带逐条请求记录。

配置改写前自动保留最近 10 份副本，可以在设置中恢复。远程功能仍需在具体服务器环境验证。

[发布说明与全部下载](https://github.com/zengjiahao-1322/codex-switcher-demo/releases/latest)

## 下载和安装

需要 Codex 桌面版或 OpenAI 官方 Codex 编辑器扩展，任选一种。发布包是原生程序，无需安装 Node.js 或开发环境。

| 平台              | 下载                                                                                                                            | 启动                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Windows x64       | [Windows 包](https://github.com/zengjiahao-1322/codex-switcher-demo/releases/latest/download/codex-switcher-windows-x64.zip)    | 推荐运行 `install.cmd`；也可完整解压后双击 `Start.cmd`，首次启动会静默创建桌面图标 |
| Mac Apple Silicon | [Mac M 系列包](https://github.com/zengjiahao-1322/codex-switcher-demo/releases/latest/download/codex-switcher-macos-arm64.zip)  | 运行 `Install.command`，或打开 `Codex Switcher.app`                                |
| Mac Intel         | [Mac Intel 包](https://github.com/zengjiahao-1322/codex-switcher-demo/releases/latest/download/codex-switcher-macos-x64.zip)    | 同上                                                                               |
| 本机伴随扩展      | [Companion VSIX](https://github.com/zengjiahao-1322/codex-switcher-demo/releases/latest/download/codex-switcher-companion.vsix) | 在本机编辑器安装并重载已有窗口                                                     |
| 远端代理          | [Remote Agent VSIX](https://github.com/zengjiahao-1322/codex-switcher-demo/releases/latest/download/codex-switcher-remote.vsix) | 通过远程页安装，或在 SSH 服务器侧安装                                              |

五个下载都附 SHA-256 校验文件。不要只取出启动脚本，运行时需要保留完整目录。

Mac 使用 ad-hoc 签名，首次打开可能需要在“系统设置 → 隐私与安全性”里允许；目前还没有 Apple Developer ID 签名或公证。

## Codex

1. 通过官方授权页添加账号，或填写 API 地址、密钥和模型。添加来源后选择并应用。
2. 如需切换已打开的编辑器窗口，安装本版伴随扩展并重载。关联由实际后端 PID 与配置目录确认：状态栏“已接入”表示可以自动重载，“后端未关联”表示还没确认对应的后端。
3. 切换时重启或重载共用当前配置目录的客户端，独立目录保持原样。
4. 旧对话的处理：
   - Codex 0.166 起，每个对话绑定在创建它的来源上。切到别的来源时，这些对话留在原来源，切回去就能继续；
   - 同一来源下换 API 或模型时，旧对话会改用目标可用的模型。
5. 额度按账号独立刷新，也可以全部刷新。套餐和订阅日期来自最新保存的登录信息；刷新失败时不显示旧额度数字。

点 VS Code 状态栏的“Codex Switcher”就能选择来源，确认后切换：本机窗口切换本机，SSH 窗口切换该服务器。额度不足时，提示里可以直接选备用账号确认切换，始终由用户手动发起。

在“设置 → 配置备份”里可以恢复最近 10 份配置副本：
- 副本不包含 `auth.json` 登录文件，恢复配置不会回滚账号登录；
- 恢复前会先保存当前配置，再按正常切换流程重载共用窗口。

请使用 `Start.cmd`、快捷方式或 Mac 应用打开的地址。默认端口为 47831；端口被占用时，以启动器实际打开的地址为准。关闭标签页不会停止服务；后台重启后，需要从启动器重新建立会话。

## Claude Code

页面顶部可以在 Codex 和 Claude Code 之间切换，两边分别显示正在使用的来源。

- **Anthropic 协议的 API**：直连，切换器只改写 Claude Code 的 `settings.json`。
- **OpenAI 协议的 API**：经本机 127.0.0.1 转换，需要切换器保持运行；回复逐段流式返回。
- **快速模型**：可以单独设置，供后台小任务和 Haiku 别名使用。
- **检测连接**：按 Claude Code 实际的请求路径发一条最短的请求，区分连不上和上游报错。
- **恢复接管前的配置**：原样恢复接管前的设置，官方登录凭据始终不改动。

## 用量统计

“用量”分页按来源统计 Codex 和 Claude Code 的 token 与估算费用，来源细分到每个官方账号、每个 API。

- **数据来源**：只读本机 Codex 与 Claude Code 的会话记录，只取用量、时间、模型、设置和错误类型这些字段，不读对话内容。打开分页时才增量扫描，不常驻后台。
- **请求记录**：每次请求一行，包括时间、来源、模型、思考强度、各类 token、费用、成功或失败、估算耗时和项目目录。
- **价格**：自动同步 OpenRouter 上 OpenAI、Anthropic、Google 等官方厂商的价格，超过 24 小时打开页面时更新。每个 API 可以在“API 配置”里设为按官方价、按倍率（可选人民币）或不计费。官方账号显示为订阅折算，不是实际扣费。
- **做不到的**：首字延迟、TPS，以及网关内部用的是哪个号。这些可以在 API 设置里填网关自己的用量面板地址，在用量页点链接跳过去看。

## 远程服务器

“远程服务器”分页提供接入步骤：在本机安装伴随扩展，在服务器侧安装远端代理，然后选择已保存的官方账号，或可直连且有密钥的 API，确认后单独应用。本机与远程互不跟随，服务器可以用不同的来源。

- **写入方式**：按服务器与 Codex 配置目录分组，同目录只写一次，并请求相关窗口重载。API 配置写入 `config.toml`，官方登录写入 `auth.json`；经 VS Code SSH 通道传输，权限为 `0600`，首次写入时分别保留 `.switcher-backup`。读取后文件被改动过，就拒绝覆盖。
- **登录同步**：同一官方账号以 `last_refresh` 最新的那份登录为准，同步到已使用该账号的本机和在线服务器；同步登录不重载窗口。
- **限制**：只支持文件凭证存储，服务器显式使用 `keyring` 或 `ephemeral` 时拒绝应用。不同步经本机转换的 API 或远端聊天，也不配置服务器网络。WSL、容器，以及 SSH 到一台本身运行切换器的机器，暂不支持。

伴随扩展固定在本机 UI 宿主，代理在远端 workspace 宿主，两者需要配套更新到同一版本。

**远程功能尚待真实 Remote-SSH Linux 服务器验收。**

## 升级与数据

可以在页面上点“检查更新”升级：只接受更大的发行序号，同时校验 SHA-256、包内构建号与序号；保留旧版备份，启动检查失败时自动恢复。如果检查更新因为网络或证书错误失败，可以手动下载安装。升级后在“编辑器与诊断”点“一键更新扩展”，再到“远程服务器”页更新远端代理。

**0.1.3、0.1.4、0.1.5 是早期的 Node 版，已从发布页下架，不能一键升级。** 请下载最新版，用 `install.cmd` 安装，或在 Mac 上运行 `Install.command`。安装时会停掉旧版后台，账号和 API 配置会自动导入。

| 内容             | 默认位置                                          |
| ---------------- | ------------------------------------------------- |
| Codex 配置与登录 | `~/.codex`，尊重 `CODEX_HOME`，界面可选目录       |
| Claude Code 设置 | `~/.claude/settings.json`，尊重 `CLAUDE_CONFIG_DIR` |
| Windows 数据     | `%LOCALAPPDATA%/CodexSwitcher/`                   |
| Mac 数据         | `~/Library/Application Support/CodexApiSwitcher/` |
| 用量索引和价格簿 | 数据目录下的 `usage/`                             |

- `BRIDGE_HOME` 指定工具数据目录，`BRIDGE_CODEX_HOME` 强制指定 Codex 目录，`CODEX_EXE` 指定官方运行时。
- 发布包不包含个人账号、密钥或聊天。诊断日志只保存在本机，导出时脱敏，不自动上传。

## 验证与开发

- **发布流水线**：在 Windows、macOS 15 Apple Silicon 和 Intel 上验证回归、浏览器、包解压启动、两份 VSIX 安装和真实 VS Code 多窗口，全部通过后才上传下载。
- **局限**：自动化使用隔离配置，不能替代具体设备上的登录、额度和 Remote-SSH 实测；Cursor、Windsurf、Insiders 仍需人工验证。
- **重载风险**：重载可能中断任务，请先保存工作。已保存的聊天文件会保留，但运行中的任务和未保存的状态不能保证恢复。“进程已启动”“已请求重载”都不代表实际模型请求已验证。

产品代码在 `rust/`、`web/`、`data/`、`platform/` 和两个 VS Code 扩展目录，见[架构说明](docs/ARCHITECTURE.md)。

开发需要 Rust stable 和 Node.js 22+：先运行 `cargo build --locked --release --manifest-path rust/Cargo.toml`，再运行 `npm test`。Node.js 只用于测试和打包脚本，发布包不包含它。
