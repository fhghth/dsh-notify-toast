/**
 * List the 指令面板 currently registered for the notification bot.
 *
 * Run: node tools/panel-probe.js [scope]
 * Reads credentials from tools/probe.config.json (gitignored).
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTokenSource } from '../qqbot-lite/token.js'
import { createApi } from '../qqbot-lite/api.js'
import { createPanelApi } from '../qqbot-lite/panel.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(readFileSync(path.join(here, 'probe.config.json'), 'utf8'))
const scope = process.argv[2] || 'c2c'

const tokenSource = createTokenSource({
  appId: config.appId,
  clientSecret: config.clientSecret,
  baseUrl: config.baseUrl,
})
const api = createApi({ tokenSource, baseUrl: config.baseUrl })
const panels = createPanelApi(api.request)

const records = await panels.list(scope)
console.log(`scope=${scope} panels=${records.length}`)
for (const record of records) {
  console.log(JSON.stringify(record, null, 2))
}
