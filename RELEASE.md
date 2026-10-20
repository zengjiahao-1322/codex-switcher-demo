# Codex Switcher 0.1.3 Demo

修复切换后旧对话仍使用原供应商，以及直接访问本机网址卡在加载中的问题；移除独立 Fast 功能，精简操作界面。Windows、Mac M 系列和 Mac Intel 同步构建发布。

## 本版更新

- **旧对话跟随切换**：统一应用时，通过 Codex 原生接口同步未归档用户对话的供应商与模型，核对保存结果后再重开客户端；保留消息、工具记录、项目目录和各对话原有速度。
- **本机网址直接打开**：支持直接访问、书签、新标签页和刷新；切换器后台重启后，已有页面自动恢复访问。读取失败时显示错误，避免一直停在加载中。
- **界面精简**：删除独立 Fast 检测、提示和默认速度展示，仅保留普通 API 检测；不新增标准／Fast 模型别名。已有 Codex 速度设置和协议转换中的服务档位传递保留。

## 下载与启动

| 系统 | 下载文件 | 启动方式 |
| --- | --- | --- |
| Windows x64 | `codex-switcher-windows-x64.zip` | 完整解压，双击 `Codex Switcher/Start.cmd`；需要安装时运行 `install.cmd` |
| Mac M 系列 | `codex-switcher-macos-arm64.zip` | 解压，运行 `Install.command`，或打开其中的 `Codex Switcher.app` |
| Mac Intel | `codex-switcher-macos-x64.zip` | 启动方式同上 |

请先安装 Codex 桌面版或 OpenAI 官方 Codex 编辑器扩展。每个包内置对应系统的 Node.js 和依赖，无需另装 Node、npm 或 Python；包内不含个人账号、密钥、聊天或验证数据。随包提供 SHA-256 校验文件。

伴随扩展单独提供 `codex-switcher-companion.vsix`，Windows / Mac 通用。在编辑器里选择“从 VSIX 安装”，或通过切换器重新接入。更新后确认各窗口状态栏显示“Codex Switcher · 已连接”。

启动后可直接访问 `http://127.0.0.1:47831/` 或 `http://localhost:47831/`。首次使用需要添加自己的账号或 API 配置。

## 更新现有安装

先退出旧版切换器，再使用新包启动或安装。保留已有数据目录；使用自定义 `BRIDGE_HOME` / `CODEX_HOME` 的用户应继续沿用原目录。仅替换切换器程序不需要切换账号或重启 Codex；点击“应用”切换来源时，目标客户端才会重启或重载。

## 验证范围与已知限制

发布流水线在 Windows、macOS 15 Apple Silicon 和 Intel 运行回归、真实浏览器入口与额度刷新检查、安装包解压启动，以及真实 VS Code 多窗口重载检查；六项任务通过后才会发布。测试使用隔离配置和合成数据，不上传个人凭据。

macOS 另验证系统 Bash 安装脚本、首次与重复安装、数据保留、签名完整性和 LaunchServices 启动。应用使用 ad-hoc 签名，尚无 Apple Developer ID 签名或公证；浏览器下载后的首次打开仍可能需要在“系统设置 → 隐私与安全性”中手动允许。个人账号完整网页登录、真实额度和日常桌面操作仍需真实 Mac 用户验收；macOS 12 尚无实机结果。

共用配置的已连接编辑器窗口会一起重载，独立目录、WSL、SSH 和容器环境不自动跟随。重启或重载可能中断正在运行的任务，请等任务完成并保存工作后再切换；已保存的聊天文件会保留，运行中的任务和未保存状态不能保证自动恢复。Cursor、Windsurf、Insiders 尚未逐款完成与 VS Code 相同的 GUI 验收。

本次标签和应用版本为 `0.1.3`，历史版本保留。
