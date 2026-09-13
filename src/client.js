// dsh-session-delete - client half.
//
// DSH's sidebar session-row "..." menu (rename / fork / archive) is rendered
// by the core UI and offers no plugin slot for extra rows, so the delete item
// is injected at the DOM level:
//
//   * watch for the portalled session menu (body > [role="menu"]);
//   * walk the React fiber chain from that menu to the session node and read
//     its real id (props.node.id) - no title matching, no conversation jump;
//   * clone a native menu row so the new item keeps the core styling;
//   * open a risk-consent dialog and POST /dsh-session-delete/delete.
//
// The module is a classic client bundle (client-modules protocol): it
// registers a factory with window.__ModuleLoader__ and returns apply().
// No React, no SDK imports - theme tokens and DOM only, so it survives core
// UI revisions that keep the menu contract.
window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory: () => {
    const NS = 'dsh-session-delete'

    const zh = {
      menu: '删除会话',
      title: '删除会话',
      desc: '将永久删除该会话及其全部对话记录（会话日志、工作区记账与统计），此操作不可恢复。',
      cancel: '取消',
      confirm: '删除',
      deleting: '删除中…',
      ack: '我已了解，永久删除',
      done: '已删除会话',
      failed: '删除失败：',
      busy: '该会话正被 DSH 打开，暂时无法删除；请重启 DSH 后再试。',
      notFound: '未找到该会话（可能已被删除）。',
      untitled: '未命名会话',
    }

    const en = {
      menu: 'Delete session',
      title: 'Delete session',
      desc: 'This permanently deletes the session and all of its conversation records (log, workspace accounting and statistics). This action cannot be undone.',
      cancel: 'Cancel',
      confirm: 'Delete',
      deleting: 'Deleting...',
      ack: 'I understand - delete permanently',
      done: 'Session deleted',
      failed: 'Delete failed: ',
      busy: 'This session is currently open in DSH and cannot be deleted yet. Restart DSH and try again.',
      notFound: 'Session not found (it may already be deleted).',
      untitled: 'Untitled session',
    }

    let localeSvc = null
    let sessionsSvc = null

    function browserLang() {
      if (typeof navigator === 'undefined') return 'zh'
      for (const tag of (navigator.languages || []).concat([navigator.language])) {
        const primary = String(tag || '').toLowerCase().split('-')[0]
        if (primary === 'zh' || primary === 'en') return primary
      }
      return 'zh'
    }

    function t(key) {
      if (localeSvc && typeof localeSvc.translate === 'function') {
        try {
          const text = localeSvc.translate(NS, key)
          if (typeof text === 'string' && text !== key) return text
        } catch {
          // fall back to the built-in dictionaries
        }
      }
      return (browserLang() === 'en' ? en : zh)[key] || key
    }

    // --- fiber access ----------------------------------------------------------

    function findFiber(el) {
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'))
      return key ? el[key] : null
    }

    // Walk up from the portalled menu element to the session row component
    // that carries `node.id`. A menu without such a node is not a session
    // menu (settings, header dropdowns) and is left alone.
    function sessionInfoFromMenu(menuEl) {
      let fiber = findFiber(menuEl)
      let guard = 0
      while (fiber && guard++ < 300) {
        const props = fiber.memoizedProps
        if (props && props.node && typeof props.node.id === 'string' && props.node.id) {
          const title = props.node.title || props.node.name || null
          return { id: props.node.id, title: typeof title === 'string' ? title : null }
        }
        fiber = fiber.return
      }
      return null
    }

    // --- styles ----------------------------------------------------------------

    const CSS = [
      '.dsdel-backdrop{position:fixed;inset:0;z-index:2147483600;background:rgba(0,0,0,.58);display:flex;align-items:center;justify-content:center;padding:16px}',
      '.dsdel-dialog{width:min(420px,92vw);border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,.3));border-radius:14px;padding:18px;box-shadow:0 16px 48px rgba(0,0,0,.32);display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary,inherit);background:linear-gradient(var(--dsw-alias-bg-layer-2,#fff),var(--dsw-alias-bg-layer-2,#fff)),linear-gradient(var(--dsw-alias-bg-layer-2,#fff),var(--dsw-alias-bg-layer-2,#fff)),linear-gradient(var(--dsw-alias-bg-layer-2,#fff),var(--dsw-alias-bg-layer-2,#fff)),var(--dsw-alias-bg-base,#fff);-webkit-backdrop-filter:blur(18px) saturate(140%);backdrop-filter:blur(18px) saturate(140%)}',
      '.dsdel-title{font-size:15px;font-weight:650;color:var(--dsw-alias-label-primary,inherit);margin:0}',
      '.dsdel-text{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary,#666);margin:0;word-break:break-all}',
      '.dsdel-meta{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#888);margin:0;word-break:break-all}',
      '.dsdel-ack{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,inherit);cursor:pointer}',
      '.dsdel-ack input{width:15px;height:15px;accent-color:var(--dsw-alias-state-error-primary,#e5484d);cursor:pointer;flex:none}',
      '.dsdel-error{font-size:12px;line-height:16px;color:var(--dsw-alias-state-error-primary,#e5484d);margin:0}',
      '.dsdel-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}',
      '.dsdel-btn{appearance:none;min-height:32px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:var(--dsw-alias-fill-elevated,rgba(128,128,128,.08));color:var(--dsw-alias-label-primary,inherit);border-radius:8px;font-size:13px;cursor:pointer}',
      '.dsdel-btn:disabled{opacity:.5;cursor:default}',
      '.dsdel-danger{border-color:var(--dsw-alias-state-error-primary,#e5484d);background:var(--dsw-alias-state-error-primary,#e5484d);color:#fff}',
      '.dsdel-toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:2147483601;background:Canvas;color:CanvasText;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);padding:9px 16px;border-radius:999px;font-size:12px;box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:min(92vw,460px);cursor:pointer}',
    ].join('')

    function ensureStyle() {
      if (document.querySelector('style[data-dsh-session-delete]')) return
      const style = document.createElement('style')
      style.dataset.dshSessionDelete = '1'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // --- feedback --------------------------------------------------------------

    function closeMenu() {
      try { document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) } catch { /* ignore */ }
      try { document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) } catch { /* ignore */ }
    }

    function toast(text, isError) {
      const el = document.createElement('div')
      el.className = 'dsdel-toast'
      el.setAttribute('role', 'status')
      el.textContent = text
      if (isError) {
        el.style.background = '#4A1D1D'
        el.style.color = '#FFD9D9'
      }
      document.body.appendChild(el)
      const kill = () => el.remove()
      el.addEventListener('click', kill)
      setTimeout(kill, 3200)
    }

    function refreshList() {
      const svc = sessionsSvc
      if (svc) {
        try {
          if (typeof svc.refresh === 'function') { svc.refresh(); return }
          if (typeof svc.refreshList === 'function') { svc.refreshList(); return }
        } catch {
          // fall through to reload
        }
      }
      try { window.location.reload() } catch { /* ignore */ }
    }

    // --- dialog ----------------------------------------------------------------

    function openDialog(info) {
      ensureStyle()
      const backdrop = document.createElement('div')
      backdrop.className = 'dsdel-backdrop'
      const dialog = document.createElement('div')
      dialog.className = 'dsdel-dialog'

      const title = document.createElement('h3')
      title.className = 'dsdel-title'
      title.textContent = t('title')

      const meta = document.createElement('p')
      meta.className = 'dsdel-meta'
      meta.textContent = `${info.title || t('untitled')} · ${info.id}`

      const text = document.createElement('p')
      text.className = 'dsdel-text'
      text.textContent = t('desc')

      const ack = document.createElement('label')
      ack.className = 'dsdel-ack'
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      const ackText = document.createElement('span')
      ackText.textContent = t('ack')
      ack.appendChild(checkbox)
      ack.appendChild(ackText)

      const error = document.createElement('p')
      error.className = 'dsdel-error'
      error.style.display = 'none'

      const actions = document.createElement('div')
      actions.className = 'dsdel-actions'
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'dsdel-btn'
      cancel.textContent = t('cancel')
      const confirm = document.createElement('button')
      confirm.type = 'button'
      confirm.className = 'dsdel-btn dsdel-danger'
      confirm.textContent = t('confirm')
      confirm.disabled = true
      actions.appendChild(cancel)
      actions.appendChild(confirm)

      dialog.appendChild(title)
      dialog.appendChild(meta)
      dialog.appendChild(text)
      dialog.appendChild(ack)
      dialog.appendChild(error)
      dialog.appendChild(actions)
      backdrop.appendChild(dialog)
      document.body.appendChild(backdrop)

      let busy = false
      const close = () => {
        if (busy) return
        backdrop.remove()
      }
      checkbox.addEventListener('change', () => { confirm.disabled = !checkbox.checked })
      cancel.addEventListener('click', close)
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close() })
      backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })

      confirm.addEventListener('click', () => {
        if (busy || !checkbox.checked) return
        busy = true
        confirm.disabled = true
        cancel.disabled = true
        confirm.textContent = t('deleting')
        error.style.display = 'none'
        fetch('/dsh-session-delete/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: info.id }),
        })
          .then(async (res) => {
            let data = {}
            try { data = await res.json() } catch { /* keep {} */ }
            if (!res.ok || !data.ok) {
              const code = data && data.code
              const message = code === 'busy'
                ? t('busy')
                : code === 'not-found'
                  ? t('notFound')
                  : (data && data.error) || `HTTP ${res.status}`
              throw new Error(message)
            }
            backdrop.remove()
            toast(t('done'))
            refreshList()
          })
          .catch((reason) => {
            busy = false
            confirm.disabled = !checkbox.checked
            cancel.disabled = false
            confirm.textContent = t('confirm')
            error.textContent = t('failed') + String((reason && reason.message) || reason)
            error.style.display = 'block'
          })
      })
    }

    // --- sidebar menu injection ------------------------------------------------

    const TRASH_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M9 7V4h6v3"/></svg>'

    function augmentMenu(menuEl, info) {
      if (menuEl.querySelector('[data-dsh-session-delete]')) return
      const viewport = menuEl.querySelector('[role="presentation"]') || menuEl.firstElementChild
      if (!viewport) return
      const proto = menuEl.querySelector('[role="menuitem"]')
      if (!proto) return
      const protoWrap = proto.parentElement
      const wrap = protoWrap ? protoWrap.cloneNode(false) : document.createElement('div')
      if (protoWrap && protoWrap.className) wrap.className = protoWrap.className

      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      button.setAttribute('data-dsh-session-delete', '1')
      if (proto.className) button.className = proto.className
      button.style.color = 'var(--dsw-alias-state-error-primary,#e5484d)'

      const icon = document.createElement('span')
      icon.style.cssText = 'display:inline-flex;flex:none;width:16px;height:16px;align-items:center;justify-content:center'
      icon.innerHTML = TRASH_ICON
      const label = document.createElement('span')
      label.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      label.textContent = t('menu')

      button.appendChild(icon)
      button.appendChild(label)
      button.addEventListener('click', (e) => {
        e.stopPropagation()
        e.preventDefault()
        closeMenu()
        openDialog(info)
      })
      wrap.appendChild(button)
      viewport.appendChild(wrap)

      // The portalled menu measured its height before this row existed; nudge
      // the core placement so the grown card is re-clamped on screen.
      window.dispatchEvent(new Event('resize'))
    }

    function install() {
      if (typeof document === 'undefined' || !document.body) return null
      ensureStyle()
      const seen = new WeakSet()
      const scan = () => {
        const menus = document.querySelectorAll('body > [role="menu"]')
        menus.forEach((menuEl) => {
          if (seen.has(menuEl)) return
          let info = null
          try { info = sessionInfoFromMenu(menuEl) } catch { /* ignore */ }
          if (!info) return
          seen.add(menuEl)
          try { augmentMenu(menuEl, info) } catch { /* best-effort DOM shim */ }
        })
      }
      scan()
      const observer = new MutationObserver(scan)
      observer.observe(document.body, { childList: true, subtree: false })
      return () => observer.disconnect()
    }

    function apply(ctx) {
      sessionsSvc = ctx.get('sessions') || null
      if (!sessionsSvc) {
        try { ctx.inject(['sessions'], (sub) => { sessionsSvc = sub.sessions }) } catch { /* optional */ }
      }
      localeSvc = ctx.get('locale') || null
      if (!localeSvc) {
        try { ctx.inject(['locale'], (sub) => { localeSvc = sub.locale }) } catch { /* optional */ }
      }
      const dispose = install()
      if (dispose) ctx.effect(() => dispose)
    }

    return { apply }
  },
})
