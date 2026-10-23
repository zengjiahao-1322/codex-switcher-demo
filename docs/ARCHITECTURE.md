# Codex API 切换器当前架构

这份图按当前源码整理，重点说明“切换配置”和“官方账号/额度”两条路径如何汇合到本地 Codex。

后端按职责存放在 `src/accounts/`、`src/config/`、`src/clients/`、`src/diagnostics/`、`src/server/` 和 `src/platform/`。`src/paths.cjs` 统一定位项目根目录；根目录 `main.cjs` 只转交启动，保证快捷方式和默认用户数据路径不随目录整理改变。

## Windows 与 Mac 共用的功能边界

账号、额度、配置应用、旧对话同步、后台切换任务、步骤耗时和窗口重载协议共用实现；平台层只负责运行程序发现、凭证存储、进程读取与退出、应用启动。不能因为没有桌面版就停用账号或切换功能。

| 安装情况                                                          | 账号登录与额度                                     | 应用配置     | 客户端更新                                                       |
| ----------------------------------------------------------------- | -------------------------------------------------- | ------------ | ---------------------------------------------------------------- |
| 仅官方 Codex 编辑器扩展（VS Code、Insiders、Cursor、Windsurf 等） | 使用当前编辑器安装的官方 app-server                | 共用切换任务 | 只停止共用目录的插件后端，再由伴随扩展重载对应窗口；不启动桌面版 |
| 仅 Codex 桌面版                                                   | 使用桌面版自带的官方 app-server                    | 共用切换任务 | 重启目标桌面端并确认新进程                                       |
| 桌面版与编辑器同时使用                                            | 优先用户指定或伴随扩展上报的运行程序，也可自动发现 | 共用切换任务 | 分别处理共用目录的桌面与插件，独立目录不跟随                     |

`src/platform/runtime.cjs` 独立发现当前编辑器渠道安装的官方运行程序，不通过桌面应用启动才能登录。伴随扩展会从编辑器扩展清单识别 OpenAI 的 Codex/ChatGPT 扩展，不依赖单一扩展 ID；只负责窗口通信与重载，不承担账号登录或额度 RPC。是否参与切换由实际本机 Codex 后端的 PID 归属和配置目录决定，远程工作区或 WSL 设置只是窗口信息，不能否定已确认的本机后端；真正使用远端配置的后端不随本机切换。

心跳成功只代表连接到了切换器服务。`clientHeartbeat` 返回 `connection.state`（`ready`、`unmatched`、`separate`）、管理目录和关联后端 PID，伴随扩展据此显示“已接入”“后端未关联”或“独立配置”。Remote-SSH 的伴随扩展在 workspace extension host 中上报 `companionHost=remote`；同一远端切换器按远端 `CODEX_HOME` 且窗口唯一时关联后端，本机切换器不会读取 SSH 主机的 PID。重载后必须等新的 Codex 后端关联到共用配置，才确认重载完成；这仍不代表已经通过真实模型请求验证了官方登录或上游额度。

`src/clients/desktop-account.cjs` 的 `runSwitch()` 统一生成步骤及耗时，`web/app.js` 统一渲染；没有按系统拆分的旧版切换页面。`src/platform/build-info.cjs` 为运行代码生成一次构建标识，新入口只复用同构建后台，避免新包连接旧后台继续显示旧页面。页面底部显示版本和构建标识，便于核对实际运行版本。

```mermaid
flowchart LR
  UI[浏览器界面\nindex.html + app.js]
  S[本地 HTTP 服务\nmain.cjs + server.cjs]
  H[业务路由\nservice.cjs]
  CORE[配置切换核心\ncore.cjs + switch-state.cjs]
  STORE[(Codex home\nconfig.toml / auth.json)]
  PROV[(API 供应商配置\nproviders.cjs + private/)]
  ACC[官方账号管理\naccounts.cjs]
  AUTH[(账号副本\nbridgeHome/accounts/<id>/auth.json)]
  RPC[独立 Codex app-server\n每个账号一次独立进程]
  QUOTA[额度 RPC\naccount/read\naccount/rateLimits/read]
  DESK[Codex 桌面端\n官方配置消费者]
  IDE[VS Code / Cursor 等\n官方 Codex 扩展]
  EXT[伴随扩展\nvscode-companion]
  CLIENT[客户端发现与重载\nclient-status.cjs]
  THREAD[旧会话来源同步\nthread-routing.cjs]
  DIAG[会话/凭证诊断\ndiagnostics.cjs]

  UI -->|/api 请求| S --> H
  H -->|选择 API / 官方账号| CORE
  CORE -->|写入当前配置| STORE
  CORE -->|读取或保存供应商| PROV
  H -->|账号列表、登录、切换| ACC
  ACC --> AUTH
  ACC -->|登录/刷新验证| RPC
  RPC --> QUOTA
  ACC -->|当前账号应用| CORE
  H -->|切换后同步未归档会话| THREAD
  H -->|停止旧后端、发送重载| CLIENT
  CLIENT --> DESK
  CLIENT --> IDE
  EXT -->|心跳、配置归属、重载确认| CLIENT
  DESK --> STORE
  IDE --> STORE
  H --> DIAG
  DIAG --> STORE
  DIAG --> ACC
```

## 一次官方账号切换

