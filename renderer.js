// VARCO 3D sidebar view: opening it brings up the editor window; the view shows connection state,
// flows (switch / create) and show/hide controls.

const VIEW_ID = 'editor'

const errText = (e) => String((e && e.message) || e)
const el = (tag, style, text) => {
  const n = document.createElement(tag)
  if (style) n.style.cssText = style
  if (text != null) n.textContent = text
  return n
}
const BTN = 'padding:5px 12px;border:1px solid var(--line-strong);border-radius:6px;background:var(--bg3);color:var(--fg);font:inherit;cursor:pointer'
const PRIMARY = BTN + ';background:var(--accent2);border-color:var(--accent2);color:var(--accent-fg)'
const button = (text, primary, onClick) => {
  const b = el('button', primary ? PRIMARY : BTN, text)
  b.type = 'button'
  b.addEventListener('click', onClick)
  return b
}
const fmt = (iso) => {
  const d = new Date(iso)
  return isNaN(d) ? '' : d.toLocaleString('sv-SE').slice(0, 16)
}

export function activate(ctx) {
  ctx.registerView({ id: VIEW_ID, title: 'VARCO 3D', icon: '🧊', mount: (host) => mount(ctx, host) })
  ctx.registerCommand({ id: 'v3d.open', title: 'VARCO 3D 에디터 열기', run: () => ctx.channel.invoke('v3d.show') })
}

function mount(ctx, host) {
  const root = el('div', 'height:100%;overflow:auto;padding:20px 24px;font-family:var(--font-ui);font-size:var(--font-size-ui);color:var(--fg);background:var(--bg);display:flex;flex-direction:column;gap:14px')
  host.replaceChildren(root)
  let s = { loggedIn: null, points: null, flowId: null, visible: false }
  let flows = []
  let disposed = false

  const call = async (method, payload) => {
    try {
      return await ctx.channel.invoke(method, payload)
    } catch (e) {
      ctx.ui.toast('error', errText(e))
      return null
    }
  }

  const render = () => {
    const head = el('div', 'display:flex;align-items:center;gap:10px;flex-wrap:wrap')
    const dot = el('span', `width:9px;height:9px;border-radius:50%;background:${s.loggedIn === false ? 'var(--err)' : s.flowId ? 'var(--ok)' : 'var(--fg-subtle)'}`)
    const title = el('div', 'font-size:18px;font-weight:700;color:var(--fg-strong)', 'VARCO 3D')
    const sub = el(
      'div',
      'flex:1;color:var(--muted)',
      s.loggedIn === false ? '로그인 필요' : s.flowId ? `에디터 연결됨${s.points != null ? ` · ${s.points.toLocaleString()} 포인트` : ''}` : '에디터 준비 중…'
    )
    const actions = el('div', 'display:flex;gap:6px')
    if (s.loggedIn === false) actions.append(button('VARCO 로그인', true, () => call('v3d.login')))
    else {
      actions.append(
        s.visible ? button('에디터 창 숨기기', false, () => call('v3d.hide')) : button('에디터 창 열기', true, () => call('v3d.show')),
        button('새 플로우', false, async () => {
          const name = await ctx.ui.prompt({ title: '새 플로우', message: '플로우 이름', defaultValue: 'OMP Agent' })
          if (name == null) return
          await call('v3d.new', { name: name.trim() || 'OMP Agent' })
          loadFlows()
        })
      )
    }
    head.append(dot, title, sub, actions)

    const note = el(
      'div',
      'color:var(--fg-subtle);font-size:12px;line-height:1.6',
      '에디터는 OMP Studio 안 숨은 창에서 계속 실행되며, AI는 varco-3d MCP로 이 에디터를 조작합니다. 창을 닫아도 숨겨질 뿐 연결은 유지됩니다.'
    )

    const list = el('div', 'display:flex;flex-direction:column;gap:6px;max-width:820px')
    list.append(el('div', 'font-weight:700;color:var(--fg-strong);margin-top:4px', '플로우'))
    if (!flows.length) list.append(el('div', 'color:var(--muted)', s.loggedIn === false ? '로그인하면 플로우 목록이 표시됩니다.' : '불러오는 중…'))
    for (const f of flows) {
      const active = f.id === s.flowId
      const row = el(
        'div',
        `display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid ${active ? 'var(--accent)' : 'var(--line)'};border-radius:8px;background:var(--bg2)`
      )
      const name = el('div', 'flex:1;min-width:0')
      name.append(el('div', 'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', f.name || 'Untitled'))
      name.append(el('div', 'font-size:11px;color:var(--fg-subtle)', `노드 ${f.nodes}개 · 수정 ${fmt(f.updatedAt)} · ${f.id.slice(0, 8)}`))
      row.append(name)
      if (active) row.append(el('span', 'color:var(--ok);font-size:12px;font-weight:700', '● 연결 중'))
      row.append(button(active ? '보기' : '이 플로우로 전환', false, async () => {
        await call(active ? 'v3d.show' : 'v3d.open', { flowId: f.id })
      }))
      list.append(row)
    }
    root.replaceChildren(head, note, list)
  }

  const loadState = async () => {
    const next = await ctx.channel.invoke('v3d.state').catch(() => null)
    if (disposed || !next) return
    s = next
    render()
  }
  const loadFlows = async () => {
    const next = await ctx.channel.invoke('v3d.flows').catch(() => null)
    if (disposed || !next) return
    flows = next
    render()
  }

  const sub = ctx.channel.on('v3d.state', (next) => {
    const flowChanged = next && next.flowId !== s.flowId
    s = next || s
    render()
    if (flowChanged || (next && next.loggedIn && !flows.length)) loadFlows()
  })
  render()
  loadState().then(loadFlows)
  // Opening the sidebar button = bring up the editor window.
  call('v3d.show')

  return () => {
    disposed = true
    sub.dispose()
    host.replaceChildren()
  }
}
