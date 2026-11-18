#!/usr/bin/env node
/**
 * P0 probe for the QQ notification bot.
 *
 * Three independent checks, each with an unambiguous verdict:
 *   token  : AppID/AppSecret → access_token
 *            proves the credentials and the token endpoint agree
 *   listen : connect the gateway, wait for one C2C message, answer it inside
 *            the passive window (msg_id) and print the sender openid
 *   send   : proactive markdown to one openid
 *            proves the bot may push without an inbound message (or tells you
 *            exactly why it may not: 40034105 / 40054013 / 40054004 / 40034100)
 *
 * The openid is per bot, so a fresh bot cannot know it in advance. Running
 * `all` without --openid therefore listens first and uses the discovered
 * openid for the proactive send.
 *
 * Credentials come from flags, environment or tools/probe.config.json:
 *   --app-id / QQBOT_APPID
 *   --secret / QQBOT_SECRET
 *   --openid / QQBOT_OPENID
 *   --base-url / QQBOT_BASE_URL   (point at the mock for a dry run)
 *
 * Examples:
 *   node tools/probe.js token
 *   node tools/probe.js all                  # 自动发现 openid 再验证主动消息
 *   node tools/probe.js send --openid <id>
 *   node tools/probe.js all --base-url http://127.0.0.1:PORT   # offline
 */

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTokenSource, TokenError } from '../qqbot-lite/token.js'
import { createQQBotLite } from '../qqbot-lite/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.join(here, 'probe.config.json')

const EXIT_OK = 0
const EXIT_USAGE = 2
const EXIT_TOKEN = 3
const EXIT_SEND = 4
const EXIT_GATEWAY = 5

function parseArgs(argv) {
  const args = { step: 'all' }
  const rest = [...argv]
  if (rest[0] && !rest[0].startsWith('-')) args.step = rest.shift()
  while (rest.length > 0) {
    const token = rest.shift()
    switch (token) {
      case '--app-id': args.appId = rest.shift(); break
      case '--secret': args.secret = rest.shift(); break
      case '--openid': args.openid = rest.shift(); break
      case '--base-url': args.baseUrl = rest.shift(); break
      case '--text': args.text = rest.shift(); break
      case '--timeout': args.timeout = Number(rest.shift()); break
      case '--config': args.config = rest.shift(); break
      case '--no-reply': args.noReply = true; break
      case '--help': case '-h': args.help = true; break
      default: throw new Error(`未知参数：${token}`)
    }
  }
  return args
}

function usage() {
  console.log(`用法: node tools/probe.js <token|send|listen|all> [选项]

选项:
  --app-id <id>      机器人 AppID（或 QQBOT_APPID）
  --secret <secret>  机器人 AppSecret（或 QQBOT_SECRET）
  --openid <openid>  接收通知的 QQ 用户 openid（或 QQBOT_OPENID）；all 可省略，自动发现
  --base-url <url>   OpenAPI 根地址，默认 https://api.bot.qq.com
  --text <text>      send 步骤的正文
  --timeout <秒>     listen 步骤等待时长，默认 120
  --no-reply         listen 步骤收到消息后不自动回复
  --config <path>    配置文件，默认 tools/probe.config.json
  -h, --help         显示本帮助

退出码: 0 成功 / 2 用法或配置 / 3 token / 4 发送 / 5 网关`)
}

function loadConfig(args) {
  const file = args.config ? path.resolve(args.config) : CONFIG_PATH
  let fromFile = {}
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      console.error(`配置文件不是合法 JSON：${file}\n${error.message}`)
      process.exit(EXIT_USAGE)
    }
  }
  const env = process.env
  return {
    appId: args.appId ?? env.QQBOT_APPID ?? fromFile.appId ?? '',
    secret: args.secret ?? env.QQBOT_SECRET ?? fromFile.clientSecret ?? fromFile.secret ?? '',
    openid: args.openid ?? env.QQBOT_OPENID ?? fromFile.openid ?? '',
    baseUrl: args.baseUrl ?? env.QQBOT_BASE_URL ?? fromFile.baseUrl ?? undefined,
    text: args.text ?? fromFile.text ?? '【P0 探针】QQ 通知通道测试消息',
    timeout: (Number.isFinite(args.timeout) && args.timeout > 0 ? args.timeout : 120) * 1000,
    noReply: Boolean(args.noReply),
    configPath: file,
  }
}

function mask(secret) {
  if (!secret) return '(空)'
  if (secret.length <= 6) return '*'.repeat(secret.length)
  return `${secret.slice(0, 3)}***${secret.slice(-2)}`
}

function banner(text) {
  console.log(`\n=== ${text} ===`)
}

