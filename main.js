// VARCO 3D host — keeps the VARCO 3D flow editor loaded in a hidden window inside OMP Studio,
// so the remote `varco-3d` MCP (https://3d.varco.ai/api/mcp) always has an editor session to act on.
// No external browser needed. The user logs in once in this window (cookies persist in PARTITION).

const ORIGIN = 'https://3d.varco.ai'
const PARTITION = 'persist:varco-3d'
const MCP_SERVER = 'varco-3d'
const DEFAULT_FLOW_NAME = 'OMP Agent'

const instances = new Set()

exports.activate = async (ctx) => {
  const { BrowserWindow, session } = require('electron')
  const ses = session.fromPartition(PARTITION)
  const st = { win: null, flowId: null, loggedIn: null, points: null, loginTimer: null, retryTimer: null, disposing: false }
  instances.add(st)

  // ---------- web API (tRPC, cookies of the partition) ----------
  const trpc = async (proc, input, mutate) => {
    const url = `${ORIGIN}/api/trpc/${proc}?batch=1` + (mutate ? '' : `&input=${encodeURIComponent(JSON.stringify({ 0: input || {} }))}`)
    const res = await ses.fetch(url, mutate ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ 0: input || {} }) } : {})
    const body = await res.json().catch(() => null)
    const item = Array.isArray(body) ? body[0] : body
    if (res.status === 401 || (item && item.error && /UNAUTHORIZED/i.test(JSON.stringify(item.error)))) {
      const e = new Error('VARCO 3D login required')
      e.login = true
      throw e
    }
    if (!res.ok || !item || item.error) throw new Error(`VARCO 3D ${proc} failed: HTTP ${res.status} ${JSON.stringify(item && item.error).slice(0, 300)}`)
    return item.result.data
  }

  const checkLogin = async () => {
    try {
      const b = await trpc('user.getPointBalance')
      st.loggedIn = true
      st.points = b && typeof b.remainingPoints === 'number' ? b.remainingPoints : null
    } catch (e) {
      if (e.login) st.loggedIn = false
      else throw e
    }
    return st.loggedIn
  }

  const listFlows = async () => {
    const flows = await trpc('customWorkflowV2.listWorkflows')
    return (flows || []).filter((f) => !f.deletedAt).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  }
  const createFlow = async (name) => {
    const f = await trpc('customWorkflowV2.createWorkflow', { name: name || DEFAULT_FLOW_NAME }, true)
    if (!f || !f.id) throw new Error('VARCO 3D did not return a flow id')
    return f
  }

  // ---------- MCP view of editor sessions ----------
  const mcpSessions = async () => {
    try {
      const r = await ctx.app.mcp.callTool(MCP_SERVER, 'list_flow_sessions', {}, { projectDir: process.cwd(), timeoutMs: 15000 })
      if (r.isError) return null
      const data = JSON.parse(r.text)
      return Array.isArray(data.sessions) ? data.sessions : null
    } catch {
      return null // MCP unavailable or not authorized: unknown
    }
  }
  const waitForSession = async (flowId, ms) => {
    const until = Date.now() + ms
    for (;;) {
      const list = await mcpSessions()
      if (list === null) return null
      if (list.some((s) => s.flowId === flowId)) return true
      if (Date.now() > until) return false
      await new Promise((r) => setTimeout(r, 1500))
    }
  }

  // ---------- editor window ----------
  const emit = () =>
    ctx.channel.emit('v3d.state', snapshot())
  const snapshot = () => ({ loggedIn: st.loggedIn, points: st.points, flowId: st.flowId, visible: !!(st.win && !st.win.isDestroyed() && st.win.isVisible()) })

  const getWin = () => {
    if (st.disposing) throw new Error('VARCO 3D plugin is reloading')
    if (st.win && !st.win.isDestroyed()) return st.win
    const win = new BrowserWindow({
      width: 1400,
      height: 900,
      show: false,
      title: 'VARCO 3D',
      autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, backgroundThrottling: false }
    })
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(ORIGIN) || /auth|login|accounts\.google|kakao|naver|apple/i.test(url)) return { action: 'allow' }
      require('electron').shell.openExternal(url)
      return { action: 'deny' }
    })
    win.on('close', (ev) => {
      if (!st.disposing) {
        ev.preventDefault() // closing hides: the editor must keep running for the MCP
        win.hide()
        emit()
      }
    })
    win.on('show', emit)
    win.on('hide', emit)
    win.webContents.on('render-process-gone', () => scheduleReload('renderer crashed'))
    win.webContents.on('did-fail-load', (_e, code, desc, _url, isMain) => {
      if (isMain && code !== -3) scheduleReload(`load failed: ${desc}`)
    })
    st.win = win
    return win
  }

  const scheduleReload = (why) => {
    if (st.disposing) return
    ctx.log('editor reload scheduled:', why)
    clearTimeout(st.retryTimer)
    st.retryTimer = setTimeout(() => {
      if (!st.disposing && st.flowId) loadFlow(st.flowId).catch((e) => ctx.log('reload failed', e.message))
    }, 5000)
  }

  const loadFlow = async (flowId) => {
    const win = getWin()
    st.flowId = flowId
    await ctx.storage.set('lastFlowId', flowId)
    await win.loadURL(`${ORIGIN}/flow/${encodeURIComponent(flowId)}`)
    emit()
  }

  const pickFlow = async (preferred) => {
    const flows = await listFlows()
    if (preferred) {
      if (!flows.some((f) => f.id === preferred)) throw new Error(`Flow ${preferred} not found in this VARCO account.`)
      return preferred
    }
    const last = await ctx.storage.get('lastFlowId')
    if (last && flows.some((f) => f.id === last)) return last
    if (flows.length) return flows[0].id
    return (await createFlow()).id
  }

  const openLogin = () => {
    const win = getWin()
    win.loadURL(`${ORIGIN}/flow`)
    win.show()
    win.focus()
    ctx.app.ui.notify('info', 'VARCO 3D 창에서 로그인하세요. 로그인하면 창이 숨겨지고 에디터가 자동으로 연결됩니다.')
    clearInterval(st.loginTimer)
    st.loginTimer = setInterval(async () => {
      try {
        if (await checkLogin()) {
          clearInterval(st.loginTimer)
          await start()
          if (st.win && !st.win.isDestroyed()) st.win.hide()
          ctx.app.ui.notify('info', 'VARCO 3D 연결 완료')
        }
      } catch {
        // network hiccup; next tick
      }
    }, 2500)
    emit()
  }

  // Ensure the editor is running on a flow (login if needed). Returns { flowId } or { login: true }.
  const start = async (flowId) => {
    if (!(await checkLogin())) {
      openLogin()
      return { login: true }
    }
    const id = await pickFlow(flowId)
    const current = st.win && !st.win.isDestroyed() ? st.win.webContents.getURL() : ''
    if (!current.includes(`/flow/${id}`)) await loadFlow(id)
    else st.flowId = id
    emit()
    return { flowId: id }
  }

  // ---------- agent tool ----------
  const text = (t, isError) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) })
  ctx.registerHostTool({
    definition: {
      name: 'varco3d_editor',
      label: 'VARCO 3D: editor',
      description:
        'Controls the VARCO 3D flow editor that OMP Studio keeps running in a hidden window (no external browser needed). The varco-3d MCP graph tools act on this editor. ' +
        'Call with action "open" before using the varco-3d MCP when list_flow_sessions is empty or you need a specific/new flow: it (re)loads the flow, waits until the MCP sees it and returns the flowId. ' +
        'Actions: status | open {flowId?} (default: last used flow) | new {name?} (creates a fresh flow and opens it) | show (let the user watch the editor) | hide. ' +
        'If the user is logged out, a login window is shown; ask the user to log in, then call open again.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'open', 'new', 'show', 'hide'] },
          flowId: { type: 'string', description: 'open: flow to load.' },
          name: { type: 'string', description: 'new: flow name. Default "OMP Agent".' }
        },
        required: ['action'],
        additionalProperties: false
      }
    },
    async execute(a) {
      try {
        if (a.action === 'status') {
          const logged = await checkLogin()
          const sessions = await mcpSessions()
          return text(
            `Logged in: ${logged}${st.points != null ? ` (points ${st.points})` : ''}\nEditor flow: ${st.flowId || 'none'}; window ${st.win && !st.win.isDestroyed() && st.win.isVisible() ? 'visible' : 'hidden'}\n` +
              `MCP sessions: ${sessions === null ? 'unknown (varco-3d MCP not reachable)' : JSON.stringify(sessions)}`
          )
        }
        if (a.action === 'show' || a.action === 'hide') {
          const win = getWin()
          if (!win.webContents.getURL()) await start()
          if (a.action === 'show') (win.show(), win.focus())
          else win.hide()
          return text(`Editor window ${a.action === 'show' ? 'shown' : 'hidden'}.`)
        }
        let target = a.flowId
        if (a.action === 'new') {
          if (!(await checkLogin())) {
            openLogin()
            return text('Not logged in to VARCO 3D. A login window was shown in OMP Studio; ask the user to log in, then call again.', true)
          }
          target = (await createFlow(a.name)).id
        }
        const r = await start(target)
        if (r.login) return text('Not logged in to VARCO 3D. A login window was shown in OMP Studio; ask the user to log in, then call varco3d_editor {action:"open"} again.', true)
        const seen = await waitForSession(r.flowId, 30000)
        if (seen === false) {
          scheduleReload('MCP did not see the editor')
          return text(`Editor loaded flow ${r.flowId}, but the varco-3d MCP does not list it yet. Wait ~10 s and call list_flow_sessions again.`, true)
        }
        return text(`VARCO 3D editor ready on flowId ${r.flowId}${seen === null ? ' (could not verify via MCP)' : ''}. Use this flowId with the varco-3d MCP tools.`)
      } catch (e) {
        return text(String((e && e.message) || e), true)
      }
    }
  })

  // ---------- renderer channel ----------
  ctx.channel.handle('v3d.state', async () => {
    await checkLogin().catch(() => {})
    return snapshot()
  })
  const showWin = async () => {
    const win = getWin()
    const url = win.webContents.getURL()
    if (!url || url === 'about:blank') {
      const r = await start()
      if (r.login) return
    }
    win.show()
    win.focus()
  }
  ctx.channel.handle('v3d.show', showWin)
  ctx.channel.handle('v3d.hide', async () => {
    if (st.win && !st.win.isDestroyed()) st.win.hide()
  })
  ctx.channel.handle('v3d.login', async () => openLogin())
  ctx.channel.handle('v3d.flows', async () =>
    (await listFlows()).map((f) => ({ id: f.id, name: f.name, updatedAt: f.updatedAt, nodes: Array.isArray(f.nodes) ? f.nodes.length : 0 }))
  )
  ctx.channel.handle('v3d.open', async (p) => {
    const r = await start(p && p.flowId)
    if (!r.login) await showWin()
    return r
  })
  ctx.channel.handle('v3d.new', async (p) => {
    const f = await createFlow(p && p.name)
    await start(f.id)
    await showWin()
    return { flowId: f.id }
  })

  // Auto-start so the MCP has an editor whenever OMP Studio runs.
  start().catch((e) => ctx.log('auto-start failed:', e && e.message))
}

exports.deactivate = () => {
  for (const st of instances) {
    st.disposing = true
    clearInterval(st.loginTimer)
    clearTimeout(st.retryTimer)
    if (st.win && !st.win.isDestroyed()) st.win.destroy()
  }
  instances.clear()
}
