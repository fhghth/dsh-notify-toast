# 桌面弹窗通知 · dsh-notify-toast

[![version](https://img.shields.io/github/package-json/v/fhghth/dsh-notify-toast)](https://github.com/fhghth/dsh-notify-toast/blob/master/package.json)
[![stars](https://img.shields.io/github/stars/fhghth/dsh-notify-toast)](https://github.com/fhghth/dsh-notify-toast/stargazers)
[![platform](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-0078D6)](#系统要求)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

DSH 插件（仅 Windows 10/11）：任务完成、需要权限审批、或 Agent 向你提问时，在屏幕右下角弹出一张置顶卡片，点一下就能跳回那个会话。

它**不走 Windows 通知中心**——卡片是一个真正的 WinForms 窗口（PowerShell + C# 编译，全机单实例常驻），所以 DSH 被别的窗口盖住时依然看得见；同时带 `WS_EX_NOACTIVATE`，不会抢走你正在输入的焦点。

> **早期开发阶段**：配置项与行为仍可能变化，也可能有破坏性改动。按 MIT 许可「按现状」提供，不附带任何担保。

## 特性

- **四类卡片**：✅ 完成 · 🔒 审批 · ❓ 提问 · ❗ 失败
- **置顶但不抢焦点**，点击跳回对应会话
- **自带 5 个音效**，也支持 Windows 系统音效和自定义 `.wav`
- **可选的手机推送**：把通知同步到 QQ，并直接在 QQ 上回答审批 / 提问
- **全部可配置**：尺寸、颜色、图标、音效、时延都在设置页里，四个预览按钮随时看效果

## 系统要求

| 项 | 要求 |
|---|---|
| 操作系统 | Windows 10 / 11 |
| DSH | 桌面版，`>= 0.2.1-rc.3` |
| Shell | Windows PowerShell 5.1（`powershell.exe`） |
| 运行时 | .NET Framework 4.8（Windows 10/11 自带） |

## 安装

### 方式一：从插件市场安装（推荐）

1. 打开 **插件** 页，切到 **发现**（Discover）标签
2. 点 **添加索引源**，填入：

   ```text
   https://raw.githubusercontent.com/fhghth/dsh-notify-toast/master/index.json
   ```

3. 在列表里找到 **桌面弹窗通知**，点 **安装** 并确认
4. 装完**刷新页面**（`F5`），客户端那一半才会加载

索引里给出的安装目标钉在完整 commit 上，所以市场以后能识别「有更新」。

### 方式二：直接按 git commit 安装

不想加索引，就让 Agent 装这个地址：

```text
plugin_manager install_bundle
target = git+https://github.com/fhghth/dsh-notify-toast.git#<完整 40 位 commit>
```

- commit 用 `git ls-remote https://github.com/fhghth/dsh-notify-toast master` 取，或在 [commits 页面](https://github.com/fhghth/dsh-notify-toast/commits/master) 复制。
- **一定要写完整 40 位**。写分支、tag、短 sha 也能装上，但市场认不出更新，以后只能卸载重装。
- 这里填的是 **git 地址**，不是仓库首页或 raw 文件地址：安装时 npm 会按 `package.json` 的 `files` 重新打包，只有打包清单里的文件才会进 profile。

### 方式三：从源码目录安装（改代码时用）

```text
plugin_manager install_bundle
target = D:\path\to\dsh-notify-toast
```

目录安装是 `link:` 链接，不经过打包，改完重启 DSH 就生效（客户端半边改完要刷新页面）。

### 装完确认

- **插件** 页出现「桌面弹窗通知」，状态是运行中
- 能打开它的设置页，点「预览完成卡」会弹出一张卡片
- 如果启用失败、日志里是 `ERR_MODULE_NOT_FOUND`：装到的是 1.2.0 或更早的坏包（`files` 里漏了 `qq-reply.js`、`qq-changes.js`），重装 1.2.1 以上即可

## 使用

打开「桌面弹窗通知」的设置页，所有开关都在这里。**先保存再预览**：预览读的是已保存的配置，不是草稿。

| 卡片 | 什么时候弹 |
|---|---|
| ✅ 完成 | 回合正常结束（子会话不弹），按 `settleMs` 去抖 |
| 🔒 审批 | 权限审批请求 |
| ❓ 提问 | Agent 调用 `ask_user_question` |
| ❗ 失败 | 回合以 `error` / `interrupted` / `blocked` 结束（默认关闭） |

### 主要配置

| 配置 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 弹窗总开关 |
| `notifyOnComplete` / `notifyOnApproval` / `notifyOnQuestion` / `notifyOnError` | `true` / `true` / `true` / `false` | 四类卡片分别开关 |
| `soundEnabled` | `true` | 音效总开关 |
| `soundComplete` … `soundError` | 自带 WAV | 支持 `sounds/*.wav`、`media:<系统音效名>`、`system:*`、`none` |
| `customSound*` | 空 | 自定义 `.wav`，绝对路径或相对插件目录，填了优先 |
| `width` / `height` / `scale` | `400` / `104` / `1.0` | 卡片尺寸，按 DPI 缩放 |
| `durationMs` / `maxCards` / `gap` / `margin` | `8000` / `4` / `8` / `16` | 停留时长、同屏上限、间距、边距 |
| `position` / `screen` | `bottom-right` / `primary` | 出现在哪个角、哪块屏 |
| `clickToOpenSession` | `true` | 点击跳回会话 |
| `settleMs` / `minIntervalMs` | `1500` / `3000` | 完成去抖、同会话限流 |
| `debug` | `false` | 调试日志 |

颜色、图标、字体在设置页里直接改，都带色盘和输入框。

## QQ 通知（可选）

桌面卡片之外，还可以把通知推到手机 QQ——用的是**独立的通知机器人**（新建 AppID，别复用 dsh-qqbot 的：同一个机器人只能有一条网关连接）。

1. 在 [QQ 开放平台](https://q.qq.com) 新建机器人，拿 `AppID` / `AppSecret`，用手机 QQ 加它好友并随便发一句话
2. 设置页填 `qqAppId` / `qqAppSecret`，打开 `qqEnabled`；`qqOpenids` 留空就用第一个给它发消息的人
3. 打开 `qqAnswerApprovals` / `qqAnswerQuestions` 后，审批和提问会**改发到 QQ**（桌面不再弹审批框，避免两边抢同一个决定）：回 `ok` / `no` / 选项编号即可，也可以直接引用卡片回复
4. 给会话发消息：`/ls` 列会话、`/s 3` 看状态卡、`#3 继续跑测试` 投递内容、`/status` 看通道状态

会话标题栏右侧有一个 **QQ** 按钮，按会话开关推送（灰 = 不推，蓝 = 推，橙点 = 未连接）；开启后还会在 QQ 里生成一块「会话看板」面板。细节和限制见 [qqbot-lite/README.md](qqbot-lite/README.md)。

## 工作原理

Host 插件（`index.js`）收到 `approval/asked`、`ask_user_question`、`turn/end` 等事件后，通过 stdin/stdout 上的 NDJSON 把内容交给唯一一个常驻通知进程（PowerShell + WinForms）绘制；卡片被点击时回传事件，Host 经本地 SSE 路由 `/dsh-notify/events` 通知客户端半边，由它调用 `ctx.uiWorkspace.openSession()` 切回会话。通知进程空闲 `idleExitMs` 后自行退出，插件重载时新实例会结束旧实例，不留孤儿进程。

## 隐私

- 默认完全本地运行；**只有开启 QQ 通知**才会访问腾讯的接口
- 只读取对话标题和会话 id，不读取消息正文
- 本地路由（`/dsh-notify/*`）只监听 DSH 的回环地址

## 已知限制

- **虚拟桌面**：卡片创建在当时那个桌面，切过去才看得见
- **独占全屏、UAC 安全桌面、锁屏**：任何窗口都盖不住
- **审批卡片会和 DSH 自己的审批框叠在右下角**，会挡住按钮，先关卡片再点
- **全机单实例**：同一时间只有一个通知进程；首个卡片有约 1.5 秒冷启动
- **QQ 通道只支持单聊**，同一 AppID 只能有一个宿主进程持有连接

## 排错

| 现象 | 处理 |
|---|---|
| 启用失败，`ERR_MODULE_NOT_FOUND` | 装的是 1.2.0 或更早的坏包，重装 1.2.1+ |
| 装完没反应 | 刷新页面；还不行就重启 DSH |
| 卡片不弹 | 检查 `enabled` 与四类分类开关；虚拟桌面 / 全屏 / 锁屏下看不到是正常现象 |
| QQ 未连接 | 检查 AppID / AppSecret；机器人必须是好友关系；确认没有别处占用同一个 AppID |

## 升级与卸载

- **升级**：市场里点 **更新**；手动装的先移除再装（市场不覆盖已安装的包）
- **卸载**：在 **插件** 页禁用或移除，通知进程会随插件一起退出
- `link:` 安装的残留：hoisted 模式下卸载后 `node_modules` 里可能留一个指向源码目录的 junction，不影响使用，换安装方式前可用 `Get-Item <profile>\node_modules\@local\dsh-notify-toast -Force` 确认

## License

MIT。自带的 `sounds/*.wav` 随本仓库分发；如该授权不适合你的再分发场景，请替换为自己的音频。

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=fhghth/dsh-notify-toast&type=Date)](https://star-history.com/#fhghth/dsh-notify-toast&Date)