const SEND_HINTS = {
  40034105: '主动消息无权限。这个机器人没有“主动发送”能力：改用被动回复窗口（用户先说一句话）或互动召回，或到 q.qq.com 检查机器人能力。',
  40054013: '用户已在 QQ 客户端关闭「允许主动发送」。让用户在机器人资料卡里打开，或改走被动回复。',
  40054004: '没有好友关系。先用手机 QQ 添加该机器人为好友，再给它发一句话。',
  40034100: '主动消息触发频控。等一会儿再试，或降低发送频率。',
  40034005: 'msg_id 过期。被动回复必须在下行消息后 60 分钟内。',
  40054005: '消息被去重。同一条 msg_id + msg_seq 重复发送会被拒。',
  40054007: '消息长度超限。',
  40054016: '机器人已下线，检查机器人状态。',
  100016: '凭据错误：AppID 与 AppSecret 不匹配。',
}

function explain(error) {
  const code = error?.code
  if (code !== undefined && SEND_HINTS[code]) console.error(`\n>>> ${SEND_HINTS[code]}`)
}

async function stepToken(cfg) {
  banner('步骤 · token')
  console.log(`AppID    : ${cfg.appId}`)
  console.log(`AppSecret: ${mask(cfg.secret)}`)
  console.log(`根地址   : ${cfg.baseUrl ?? 'https://api.bot.qq.com'}`)
  const source = createTokenSource({
    appId: cfg.appId,
    clientSecret: cfg.secret,
    baseUrl: cfg.baseUrl,
  })
  try {
    const started = Date.now()
    const token = await source.getToken()
    const cached = source.peek()
    console.log(`\n[OK] 已取得 access_token（${Date.now() - started}ms）`)
    console.log(`     长度=${token.length} 前缀=${token.slice(0, 6)}…`)
    if (cached) {
      console.log(
        `     预计过期：${new Date(cached.expiresAt).toLocaleString()}（已预留 60s 刷新余量）`,
      )
    }
  } catch (error) {
    console.error(`\n[FAIL] ${error instanceof TokenError ? error.message : error}`)
    explain(error)
    process.exit(EXIT_TOKEN)
  }
}

async function stepSend(cfg) {
  banner('步骤 · 主动消息')
  if (!cfg.openid) {
    console.error('[FAIL] 缺少 openid：主动消息必须指定接收者（--openid 或 QQBOT_OPENID）')
    process.exit(EXIT_USAGE)
  }
  console.log(`接收者   : ${cfg.openid}`)
  console.log(`正文     : ${cfg.text}`)
  const bot = createQQBotLite({
    appId: cfg.appId,
    clientSecret: cfg.secret,
    baseUrl: cfg.baseUrl,
    logger: { info: () => {}, warn: console.warn, error: console.error, debug: () => {} },
  })
  try {
    const result = await bot.sendC2C(cfg.openid, { markdown: cfg.text })
    console.log('\n[OK] 主动消息已发出')
    console.log(`     message_id = ${result.id ?? '(未返回)'}`)
    console.log(`     timestamp  = ${result.timestamp ?? '(未返回)'}`)
    console.log(`     ref_idx    = ${result.refIdx ?? '(未返回)'}`)
    console.log('\n结论：主动消息可用 —— 没有用户消息时也能推送。')
    return true
  } catch (error) {
    console.error(`\n[FAIL] 主动消息发送失败：code=${error?.code ?? '?'} ${error?.message ?? error}`)
    explain(error)
    if (error?.code === 40034105 || error?.code === 40054013) {
      console.error('\n结论：主动消息不可用 → 通知必须走「被动回复窗口」或「互动召回」。')
      console.error('      方案仍可行：用户每 60 分钟内发一句话，可保留 4 条被动回复预算。')
    }
    process.exit(EXIT_SEND)
  }
}

