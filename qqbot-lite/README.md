# qqbot-lite

零依赖的 QQ 机器人客户端，只做通知 bot 需要的那一小块协议。

用来给 `dsh-notify-toast` 增加 QQ 通道：会话结束时发一张卡片、需要审批时提醒、在 QQ 里按会话 ID 回一句话继续跑。

## 为什么不用 `@tencent-connect/qqbot-nodejs`

不是因为它不好，而是这个场景用不上它的大部分内容：

| 官方 SDK 提供 | 通知 bot 需要吗 |
|---|---|
| 中间件链（mention gate、去重、历史缓冲、斜杠命令、访问策略） | 不需要 |
| 媒体分块上传、流式消息 | 不需要 |
| Webhook 传输、网关 session 落盘 | 不需要 |
| token 管理、发消息、WebSocket 网关 | **只需要这三样** |

另外两个现实问题：

1. 插件是 `link:` 安装的（真实路径在 profile 之外），`import '@tencent-connect/qqbot-nodejs'` 解析不到
2. SDK 是 `dsh-qqbot` 的传递依赖，卸载/升级那个插件时会一起消失

自己写 300 行、零依赖，运行时只需要 Node ≥ 22 内置的 `fetch` 和 `WebSocket`。

## 协议依据（官方文档）

| 能力 | 文档 | 实现 |
|---|---|---|
| 换 token | [接口调用与鉴权](https://bot.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html) | `token.js` |
| 发消息 | [发送单聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html) | `api.js` |
| 收消息 | [WebSocket 方式](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html) | `gateway.js` |
| 事件结构与 intents | [通用数据结构](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/payload.html) | `gateway.js` / `index.js` |

## 文件

```
qqbot-lite/
├─ token.js     access_token 缓存（7200s，提前 60s 刷新，并发合并为一次请求）
├─ api.js       发送消息（markdown/文本；被动 / 互动召回 / 主动；msg_seq 分配；错误码提示）
├─ gateway.js   WebSocket 网关（hello/identify/heartbeat/resume/重连/close code 策略）
└─ index.js     组合体 + 事件归一化（C2C / 群 / 控制事件）
```

## 用法

```js
import { createQQBotLite, Intents } from './qqbot-lite/index.js'

const bot = createQQBotLite({
  appId: process.env.QQBOT_APPID,
  clientSecret: process.env.QQBOT_SECRET,
  intents: Intents.DEFAULT, // GROUP_AND_C2C_EVENT | INTERACTION
})

bot.on('ready', ({ sessionId }) => console.log('ready', sessionId))
bot.on('message', async (message) => {
  // message: { scope, openid, msgId, eventId, content, timestamp, raw }
  await bot.sendC2C(message.openid, { markdown: '收到', msgId: message.msgId })
})
bot.on('control', (event) => {
  // FRIEND_ADD / C2C_MSG_REJECT / C2C_MSG_RECEIVE / GROUP_ADD_ROBOT ...
})

await bot.start()
```

只发不收时不用 `start()`：

```js
import { createTokenSource } from './qqbot-lite/token.js'
import { createApi } from './qqbot-lite/api.js'

const tokenSource = createTokenSource({ appId, clientSecret })
const api = createApi({ tokenSource })
await api.sendC2C(openid, { markdown: '**会话完成**' }) // 主动消息
```

## 三种消息的优先级

| 类型 | 请求字段 | 限额 | 何时用 |
|---|---|---|---|
| 被动回复 | `msgId` 或 `eventId` | 私聊 60 分钟 / 每条消息 4 次 | 用户刚说过话，优先用它 |
| 互动召回 | `isWakeup` | 用户主动对话后 30 天内 4 个周期各 1 条 | 被动窗口过期、又不想消耗主动额度 |
| 主动消息 | 三个都不带 | 20 次/分/用户、1000 条/天/用户 | 窗口冷时的兜底 |

三者互斥，本模块会直接抛错拦住写错的调用。

常见错误码已翻译成人话（见 `api.js` 的 `CODE_HINTS`）：`40034105` 主动消息无权限、`40054013` 用户关闭了允许主动发送、`40054004` 无好友关系、`40034128` 被动回复超次数/超时。

## 测试

离线测试不需要任何凭据，自带一个最小 WebSocket 服务器实现：

```bash
node --test "tests/**/*.test.js"
```

覆盖：token 缓存/提前刷新/并发合并/错误体、消息体形状与 `msg_seq` 递增、三种消息类型的互斥、close code 重连策略、4006 重新 identify、4014 致命不重连、端到端收发。

## 探针（P0）

真实链路验证，三步各自给结论。**openid 是按机器人隔离的**，所以新机器人第一次不知道自己的 openid：`all` 会先连网关收一条消息、自动发现 openid，再验证主动消息。

```bash
# 推荐第一次这样跑：token → 收消息（顺带发现 openid）→ 主动消息
node tools/probe.js all

# 已经知道 openid 时
node tools/probe.js token
node tools/probe.js send --openid <openid>
node tools/probe.js listen          # 只验证收消息
```

- `token`：凭据是否有效，返回 token 长度和预计过期时间
- `listen`：网关能否就绪并收到私聊消息；收到后会**用 msg_id 被动回复一条**，从而验证被动窗口
- `send`：主动消息是否可用（会真的发一条）；失败时按错误码给出结论

凭据来源：`--app-id/--secret/--openid`、环境变量 `QQBOT_APPID/QQBOT_SECRET/QQBOT_OPENID`，或 `tools/probe.config.json`（已 gitignore）。

想离线演练先跑 mock：

```bash
node tools/probe.js all --base-url http://127.0.0.1:<port> --app-id mock-app --secret mock-secret --openid u1
```

## 已知边界

- 只实现单实例、单分片（`shard: [0, 1]`）：同一个 AppID 不要开两条连接
- 不支持 webhook 传输、媒体消息、频道（guild）场景
- WebSocket 升级不带自定义 `User-Agent`（Node 内置 WebSocket 不支持自定义头；QQ 侧不要求）
- `msg_seq` 计数只在进程内有效，重启后从头开始
