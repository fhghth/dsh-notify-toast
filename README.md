# 桌面弹窗通知 · dsh-notify-toast

DSH 插件：任务完成、需要权限审批、或 Agent 向你提问时，在**屏幕右下角**弹出一张置顶卡片。

它**不使用 Windows 通知中心**——卡片是一个真正的窗口，由一个常驻的 .NET/WinForms 进程绘制，所以 DSH 最小化或被其他窗口盖住时依然可见。

> **早期开发阶段**：插件仍在迭代，配置项与行为可能变化，也可能出现破坏性改动。按 MIT 许可「按现状」提供，不附带任何担保，使用风险自负。

## 功能

- **四类卡片**：任务完成、权限审批、Agent 提问、任务失败。
- **可选的手机推送**：把通知同步到 QQ（独立通知机器人，按会话开关，默认关闭）。
- **置顶但不抢焦点**：`WS_EX_NOACTIVATE` + `WS_EX_TOOLWINDOW`，你的前台应用不会被打断输入。
- **点击跳回会话**：点卡片会把 DSH 提到前台并切到对应对话。
- **自带 5 个音效**：随插件分发，另支持 Windows 自带音效库与自定义 `.wav`。
- **全部可配置**：尺寸、颜色、图标、音效、时延都能在插件设置页改，并可用预览按钮直接灌一张卡片确认效果。

## 系统要求

| 项 | 要求 |
|---|---|
| 操作系统 | Windows 10 / 11 |
| DSH | 桌面版，`>= 0.2.1-rc.3` |
| Shell | Windows PowerShell 5.1（`powershell.exe`） |
| 运行时 | .NET Framework 4.8（Windows 10/11 自带） |

插件仅支持 Windows：通知进程是 PowerShell + WinForms。

## 安装

### 从插件市场索引安装

在 **设置 → 插件 → 插件市场** 里添加上面的索引地址，然后到「发现」页安装 **桌面弹窗通知**。

### 手动安装

```text
plugin_manager install_bundle  target = <索引里给出的安装 spec>
```

或从源码目录：

```text
plugin_manager install_bundle  target = D:\path\to\dsh-notify-toast
```

安装后**刷新页面**，客户端半边才会加载。

## 使用

1. **设置 → 插件 → 桌面弹窗通知**：所有配置都在这里。
2. 用 **预览完成卡 / 预览审批卡 / 预览提问卡 / 预览失败卡** 检查外观，不用真的跑任务。
3. **先保存再预览**：预览读取的是已保存的配置，不是草稿。

### 什么时候弹

| 卡片 | 触发条件 |
|---|---|
| ✓ 完成 | 回合以 `completed` 结束（子代理会话不弹），按 `settleMs` 去抖 |
| 🔒 审批 | 审批服务记录 `approval/asked` |
| ? 提问 | Agent 调用 `ask_user_question` |
| ! 失败 | 回合以 `error` / `interrupted` / `blocked` 结束（默认关闭） |

### 主要配置项

| 配置 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 卡片总开关 |
| `notifyOnComplete` / `notifyOnApproval` / `notifyOnQuestion` / `notifyOnError` | `true` / `true` / `true` / `false` | 分类开关 |
| `soundEnabled` | `true` | 音效总开关 |
| `soundComplete` / `soundApproval` / `soundQuestion` / `soundError` | 自带 WAV | 支持 `sounds/*.wav`、`media:<系统音效名>`、`system:*`、`none` |
| `width` / `height` / `scale` | `400` / `104` / `1.0` | 卡片尺寸，按 DPI 缩放 |
| `durationMs` / `maxCards` / `gap` / `margin` | `8000` / `4` / `8` / `16` | 停留时长与布局 |
| `position` / `screen` | `bottom-right` / `primary` | 停靠位置与显示器 |
| `bgColor` … `accentQuestion` | 白底黑字 | 颜色（设置页提供色盘） |
| `iconStyle` | `vector` | `vector` / `glyph` / `image` |
| `settleMs` / `minIntervalMs` | `1500` / `3000` | 完成去抖与同会话限流 |
| `clickToOpenSession` | `true` | 点击跳回会话 |
| `idleExitMs` | `900000` | 通知进程空闲多久后退出 |
| `debug` | `false` | 调试日志 |

自定义音效支持**绝对路径**或**相对插件目录**的路径，所以 fork 可以自带 WAV。

## QQ 通知（可选）

除了桌面弹窗，还可以把通知推到手机 QQ。用的是**独立的通知机器人**（新 AppID），和 dsh-qqbot 的对话机器人互不影响。

### 准备机器人

