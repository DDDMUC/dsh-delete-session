// dsh-delete-session - client half.
//
// Integration is entirely through the host's public slot contract - no menu
// scraping, no React internals:
//
//   * `sidebar.workspaces.session.menu.item` - two rows registered beside the
//     shipped pin/rename/fork/archive rows: "Select multiple" (order 409) and
//     "Delete session" (order 410, in the host's danger colour). Each entry
//     renders one `role="menuitem"` button through ui-primitives'
//     `MenuItemButton`, so it inherits the host styling and joins the menu's
//     own keyboard walk and focus return.
//   * `shell.overlay` - the confirmation dialog, rendered with the host's
//     `Modal` primitive instead of a hand-built backdrop.
//   * `plugins.row.config` - the plugin page card that decides whether a
//     delete asks first.
//
// The one surface with no usable slot is the multi-select checkbox on each
// Session row: `sidebar.session.row.leading` is the *else* branch of the host's
// `showStatus ? <SessionStatusDots/> : renderSlot(...)`, so it disappears the
// moment a row is busy - exactly when a batch delete is most likely. Those
// checkboxes therefore stay a DOM decoration over `[role="treeitem"]`, and row
// identity comes from the host's own `data-row-key="session:<id>"` attribute
// rather than from a walk up the React fiber tree.
//
// The module is a classic client bundle (client-modules protocol): it registers
// a factory with `window.__ModuleLoader__` and returns apply().
window.__ModuleLoader__.load({
  id: 'dsh-delete-session',
  factory: (require) => {
    const NS = 'dsh-delete-session'
    const react = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const { createElement: h, Fragment } = react

    const zh = {
      menu: '删除会话',
      multiSelect: '多选',
      title: '删除会话',
      desc: '将永久删除该会话及其全部对话记录（会话日志、工作区记账与统计），此操作不可恢复。',
      cancel: '取消',
      confirm: '删除',
      deleting: '删除中…',
      dontAsk: '不再询问，以后直接删除',
      done: '已删除会话',
      failed: '删除失败：',
      busy: '该会话正被 DSH 打开，删除未能完成；请稍后重试（通常几秒后即可），或重启 DSH 后再试。',
      notFound: '未找到该会话（可能已被删除）。',
      untitled: '未命名会话',
      cancelSelect: '取消',
      selectedCount: (n) => `已选 ${n} 个`,
      batchRunning: (done, total) => `正在删除 ${done}/${total}…`,
      deleteSelected: '删除',
      batchDone: (n) => `已删除 ${n} 个会话`,
      batchPartial: (ok, fail) => `已删除 ${ok} 个，${fail} 个失败`,
      batchFailed: '批量删除失败：',
      pageAsk: '删除时询问',
      pageHintAsk: '每次删除会话前都会弹出确认框。',
      pageHintAuto: '删除会话会直接执行，不再询问。',
      pageSummaryAsk: '删除前询问',
      pageSummaryAuto: '直接删除',
    }

    const en = {
      menu: 'Delete session',
      multiSelect: 'Select multiple',
      title: 'Delete session',
      desc: 'This permanently deletes the session and all of its conversation records (log, workspace accounting and statistics). This action cannot be undone.',
      cancel: 'Cancel',
      confirm: 'Delete',
      deleting: 'Deleting...',
      dontAsk: "Don't ask again",
      done: 'Session deleted',
      failed: 'Delete failed: ',
      busy: 'This session is currently open in DSH; the delete did not complete. Try again in a moment (usually a few seconds), or restart DSH and retry.',
      notFound: 'Session not found (it may already be deleted).',
      untitled: 'Untitled session',
      cancelSelect: 'Cancel',
      selectedCount: (n) => `${n} selected`,
      batchRunning: (done, total) => `Deleting ${done}/${total}...`,
      deleteSelected: 'Delete',
      batchDone: (n) => `Deleted ${n} session(s)`,
      batchPartial: (ok, fail) => `Deleted ${ok}, ${fail} failed`,
      batchFailed: 'Batch delete failed: ',
      pageAsk: 'Ask before deleting',
      pageHintAsk: 'Show a confirmation dialog before every session delete.',
      pageHintAuto: 'Delete the session right away without asking.',
      pageSummaryAsk: 'Ask before deleting',
      pageSummaryAuto: 'Delete without asking',
    }

    let sessionsSvc = null
    let localeSvc = null

    function browserLang() {
      if (typeof navigator === 'undefined') return 'zh'
      for (const tag of (navigator.languages || []).concat([navigator.language])) {
        const primary = String(tag || '').toLowerCase().split('-')[0]
        if (primary === 'zh' || primary === 'en') return primary
      }
      return 'zh'
    }

    // The DOM decoration layer (row checkboxes, batch bar, toast) is not a slot
    // occupant, so it has no injected `t`; it uses the built-in dictionaries and
    // honours the registered `locale` namespace when the host provides one.
    // Slot components receive the host-injected `t` and use that instead.
    function t(key, a, b) {
      if (localeSvc && typeof localeSvc.translate === 'function') {
        try {
          const text = localeSvc.translate(NS, key)
          if (typeof text === 'string' && text !== key) return text
        } catch {
          // fall back to the built-in dictionaries
        }
      }
      const value = (browserLang() === 'en' ? en : zh)[key]
      return typeof value === 'function' ? value(a, b) : value || key
    }

    // --- state -----------------------------------------------------------------
    // One module-level store shared by the slot components and the DOM layer.
    // Components read it through `useSnapshot`, so each stays a plain function of
    // the store with no local state - which also keeps it drivable from the
    // offline test without a React renderer.

    const state = {
      /** { sessionId, title, busy, error, skip } while a confirmation dialog is up. */
      dialog: null,
      selecting: false,
      selected: new Set(),
      /** Rows hidden optimistically while their delete request is in flight. */
      pending: new Set(),
      /** { total, done, failed } while a batch delete runs, else null. */
      batch: null,
    }

    const listeners = new Set()

    function buildSnapshot() {
      return {
        dialog: state.dialog,
        selecting: state.selecting,
        selected: state.selected,
        pending: state.pending,
        batch: state.batch,
        selectedCount: state.selected.size,
      }
    }

    // `useSyncExternalStore` needs a value that is stable between notifications.
    let snapshot = buildSnapshot()

    function getSnapshot() {
      return snapshot
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }

    function publish() {
      snapshot = buildSnapshot()
      for (const listener of listeners) {
        try { listener() } catch { /* a subscriber must not break the mutation */ }
      }
      scheduleDecorate()
    }

    // `useSyncExternalStore` where the host's React has it (React 18+), otherwise
    // a subscribe/effect pair. Chosen once at module scope, so no hook is called
    // conditionally during a render.
    const useSnapshot = typeof react.useSyncExternalStore === 'function'
      ? () => react.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      : () => {
          const [value, setValue] = react.useState(getSnapshot)
          react.useEffect(() => subscribe(() => setValue(getSnapshot())), [])
          return value
        }

    // --- confirmation preference ----------------------------------------------

    // Once the user opts out ("删除时询问" unticked - either in the plugin page or
    // via the dialog's "don't ask again") the confirmation dialog is skipped and
    // the menu item deletes directly. The plugin page's checkbox and the dialog
    // read the same key, and a subscription keeps the card in step when either
    // one flips it.
    const SKIP_KEY = 'dsh-delete-session:skip-confirm'
    const skipListeners = new Set()

    function skipConfirm() {
      try { return localStorage.getItem(SKIP_KEY) === '1' } catch { return false }
    }

    function setSkipConfirm(value) {
      const skip = value === true
      try {
        if (skip) localStorage.setItem(SKIP_KEY, '1')
        else localStorage.removeItem(SKIP_KEY)
      } catch { /* private mode: ignore */ }
      for (const listener of skipListeners) {
        try { listener() } catch { /* a subscriber must not break the toggle */ }
      }
    }

    function subscribeSkip(listener) {
      skipListeners.add(listener)
      return () => { skipListeners.delete(listener) }
    }

    // --- host calls ------------------------------------------------------------

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

    // Deleting the session the main view is showing leaves the app to restore a
    // stale neighbour (an unavailable Agent Team row with a disabled composer),
    // which reads as "the delete did not work". Open a fresh session instead.
    function deletedVariants(id) {
      return id.startsWith('session-') ? [id, id.slice('session-'.length)] : [id, `session-${id}`]
    }

    function leaveIfCurrent(id) {
      let current = null
      try {
        const raw = localStorage.getItem('dsh.sessions.current')
        current = raw ? (JSON.parse(raw) || {}).sessionId || null : null
      } catch {
        return
      }
      if (!current || !deletedVariants(id).includes(current)) return
      const btn = document.querySelector(
        'button[class*="newSession"], button[aria-label*="New session" i], button[aria-label*="新会话"]',
      )
      if (btn) {
        try {
          btn.click()
          return
        } catch {
          // fall through to the state reset
        }
      }
      try {
        localStorage.removeItem('dsh.sessions.current')
        window.location.reload()
      } catch {
        // ignore
      }
    }

    // --- styles ----------------------------------------------------------------
    // Only what the DOM decoration layer owns. The confirmation dialog is the
    // host's `Modal`, so it brings no backdrop CSS of its own.

    const CSS = [
      '.dsdel-toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:2147483601;background:Canvas;color:CanvasText;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);padding:9px 16px;border-radius:999px;font-size:12px;box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:min(92vw,460px);cursor:pointer}',
      '.dsdel-check{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.5));background:transparent;flex:none;margin-right:8px;box-sizing:border-box;cursor:pointer}',
      '.dsdel-check-on{background:var(--dsw-alias-state-business-primary,#4c6ef5);border-color:var(--dsw-alias-state-business-primary,#4c6ef5)}',
      '.dsdel-check-on::after{content:"";width:9px;height:5px;border-left:2px solid #fff;border-bottom:2px solid #fff;transform:rotate(-45deg) translateY(-1px)}',
      // 乐观删除：行先隐藏，失败时随 decorate 恢复
      '.dsdel-row-pending{display:none!important}',
      '.dsdel-bar{position:fixed;left:12px;bottom:12px;z-index:2147483600;display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,.3));box-shadow:0 12px 32px rgba(0,0,0,.28);color:var(--dsw-alias-label-primary,inherit);font-size:13px;background:linear-gradient(var(--dsw-alias-bg-layer-2,#fff),var(--dsw-alias-bg-layer-2,#fff)),linear-gradient(var(--dsw-alias-bg-layer-2,#fff),var(--dsw-alias-bg-layer-2,#fff)),linear-gradient(var(--dsw-alias-bg-layer-2,#fff),var(--dsw-alias-bg-layer-2,#fff)),var(--dsw-alias-bg-base,#fff)}',
      '.dsdel-bar-count{white-space:nowrap}',
      '.dsdel-bar-btn{appearance:none;min-height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:var(--dsw-alias-fill-elevated,rgba(128,128,128,.08));color:var(--dsw-alias-label-primary,inherit);border-radius:8px;font-size:13px;cursor:pointer}',
      '.dsdel-bar-btn:disabled{opacity:.5;cursor:default}',
      '.dsdel-bar-danger{border-color:var(--dsw-alias-state-error-primary,#e5484d);background:var(--dsw-alias-state-error-primary,#e5484d);color:#fff}',
      '.dsdel-page{display:flex;flex-direction:column;gap:8px}',
      '.dsdel-page-hint{margin:0;color:var(--dsw-alias-label-tertiary,#888);font-size:13px;line-height:20px}',
      '.dsdel-modal-text{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary,#666);word-break:break-all}',
      '.dsdel-modal-meta{margin:0 0 8px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#888);word-break:break-all}',
      '.dsdel-modal-error{margin:8px 0 0;font-size:12px;line-height:16px;color:var(--dsw-alias-state-error-primary,#e5484d)}',
      // ui-primitives' `Button` has no danger variant (the host styles its own
      // destructive buttons with a package-local CSS-module class), so the
      // confirm button carries this class instead.
      '.dsdel-danger-btn{border-color:var(--dsw-alias-state-error-primary,#e5484d)!important;background:var(--dsw-alias-state-error-primary,#e5484d)!important;color:#fff!important}',
      '.dsdel-danger-btn:disabled{opacity:.5}',
    ].join('')

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-dsh-delete-session]')) return
      const style = document.createElement('style')
      style.dataset.dshDeleteSession = '1'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // --- feedback --------------------------------------------------------------

    function toast(text, isError) {
      if (typeof document === 'undefined' || !document.body) return
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

    // --- multi-select row decoration -------------------------------------------
    // Entered from the session menu ("多选"). While active, every session row gets
    // a round checkbox, clicking a row toggles it instead of opening the
    // conversation, and a bottom bar runs the batch delete. No select-all and no
    // per-row disabling: every row is selectable and the batch deletes
    // immediately (the single-session flow keeps its own consent dialog).

    let bar = null
    let decorateRaf = null
    let rowObserver = null

    // Row identity comes from the host's own drag-and-drop key rather than from
    // React internals: every Session row carries `data-row-key="session:<id>"`.
    // A row without it is simply not selectable.
    const ROW_KEY_PREFIX = 'session:'

    function sessionIdFromRow(row) {
      if (!row || typeof row.getAttribute !== 'function') return null
      const key = row.getAttribute('data-row-key')
      if (typeof key !== 'string' || !key.startsWith(ROW_KEY_PREFIX)) return null
      const id = key.slice(ROW_KEY_PREFIX.length)
      return id === '' ? null : id
    }

    function decorateRows() {
      if (typeof document === 'undefined') return
      const rows = document.querySelectorAll('[role="treeitem"]')
      rows.forEach((row) => {
        const id = sessionIdFromRow(row)
        if (!id) return
        // Checkboxes belong to multi-select only: a single delete (or any other
        // decorate pass outside the mode) must not plant them on every row.
        if (!state.selecting) {
          const stray = row.querySelector(':scope > .dsdel-check')
          if (stray) stray.remove()
        } else {
          let check = row.querySelector(':scope > .dsdel-check')
          if (!check) {
            check = document.createElement('span')
            check.className = 'dsdel-check'
            check.setAttribute('data-dsh-delete-session', 'check')
            row.insertBefore(check, row.firstChild)
          }
          check.classList.toggle('dsdel-check-on', state.selected.has(id))
        }
        row.classList.toggle('dsdel-row-pending', state.pending.has(id))
      })
      if (!state.selecting) {
        document.querySelectorAll('.dsdel-check').forEach((el) => el.remove())
      }
    }

    function scheduleDecorate() {
      if (typeof requestAnimationFrame !== 'function') return
      if (decorateRaf !== null) return
      decorateRaf = requestAnimationFrame(() => {
        decorateRaf = null
        try { decorateRows() } catch { /* best-effort DOM shim */ }
      })
    }

    function updateBar() {
      if (!bar) return
      const count = bar.querySelector('.dsdel-bar-count')
      if (count) {
        count.textContent = state.batch
          ? t('batchRunning', state.batch.done + state.batch.failed, state.batch.total)
          : t('selectedCount', state.selected.size)
      }
      const cancel = bar.querySelector('.dsdel-bar-btn:not(.dsdel-bar-danger)')
      const del = bar.querySelector('.dsdel-bar-danger')
      if (cancel) cancel.disabled = state.batch !== null
      if (del) del.disabled = state.batch !== null || state.selected.size === 0
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

    function toggleSelect(id) {
      if (state.selected.has(id)) state.selected.delete(id)
      else state.selected.add(id)
      publish()
      updateBar()
    }

    function onSelectClickCapture(e) {
      if (!state.selecting) return
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
      if (state.batch !== null) return
      e.stopPropagation()
      exitSelection()
    }

    function enterSelection() {
      if (state.selecting) return
      state.selecting = true
      state.selected.clear()
      ensureStyle()
      if (!bar) bar = buildBar()
      bar.style.display = 'flex'
      document.addEventListener('click', onSelectClickCapture, true)
      document.addEventListener('keydown', onSelectKeydown, true)
      if (typeof MutationObserver === 'function') {
        rowObserver = new MutationObserver(scheduleDecorate)
        rowObserver.observe(document.body, { childList: true, subtree: true })
      }
      publish()
      updateBar()
    }

    function exitSelection(options) {
      if (!state.selecting) return
      state.selecting = false
      state.selected.clear()
      state.batch = null
      const keepPending = !!(options && options.keepPending)
      if (!keepPending) {
        state.pending.clear()
        document.querySelectorAll('.dsdel-row-pending').forEach((el) => el.classList.remove('dsdel-row-pending'))
      }
      if (bar) bar.style.display = 'none'
      document.removeEventListener('click', onSelectClickCapture, true)
      document.removeEventListener('keydown', onSelectKeydown, true)
      if (rowObserver) { rowObserver.disconnect(); rowObserver = null }
      document.querySelectorAll('.dsdel-check').forEach((el) => el.remove())
      publish()
    }

    // 成功删除后行要保持隐藏直到列表刷新落地，之后再清掉乐观状态（避免行“闪回”）。
    function settlePendingSoon() {
      setTimeout(() => {
        state.pending.clear()
        publish()
      }, 2500)
    }

    // 批量删除：客户端并发（小池）+ 乐观隐藏 + 进度显示。
    // 走单会话端点（每个请求各自跑宿主端的完整删除管线），宿主端对同一存储的
    // 记账变更已串行化，因此不同会话并发是安全的；失败的行立即恢复显示并保持选中，
    // 方便直接重试。
    // 6 是实测值：64 个 ~2MB 会话的墙钟时间 4 路 281ms / 6 路 189ms / 8 路 142ms
    // （I/O 并行度约在 8 饱和），6 路比 4 路快约 1/3 且仍在饱和点以下。
    const BATCH_CONCURRENCY = 6

    function runBatchDelete() {
      if (state.batch !== null) return
      const ids = [...state.selected]
      if (ids.length === 0) return
      state.batch = { total: ids.length, done: 0, failed: 0 }
      state.selected.clear()
      for (const id of ids) state.pending.add(id)
      publish()
      updateBar()

      const failedIds = []
      let cursor = 0
      const worker = async () => {
        while (true) {
          const index = cursor
          cursor += 1
          if (index >= ids.length) return
          const id = ids[index]
          try {
            await postDelete(id)
            state.batch.done += 1
          } catch {
            state.batch.failed += 1
            failedIds.push(id)
            state.pending.delete(id)
          }
          publish()
          updateBar()
        }
      }
      const workers = []
      for (let i = 0; i < Math.min(BATCH_CONCURRENCY, ids.length); i += 1) workers.push(worker())

      Promise.all(workers).then(() => {
        const failed = state.batch ? state.batch.failed : 0
        const ok = state.batch ? state.batch.done : 0
        state.batch = null
        if (failed === 0) {
          toast(t('batchDone', ok))
          exitSelection({ keepPending: true })
          settlePendingSoon()
        } else {
          for (const id of failedIds) state.selected.add(id)
          toast(t('batchPartial', ok, failed), true)
          publish()
          updateBar()
        }
        refreshList()
        for (const id of ids) {
          if (!failedIds.includes(id)) leaveIfCurrent(id)
        }
      })
    }

    // --- single delete ---------------------------------------------------------

    function deleteNow(info) {
      state.pending.add(info.sessionId)
      publish()
      postDelete(info.sessionId)
        .then(() => {
          toast(t('done'))
          refreshList()
          settlePendingSoon()
          leaveIfCurrent(info.sessionId)
        })
        .catch((reason) => {
          state.pending.delete(info.sessionId)
          publish()
          toast(t('failed') + String((reason && reason.message) || reason), true)
        })
    }

    function openDeleteDialog(sessionId, title) {
      state.dialog = { sessionId, title: title || null, busy: false, error: null, skip: false }
      publish()
    }

    function closeDeleteDialog() {
      if (state.dialog === null || state.dialog.busy) return
      state.dialog = null
      publish()
    }

    // The "don't ask again" flag is committed only when the user actually
    // confirms, exactly as before - ticking the box and then cancelling must not
    // change the preference.
    function confirmDelete() {
      const dialog = state.dialog
      if (dialog === null || dialog.busy) return
      if (dialog.skip) setSkipConfirm(true)
      dialog.busy = true
      dialog.error = null
      state.pending.add(dialog.sessionId)
      publish()
      postDelete(dialog.sessionId)
        .then(() => {
          state.dialog = null
          toast(t('done'))
          refreshList()
          settlePendingSoon()
          leaveIfCurrent(dialog.sessionId)
          publish()
        })
        .catch((reason) => {
          state.pending.delete(dialog.sessionId)
          dialog.busy = false
          dialog.error = t('failed') + String((reason && reason.message) || reason)
          publish()
        })
    }

    // --- menu rows (slot: sidebar.workspaces.session.menu.item) ----------------

    /** Inline glyphs for the two rows; the host exposes no matching pair. */
    const TRASH_PATHS = ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13', 'M9 7V4h6v3']
    const SELECT_PATHS = ['M5 7m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M5 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M11 7h9', 'M11 17h9']

    function glyph(paths) {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        paths.map((d) => h('path', { key: d, d })),
      )
    }

    // ui-primitives' `MenuItemButton` takes a real `danger` parameter (verified
    // against the shipped component), which puts the host's own danger class on
    // the button. Passing it is what keeps the delete row in the host's danger
    // colour - icon included - rather than a plugin guess.
    //
    // No `separatorBefore`: this migration moves the rows onto the host's slot
    // contract and must not change how the menu looks.

    /** "Select multiple" row (order 409, directly above the delete row). */
    function SelectMultipleMenuItem({ useMenuOpenState, t: translate }) {
      const [, setMenuOpen] = useMenuOpenState()
      return h(primitives.MenuItemButton, {
        icon: glyph(SELECT_PATHS),
        onSelect: () => {
          setMenuOpen(false)
          enterSelection()
        },
        children: translate('multiSelect'),
      })
    }

    /** "Delete session" row (order 410, in the host's danger colour). */
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, t: translate }) {
      const [, setMenuOpen] = useMenuOpenState()
      return h(primitives.MenuItemButton, {
        danger: true,
        icon: glyph(TRASH_PATHS),
        onSelect: (event) => {
          setMenuOpen(false)
          // Shift-click always asks, even after "don't ask again" was ticked.
          if (skipConfirm() && !(event && event.shiftKey)) deleteNow({ sessionId })
          else openDeleteDialog(sessionId, displayTitle)
        },
        children: translate('menu'),
      })
    }

    // --- confirmation dialog (slot: shell.overlay) -----------------------------

    function DeleteSessionDialog({ t: translate }) {
      const view = useSnapshot()
      const dialog = view.dialog
      if (dialog === null) return null

      const footer = h(
        Fragment,
        null,
        h(primitives.Button, {
          variant: 'outline',
          disabled: dialog.busy,
          onClick: () => closeDeleteDialog(),
          children: translate('cancel'),
        }),
        h(primitives.Button, {
          variant: 'outline',
          className: 'dsdel-danger-btn',
          disabled: dialog.busy,
          onClick: () => confirmDelete(),
          children: dialog.busy ? translate('deleting') : translate('confirm'),
        }),
      )

      return h(primitives.Modal, {
        open: true,
        onClose: () => closeDeleteDialog(),
        closeLabel: translate('cancel'),
        title: translate('title'),
        footer,
        children: [
          h('p', { key: 'meta', className: 'dsdel-modal-meta' },
            `${dialog.title || translate('untitled')} · ${dialog.sessionId}`),
          h('p', { key: 'desc', className: 'dsdel-modal-text' }, translate('desc')),
          h('label', {
            key: 'skip',
            className: 'dsdel-modal-text',
            style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px', cursor: 'pointer' },
          },
            h('input', {
              type: 'checkbox',
              onChange: (e) => { dialog.skip = !!(e && e.target && e.target.checked) },
            }),
            translate('dontAsk'),
          ),
          dialog.error !== null
            ? h('p', { key: 'error', className: 'dsdel-modal-error', role: 'alert' }, dialog.error)
            : null,
        ],
      })
    }

    // --- plugin page card (slot: plugins.row.config) ---------------------------

    // The manager's detail page for this bundle gives the component row a
    // configure arrow once the bundle registers its own row.config entry (key
    // `<bundle package>#<row id>`). The card carries the one setting the dialog
    // also exposes: whether a session delete asks first.
    function AskBeforeDeleteOption({ view, t: injected }) {
      // Unlike the menu rows and the dialog, this entry is registered without a
      // `locale`, so the host injects no `t` here. Falling back to the
      // module-level translator (same dictionaries) keeps the card working
      // instead of throwing on an undefined call.
      const translate = typeof injected === 'function' ? injected : t
      const [ask, setAsk] = react.useState(!skipConfirm())
      react.useEffect(() => subscribeSkip(() => setAsk(!skipConfirm())), [])
      if (view === 'summary') return translate(ask ? 'pageSummaryAsk' : 'pageSummaryAuto')
      return h('div', { className: 'dsdel-page' },
        h(primitives.Checkbox, {
          checked: ask,
          label: translate('pageAsk'),
          onChange: (checked) => {
            setAsk(checked === true)
            setSkipConfirm(checked !== true)
          },
        }),
        h('p', { className: 'dsdel-page-hint' }, translate(ask ? 'pageHintAsk' : 'pageHintAuto')),
      )
    }

    // --- plugin ------------------------------------------------------------------

    function apply(ctx) {
      ensureStyle()

      sessionsSvc = ctx.get('sessions') || null
      if (!sessionsSvc) {
        try { ctx.inject(['sessions'], (sub) => { sessionsSvc = sub.sessions }) } catch { /* optional */ }
      }
      localeSvc = ctx.get('locale') || null

      // Slot components are handed a `t` bound to this namespace, so the
      // dictionaries must reach the host - on BOTH arrival paths. If `locale`
      // only turns up through `ctx.inject`, a registration living on the
      // synchronous branch would never run and the menu would fall back to
      // printing raw keys ("multiSelect", "menu"). `ctx.effect` ties the
      // registration's lifetime to the plugin, matching ui-workspace.
      let localeRegistered = false
      const adoptLocale = (svc) => {
        localeSvc = svc || null
        if (localeRegistered || !localeSvc || typeof localeSvc.register !== 'function') return
        localeRegistered = true
        const register = () => localeSvc.register(NS, { zh, en })
        try {
          if (typeof ctx.effect === 'function') ctx.effect(register, `${NS}: dictionaries`)
          else register()
        } catch { /* already registered */ }
      }
      if (localeSvc) adoptLocale(localeSvc)
      else {
        try { ctx.inject(['locale'], (sub) => adoptLocale(sub.locale)) } catch { /* optional */ }
      }

      const install = (slots) => {
        // Session menu rows. A package-namespaced id keeps them beside the
        // shipped pin(100)/rename(200)/fork(300)/archive(400)/session-id(450).
        slots.inject('sidebar.workspaces.session.menu.item', () => slots.register(
          { name: 'sidebar.workspaces.session.menu.item', id: `${NS}-multi`, order: 409, locale: NS },
          SelectMultipleMenuItem,
        ))
        slots.inject('sidebar.workspaces.session.menu.item', () => slots.register(
          { name: 'sidebar.workspaces.session.menu.item', id: NS, order: 410, locale: NS },
          DeleteSessionMenuItem,
        ))
        // The confirmation dialog rides the frame-wide overlay seat.
        slots.inject('shell.overlay', () => slots.register(
          { name: 'shell.overlay', id: `${NS}-dialog`, locale: NS },
          DeleteSessionDialog,
        ))
        // The plugin page card.
        slots.inject('plugins.row.config', () => slots.register(
          { name: 'plugins.row.config', key: `${NS}#${NS}` },
          AskBeforeDeleteOption,
        ))

        // The batch bar and its row observer are the only long-lived DOM state;
        // drop them when the plugin unloads.
        return () => {
          exitSelection()
          if (bar) { bar.remove(); bar = null }
        }
      }

      const slots = ctx.get('slots')
      if (slots) {
        const dispose = install(slots)
        ctx.effect(() => dispose)
      } else {
        try {
          ctx.inject(['slots'], (sub) => {
            const dispose = install(sub.slots)
            ctx.effect(() => dispose)
          })
        } catch { /* no slot surface on this profile */ }
      }
    }

    return { apply }
  },
})