/** Connect, wait for one C2C message, answer it passively, return the message. */
async function runListen(cfg) {
  banner('步骤 · 网关收消息')
  console.log('正在连接网关，收到一条私聊消息即算通过。')
  console.log('请用手机 QQ 给这个机器人发一句话……\n')

  const bot = createQQBotLite({
    appId: cfg.appId,
    clientSecret: cfg.secret,
    baseUrl: cfg.baseUrl,
    logger: {
      info: () => {},
      warn: (m) => console.warn(`     ${m}`),
      error: (m) => console.error(`     ${m}`),
      debug: () => {},
    },
  })

  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      bot.stop()
      fn(value)
    }

    bot.on('state', (state) => {
      if (state.state === 'connecting') console.log('     连接中…')
      else if (state.state === 'ready') console.log(`     [OK] 网关就绪（session=${state.detail ?? '?'}）`)
      else if (state.state === 'reconnecting') console.log(`     重连中：${state.detail}`)
      else if (state.state === 'fatal') {
        console.error(`     [FAIL] 网关致命错误：${state.detail}`)
        if (/\b(4014|4914|4915)\b/.test(String(state.detail))) {
          console.error('\n>>> intent 无权限或机器人未上线：到 q.qq.com 确认「私聊消息」事件权限，')
          console.error('    并确认机器人已上线（未上线只能连沙箱环境）。')
        }
        finish(reject, new Error(`gateway fatal: ${state.detail}`))
      }
    })

    bot.on('message', async (message) => {
      console.log('\n[OK] 收到消息')
      console.log(`     scope     = ${message.scope}`)
      console.log(`     openid    = ${message.openid ?? message.memberOpenid}`)
      console.log(`     msg_id    = ${message.msgId}`)
      console.log(`     event_id  = ${message.eventId}`)
      console.log(`     内容      = ${message.content}`)
      if (cfg.openid && message.openid && message.openid !== cfg.openid) {
        console.warn(`     ⚠ 发送者 openid 与配置不同：配置=${cfg.openid}`)
      }

      const openid = message.openid ?? cfg.openid
      if (!cfg.noReply && openid) {
        try {
          const result = await bot.sendC2C(openid, {
            markdown: `收到：${message.content.slice(0, 40)}\n（probe 被动回复，msg_id=${message.msgId}）`,
            msgId: message.msgId,
          })
          console.log(`     [OK] 已用被动回复窗口回信，message_id=${result.id ?? '?'}`)
        } catch (error) {
          console.error(`     [FAIL] 被动回复失败：code=${error?.code ?? '?'} ${error?.message ?? error}`)
          explain(error)
        }
      }
      console.log(`\n结论：网关可用，收到的 openid = ${openid}`)
      console.log(`     之后可以直接用：--openid ${openid}`)
      finish(resolve, { openid, message })
    })

    const timer = setTimeout(() => {
      console.error(`\n[FAIL] ${Math.round(cfg.timeout / 1000)} 秒内没有收到任何消息。`)
      console.error('排查：机器人是否已添加为好友？发的是私聊（不是群聊）？机器人是否在线？')
      finish(reject, new Error('listen timeout'))
    }, cfg.timeout)
    timer.unref?.()

    bot.start().catch((error) => {
      console.error(`\n[FAIL] 网关连接失败：${error?.message ?? error}`)
      explain(error)
      finish(reject, error)
    })
  })
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    usage()
    process.exit(EXIT_USAGE)
  }
  if (args.help) {
    usage()
    process.exit(EXIT_OK)
  }
  if (!['token', 'send', 'listen', 'all'].includes(args.step)) {
    console.error(`未知步骤：${args.step}`)
    usage()
    process.exit(EXIT_USAGE)
  }

  const cfg = loadConfig(args)
  if (existsSync(cfg.configPath) && !args.config) {
    console.log(`（已读取配置：${cfg.configPath}）`)
  }
  if (!cfg.appId || !cfg.secret) {
    console.error('缺少凭据：请用 --app-id/--secret 或环境变量 QQBOT_APPID/QQBOT_SECRET，')
    console.error(`或写入配置文件 ${CONFIG_PATH}（字段 appId / clientSecret / openid）。`)
    process.exit(EXIT_USAGE)
  }

  console.log(`步骤: ${args.step}`)

  if (args.step === 'token') {
    await stepToken(cfg)
    console.log('\n完成。')
    return
  }
  if (args.step === 'send') {
    await stepSend(cfg)
    console.log('\n完成。')
    return
  }
  if (args.step === 'listen') {
    try {
      await runListen(cfg)
    } catch {
      process.exit(EXIT_GATEWAY)
    }
    return
  }

  // all: a fresh bot cannot know the openid, so listen first when it is missing.
  await stepToken(cfg)
  let openid = cfg.openid
  if (!openid) {
    try {
      const result = await runListen(cfg)
      openid = result.openid
    } catch {
      console.error('\n[FAIL] 未能通过网关收到消息，主动消息这步没有可用的 openid。')
      process.exit(EXIT_GATEWAY)
    }
  } else {
    await stepSend(cfg)
    try {
      await runListen(cfg)
    } catch {
      process.exit(EXIT_GATEWAY)
    }
  }
  if (openid && openid !== cfg.openid) {
    cfg.openid = openid
    await stepSend(cfg)
  }
  console.log('\n完成。')
}

main().catch((error) => {
  console.error(error?.stack ?? String(error))
  process.exit(EXIT_USAGE)
})