1. 在 [QQ 开放平台](https://q.qq.com) 创建一个**新的机器人**，拿到 `AppID` / `AppSecret`
2. 用手机 QQ 把它加为好友（私聊消息需要好友关系）
3. 给它随便发一句话 —— 插件会记下第一个发消息的人作为默认接收者

> 不要复用 dsh-qqbot 的 AppID：同一个机器人只能有一条网关连接，而且通知会让你跟对话机器人抢消息。

### 开启

设置 → 插件 → 桌面弹窗通知 → **QQ 通知（可选）**：

| 配置 | 默认 | 含义 |
|---|---|---|
| `qqEnabled` | `false` | QQ 通知总开关 |
| `qqAppId` / `qqAppSecret` | 空 | 通知机器人的凭据 |
| `qqOpenids` | 空 | 接收者 openid，多个用逗号分隔；留空则用第一个给机器人发过消息的人 |
| `qqNotifyOnComplete` / `qqNotifyOnError` | `true` / `true` | 完成 / 失败时是否推 QQ |
| `qqMinIntervalMs` | `30000` | 同一会话推 QQ 的最小间隔 |

保存后设置页会显示连接状态（已连接 / 重连中 / 错误原因），旁边的「发送 QQ 测试消息」可以直接验证链路。

### 会话级开关

QQ 通道开启后，会话标题栏（**对话 / 轨迹**右侧）会出现一个 **QQ** 小按钮：

- **灰**：本会话不推送
- **蓝**：本会话的完成/失败通知会推到 QQ
- **橙点**：QQ 未连接

开关是**按会话**的，默认关闭 —— 避免每个会话都往手机刷消息。状态存在 `~/.dsh-notify-toast/state.json`，刷新页面或重载插件都不会丢。

### 推送到手机的内容

```
✅ 会话完成
标题：修复插件市场 README
用时：3 分 12 秒
目录：D:\DSHProject\dsh-qq
```

纯模板字段，不经过模型生成。

### 投递策略

1. 优先**主动消息**（不占用被动回复预算）
2. 主动消息失败（无权限 `40034105` / 用户关闭 `40054013` / 频控 `40034100`）时降级被动回复
3. 被动窗口（私聊 60 分钟 / 4 次）也过期则跳过，不阻塞会话

### 限制

- P1 只做**通知推送**：在 QQ 里回消息目前只会收到一条使用指引，不会进入任何会话
- 只支持单聊，不支持群聊
- 同一 AppID 只允许一个宿主进程持有连接（`~/.dsh-notify-toast/qqbot.lock` 单实例锁）

## 工作原理

```
approval/asked · tools/pre-execute(ask_user_question) · turn/end
        │  Host 插件（index.js）
        │  stdin/stdout 上的 NDJSON
        ▼
notifier 进程（PowerShell + WinForms，单实例）
        │  点击 → SetForegroundWindow + stdout 事件
        ▼
Host → SSE /dsh-notify/events → 客户端半边 → ctx.uiWorkspace.openSession()
```

Host 按需拉起**唯一**一个通知进程，展示期间保持常驻，空闲 `idleExitMs` 后退出；新实例启动时会结束旧实例，因此插件重载不会留下孤儿进程。

## 隐私

- 全部本地运行，插件不发起任何网络请求。
- 只读取**对话标题**和会话 id，不读取消息内容。
- 三个本地路由（`/dsh-notify/events`、`/dsh-notify/config`、`/dsh-notify/preview*`）只监听 DSH 的回环地址。

## 已知限制

- **虚拟桌面**：卡片创建在当前桌面，切换桌面后不会再跟过去。
- **独占全屏、UAC 安全桌面、锁屏**：任何窗口都盖不住。
- **审批卡片与 DSH 自己的审批框同在右下角**，会挡住按钮，需要先关掉卡片。
- **全机单实例**：同一时间只有一个通知进程，新实例启动时会结束旧的（只认 `notifier.ps1` 的完整命令行，不会误伤其它 shell）。
- **`link:` 安装的残留**：在 hoisted 模式下卸载 `link:` 装的插件，`node_modules` 里可能留下一个指向源码目录的 junction；不影响使用，切换安装方式前建议用 `Get-Item <profile>\node_modules\@local\dsh-notify-toast -Force` 确认一下。
- 进程退出后的第一张卡片有约 **1.5 秒**冷启动（PowerShell + C# 编译）。
- **升级 = 卸载后重装**，市场没有原地升级。

## 卸载

在 **设置 → 插件** 里禁用或移除该 bundle，通知进程会随插件一起退出。

## English summary

A DSH plugin that shows topmost desktop cards (bottom-right) for task completion, approval requests and agent questions on Windows. It draws its own WinForms window instead of using the Windows notification center, never steals keyboard focus, and offers click-to-open-conversation, bundled sounds and a full settings page. Requires Windows 10/11 and DSH `>= 0.2.1-rc.3`. MIT licensed.

Early development: options and behaviour may change, including breaking changes. Provided "as is", without warranty of any kind.

## License

MIT。自带的 `sounds/*.wav` 随本仓库分发；如该授权不适合你的再分发场景，请替换为自己的音频。