1. 页面把账号 id 发给 `src/server/service.cjs`。
2. `src/accounts/accounts.cjs` 准备账号登录；需要续期或验证时，通过 `src/accounts/official-session.cjs` 调用独立的 Codex `app-server` 做 `account/read(refreshToken=true)`，并检查编辑器重载通道。
3. 关闭目标桌面端，并由 `src/clients/client-status.cjs` 停止共用配置的旧编辑器后端；停止前保留窗口身份，以便后端退出后仍能发送重载。
4. 重新保存退出时更新的当前登录，再由 `src/accounts/accounts.cjs` 写入所选账号凭证、`src/config/core.cjs` 恢复官方配置，最后通过 `src/diagnostics/thread-routing.cjs` 同步并核对旧会话来源。
5. 重新打开目标桌面端，并向已连接的伴随扩展发送编辑器窗口重载请求。

准备阶段并行执行账号/API 验证与编辑器归属检查，全部收尾且通过后才能关闭客户端和应用配置；任一检查失败都保留配置。Windows 使用随包构建的 C# 进程助手通过 Toolhelp32、QueryFullProcessImageNameW 和目标进程内存读取完成扫描，异步等待助手时不阻塞登录 RPC；开发源码安装会先构建该助手。关闭阶段复用该阶段新取得的进程树，按已确认进程的退出信号等待，共享两秒保存时限，强制停止后仍确认实际退出。后台切换进程在父进程完成锁交接、写入排队状态并通过 IPC 发出开始消息后执行，不再固定等待 1.5 秒。这些优化不依赖缩短账号校验或使用旧验证结果。

两端的编辑器后端和 Mac 桌面使用 `src/platform/process-stop.cjs`：发送 SIGTERM 后最多等待 1.5 秒，仍未退出的已确认进程使用 SIGKILL，再等待真实退出。权限错误直接回报，不当作已经退出。客户端归属取最近的桌面或编辑器宿主，避免由 Codex 终端启动的编辑器被误归为桌面端。

添加账号时，每次登录使用 `accounts/login/<随机标识>/` 独立目录。登录完成通知必须匹配本次 `loginId`；通知早于 start 响应时先暂存，收到响应后处理。成功状态先提交再关闭登录进程，旧通知不覆盖结果；失败时保留已写入的凭证和脱敏原因，方便恢复。

旧对话按目标供应商和模型筛选；未指定模型时先解析默认模型，再跳过已经匹配的会话。速度设置从历史末尾按 64 KiB 块读取，不解析聊天正文。超过四条的批次由两个官方后端动态分担，总在途数仍最多四条，失败后停止派发并等待在途任务结束；更新后仍重新启动后端逐条核对持久结果。Windows 进程扫描按 PID 查询父进程，关闭桌面时只查询目标进程，保留真实退出确认和独立配置隔离。10 秒是常见切换场景的优化目标，耗时仍受账号服务、历史大小和客户端退出速度影响。

## 一次额度刷新

1. 页面按账号 id 调用 `accountQuota`，不持有配置切换锁。
2. `src/accounts/accounts.cjs` 为该账号启动独立的 Codex `app-server`，读取同一账号副本。
3. 先读账号状态，再调用 `account/rateLimits/read`。
4. `src/accounts/quota-reader.cjs` 统一限制最多同时处理两个账号，网页拆开的单账号请求和批量请求共用名额；同一账号的重复请求（包括排队中）仍会合并。
5. 成功时写入该账号的 `quota.json`。
6. 失败时保留上次成功时间，但界面不再显示旧额度数字，只显示失败原因和结构化错误类型。

## 凭证状态的判断边界

- `auth.json` / macOS 钥匙串是官方登录凭证来源；不会为额度另造一份账号凭证。
- access token 的 JWT `exp` 只能说明访问令牌到期，不能单独证明整个官方 session 失效。
- 诊断遇到过期 access token 时，会调用官方账号验证；成功就显示“官方登录仍可用”，明确鉴权失败才提供重新登录操作。
- 网络失败、超时和额度服务暂时不可用不会被改写成“登录失效”。

## 代码入口

| 层       | 文件                                                                    | 责任                                                         |
| -------- | ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| 启动     | `main.cjs`、`src/server/server.cjs`                                     | 启动本地服务、页面会话和 API 路由                            |
| 业务     | `src/server/service.cjs`                                                | 把页面操作编排成切换、账号、额度、诊断任务                   |
| 配置     | `src/config/core.cjs`、`src/config/switch-state.cjs`                    | 原子写入配置、快照、切换状态和恢复                           |
| 官方账号 | `src/accounts/accounts.cjs`                                             | 登录副本、账号切换和对外账号接口                             |
| 官方会话 | `src/accounts/official-session.cjs`                                     | 独立 app-server 生命周期、JSON-RPC 和错误分类                |
| 额度读取 | `src/accounts/quota-reader.cjs`                                         | 额度 RPC、统一两个并发、账号级请求合并、额度缓存和结构化错误 |
| 客户端   | `src/clients/client-status.cjs`、`vscode-companion/`                    | 发现窗口、确认配置归属、请求重载和记录结果                   |
| 会话诊断 | `src/diagnostics/diagnostics.cjs`、`src/diagnostics/thread-routing.cjs` | 旧会话错误证据、来源同步和可见上下文导出                     |
| 页面     | `web/index.html`、`web/app.js`                                          | 来源选择、账号列表、额度和客户端状态展示                     |
