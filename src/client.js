// dsh-delete-session - client half.
//
// DSH's sidebar session-row "..." menu (rename / fork / archive) is rendered
// by the core UI and offers no plugin slot for extra rows, so the delete item
// is injected at the DOM level:
//
//   * watch for the portalled session menu (body > [role="menu"]);
//   * walk the React fiber chain from that menu to the session node and read
//     its real id (props.node.id) - no title matching, no conversation jump;
//   * clone a native menu row so the new item keeps the core styling;
//   * open a risk-consent dialog and POST /dsh-delete-session/delete.
//
// The module is a classic client bundle (client-modules protocol): it
// registers a factory with window.__ModuleLoader__ and returns apply().
// No React, no SDK imports - theme tokens and DOM only, so it survives core
// UI revisions that keep the menu contract.
window.__ModuleLoader__.load({
  id: 'dsh-delete-session',
  factory: () => {
    const NS = 'dsh-delete-session'

    const zh = {
      menu: '删除会话',
      title: '删除会话',
      desc: '将永久删除该会话及其全部对话记录（会话日志、工作区记账与统计），此操作不可恢复。',
      cancel: '取消',
      confirm: '删除',
      deleting: '删除中…',
      ack: '我已了解，永久删除',
      dontAsk: '不再询问，以后直接删除',
      done: '已删除会话',
      failed: '删除失败：',
      busy: '该会话正被 DSH 打开，删除未能完成；请稍后重试（通常几秒后即可），或重启 DSH 后再试。',
      notFound: '未找到该会话（可能已被删除）。',
      untitled: '未命名会话',
      multiSelect: '多选',
      cancelSelect: '取消',
      selectedCount: (n) => `已选 ${n} 个`,
      deleteSelected: '删除',
      batchDone: (n) => `已删除 ${n} 个会话`,
      batchPartial: (ok, fail) => `已删除 ${ok} 个，${fail} 个失败`,
      batchFailed: '批量删除失败：',
    }

    const en = {
      menu: 'Delete session',
      title: 'Delete session',
      desc: 'This permanently deletes the session and all of its conversation records (log, workspace accounting and statistics). This action cannot be undone.',
      cancel: 'Cancel',
      confirm: 'Delete',
      deleting: 'Deleting...',
      ack: 'I understand - delete permanently',
      dontAsk: "Don't ask again",
      done: 'Session deleted',
      failed: 'Delete failed: ',
      busy: 'This session is currently open in DSH; the delete did not complete. Try again in a moment (usually a few seconds), or restart DSH and retry.',
      notFound: 'Session not found (it may already be deleted).',
      untitled: 'Untitled session',
      multiSelect: 'Select multiple',
      cancelSelect: 'Cancel',
      selectedCount: (n) => `${n} selected`,
      deleteSelected: 'Delete',
      batchDone: (n) => `Deleted ${n} session(s)`,
      batchPartial: (ok, fail) => `Deleted ${ok}, ${fail} failed`,
      batchFailed: 'Batch delete failed: ',
    }

    let localeSvc = null
    let sessionsSvc = null

    // Once the user ticks "don't ask again" the confirmation dialog is
    // skipped and the menu item deletes directly. Shift+click always opens
    // the dialog again, and clearing the key in localStorage restores it.
    const SKIP_KEY = 'dsh-delete-session:skip-confirm'

    function skipConfirm() {
      try { return localStorage.getItem(SKIP_KEY) === '1' } catch { return false }
    }

    function setSkipConfirm() {
      try { localStorage.setItem(SKIP_KEY, '1') } catch { /* private mode: ignore */ }
    }

    function postDelete(sessionId) {
      return fetch('/dsh-delete-session/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      }).then(async (res) => {
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
        return data
      })
    }

    function deleteNow(info) {
      postDelete(info.id)
        .then(() => {
          toast(t('done'))
          refreshList()
        })
        .catch((reason) => toast(t('failed') + String((reason && reason.message) || reason), true))
    }

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
      '.dsdel-check{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.5));background:transparent;flex:none;margin-right:8px;box-sizing:border-box;cursor:pointer}',
      '.dsdel-check-on{background:var(--dsw-alias-state-business-primary,#4c6ef5);border-color:var(--dsw-alias-state-business-primary,#4c6ef5)}',
      '.dsdel-check-on::after{content:"";width:9px;height:5px;border-left:2px solid #fff;border-bottom:2px solid #fff;transform:rotate(-45deg) translateY(-1px)}',
      '.dsdel-bar{position:fixed;left:12px;bottom:12px;z-index:2147483600;display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,.3));box-shadow:0 12px 32px rgba(0,0,0,.28);color:var(--dsw-alias-label-primary,inherit);font-size:13px;background:linear-gradient(var(--dsw-alias-bg-layer-2,#fff),var(--dsw-alias-bg-layer-2,#fff)),linear-gradient(var(--dsw-alias-bg-layer-2,#fff),var(--dsw-alias-bg-layer-2,#fff)),linear-gradient(var(--dsw-alias-bg-layer-2,#fff),var(--dsw-alias-bg-layer-2,#fff)),var(--dsw-alias-bg-base,#fff)}',
      '.dsdel-bar-count{white-space:nowrap}',
      '.dsdel-bar-btn{appearance:none;min-height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:var(--dsw-alias-fill-elevated,rgba(128,128,128,.08));color:var(--dsw-alias-label-primary,inherit);border-radius:8px;font-size:13px;cursor:pointer}',
      '.dsdel-bar-btn:disabled{opacity:.5;cursor:default}',
      '.dsdel-bar-danger{border-color:var(--dsw-alias-state-error-primary,#e5484d);background:var(--dsw-alias-state-error-primary,#e5484d);color:#fff}',
    ].join('')

    function ensureStyle() {
      if (document.querySelector('style[data-dsh-delete-session]')) return
      const style = document.createElement('style')
      style.dataset.dshDeleteSession = '1'
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

      const skip = document.createElement('label')
      skip.className = 'dsdel-ack'
      const skipBox = document.createElement('input')
      skipBox.type = 'checkbox'
      const skipText = document.createElement('span')
      skipText.textContent = t('dontAsk')
      skip.appendChild(skipBox)
      skip.appendChild(skipText)

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
      dialog.appendChild(skip)
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
        if (skipBox.checked) setSkipConfirm()
        postDelete(info.id)
          .then(() => {
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

    // --- multi-select ----------------------------------------------------------
    // Entered from the session menu ("多选"). While active, every session row
    // gets a round checkbox, clicking a row toggles it instead of opening the
    // conversation, and a bottom bar runs the batch delete. No select-all and
    // no per-row disabling: every row is selectable and the batch deletes
    // immediately (the single-session flow keeps its own consent dialog).

    let selecting = false
    const selected = new Set()
    let bar = null
    let decorateRaf = null
    let rowObserver = null

    function sessionIdFromRow(row) {
      let fiber = findFiber(row)
      let guard = 0
      while (fiber && guard++ < 300) {
        const props = fiber.memoizedProps
        if (props && props.node && typeof props.node.id === 'string' && props.node.id) return props.node.id
        fiber = fiber.return
      }
      return null
    }

    function decorateRows() {
      const rows = document.querySelectorAll('[role="treeitem"]')
      rows.forEach((row) => {
        const id = sessionIdFromRow(row)
        if (!id) return
        let check = row.querySelector(':scope > .dsdel-check')
        if (!check) {
          check = document.createElement('span')
          check.className = 'dsdel-check'
          check.setAttribute('data-dsh-delete-session', 'check')
          row.insertBefore(check, row.firstChild)
        }
        check.classList.toggle('dsdel-check-on', selected.has(id))
      })
    }

    function scheduleDecorate() {
      if (decorateRaf !== null) return
      decorateRaf = requestAnimationFrame(() => {
        decorateRaf = null
        try { decorateRows() } catch { /* best-effort DOM shim */ }
      })
    }

    function updateBar() {
      if (!bar) return
      const count = bar.querySelector('.dsdel-bar-count')
      if (count) count.textContent = t('selectedCount')(selected.size)
      const del = bar.querySelector('.dsdel-bar-danger')
      if (del) del.disabled = selected.size === 0
    }

    function toggleSelect(id) {
      if (selected.has(id)) selected.delete(id)
      else selected.add(id)
      scheduleDecorate()
      updateBar()
    }

    function onSelectClickCapture(e) {
      if (!selecting) return
      const row = e.target && e.target.closest ? e.target.closest('[role="treeitem"]') : null
      if (!row) return
      const id = sessionIdFromRow(row)
      if (!id) return
      e.preventDefault()
      e.stopPropagation()
      toggleSelect(id)
    }

    function onSelectKeydown(e) {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      exitSelection()
    }

    function buildBar() {
      const el = document.createElement('div')
      el.className = 'dsdel-bar'
      el.setAttribute('role', 'toolbar')
      const count = document.createElement('span')
      count.className = 'dsdel-bar-count'
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'dsdel-bar-btn'
      cancel.textContent = t('cancelSelect')
      cancel.addEventListener('click', (e) => { e.stopPropagation(); exitSelection() })
      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'dsdel-bar-btn dsdel-bar-danger'
      del.textContent = t('deleteSelected')
      del.addEventListener('click', (e) => { e.stopPropagation(); runBatchDelete() })
      el.appendChild(count)
      el.appendChild(cancel)
      el.appendChild(del)
      document.body.appendChild(el)
      return el
    }

    function enterSelection() {
      if (selecting) return
      selecting = true
      selected.clear()
      ensureStyle()
      if (!bar) bar = buildBar()
      bar.style.display = 'flex'
      document.addEventListener('click', onSelectClickCapture, true)
      document.addEventListener('keydown', onSelectKeydown, true)
      if (typeof MutationObserver === 'function') {
        rowObserver = new MutationObserver(scheduleDecorate)
        rowObserver.observe(document.body, { childList: true, subtree: true })
      }
      scheduleDecorate()
      updateBar()
    }

    function exitSelection() {
      if (!selecting) return
      selecting = false
      selected.clear()
      if (bar) bar.style.display = 'none'
      document.removeEventListener('click', onSelectClickCapture, true)
      document.removeEventListener('keydown', onSelectKeydown, true)
      if (rowObserver) { rowObserver.disconnect(); rowObserver = null }
      document.querySelectorAll('.dsdel-check').forEach((el) => el.remove())
    }

    function postDeleteMany(sessionIds) {
      return fetch('/dsh-delete-session/delete-many', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionIds }),
      }).then(async (res) => {
        let data = {}
        try { data = await res.json() } catch { /* keep {} */ }
        if (!res.ok || !data.ok) throw new Error((data && data.error) || `HTTP ${res.status}`)
        return data
      })
    }

    function runBatchDelete() {
      const ids = [...selected]
      if (ids.length === 0) return
      const del = bar ? bar.querySelector('.dsdel-bar-danger') : null
      if (del) del.disabled = true
      postDeleteMany(ids)
        .then((data) => {
          const failed = data.failed || 0
          const deleted = data.deleted || 0
          toast(failed > 0 ? t('batchPartial')(deleted, failed) : t('batchDone')(deleted), failed > 0)
          exitSelection()
          refreshList()
        })
        .catch((reason) => {
          if (del) del.disabled = false
          toast(t('batchFailed') + String((reason && reason.message) || reason), true)
        })
    }

    // --- sidebar menu injection ------------------------------------------------

    const TRASH_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M9 7V4h6v3"/></svg>'
    const SELECT_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="5" cy="7" r="2"/><circle cx="5" cy="17" r="2"/><path d="M11 7h9"/><path d="M11 17h9"/></svg>'

    // Clone a native menu row so an injected action keeps the core styling.
    function buildMenuItem(menuEl, label, iconSvg, danger, onClick) {
      const proto = menuEl.querySelector('[role="menuitem"]')
      if (!proto) return null
      const protoWrap = proto.parentElement
      const wrap = protoWrap ? protoWrap.cloneNode(false) : document.createElement('div')
      if (protoWrap && protoWrap.className) wrap.className = protoWrap.className
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      if (proto.className) button.className = proto.className
      if (danger) button.style.color = 'var(--dsw-alias-state-error-primary,#e5484d)'
      const icon = document.createElement('span')
      icon.style.cssText = 'display:inline-flex;flex:none;width:16px;height:16px;align-items:center;justify-content:center'
      icon.innerHTML = iconSvg
      const text = document.createElement('span')
      text.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      text.textContent = label
      button.appendChild(icon)
      button.appendChild(text)
      button.addEventListener('click', (e) => {
        e.stopPropagation()
        e.preventDefault()
        closeMenu()
        onClick(e)
      })
      wrap.appendChild(button)
      return wrap
    }

    function augmentMenu(menuEl, info) {
      if (menuEl.querySelector('[data-dsh-delete-session="1"]')) return
      const viewport = menuEl.querySelector('[role="presentation"]') || menuEl.firstElementChild
      if (!viewport) return

      const selectWrap = buildMenuItem(menuEl, t('multiSelect'), SELECT_ICON, false, () => enterSelection())
      const deleteWrap = buildMenuItem(menuEl, t('menu'), TRASH_ICON, true, (e) => {
        if (skipConfirm() && !e.shiftKey) deleteNow(info)
        else openDialog(info)
      })
      if (selectWrap) {
        selectWrap.firstChild.setAttribute('data-dsh-delete-session', 'select')
        viewport.appendChild(selectWrap)
      }
      if (deleteWrap) {
        deleteWrap.firstChild.setAttribute('data-dsh-delete-session', '1')
        viewport.appendChild(deleteWrap)
      }

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
