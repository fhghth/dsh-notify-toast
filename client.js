window.__ModuleLoader__.load({
  id: '@local/dsh-notify-toast',
  factory(require) {
    const React = require('react')
    const el = React.createElement

    // Windows ships a full set of short sounds in %WINDIR%\Media; the legacy
    // SystemSounds set collapses most events onto the same file, so the
    // distinct choices come from `media:<file name>`.
    const SOUNDS = [
      ['sounds/bubble-1.wav', '插件自带 · 气泡 1'],
      ['sounds/bubble-2.wav', '插件自带 · 气泡 2'],
      ['sounds/alert-1.wav', '插件自带 · 提醒 1'],
      ['sounds/alert-2.wav', '插件自带 · 提醒 2'],
      ['sounds/alert-3.wav', '插件自带 · 提醒 3'],
      ['media:Windows Notify System Generic', '系统通知 · 默认'],
      ['media:Windows Proximity Notification', '系统通知 · 邻近提醒'],
      ['media:Windows Notify Calendar', '系统通知 · 日历'],
      ['media:Windows Notify Messaging', '系统通知 · 消息'],
      ['media:Windows Notify Email', '系统通知 · 邮件'],
      ['media:Windows Ding', '系统通知 · 短叮'],
      ['media:notify', '系统通知 · notify'],
      ['media:chimes', '钟声 chimes'],
      ['media:tada', '完成 tada'],
      ['media:Windows Print complete', '打印完成'],
      ['media:Windows Exclamation', '提示 · 惊叹'],
      ['media:Windows Message Nudge', '提醒 · Nudge'],
      ['media:Windows Critical Stop', '错误 · Critical Stop'],
      ['media:Windows Error', '错误 · Error'],
      ['media:Windows Hardware Fail', '错误 · Hardware Fail'],
      ['system:asterisk', '旧版 · 提示音'],
      ['system:exclamation', '旧版 · 惊叹'],
      ['system:hand', '旧版 · 错误'],
      ['none', '静音'],
    ]
    const POSITIONS = [
      ['bottom-right', '右下角'],
      ['bottom-left', '左下角'],
      ['top-right', '右上角'],
      ['top-left', '左上角'],
    ]
    const SCREENS = [
      ['primary', '主屏幕'],
      ['cursor', '鼠标所在屏'],
    ]
    const ICON_STYLES = [
      ['vector', '矢量绘制（推荐）'],
      ['glyph', '字符 / 表情'],
      ['image', '图片文件'],
    ]

    const GROUPS = [
      {
        title: '开关',
        fields: [
          { key: 'enabled', label: '弹窗总开关', type: 'bool' },
          { key: 'notifyOnComplete', label: '任务完成时弹窗', type: 'bool' },
          { key: 'notifyOnApproval', label: '需要权限审批时弹窗', type: 'bool' },
          { key: 'notifyOnQuestion', label: 'Agent 向你提问时弹窗', type: 'bool' },
          { key: 'notifyOnError', label: '任务失败 / 中断时弹窗', type: 'bool' },
          { key: 'soundEnabled', label: '音效总开关', type: 'bool' },
        ],
      },
      {
        title: '音效',
        fields: [
          { key: 'soundComplete', label: '完成音效', type: 'text', options: SOUNDS, audition: true },
          { key: 'soundApproval', label: '审批音效', type: 'text', options: SOUNDS, audition: true },
          { key: 'soundQuestion', label: '提问音效', type: 'text', options: SOUNDS, audition: true },
          { key: 'soundError', label: '失败音效', type: 'text', options: SOUNDS, audition: true },
          { key: 'customSoundComplete', label: '完成自定义音效', type: 'text', hint: '.wav 绝对路径或相对插件目录，填了优先' },
          { key: 'customSoundApproval', label: '审批自定义音效', type: 'text', hint: '.wav 路径' },
          { key: 'customSoundQuestion', label: '提问自定义音效', type: 'text', hint: '.wav 路径' },
          { key: 'customSoundError', label: '失败自定义音效', type: 'text', hint: '.wav 路径' },
        ],
      },
      {
        title: '尺寸与位置',
        fields: [
          { key: 'width', label: '卡片宽度', type: 'number', hint: '96dpi 像素，实际按 DPI 缩放' },
          { key: 'height', label: '卡片高度', type: 'number' },
          { key: 'scale', label: '额外缩放', type: 'number', hint: '0.8 ~ 1.6' },
          { key: 'margin', label: '距屏幕边缘', type: 'number' },
          { key: 'gap', label: '卡片间距', type: 'number' },
          { key: 'maxCards', label: '同屏最多卡片数', type: 'number', hint: '1 ~ 6' },
          { key: 'durationMs', label: '停留时长（毫秒）', type: 'number' },
          { key: 'position', label: '屏幕位置', type: 'text', options: POSITIONS },
          { key: 'screen', label: '显示器', type: 'text', options: SCREENS },
        ],
      },
      {
        title: '外观',
        fields: [
          { key: 'bgColor', label: '背景色', type: 'color', hint: '点左侧色块取色，或直接填 #RRGGBB' },
          { key: 'borderColor', label: '描边色', type: 'color', hint: '点左侧色块取色' },
          { key: 'titleColor', label: '标题颜色', type: 'color', hint: '点左侧色块取色' },
          { key: 'subtitleColor', label: '副标题颜色', type: 'color', hint: '点左侧色块取色' },
          { key: 'accentComplete', label: '完成图标颜色', type: 'color', hint: '点左侧色块取色' },
          { key: 'accentApproval', label: '审批图标颜色', type: 'color', hint: '点左侧色块取色' },
          { key: 'accentQuestion', label: '提问图标颜色', type: 'color', hint: '点左侧色块取色' },
          { key: 'accentError', label: '失败图标颜色', type: 'color', hint: '点左侧色块取色' },
          { key: 'iconStyle', label: '图标样式', type: 'text', options: ICON_STYLES },
          { key: 'iconComplete', label: '完成图标', type: 'text', hint: '字符表情或图片路径' },
          { key: 'iconApproval', label: '审批图标', type: 'text', hint: '字符表情或图片路径' },
          { key: 'iconQuestion', label: '提问图标', type: 'text', hint: '字符表情或图片路径' },
          { key: 'iconError', label: '失败图标', type: 'text', hint: '字符表情或图片路径' },
          { key: 'fontFamily', label: '字体', type: 'text', hint: '字体名称' },
        ],
      },
      {
        title: '行为',
        fields: [
          { key: 'settleMs', label: '完成去抖（毫秒）', type: 'number', hint: '延迟弹窗，等待续跑' },
          { key: 'minIntervalMs', label: '同会话最小间隔', type: 'number' },
          { key: 'showElapsed', label: '副标题显示用时', type: 'bool' },
          { key: 'clickToOpenSession', label: '点击跳回会话', type: 'bool' },
          { key: 'idleExitMs', label: '空闲退出（毫秒）', type: 'number' },
          { key: 'debug', label: '调试日志', type: 'bool' },
        ],
      },
      {
        title: 'QQ 通知（可选）',
        fields: [
          { key: 'qqEnabled', label: '启用 QQ 通知通道', type: 'bool', hint: '需要在 QQ 开放平台单独创建一个通知机器人' },
          { key: 'qqAppId', label: '机器人 AppID', type: 'text' },
          { key: 'qqAppSecret', label: '机器人 AppSecret', type: 'secret', hint: '保存在 profile 配置里，仅本机可见' },
          { key: 'qqOpenids', label: '接收通知的 openid', type: 'text', hint: '多个用逗号分隔；留空则自动使用第一个给机器人发过消息的人' },
          { key: 'qqNotifyOnComplete', label: '任务完成时推送到 QQ', type: 'bool' },
          { key: 'qqNotifyOnError', label: '失败 / 中断时推送到 QQ', type: 'bool' },
          { key: 'qqMinIntervalMs', label: 'QQ 同会话最小间隔（毫秒）', type: 'number' },
          { key: 'qqAnswerApprovals', label: '在 QQ 上回答审批', type: 'bool', hint: '开启后：本会话的审批会发到 QQ 等待回复，桌面不再弹出审批框' },
          { key: 'qqAnswerQuestions', label: '在 QQ 上回答提问', type: 'bool', hint: '开启后：本会话的 Agent 提问同样转到 QQ' },
          { key: 'qqPanelEnabled', label: '同步会话到 QQ 指令面板', type: 'bool', hint: '在 QQ 聊天里生成一块「会话看板」，点任意一项即可切到那个会话；不占用消息条数' },
        ],
      },
    ]

    const styles = {
      title: { fontSize: 15, fontWeight: 600, marginBottom: 6, color: 'var(--dsw-alias-label-primary, #111)' },
      desc: { fontSize: 12, lineHeight: 1.6, marginBottom: 18, color: 'var(--dsw-alias-label-secondary, #666)' },
      section: { marginBottom: 22 },
      h3: { fontSize: 13, fontWeight: 600, margin: '0 0 12px', color: 'var(--dsw-alias-label-primary, #111)' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(230px, 100%), 1fr))', gap: 12 },
      field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
      label: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #555)' },
      hint: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #999)' },
      input: {
        height: 32,
        padding: '0 8px',
        fontSize: 13,
        color: 'var(--dsw-alias-label-primary, #111)',
        background: 'var(--dsw-alias-bg-base, #fff)',
        border: '0.5px solid var(--dsw-alias-border-l2, #d9d9d9)',
        borderRadius: 6,
        outline: 'none',
        minWidth: 0,
      },
      checkRow: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 },
      checkLabel: { fontSize: 13, color: 'var(--dsw-alias-label-primary, #111)' },
      swatch: {
        width: 40,
        height: 32,
        padding: 0,
        border: '0.5px solid var(--dsw-alias-border-l2, #d9d9d9)',
        borderRadius: 6,
        background: 'transparent',
        cursor: 'pointer',
        flex: '0 0 auto',
      },
      actions: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 4, marginBottom: 8 },
      button: {
        height: 32,
        padding: '0 18px',
        borderRadius: 6,
        border: 'none',
        background: 'var(--dsw-alias-brand-primary, #111)',
        color: 'var(--dsw-alias-brand-primary-foreground, #fff)',
        fontSize: 13,
        cursor: 'pointer',
      },
      msg: { fontSize: 12 },
      note: { fontSize: 13, color: 'var(--dsw-alias-label-secondary, #666)', padding: '8px 0' },
      ghost: {
        height: 32,
        padding: '0 14px',
        borderRadius: 6,
        border: '0.5px solid var(--dsw-alias-border-l2, #d9d9d9)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, #111)',
        fontSize: 13,
        cursor: 'pointer',
      },
    }

    function Field(props) {
      const { field, value, onChange } = props
      if (field.type === 'bool') {
        return el(
          'label',
          { style: styles.checkRow },
          el('input', { type: 'checkbox', checked: Boolean(value), onChange: (event) => onChange(event.target.checked) }),
          el('span', { style: styles.checkLabel }, field.label),
        )
      }
      let control
      if (field.type === 'color') {
        const raw = typeof value === 'string' ? value.trim() : ''
        const hex = /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : '#000000'
        control = el(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
          el('input', {
            type: 'color',
            value: hex,
            title: '选择颜色',
            style: styles.swatch,
            onChange: (event) => onChange(event.target.value.toUpperCase()),
          }),
          el('input', {
            style: { ...styles.input, flex: 1, minWidth: 0 },
            type: 'text',
            value: raw,
            placeholder: '#RRGGBB',
            onChange: (event) => onChange(event.target.value),
          }),
        )
      } else if (field.type === 'secret') {
        control = el('input', {
          style: styles.input,
          type: 'password',
          autoComplete: 'off',
          value: value ?? '',
          onChange: (event) => onChange(event.target.value),
        })
      } else if (field.options) {
        control = el(
          'select',
          { style: styles.input, value: value ?? '', onChange: (event) => onChange(event.target.value) },
          field.options.map(([optionValue, optionLabel]) => el('option', { key: optionValue, value: optionValue }, optionLabel)),
        )
      } else if (field.type === 'number') {
        control = el('input', {
          style: styles.input,
          type: 'number',
          value: value ?? '',
          onChange: (event) => onChange(event.target.value === '' ? '' : Number(event.target.value)),
        })
      } else {
        control = el('input', {
          style: styles.input,
          type: 'text',
          value: value ?? '',
          onChange: (event) => onChange(event.target.value),
        })
      }
      const controlNode = field.audition
        ? el(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            el('div', { style: { flex: 1, minWidth: 0 } }, control),
            el(
              'button',
              {
                type: 'button',
                style: { ...styles.ghost, height: 32, padding: '0 12px' },
                onClick: () => props.onAudition && props.onAudition(value),
              },
              '试听',
            ),
          )
        : control

      return el(
        'div',
        { style: styles.field },
        el('span', { style: styles.label }, field.label),
        controlNode,
        field.hint ? el('span', { style: styles.hint }, field.hint) : null,
      )
    }

    // ---- QQ session switch ---------------------------------------------------
    //
    // One shared store keeps every open toggle in sync: the SSE bridge pushes
    // status and subscription changes, and a toggle also reads its own state
    // once on mount (a page opened later never misses the snapshot).

    const qqStore = {
      global: null,
      sessions: new Map(),
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
      },
      emit() {
        for (const fn of [...this.listeners]) {
          try { fn() } catch {}
        }
      },
      setGlobal(global) {
        if (!global) return
        this.global = global
        this.emit()
      },
      setSession(state) {
        if (!state || !state.sessionId) return
        this.sessions.set(state.sessionId, state)
        this.emit()
      },
    }

    async function fetchQQState(sessionId) {
      const query = sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : ''
      const response = await fetch('/dsh-notify/qq/state' + query, { headers: { accept: 'application/json' } })
      const data = await response.json()
      if (!data || !data.ok) throw new Error((data && data.error) || 'HTTP ' + response.status)
      qqStore.setGlobal(data.global)
      if (data.session) qqStore.setSession(data.session)
      return data
    }

    function QQToggle(props) {
      const sessionId = props && props.sessionId ? props.sessionId : ''
      const [, bump] = React.useState(0)
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        if (!sessionId) return undefined
        let alive = true
        fetchQQState(sessionId).catch(() => {})
        const off = qqStore.subscribe(() => {
          if (alive) bump((value) => value + 1)
        })
        return () => {
          alive = false
          off()
        }
      }, [sessionId])

      const global = qqStore.global
      if (!sessionId || !global || !global.enabled) return null

      const state = qqStore.sessions.get(sessionId)
      const on = Boolean(state && state.on)
      const connected = Boolean(global.connected)

      const toggle = async () => {
        if (busy) return
        setBusy(true)
        try {
          const response = await fetch('/dsh-notify/qq/subscribe', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, enabled: !on }),
          })
          const data = await response.json()
          if (!data || !data.ok) throw new Error((data && data.error) || 'HTTP ' + response.status)
          qqStore.setSession({ sessionId: data.sessionId, on: data.on, alias: data.alias })
        } catch (error) {
          console.warn('[dsh-notify-toast] QQ 开关失败：' + (error && error.message ? error.message : error))
        } finally {
          setBusy(false)
        }
      }

      const title = !connected
        ? 'QQ 通知未连接，请到「设置 → 插件 → 桌面弹窗通知」检查'
        : on
          ? '已开启：本会话结束时会推送到 QQ（点击关闭）'
          : '开启本会话的 QQ 通知'

      return el(
        'button',
        {
          type: 'button',
          title,
          'aria-pressed': on,
          'aria-label': title,
          disabled: busy,
          onClick: toggle,
          style: {
            height: 26,
            padding: '0 9px',
            borderRadius: 13,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.4,
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1,
            border: on
              ? '0.5px solid var(--dsw-alias-brand-primary, #111)'
              : '0.5px solid var(--dsw-alias-border-l2, #d9d9d9)',
            background: on ? 'var(--dsw-alias-brand-primary, #111)' : 'transparent',
            color: on
              ? 'var(--dsw-alias-brand-primary-foreground, #fff)'
              : 'var(--dsw-alias-label-secondary, #666)',
          },
        },
        'QQ',
        el('span', {
          style: {
            width: 6,
            height: 6,
            borderRadius: 3,
            background: connected ? (on ? '#22c55e' : '#9ca3af') : '#f59e0b',
          },
        }),
      )
    }

    function SettingsPage() {
      const [draft, setDraft] = React.useState(null)
      const [revision, setRevision] = React.useState(0)
      const [saving, setSaving] = React.useState(false)
      const [message, setMessage] = React.useState(null)
      const [previewing, setPreviewing] = React.useState('')
      const [qqStatus, setQQStatus] = React.useState(null)
      const [testingQQ, setTestingQQ] = React.useState(false)

      const refreshQQStatus = async () => {
        try {
          const response = await fetch('/dsh-notify/qq/state', { headers: { accept: 'application/json' } })
          const data = await response.json()
          if (data && data.ok) setQQStatus(data.global)
        } catch {}
      }

      const testQQ = async () => {
        setTestingQQ(true)
        setMessage(null)
        try {
          const response = await fetch('/dsh-notify/qq/test', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          const data = await response.json()
          if (!response.ok || !data.ok) throw new Error((data && data.error) || 'HTTP ' + response.status)
          setMessage({ kind: 'ok', text: `已发送 QQ 测试消息（${data.targets} 个接收者）` })
        } catch (error) {
          setMessage({ kind: 'error', text: 'QQ 测试失败：' + error.message })
        } finally {
          setTestingQQ(false)
          void refreshQQStatus()
        }
      }

      const qqStatusText = (status) => {
        if (!status) return 'QQ 通知：读取中…'
        if (!status.enabled) return 'QQ 通知：未启用'
        if (status.connected) return 'QQ 通知：已连接 · appId ' + (status.appId || '?')
        return 'QQ 通知：' + status.state + (status.detail ? ' · ' + status.detail : '')
      }

      const preview = async (kind) => {
        setPreviewing(kind)
        setMessage(null)
        try {
          const response = await fetch('/dsh-notify/preview', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kind }),
          })
          const data = await response.json()
          if (!response.ok || !data.ok) throw new Error(data.error || 'HTTP ' + response.status)
          setMessage({ kind: 'ok', text: '已按当前配置发送预览卡片' })
        } catch (error) {
          setMessage({ kind: 'error', text: '预览失败：' + error.message })
        } finally {
          setPreviewing('')
        }
      }

      const audition = async (sound, key) => {
        const customKey =
          key === 'soundApproval'
            ? 'customSoundApproval'
            : key === 'soundError'
              ? 'customSoundError'
              : 'customSoundComplete'
        try {
          const response = await fetch('/dsh-notify/preview-sound', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sound, custom: (draft && draft[customKey]) || '' }),
          })
          const data = await response.json()
          if (!response.ok || !data.ok) throw new Error(data.error || 'HTTP ' + response.status)
        } catch (error) {
          setMessage({ kind: 'error', text: '试听失败：' + error.message })
        }
      }

      React.useEffect(() => {
        let alive = true
        fetch('/dsh-notify/config', { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((data) => {
            if (!alive) return
            setDraft({ ...(data.values || {}) })
            setRevision(Number(data.revision) || 0)
          })
          .catch((error) => {
            if (!alive) return
            setDraft({})
            setMessage({ kind: 'error', text: '读取配置失败：' + error.message })
          })
        return () => { alive = false }
      }, [])

      React.useEffect(() => {
        void refreshQQStatus()
      }, [])

      const setField = (key, value) => setDraft((current) => ({ ...current, [key]: value }))

      const save = async () => {
        setSaving(true)
        setMessage(null)
        try {
          const response = await fetch('/dsh-notify/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ values: draft, revision }),
          })
          const data = await response.json()
          if (!response.ok || !data.ok) throw new Error(data.error || 'HTTP ' + response.status)
          setDraft({ ...(data.values || draft) })
          setRevision(Number(data.revision) || revision)
          setMessage({ kind: 'ok', text: '已保存，下一张弹窗即生效' })
          setTimeout(() => { void refreshQQStatus() }, 1500)
        } catch (error) {
          setMessage({ kind: 'error', text: '保存失败：' + error.message })
        } finally {
          setSaving(false)
        }
      }

      if (!draft) {
        return el('div', { style: styles.note }, message ? message.text : '正在读取配置…')
      }

      return el(
        'div',
        null,
        el('div', { style: styles.title }, '桌面弹窗通知'),
        el('div', { style: styles.desc }, '任务完成、需要权限审批或 Agent 提问时，在屏幕右下角弹出置顶卡片。改动保存后，下一张卡片即按新配置显示。'),
        el('div', { style: { ...styles.note, marginBottom: 18 } }, qqStatusText(qqStatus)),
        el(
          'div',
          { style: { ...styles.actions, marginBottom: 22 } },
          [
            ['complete', '预览完成卡'],
            ['approval', '预览审批卡'],
            ['question', '预览提问卡'],
            ['error', '预览失败卡'],
          ].map(([kind, label]) =>
            el(
              'button',
              {
                key: kind,
                type: 'button',
                style: { ...styles.ghost, opacity: previewing && previewing !== kind ? 0.5 : 1 },
                disabled: Boolean(previewing),
                onClick: () => preview(kind),
              },
              previewing === kind ? '发送中…' : label,
            ),
          ),
        ),
        GROUPS.map((group) =>
          el(
            'section',
            { key: group.title, style: styles.section },
            el('h3', { style: styles.h3 }, group.title),
            el(
              'div',
              { style: styles.grid },
              group.fields.map((field) =>
                el(Field, {
                  key: field.key,
                  field,
                  value: draft[field.key],
                  onChange: (value) => setField(field.key, value),
                  onAudition: field.audition ? (sound) => audition(sound, field.key) : undefined,
                }),
              ),
            ),
          ),
        ),
        el(
          'div',
          { style: styles.actions },
          el(
            'button',
            { type: 'button', style: { ...styles.button, opacity: saving ? 0.6 : 1 }, disabled: saving, onClick: save },
            saving ? '保存中…' : '保存',
          ),
          el(
            'button',
            {
              type: 'button',
              style: { ...styles.ghost, opacity: testingQQ ? 0.6 : 1 },
              disabled: testingQQ,
              onClick: testQQ,
            },
            testingQQ ? '发送中…' : '发送 QQ 测试消息',
          ),
          message
            ? el('span', { style: { ...styles.msg, color: message.kind === 'ok' ? '#16A34A' : '#DC2626' } }, message.text)
            : null,
        ),
      )
    }

    function BundleConfig(props) {
      if (props && props.view === 'summary') return null
      return el(SettingsPage)
    }

    return {
      inject: ['slots', 'uiWorkspace'],
      apply(ctx) {
        // Click-to-focus bridge: the notifier posts a session id, the page navigates.
        ctx.effect(() => {
          let source = null
          let retry = null
          let closed = false

          const connect = () => {
            if (closed) return
            try {
              source = new EventSource('/dsh-notify/events')
            } catch {
              return
            }
            source.onmessage = (event) => {
              try {
                const data = JSON.parse(event.data)
                if (!data) return
                if (data.type === 'focus' && data.sessionId) {
                  try { window.focus() } catch {}
                  ctx.uiWorkspace.openSession(data.sessionId)
                } else if (data.type === 'qq-status') {
                  const { type, ...global } = data
                  qqStore.setGlobal(global)
                } else if (data.type === 'qq-subscription') {
                  qqStore.setSession({ sessionId: data.sessionId, on: data.on, alias: data.alias })
                }
              } catch {}
            }
            source.onerror = () => {
              try { if (source) source.close() } catch {}
              source = null
              if (!closed) retry = setTimeout(connect, 2000)
            }
          }

          connect()
          return () => {
            closed = true
            if (retry) clearTimeout(retry)
            try { if (source) source.close() } catch {}
          }
        })

        // Settings form on the bundle's page in Settings -> Plugins.
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: '@local/dsh-notify-toast',
        }, BundleConfig))

        // Per-session QQ switch in the session header, beside the View tabs.
        // Rendered only when the global QQ channel is enabled.
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'qq-notify-toggle',
          order: 120,
          label: 'QQ 通知',
        }, QQToggle))
      },
    }
  },
})
