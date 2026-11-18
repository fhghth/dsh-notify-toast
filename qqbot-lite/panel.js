/**
 * QQ Bot 指令面板 (command panel) API.
 *
 * A panel is a native QQ surface that renders a list of `command` / `link`
 * entries next to the chat. It costs no message quota, which makes it the right
 * place for a "which session is where" board — pushing that as messages would
 * just add to the flood.
 *
 * Official contract (api-v2 / 指令面板):
 *   GET    /v2/panels?scope=&cursor=&limit=   list, newest first, paginated
 *   POST   /v2/panels                         { scope, target_type, user_openids, panel }
 *   GET    /v2/panels/{panel_id}              full record incl.关联对象
 *   PUT    /v2/panels/{panel_id}              replace `panel` only, not the target list
 *   DELETE /v2/panels/{panel_id}
 *
 * Limits worth remembering:
 *   - at most 20 panels per bot, at most 20 items per panel
 *   - `name` <= 14 display columns (~7 CJK), `desc` <= 30 (~15 CJK)
 *   - `type=command` puts `name` into the chat input box when tapped
 *   - create/update/delete are 10 QPM, listing is 30 QPM
 *   - `channel` / `dm` panels only accept `target_type=all`
 */

/** Panel item / panel count limits enforced by the platform. */
export const PANEL_MAX_ITEMS = 20

/** Platform error: "指令面板不存在" — the only case worth a silent recreate. */
export const PANEL_GONE_CODE = 40030006

/**
 * @param {(method: string, path: string, body?: object) => Promise<any>} request
 *   the authenticated OpenAPI call from `createApi`
 */
export function createPanelApi(request) {
  if (typeof request !== 'function') throw new Error('createPanelApi requires request()')

  /**
   * Every panel record for one scope. Follows `next_cursor` until the last page
   * or `maxPages`, so a runaway cursor cannot loop forever.
   */
  async function list(scope = 'c2c', { limit = 50, maxPages = 5 } = {}) {
    const records = []
    let cursor = ''
    for (let page = 0; page < maxPages; page += 1) {
      const query = new URLSearchParams({ scope, limit: String(limit) })
      if (cursor) query.set('cursor', cursor)
      const data = await request('GET', `/v2/panels?${query.toString()}`)
      if (Array.isArray(data?.records)) records.push(...data.records)
      cursor = typeof data?.next_cursor === 'string' ? data.next_cursor : ''
      if (!cursor || data?.is_end === true) break
    }
    return records
  }

  async function get(panelId) {
    if (!panelId) throw new Error('get(panelId) requires an id')
    return request('GET', `/v2/panels/${encodeURIComponent(panelId)}`)
  }

  /**
   * @returns {Promise<string>} the new panel id
   */
  async function create({ scope = 'c2c', targetType = 'all', userOpenids, groupOpenids, panel } = {}) {
    const body = { scope, target_type: targetType, panel }
    if (Array.isArray(userOpenids) && userOpenids.length > 0) {
      body.user_openids = userOpenids.slice(0, 20)
    }
    if (Array.isArray(groupOpenids) && groupOpenids.length > 0) {
      body.group_openids = groupOpenids.slice(0, 20)
    }
    const data = await request('POST', '/v2/panels', body)
    const id = data?.panel_id
    if (!id) throw new Error('创建指令面板没有返回 panel_id')
    return id
  }

  /** Replace the item list / remark; the associated openids are untouched. */
  async function update(panelId, panel) {
    if (!panelId) throw new Error('update(panelId) requires an id')
    return request('PUT', `/v2/panels/${encodeURIComponent(panelId)}`, { panel })
  }

  async function remove(panelId) {
    if (!panelId) throw new Error('remove(panelId) requires an id')
    return request('DELETE', `/v2/panels/${encodeURIComponent(panelId)}`)
  }

  return { list, get, create, update, remove }
}

/** True when the failure means "this panel no longer exists". */
export function isPanelGone(error) {
  return Boolean(error && typeof error === 'object' && error.code === PANEL_GONE_CODE)
}
