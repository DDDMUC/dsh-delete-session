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
      descRecycle: '将把该会话及其全部对话记录（会话日志、工作区记账与统计）从列表中移除，并放进系统回收站。',
      descPermanent: '将永久删除该会话及其全部对话记录（会话日志、工作区记账与统计），此操作不可恢复。',
      cancel: '取消',
      confirm: '删除',
      deleting: '删除中…',
      done: '已删除会话',
      failed: '删除失败：',
      busy: '该会话正被 DSH 打开，删除未能完成；请稍后重试（通常几秒后即可），或重启 DSH 后再试。',
      notFound: '未找到该会话（可能已被删除）。',
      untitled: '未命名会话',
      cancelSelect: '取消',
      selectedCount: (n) => `已选 ${n} 个`,
      batchRunning: (done, total) => `正在删除 ${done}/${total}…`,
      moveSelected: '移动',
      batchMoving: (done, total) => `正在移动 ${done}/${total}…`,
      batchMoved: (ok, fail) => (fail > 0 ? `已移动 ${ok} 个 / ${fail} 个失败` : `已移动 ${ok} 个`),
      moveBadResult: (fields) => `移动结果缺少字段：${fields}`,
      deleteSelected: '删除',
      batchDone: (n) => `已删除 ${n} 个会话`,
      batchPartial: (ok, fail) => `已删除 ${ok} 个，${fail} 个失败`,
      batchFailed: '批量删除失败：',
      pageAsk: '删除时询问',
      pageRecycle: '删除至回收站',
      pageSyncChildren: '同时删除子会话',
      starAsk: '⭐ 顺手留颗 Star，作者能高兴一整天',
      starCta: '行，给你一颗 Star',
      pageSyncChildrenOn: '删除对话时，把它派生的子代理会话一起删掉。',
      pageSyncChildrenOff: '不勾选时，删除前会列出子会话，由你勾选要删哪些。',
      childrenHint: '这个对话有 {n} 个子会话（子代理），勾选的会一起删除。',
      pageRecycleOn: '删除后放进系统回收站，可以还原。',
      pageRecycleOff: '删除后直接从硬盘移除，不可恢复。',
      pageHintAsk: '每次删除会话前都会弹出确认框。',
      pageHintAuto: '删除会话会直接执行，不再询问。',
      // The produced-file list only exists inside the dialog, so ask mode keeps a
      // delete dialog even when the confirmation above is turned off.
      pageHintAutoWithArtifacts: '删除会话仍会弹窗——产出文件要先列清单给你勾选。',
      pageSummaryAsk: '删除前询问',
      pageSummaryAuto: '直接删除',
      pageArtifactsOff: '不处理产出文件（保持当前行为）',
      pageHintArtifactsOff: '删除会话只清理对话记录，完全不碰工作目录里的文件。',
      pageHintArtifactsOn: '删除会话时还会处理这个对话在工作目录里碰过的文件。',
      pageArtifactsAuto: '产出文件默认全部进隔离夹',
      pageHintArtifactsAuto: '按下面的范围把匹配的文件全部移入隔离夹，不再询问。',
      pageHintArtifactsAsk: '删除会话时会列出文件清单，由你勾选。',
      pageScopeCreated: '仅新建的文件',
      pageScopeAll: '新建的和改过的文件',
      pageScopeCreatedHint: '只动这个对话自己创建的文件；它改过的既有文件一律不动。',
      pageScopeAllHint: '还会包含这个对话改写过的既有文件 —— 移走它们会改变工作目录里原有的内容。',
      pageSkipGit: '跳过 git 仓库内的文件',
      pageSkipGitOn: '只处理不在 git 仓库里的文件；仓库里的代码不会被搬走。',
      pageSkipGitOff: '仓库里的文件也会被搬进隔离夹 —— 删一个在项目里干过活的对话，可能把项目源码一起搬走。',
      pageSummaryArtifactsOff: '不处理产出文件',
      pageSummaryArtifactsAuto: '产出文件自动隔离',
      pageSummaryArtifactsAsk: '产出文件先询问',
      pageRootLabel: '隔离夹保存位置',
      pageRootPlaceholder: '留空则使用默认路径',
      pageRootBrowse: '选择文件夹…',
      pageRootOpen: '打开',
      rootOpened: '已在文件管理器中打开',
      rootOpenFailed: '打开失败：',
      pickerOpening: '已打开系统文件夹对话框，请在弹出的窗口里选择',
      pageRootReset: '用默认',
      pageRootDefaultHint: (path) => `当前使用默认路径：${path}`,
      pageRootCustomHint: '隔离夹会建在这个目录下，每次删除生成一个带时间戳的子目录',
      pickerTitle: '选择隔离夹保存位置',
      pickerLoading: '读取中…',
      pickerEmpty: '这个目录下没有子目录',
      pickerChoose: '选择此目录',
      pickerTruncated: '子目录太多，只列出前 500 个',
      pickerDefault: (path) => `默认路径：${path}`,
      rootSet: '保存位置已更新',
      artifactSection: '本对话产出的文件',
      artifactLoading: '正在扫描…',
      artifactFailed: '扫描失败：',
      artifactNone: '没有需要处理的文件。',
      artifactCount: (created, modified) => `新建 ${created} 个 · 改过 ${modified} 个`,
      artifactAutoNote: (n) => `删除后将把 ${n} 个文件移入隔离夹`,
      // Auto mode does not scan, so it can state the outcome but not a count.
      artifactAutoOnly: '产出文件会自动全部移入隔离夹，这里不再逐个列出。',
      artifactRefused: (n) => `另有 ${n} 项已跳过`,
      artifactSelected: (n) => `已选 ${n} 个`,
      artifactMore: (n) => `另有 ${n} 个未列出`,
      artifactTruncated: '清单过长已截断，未列出的不会处理。',
      artifactScopeCreated: '范围：仅新建',
      artifactScopeAll: '范围：新建 + 改过',
      artifactModifiedWarn: '改过的既有文件（默认不选）：',
      doneQuarantine: (n) => `已删除会话，${n} 个文件已移入隔离夹`,
      doneQuarantineFailed: (ok, fail) => `已删除会话，隔离 ${ok} 个、${fail} 个失败`,
    }

    const en = {
      menu: 'Delete session',
      multiSelect: 'Select multiple',
      title: 'Delete session',
      descRecycle: 'This removes the session and all of its conversation records (log, workspace accounting and statistics) from the list and puts them in the system trash.',
      descPermanent: 'This permanently deletes the session and all of its conversation records (log, workspace accounting and statistics). This cannot be undone.',
      cancel: 'Cancel',
      confirm: 'Delete',
      deleting: 'Deleting...',
      done: 'Session deleted',
      failed: 'Delete failed: ',
      busy: 'This session is currently open in DSH; the delete did not complete. Try again in a moment (usually a few seconds), or restart DSH and retry.',
      notFound: 'Session not found (it may already be deleted).',
      untitled: 'Untitled session',
      cancelSelect: 'Cancel',
      selectedCount: (n) => `${n} selected`,
      batchRunning: (done, total) => `Deleting ${done}/${total}...`,
      moveSelected: 'Move',
      batchMoving: (done, total) => `Moving ${done}/${total}...`,
      batchMoved: (ok, fail) => (fail > 0 ? `Moved ${ok}, ${fail} failed` : `Moved ${ok}`),
      moveBadResult: (fields) => `Move result is missing fields: ${fields}`,
      deleteSelected: 'Delete',
      batchDone: (n) => `Deleted ${n} session(s)`,
      batchPartial: (ok, fail) => `Deleted ${ok}, ${fail} failed`,
      batchFailed: 'Batch delete failed: ',
      pageAsk: 'Ask before deleting',
      pageRecycle: 'Delete to the Recycle Bin',
      pageSyncChildren: 'Delete child sessions too',
      starAsk: '⭐ A star would make the author\'s day',
      starCta: 'Fine — have one',
      pageSyncChildrenOn: 'A delete also removes the subagent sessions it spawned.',
      pageSyncChildrenOff: 'When off, the dialog lists the child sessions and you tick the ones to delete.',
      childrenHint: 'This conversation has {n} child sessions (subagents). Ticked ones are deleted too.',
      pageRecycleOn: 'The session goes to the system trash and can be restored.',
      pageRecycleOff: 'The session is removed from the disk right away and cannot be restored.',
      pageHintAsk: 'Show a confirmation dialog before every session delete.',
      pageHintAuto: 'Delete the session right away without asking.',
      pageHintAutoWithArtifacts: 'A delete still opens a dialog, because the produced-file list has to be shown first.',
      pageSummaryAsk: 'Ask before deleting',
      pageSummaryAuto: 'Delete without asking',
      pageArtifactsOff: 'Leave produced files alone (current behaviour)',
      pageHintArtifactsOff: 'Deleting a session clears its record only and never touches files in the working directory.',
      pageHintArtifactsOn: 'Deleting a session also handles the files this conversation touched in its working directory.',
      pageArtifactsAuto: 'Send produced files straight to quarantine',
      pageHintArtifactsAuto: 'Every file in the scope below moves to quarantine without asking.',
      pageHintArtifactsAsk: 'Deleting a session lists the files and lets you tick what to move.',
      pageScopeCreated: 'Only files it created',
      pageScopeAll: 'Created and changed files',
      pageScopeCreatedHint: 'Touches only files this conversation created; files it merely edited are never moved.',
      pageScopeAllHint: 'Also includes pre-existing files this conversation rewrote — moving them changes what was already in the working directory.',
      pageSkipGit: 'Skip files inside a git repository',
      pageSkipGitOn: 'Only files outside git repositories are handled; code inside a repository is never moved.',
      pageSkipGitOff: 'Repository files move into quarantine too — deleting a conversation that worked in a project can carry the project source away.',
      pageSummaryArtifactsOff: 'Produced files left alone',
      pageSummaryArtifactsAuto: 'Produced files auto-quarantined',
      pageSummaryArtifactsAsk: 'Produced files ask first',
      pageRootLabel: 'Quarantine folder location',
      pageRootPlaceholder: 'Leave empty to use the default path',
      pageRootBrowse: 'Choose folder…',
      pageRootOpen: 'Open',
      rootOpened: 'Opened in the file manager',
      rootOpenFailed: 'Could not open: ',
      pickerOpening: 'The system folder dialog is open; pick a folder in that window',
      pageRootReset: 'Use default',
      pageRootDefaultHint: (path) => `Using the default path: ${path}`,
      pageRootCustomHint: 'The quarantine folder is created here, one timestamped subfolder per delete',
      pickerTitle: 'Choose where quarantined files go',
      pickerLoading: 'Reading…',
      pickerEmpty: 'No subfolders here',
      pickerChoose: 'Use this folder',
      pickerTruncated: 'Too many subfolders: only the first 500 are listed',
      pickerDefault: (path) => `Default path: ${path}`,
      rootSet: 'Location updated',
      artifactSection: 'Files this conversation produced',
      artifactLoading: 'Scanning...',
      artifactFailed: 'Scan failed: ',
      artifactNone: 'Nothing to handle.',
      artifactCount: (created, modified) => `${created} created · ${modified} changed`,
      artifactAutoNote: (n) => `${n} file(s) will move to quarantine on delete`,
      artifactAutoOnly: 'Produced files move to quarantine automatically; they are not listed here.',
      artifactRefused: (n) => `${n} more were skipped`,
      artifactSelected: (n) => `${n} selected`,
      artifactMore: (n) => `${n} more not listed`,
      artifactTruncated: 'The list was truncated; anything unlisted is left alone.',
      artifactScopeCreated: 'Scope: created only',
      artifactScopeAll: 'Scope: created + changed',
      artifactModifiedWarn: 'Pre-existing files it changed (unticked by default):',
      doneQuarantine: (n) => `Session deleted, ${n} file(s) moved to quarantine`,
      doneQuarantineFailed: (ok, fail) => `Session deleted, ${ok} quarantined and ${fail} failed`,
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

    /**
     * Wrap a host-injected `t` so function-valued entries render their value.
     *
     * The locale contract leaves a function entry untouched: `translate(key, a, b)`
     * returns the arrow function itself, and the caller is the one that invokes it.
     * Using the injected `t` directly therefore printed the function's own source
     * in the dialog ("(created, modified) => ...") instead of the numbers.
     */
    function localizedTranslator(injected) {
      const raw = typeof injected === 'function' ? injected : t
      if (raw.__dsdelLocalized === true) return raw
      const wrapped = (key, a, b) => {
        // Our own dictionary answers first, and it is resolved HERE rather than
        // through the host. `dsh-client-locale` interpolates whatever it finds as
        // soon as params are present - it calls `template.replace(...)` - while
        // most of these entries are functions. Handing it params made the host
        // throw "template.replace is not a function", and the slot boundary turned
        // that into an empty `data-slot-error` anchor: the bar vanished, Cancel
        // and all. Calling it without params is no better: the host (and this
        // module's own `t`) invoke function entries with no arguments, which
        // produces "已选 undefined 个".
        const dictionary = browserLang() === 'en' ? en : zh
        const local = dictionary[key]
        if (local !== undefined) {
          if (typeof local === 'function') return local(a, b)
          if (typeof local === 'string' && local.includes('{') && a !== undefined) {
            const params = a !== null && typeof a === 'object'
              ? a
              : { n: a, done: a, total: b, ok: a, fail: b, path: a }
            return local.replace(/\{(\w+)\}/g, (match, name) => (
              params[name] === undefined ? match : String(params[name])
            ))
          }
          return local
        }
        // A key this plugin does not ship: let the host answer.
        const value = raw(key)
        return typeof value === 'function' ? value(a, b) : (value === undefined || value === null ? key : value)
      }
      wrapped.__dsdelLocalized = true
      return wrapped
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
      /** Folder-picker state while it is open, else null. */
      picker: null,
      /** The host's default quarantine root, fetched once so the card can name it. */
      defaultRoot: null,
    }

    const listeners = new Set()

    function buildSnapshot() {
      return {
        dialog: state.dialog,
        selecting: state.selecting,
        selected: state.selected,
        pending: state.pending,
        batch: state.batch,
        picker: state.picker,
        defaultRoot: state.defaultRoot,
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

    // --- artifact preferences --------------------------------------------------
    // The produced-files feature ships OFF: `OFF_KEY` is ticked unless the user
    // explicitly clears it, so an existing install keeps behaving exactly as it
    // did before the feature existed. When it is on, `AUTO_KEY` decides whether
    // the dialog asks, and `SCOPE_KEY` decides what the candidate set is.

    const OFF_KEY = 'dsh-delete-session:artifacts-off'
    const AUTO_KEY = 'dsh-delete-session:artifacts-auto'
    const SCOPE_KEY = 'dsh-delete-session:artifact-scope'
    /** Where the timestamped quarantine folder is created. Empty means the DSH home. */
    const ROOT_KEY = 'dsh-delete-session:quarantine-root'
    /** Skip files inside a git working tree when quarantining. */
    const SKIP_GIT_KEY = 'dsh-delete-session:skip-git'
    /** Whether a delete goes to the system trash instead of vanishing. */
    const RECYCLE_KEY = 'dsh-delete-session:recycle'
    /** Whether a delete takes the subagent sessions with it, without asking. */
    const SYNC_CHILDREN_KEY = 'dsh-delete-session:sync-children'
    /** How many artifact rows the dialog lists before collapsing the rest. */
    const ARTIFACT_ROWS_SHOWN = 40
    const prefListeners = new Set()

    function readPref(key, fallback) {
      try {
        const value = localStorage.getItem(key)
        return value === null ? fallback : value
      } catch {
        return fallback
      }
    }

    function writePref(key, value) {
      try {
        if (value === null) localStorage.removeItem(key)
        else localStorage.setItem(key, value)
      } catch {
        // private mode: the preference simply does not persist
      }
      for (const listener of prefListeners) {
        try { listener() } catch { /* a subscriber must not break the toggle */ }
      }
    }

    function subscribePrefs(listener) {
      prefListeners.add(listener)
      return () => { prefListeners.delete(listener) }
    }

    /** Whether the produced-files feature is off. Off unless explicitly enabled. */
    function artifactsOff() {
      return readPref(OFF_KEY, '1') !== '0'
    }

    function setArtifactsOff(off) {
      writePref(OFF_KEY, off ? null : '0')
    }

    /** Whether the whole candidate set moves without asking. */
    function artifactsAuto() {
      return readPref(AUTO_KEY, '0') === '1'
    }

    function setArtifactsAuto(auto) {
      writePref(AUTO_KEY, auto ? '1' : null)
    }

    /** Candidate scope: files this session created, or those plus the ones it changed. */
    function artifactScope() {
      return readPref(SCOPE_KEY, 'created') === 'all' ? 'all' : 'created'
    }

    function setArtifactScope(scope) {
      writePref(SCOPE_KEY, scope === 'all' ? 'all' : 'created')
    }

    /**
     * Skip files that live inside a git working tree. On by default: a session
     * started in a repository produces that repository's source, and moving it
     * out from under the project is never what "clean up the files this chat
     * created" means.
     */
    function skipGitRepos() {
      return readPref(SKIP_GIT_KEY, '1') === '1'
    }

    function setSkipGitRepos(skip) {
      writePref(SKIP_GIT_KEY, skip ? null : '0')
    }

    /**
     * Send the session to the system trash rather than removing it outright.
     * On by default: a wrong click should be undoable unless the user said otherwise.
     */
    function recycleSession() {
      return readPref(RECYCLE_KEY, '1') === '1'
    }

    function setRecycleSession(on) {
      writePref(RECYCLE_KEY, on ? null : '0')
    }

    /**
     * Take the child sessions along without asking. Off by default: a subagent is
     * a conversation of its own, so it is offered rather than swept up.
     */
    function syncChildren() {
      return readPref(SYNC_CHILDREN_KEY, '0') === '1'
    }

    function setSyncChildren(on) {
      writePref(SYNC_CHILDREN_KEY, on ? '1' : null)
    }

    /** The chosen quarantine root, or '' for "use the host default". */
    function quarantineRoot() {
      return readPref(ROOT_KEY, '')
    }

    function setQuarantineRoot(value) {
      writePref(ROOT_KEY, typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
    }

    // --- host calls ------------------------------------------------------------

    /** The read-only artifact scan the dialog renders. */
    function postArtifacts(sessionId) {
      const root = quarantineRoot()
      const payload = root === '' ? { sessionId } : { sessionId, root }
      payload.skipGit = skipGitRepos()
      return fetch('/dsh-delete-session/artifacts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(async (res) => {
        let data = {}
        try { data = await res.json() } catch { /* keep {} */ }
        if (!res.ok || !data.ok) throw new Error((data && data.error) || `HTTP ${res.status}`)
        return data
      })
    }

    /** One directory listing for the folder picker. */
    function postBrowse(target) {
      return fetch('/dsh-delete-session/browse', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(target === undefined || target === '' ? {} : { path: target }),
      }).then(async (res) => {
        let data = {}
        try { data = await res.json() } catch { /* keep {} */ }
        if (!res.ok || !data.ok) throw new Error((data && data.error) || `HTTP ${res.status}`)
        return data
      })
    }

    /**
     * Ask the host to raise the real Windows folder dialog. The request stays open
     * while the user browses, so `code` is carried on failures: `unsupported`
     * means this platform has no native dialog and the in-page picker should run.
     */
    function postPick() {
      return fetch('/dsh-delete-session/pick', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }).then(async (res) => {
        let data = {}
        try { data = await res.json() } catch { /* keep {} */ }
        if (!res.ok || !data.ok) {
          const error = new Error((data && data.error) || `HTTP ${res.status}`)
          error.code = data && data.code
          throw error
        }
        return data
      })
    }

    /** Ask the host to show a directory in the OS file manager. */
    function postReveal(target) {
      return fetch('/dsh-delete-session/reveal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: target }),
      }).then(async (res) => {
        let data = {}
        try { data = await res.json() } catch { /* keep {} */ }
        if (!res.ok || !data.ok) throw new Error((data && data.error) || `HTTP ${res.status}`)
        return data
      })
    }

    /** Show the quarantine folder the current settings would write to. */
    function openQuarantineRoot(target) {
      if (typeof target !== 'string' || target === '') return
      postReveal(target)
        .then(() => toast(t('rootOpened')))
        .catch((reason) => toast(t('rootOpenFailed') + String((reason && reason.message) || reason), true))
    }

    function postDelete(sessionId, quarantine, childSessionIds) {
      const root = quarantineRoot()
      const payload = quarantine === undefined ? { sessionId } : { sessionId, quarantine }
      if (root !== '') payload.root = root
      // Subagent sessions are sessions of their own, so they travel as a list the
      // host can verify rather than something it has to discover.
      if (Array.isArray(childSessionIds) && childSessionIds.length > 0) {
        payload.childSessionIds = childSessionIds
      }
      // Whether the files go to the system trash is a per-delete choice, so it
      // travels with the request rather than being read from the host config.
      payload.recycle = recycleSession()
      return fetch('/dsh-delete-session/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
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
      '.dsdel-bar{display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:6px 8px;box-sizing:border-box;font-size:13px}',
      // The sidebar foot stacks three things: the footer-action row, the usage
      // card and the account row. While a selection runs only the action row
      // stays, so the bar sits where the account row used to end the sidebar.
      'body.dsdel-selecting [class*="_footArea"] > *:not([class*="_footerActions"]){display:none}',
      // The other footer buttons are named POSITIVELY, by the attributes their
      // plugins put on them, and never by "everything except the bar": the bar
      // turned out not to be a direct child of the slot container, so an
      // exclusion rule silently hid the bar together with its Cancel button.
      'body.dsdel-selecting [data-slot="sidebar.footer.action"] > [data-dsh-plugin]{display:none}',
      'body.dsdel-selecting [data-slot="sidebar.footer.action"] > [class*="_entryRow"]{display:none}',
      '.dsdel-bar-count{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary,inherit)}',
      '.dsdel-bar-btn{flex:0 0 auto;white-space:nowrap;appearance:none;min-height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:var(--dsw-alias-fill-elevated,rgba(128,128,128,.08));color:var(--dsw-alias-label-primary,inherit);border-radius:8px;font-size:13px;cursor:pointer}',
      '.dsdel-bar-btn:disabled{opacity:.5;cursor:default}',
      '.dsdel-bar-danger{border-color:var(--dsw-alias-state-error-primary,#e5484d);background:var(--dsw-alias-state-error-primary,#e5484d);color:#fff}',
      '.dsdel-page{display:flex;flex-direction:column;gap:8px}',
      '.dsdel-page-hint{margin:0;color:var(--dsw-alias-label-tertiary,#888);font-size:13px;line-height:20px}',
      '.dsdel-star{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-tertiary,#8b93a1);padding:2px 2px 0;}',
      '.dsdel-star-link{color:var(--dsw-alias-brand-primary,#4d76e6);text-decoration:underline;}',
      '.dsdel-root-input{flex:1 1 220px;min-width:160px;min-height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-secondary,#d0d0d0);border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:13px}',
      '.dsdel-picker-path{margin:0 0 8px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#666);word-break:break-all}',
      // A wider confirmation dialog: the class reaches it when `Modal` forwards
      // `className`, and the `:has()` rule catches the host-owned container when
      // it does not. Both are harmless if the other one is the one that applies.
      '.dsdel-dialog-wide{width:min(94vw,980px)!important;max-width:min(94vw,980px)!important}',
      '[role="dialog"]:has(.dsdel-modal-meta),[aria-modal="true"]:has(.dsdel-modal-meta){width:min(94vw,980px);max-width:min(94vw,980px)}',
      '.dsdel-picker-list{display:flex;flex-direction:column;gap:2px;max-height:280px;overflow:auto;margin:0 0 8px}',
      '.dsdel-picker-row{appearance:none;text-align:left;padding:6px 8px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer}',
      '.dsdel-picker-row:hover{background:var(--dsw-alias-fill-secondary,rgba(127,127,127,0.12))}',
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
      const existing = document.querySelector('style[data-dsh-delete-session]')
      if (existing !== null) {
        // This tag outlives the module instance: when a newer build re-executes in
        // the same document, bailing out here would keep the old stylesheet and
        // pair it with the new markup. Rewriting it keeps the two in step.
        if (existing.textContent !== CSS) existing.textContent = CSS
        return
      }
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

    // The bar lives in the sidebar footer slot: the host owns where that row sits,
    // so there is no element here to create, dock or hide.
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

    /**
     * The bulk-move face `dsh-session-relocate` publishes on `window`. Read when
     * the bar is built rather than cached at module load, so a relocate plugin
     * that registers after this one is still picked up.
     */
    function relocateApi() {
      if (typeof window === 'undefined') return null
      const api = window.__DSH_SESSION_RELOCATE__
      if (!api || api.supportsBulkMove !== true) return null
      if (typeof api.moveSelection !== 'function') return null
      return api
    }

    /**
     * The batch bar, rendered into the host's `sidebar.footer.action` seat.
     *
     * The host decides where that row sits, how wide it is and whether the account
     * chip shares it. Occupying the slot means this plugin never measures, docks,
     * hides or restores host DOM: the row gains our controls while a selection is
     * running, and loses them the moment it ends.
     */
    function BulkBar({ t: injected }) {
      const translate = localizedTranslator(injected)
      const view = useSnapshot()
      // Outside selection mode the footer keeps its normal face.
      if (!view.selecting) return null
      const busy = view.batch !== null
      const empty = view.selectedCount === 0
      // A move reports processed-so-far (success + failure + skip) in one number;
      // a delete counts its own two buckets.
      const done = view.batch === null ? 0 : view.batch.kind === 'move' ? view.batch.done : view.batch.done + view.batch.failed
      const label = view.batch === null
        ? translate('selectedCount', view.selectedCount)
        : view.batch.kind === 'move'
          ? translate('batchMoving', done, view.batch.total)
          : translate('batchRunning', done, view.batch.total)
      return h('div', { className: 'dsdel-bar', role: 'toolbar' },
        h('span', { key: 'count', className: 'dsdel-bar-count' }, label),
        h('button', {
          key: 'cancel',
          type: 'button',
          className: 'dsdel-bar-btn dsdel-bar-cancel',
          disabled: busy,
          onClick: (event) => {
            if (event && event.stopPropagation) event.stopPropagation()
            exitSelection()
          },
        }, translate('cancelSelect')),
        // One more button when dsh-session-relocate is installed; otherwise the bar
        // is exactly what it was before.
        relocateApi() === null ? null : h('button', {
          key: 'move',
          type: 'button',
          className: 'dsdel-bar-btn dsdel-bar-move',
          disabled: busy || empty,
          onClick: (event) => {
            if (event && event.stopPropagation) event.stopPropagation()
            runBatchMove()
          },
        }, translate('moveSelected')),
        h('button', {
          key: 'delete',
          type: 'button',
          className: 'dsdel-bar-btn dsdel-bar-danger',
          disabled: busy || empty,
          onClick: (event) => {
            if (event && event.stopPropagation) event.stopPropagation()
            runBatchDelete()
          },
        }, translate('deleteSelected')),
      )
    }
    function toggleSelect(id) {
      if (state.selected.has(id)) state.selected.delete(id)
      else state.selected.add(id)
      publish()
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

    /**
     * Mark the page while the mode runs. The marker is the only hook the
     * stylesheet needs to let the account row step aside for the bar.
     */
    function markSelecting(on) {
      if (typeof document === 'undefined' || !document.body) return
      const classes = document.body.classList
      if (!classes) return
      if (on) classes.add('dsdel-selecting')
      else classes.remove('dsdel-selecting')
    }

    function enterSelection() {
      if (state.selecting) return
      state.selecting = true
      state.selected.clear()
      ensureStyle()
      markSelecting(true)
      document.addEventListener('click', onSelectClickCapture, true)
      document.addEventListener('keydown', onSelectKeydown, true)
      if (typeof MutationObserver === 'function') {
        rowObserver = new MutationObserver(scheduleDecorate)
        rowObserver.observe(document.body, { childList: true, subtree: true })
      }
      publish()
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
      markSelecting(false)
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
      state.batch = { kind: 'delete', total: ids.length, done: 0, failed: 0 }
      state.selected.clear()
      for (const id of ids) state.pending.add(id)
      publish()

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
        }
        refreshList()
        for (const id of ids) {
          if (!failedIds.includes(id)) leaveIfCurrent(id)
        }
      })
    }

    /**
     * Hand the selection to dsh-session-relocate. That plugin owns the target
     * picker and the move itself; this side runs the progress readout and the
     * summary. A cancelled picker leaves the selection untouched and says
     * nothing, because nothing happened.
     */
    async function runBatchMove() {
      if (state.batch !== null) return
      const api = relocateApi()
      if (api === null) return
      const ids = [...state.selected]
      if (ids.length === 0) return

      state.batch = { kind: 'move', total: ids.length, done: 0, failed: 0 }
      publish()

      let result
      try {
        result = await api.moveSelection(ids, {
          onProgress: (done, total) => {
            if (state.batch === null || state.batch.kind !== 'move') return
            if (typeof done === 'number' && Number.isFinite(done)) state.batch.done = Math.max(0, done)
            if (typeof total === 'number' && Number.isFinite(total)) state.batch.total = Math.max(1, total)
          },
        })
      } catch (reason) {
        state.batch = null
        publish()
        toast(t('failed') + String((reason && reason.message) || reason), true)
        return
      }

      state.batch = null
      // `canceled` is the contract spelling; `cancelled` is also honoured because
      // the contract's first draft used it. Nothing else about the result is
      // guessed: a missing count is reported, never substituted.
      if (result && (result.canceled === true || result.cancelled === true)) {
        // The user backed out of the target picker; keep the selection for a retry.
        publish()
        return
      }

      const missing = ['moved', 'failed', 'total'].filter((key) => !result || typeof result[key] !== 'number')
      if (missing.length > 0) {
        // Falling back here would turn "genuinely zero failures" and "the field
        // was not sent" into the same summary, so the shape is enforced instead.
        toast(t('moveBadResult', missing.join(', ')), true)
        exitSelection()
        refreshList()
        return
      }

      toast(t('batchMoved', result.moved, result.failed), result.failed > 0)
      exitSelection()
      refreshList()
      if (result.failed === 0) {
        for (const id of ids) leaveIfCurrent(id)
      }
    }

    // --- single delete ---------------------------------------------------------

    function deleteNow(info) {
      state.pending.add(info.sessionId)
      publish()
      // The no-dialog path can only honour auto mode: ask mode needs the list,
      // and the menu row forces the dialog in that case. With the feature off no
      // quarantine field is sent at all, keeping the request identical to the
      // version that predates the feature.
      const quarantine = !artifactsOff() && artifactsAuto() ? { scope: artifactScope() } : undefined
      postDelete(info.sessionId, quarantine)
        .then((result) => {
          const outcome = result && result.quarantine ? result.quarantine : null
          if (outcome !== null && outcome.failed.length > 0) {
            toast(t('doneQuarantineFailed', outcome.moved.length, outcome.failed.length), true)
          } else if (outcome !== null && outcome.moved.length > 0) {
            toast(t('doneQuarantine', outcome.moved.length))
          } else {
            toast(t('done'))
          }
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

    /** The rows a scope selects, in list order. */
    function candidatePaths(plan, scope) {
      if (plan === null || plan === undefined) return []
      const rows = scope === 'all' ? [...plan.created, ...plan.modified] : [...plan.created]
      return rows.map((row) => row.path)
    }

    function openDeleteDialog(sessionId, title) {
      // With the feature off the dialog carries no artifact section at all and
      // the delete request stays byte-identical to the previous version.
      //
      // Auto mode sends `{ scope }` and the host derives the whole set itself, so
      // the scan result would never be read: scanning there only burns time before
      // the dialog can appear. Ask mode is the one that needs the listing.
      const artifacts = artifactsOff()
        ? null
        : artifactsAuto()
          ? { auto: true, loading: false, plan: null, error: null, selected: new Set() }
          : { auto: false, loading: true, plan: null, error: null, selected: new Set() }
      state.dialog = {
        sessionId,
        title: title || null,
        busy: false,
        error: null,
        artifacts,
        // The subagent sessions this conversation spawned. Filled in after the
        // dialog opens: the list costs one host call, and on most conversations
        // there is nothing to list.
        children: { loading: true, list: [], selected: new Set() },
      }
      publish()
      if (artifacts !== null && artifacts.auto !== true) loadArtifacts(sessionId)
      loadChildren(sessionId)
    }

    /**
     * List the subagent sessions behind this conversation. With the switch on they
     * are all taken with the parent; with it off every one starts ticked and the
     * dialog lets the user narrow the set.
     */
    function loadChildren(sessionId) {
      fetch(`/dsh-delete-session/children`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
        .then(async (res) => {
          let data = {}
          try { data = await res.json() } catch { /* keep {} */ }
          const list = res.ok && Array.isArray(data.children) ? data.children : []
          const dialog = state.dialog
          if (dialog === null || dialog.sessionId !== sessionId) return
          dialog.children = {
            loading: false,
            list,
            selected: new Set(list.map((child) => child.id)),
          }
          publish()
        })
        .catch(() => {
          const dialog = state.dialog
          if (dialog === null || dialog.sessionId !== sessionId) return
          // A host that cannot list children still deletes the parent; reporting
          // an error here would block a delete that is otherwise fine.
          dialog.children = { loading: false, list: [], selected: new Set() }
          publish()
        })
    }

    /** The children this delete should take along. */
    function childSessionIdsFor(dialog) {
      if (dialog.children === undefined || dialog.children === null) return []
      if (syncChildren()) return dialog.children.list.map((child) => child.id)
      return dialog.children.list
        .filter((child) => dialog.children.selected.has(child.id))
        .map((child) => child.id)
    }

    /** Fetch the read-only scan and preselect the current scope's candidates. */
    function loadArtifacts(sessionId) {
      const settle = (mutate) => {
        const dialog = state.dialog
        if (dialog === null || dialog.artifacts === null || dialog.sessionId !== sessionId) return
        mutate(dialog.artifacts)
        publish()
      }
      postArtifacts(sessionId)
        .then((plan) => settle((artifacts) => {
          artifacts.loading = false
          artifacts.plan = plan
          artifacts.selected = new Set(candidatePaths(plan, artifactScope()))
        }))
        .catch((reason) => settle((artifacts) => {
          artifacts.loading = false
          artifacts.error = String((reason && reason.message) || reason)
        }))
    }

    function closeDeleteDialog() {
      if (state.dialog === null || state.dialog.busy) return
      state.dialog = null
      publish()
    }

    // --- quarantine folder picker ----------------------------------------------

    /**
     * Open the folder picker at the configured root. The browser cannot hand a
     * page a real filesystem path, so the listing comes from the host instead.
     */
    function openPicker() {
      state.picker = {
        loading: true,
        error: null,
        path: '',
        parent: null,
        entries: [],
        roots: [],
        truncated: false,
        defaultRoot: state.defaultRoot,
      }
      publish()
      loadPicker(quarantineRoot())
    }

    function closePicker() {
      state.picker = null
      publish()
    }

    function loadPicker(target) {
      postBrowse(target)
        .then((listing) => {
          if (state.picker === null) return
          state.picker = {
            loading: false,
            error: null,
            path: listing.path,
            parent: listing.parent,
            entries: listing.entries,
            roots: listing.roots,
            truncated: listing.truncated,
            defaultRoot: listing.defaultRoot,
          }
          state.defaultRoot = listing.defaultRoot
          publish()
        })
        .catch((reason) => {
          if (state.picker === null) return
          state.picker = {
            ...state.picker,
            loading: false,
            error: String((reason && reason.message) || reason),
          }
          publish()
        })
    }

    /** Commit the directory the picker is showing. */
    function pickCurrent() {
      const picker = state.picker
      if (picker === null || picker.loading || picker.path === '') return
      setQuarantineRoot(picker.path)
      closePicker()
      toast(t('rootSet'))
    }

    /**
     * Prefer the OS folder dialog, which is the one the user actually expects.
     * It only exists on Windows; everywhere else the in-page picker takes over.
     */
    let folderDialogOpen = false
    function chooseFolder() {
      if (folderDialogOpen) return
      folderDialogOpen = true
      // The dialog can open behind the browser window, so say it was raised.
      toast(t('pickerOpening'))
      postPick()
        .then((picked) => {
          if (picked.cancelled === true) return
          setQuarantineRoot(picked.path)
          toast(t('rootSet'))
        })
        .catch((reason) => {
          if (reason && reason.code === 'unsupported') {
            openPicker()
            return
          }
          toast(t('failed') + String((reason && reason.message) || reason), true)
        })
        .finally(() => {
          folderDialogOpen = false
        })
    }

    /** Learn the host default once, so the settings card can name it. */
    function loadDefaultRoot() {
      if (state.defaultRoot !== null) return
      postBrowse('')
        .then((listing) => {
          state.defaultRoot = listing.defaultRoot
          publish()
        })
        .catch(() => {
          // the card falls back to a generic label; nothing to report here
        })
    }

    /**
     * Build the quarantine request for the open dialog. The host re-derives the
     * candidate set and intersects it with `paths`, so this can only narrow what
     * the user was shown - never widen it.
     */
    function quarantineRequest(dialog) {
      if (dialog.artifacts === null) return undefined
      const scope = artifactScope()
      const skipGit = skipGitRepos()
      // In auto mode no `paths` is sent: the host takes the whole set it derives.
      if (artifactsAuto()) return { scope, skipGit }
      const allowed = new Set(candidatePaths(dialog.artifacts.plan, scope))
      const paths = [...dialog.artifacts.selected].filter((path) => allowed.has(path))
      return { scope, paths, skipGit }
    }

    // The "don't ask again" flag is committed only when the user actually
    // confirms, exactly as before - ticking the box and then cancelling must not
    // change the preference.
    function confirmDelete() {
      const dialog = state.dialog
      if (dialog === null || dialog.busy) return
      const quarantine = quarantineRequest(dialog)
      const childSessionIds = childSessionIdsFor(dialog)
      dialog.busy = true
      dialog.error = null
      state.pending.add(dialog.sessionId)
      publish()
      postDelete(dialog.sessionId, quarantine, childSessionIds)
        .then((result) => {
          state.dialog = null
          const outcome = result && result.quarantine ? result.quarantine : null
          if (outcome !== null && outcome.failed.length > 0) {
            toast(t('doneQuarantineFailed', outcome.moved.length, outcome.failed.length), true)
          } else if (outcome !== null && outcome.moved.length > 0) {
            toast(t('doneQuarantine', outcome.moved.length))
          } else {
            toast(t('done'))
          }
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
          // Ask mode keeps the dialog even when "don't ask again" is ticked: the
          // file list only exists there, and skipping it would make the feature
          // silently do nothing.
          const needsDialog = !artifactsOff() && !artifactsAuto()
          // Shift-click always asks, even after "don't ask again" was ticked.
          if (skipConfirm() && !needsDialog && !(event && event.shiftKey)) deleteNow({ sessionId })
          else openDeleteDialog(sessionId, displayTitle)
        },
        children: translate('menu'),
      })
    }

    // --- confirmation dialog (slot: shell.overlay) -----------------------------

    /**
     * The produced-files section: the scan summary, then either the tick list
     * (ask mode) or a single line stating how many files will move (auto mode).
     * A null `artifacts` means the feature is off and the dialog says nothing.
     */
    /**
     * The subagent sessions behind this conversation. Hidden while the switch
     * already answers the question, and while the list is still loading.
     */
    function renderChildren(dialog, translate) {
      const children = dialog.children
      if (children === undefined || children === null) return null
      if (children.loading) return null
      if (children.list.length === 0) return null
      if (syncChildren()) return null
      return h('div', { key: 'children', className: 'dsdel-modal-children' },
        h('p', { key: 'hint', className: 'dsdel-modal-text' },
          translate('childrenHint', children.list.length)),
        ...children.list.map((child) => h(primitives.Checkbox, {
          key: `child:${child.id}`,
          checked: children.selected.has(child.id),
          label: child.cwd ? `${child.id} · ${child.cwd}` : child.id,
          onChange: (checked) => {
            if (checked === true) children.selected.add(child.id)
            else children.selected.delete(child.id)
            publish()
          },
        })),
      )
    }

    function renderArtifacts(artifacts, translate) {
      if (artifacts === null) return null
      // Auto mode never scanned, so there is no plan to describe: name the
      // outcome instead of showing a list nobody asked for.
      if (artifacts.auto === true) {
        return h('div', { key: 'artifacts' }, [
          h('p', { key: 'head', className: 'dsdel-modal-text', style: { marginTop: '12px', fontWeight: 600 } },
            translate('artifactSection')),
          h('p', { key: 'auto', className: 'dsdel-modal-text' }, translate('artifactAutoOnly')),
        ])
      }
      if (artifacts.loading) {
        return h('p', { key: 'artifacts', className: 'dsdel-modal-meta', style: { marginTop: '12px' } },
          translate('artifactLoading'))
      }
      if (artifacts.error !== null) {
        return h('p', { key: 'artifacts', className: 'dsdel-modal-error', role: 'alert' },
          translate('artifactFailed') + artifacts.error)
      }
      const plan = artifacts.plan
      if (plan === null) return null
      const scope = artifactScope()
      const auto = artifactsAuto()
      const rows = scope === 'all' ? [...plan.created, ...plan.modified] : [...plan.created]

      const elements = [
        h('p', { key: 'head', className: 'dsdel-modal-text', style: { marginTop: '12px', fontWeight: 600 } },
          translate('artifactSection')),
        h('p', { key: 'count', className: 'dsdel-modal-meta' },
          `${translate('artifactCount', plan.created.length, plan.modified.length)} · ${translate(scope === 'all' ? 'artifactScopeAll' : 'artifactScopeCreated')}`),
      ]

      if (rows.length === 0) {
        elements.push(h('p', { key: 'none', className: 'dsdel-modal-meta' }, translate('artifactNone')))
      } else if (auto) {
        elements.push(h('p', { key: 'auto', className: 'dsdel-modal-text' }, translate('artifactAutoNote', rows.length)))
      } else {
        elements.push(h('p', { key: 'selected', className: 'dsdel-modal-meta' },
          translate('artifactSelected', artifacts.selected.size)))
        for (const row of rows.slice(0, ARTIFACT_ROWS_SHOWN)) {
          elements.push(h('label', {
            key: `row:${row.path}`,
            className: 'dsdel-modal-text',
            style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 0', cursor: 'pointer' },
          },
            h('input', {
              type: 'checkbox',
              checked: artifacts.selected.has(row.path),
              onChange: (e) => {
                if (e && e.target && e.target.checked) artifacts.selected.add(row.path)
                else artifacts.selected.delete(row.path)
                publish()
              },
            }),
            h('span', { style: { wordBreak: 'break-all' } }, row.displayPath || row.path),
          ))
        }
        if (rows.length > ARTIFACT_ROWS_SHOWN) {
          elements.push(h('p', { key: 'more', className: 'dsdel-modal-meta' },
            translate('artifactMore', rows.length - ARTIFACT_ROWS_SHOWN)))
        }
      }

      if (plan.refused.length > 0) {
        elements.push(h('p', { key: 'refused', className: 'dsdel-modal-meta' },
          translate('artifactRefused', plan.refused.length)))
      }
      if (plan.truncated) {
        elements.push(h('p', { key: 'truncated', className: 'dsdel-modal-meta' }, translate('artifactTruncated')))
      }
      return h('div', { key: 'artifacts' }, elements)
    }

    /** Folder picker overlay: walk directories, then commit one. */
    function QuarantinePicker({ t: injected }) {
      const translate = localizedTranslator(injected)
      const view = useSnapshot()
      const picker = view.picker
      if (picker === null) return null

      const children = []
      if (picker.loading) {
        children.push(h('p', { key: 'loading', className: 'dsdel-modal-meta' }, translate('pickerLoading')))
      } else if (picker.error !== null) {
        children.push(h('p', { key: 'error', className: 'dsdel-modal-error', role: 'alert' }, picker.error))
      } else {
        children.push(h('p', { key: 'path', className: 'dsdel-picker-path' }, picker.path))

        const up = []
        if (picker.parent !== null) {
          up.push(h('button', {
            key: 'up',
            type: 'button',
            className: 'dsdel-picker-row',
            onClick: () => loadPicker(picker.parent),
          }, '..'))
        }
        for (const drive of picker.roots) {
          up.push(h('button', {
            key: `drive:${drive.path}`,
            type: 'button',
            className: 'dsdel-picker-row',
            onClick: () => loadPicker(drive.path),
          }, drive.name))
        }
        if (up.length > 0) children.push(h('div', { key: 'up', className: 'dsdel-picker-list' }, up))

        if (picker.entries.length === 0) {
          children.push(h('p', { key: 'empty', className: 'dsdel-modal-meta' }, translate('pickerEmpty')))
        } else {
          children.push(h('div', { key: 'list', className: 'dsdel-picker-list' },
            picker.entries.map((entry) => h('button', {
              key: entry.path,
              type: 'button',
              className: 'dsdel-picker-row',
              onClick: () => loadPicker(entry.path),
            }, `${entry.name}/`))))
        }
        if (picker.truncated) {
          children.push(h('p', { key: 'truncated', className: 'dsdel-modal-meta' }, translate('pickerTruncated')))
        }
        children.push(h('p', { key: 'default', className: 'dsdel-modal-meta' },
          translate('pickerDefault', picker.defaultRoot || '-')))
      }

      return h(primitives.Modal, {
        open: true,
        onClose: () => closePicker(),
        closeLabel: translate('cancel'),
        title: translate('pickerTitle'),
        footer: [
          h(primitives.Button, {
            key: 'cancel',
            variant: 'outline',
            onClick: () => closePicker(),
            children: translate('cancel'),
          }),
          h(primitives.Button, {
            key: 'choose',
            disabled: picker.loading || picker.path === '',
            onClick: () => pickCurrent(),
            children: translate('pickerChoose'),
          }),
        ],
        children,
      })
    }

    function DeleteSessionDialog({ t: injected }) {
      const translate = localizedTranslator(injected)
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
        // The produced-file list needs more room than the default dialog gives.
        // `Modal` does not document a width prop, so the class, the inline style
        // and the `:has()` rule in the stylesheet all try, and whichever the host
        // honours wins.
        className: 'dsdel-dialog-wide',
        style: { width: 'min(94vw, 980px)', maxWidth: 'min(94vw, 980px)' },
        onClose: () => closeDeleteDialog(),
        closeLabel: translate('cancel'),
        title: translate('title'),
        footer,
        children: [
          h('p', { key: 'meta', className: 'dsdel-modal-meta' },
            `${dialog.title || translate('untitled')} · ${dialog.sessionId}`),
          // The sentence has to match the switch: one promises the Recycle Bin,
          // the other promises exactly what an unchecked box means.
          h('p', { key: 'desc', className: 'dsdel-modal-text' },
            translate(recycleSession() ? 'descRecycle' : 'descPermanent')),
          renderArtifacts(dialog.artifacts, translate),
          renderChildren(dialog, translate),
          // Whether a delete asks first is a setting, not a dialog affordance:
          // it lives on the plugin page only, so this dialog never changes it.
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
      const translate = localizedTranslator(injected)
      // `view` is already the prop name (page or summary), so the store snapshot
      // needs its own binding here.
      const pageSnapshot = useSnapshot()
      // The host owns the default path, so it is fetched once per mount.
      const defaultRootValue = () => (pageSnapshot && pageSnapshot.defaultRoot) || ''
      const [ask, setAsk] = react.useState(!skipConfirm())
      const [recycle, setRecycle] = react.useState(recycleSession())
      const [syncChildrenState, setSyncChildrenState] = react.useState(syncChildren())
      const [off, setOff] = react.useState(artifactsOff())
      const [auto, setAuto] = react.useState(artifactsAuto())
      const [scope, setScope] = react.useState(artifactScope())
      const [skipGit, setSkipGit] = react.useState(skipGitRepos())
      const [root, setRoot] = react.useState(quarantineRoot())
      react.useEffect(() => subscribeSkip(() => setAsk(!skipConfirm())), [])
      react.useEffect(() => { loadDefaultRoot() }, [])
      react.useEffect(() => subscribePrefs(() => {
        setOff(artifactsOff())
        setAuto(artifactsAuto())
        setScope(artifactScope())
        setRoot(quarantineRoot())
      }), [])

      if (view === 'summary') {
        if (off) return translate('pageSummaryArtifactsOff')
        return translate(auto ? 'pageSummaryArtifactsAuto' : 'pageSummaryArtifactsAsk')
      }

      const children = [
        h(primitives.Checkbox, {
          key: 'ask',
          checked: ask,
          label: translate('pageAsk'),
          onChange: (checked) => {
            setAsk(checked === true)
            setSkipConfirm(checked !== true)
          },
        }),
        h('p', { key: 'askHint', className: 'dsdel-page-hint' },
          // Ask mode needs the dialog for its file list, so "delete straight away"
          // would be a promise this combination does not keep.
          translate(ask ? 'pageHintAsk' : (!off && !auto ? 'pageHintAutoWithArtifacts' : 'pageHintAuto'))),

        h(primitives.Checkbox, {
          key: 'recycle',
          checked: recycle,
          label: translate('pageRecycle'),
          onChange: (checked) => {
            setRecycle(checked === true)
            setRecycleSession(checked === true)
          },
        }),
        h('p', { key: 'recycleHint', className: 'dsdel-page-hint' },
          translate(recycle ? 'pageRecycleOn' : 'pageRecycleOff')),

        h(primitives.Checkbox, {
          key: 'syncChildren',
          checked: syncChildrenState,
          label: translate('pageSyncChildren'),
          onChange: (checked) => {
            setSyncChildrenState(checked === true)
            setSyncChildren(checked === true)
          },
        }),
        h('p', { key: 'syncChildrenHint', className: 'dsdel-page-hint' },
          translate(syncChildrenState ? 'pageSyncChildrenOn' : 'pageSyncChildrenOff')),

        h(primitives.Checkbox, {
          key: 'off',
          checked: off,
          label: translate('pageArtifactsOff'),
          onChange: (checked) => {
            setOff(checked === true)
            setArtifactsOff(checked === true)
          },
        }),
        h('p', { key: 'offHint', className: 'dsdel-page-hint' }, translate(off ? 'pageHintArtifactsOff' : 'pageHintArtifactsOn')),
      ]

      // Everything below the master switch only matters while the feature is on;
      // leaving it rendered-but-inert would suggest a setting that does nothing.
      // The layout is inline rather than a class: a stylesheet injected into the
      // host page has already proven able to lag behind a rebuilt module, and a
      // group whose indentation depends on it can silently collapse.
      if (!off) {
        children.push(
          h('div', {
            key: 'artifacts-sub',
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              marginLeft: '10px',
              paddingLeft: '14px',
              borderLeft: '2px solid rgba(127,127,127,0.35)',
            },
          },
            h(primitives.Checkbox, {
              key: 'auto',
              checked: auto,
              label: translate('pageArtifactsAuto'),
              onChange: (checked) => {
                setAuto(checked === true)
                setArtifactsAuto(checked === true)
              },
            }),
            h('p', { key: 'autoHint', className: 'dsdel-page-hint' }, translate(auto ? 'pageHintArtifactsAuto' : 'pageHintArtifactsAsk')),
            h('div', {
              key: 'scope',
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                marginLeft: '2px',
                paddingLeft: '14px',
                borderLeft: '2px solid rgba(127,127,127,0.2)',
              },
            },
              h(primitives.Checkbox, {
                key: 'scopeCreated',
                checked: scope === 'created',
                label: translate('pageScopeCreated'),
                onChange: (checked) => {
                  if (checked !== true) return
                  setScope('created')
                  setArtifactScope('created')
                },
              }),
              h(primitives.Checkbox, {
                key: 'scopeAll',
                checked: scope === 'all',
                label: translate('pageScopeAll'),
                onChange: (checked) => {
                  if (checked !== true) return
                  setScope('all')
                  setArtifactScope('all')
                },
              }),
            ),
            h('p', { key: 'scopeHint', className: 'dsdel-page-hint' }, translate(scope === 'all' ? 'pageScopeAllHint' : 'pageScopeCreatedHint')),
            h(primitives.Checkbox, {
              key: 'skipGit',
              checked: skipGit,
              label: translate('pageSkipGit'),
              onChange: (checked) => {
                setSkipGit(checked === true)
                setSkipGitRepos(checked === true)
              },
            }),
            h('p', { key: 'skipGitHint', className: 'dsdel-page-hint' },
              translate(skipGit ? 'pageSkipGitOn' : 'pageSkipGitOff')),
            h('div', { key: 'root', style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '2px' } },
              h('p', { key: 'rootLabel', className: 'dsdel-page-hint' }, translate('pageRootLabel')),
              h('div', { key: 'rootRow', style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
                h('input', {
                  key: 'rootInput',
                  type: 'text',
                  className: 'dsdel-root-input',
                  value: root,
                  placeholder: defaultRootValue() || translate('pageRootPlaceholder'),
                  spellCheck: false,
                  onChange: (event) => {
                    setQuarantineRoot((event && event.target && event.target.value) || '')
                  },
                }),
                h(primitives.Button, {
                  key: 'browse',
                  variant: 'outline',
                  onClick: () => chooseFolder(),
                  children: translate('pageRootBrowse'),
                }),
                h(primitives.Button, {
                  key: 'open',
                  variant: 'outline',
                  onClick: () => openQuarantineRoot(root === '' ? defaultRootValue() : root),
                  children: translate('pageRootOpen'),
                }),
                h(primitives.Button, {
                  key: 'reset',
                  variant: 'outline',
                  disabled: root === '',
                  onClick: () => setQuarantineRoot(''),
                  children: translate('pageRootReset'),
                }),
              ),
              h('p', { key: 'rootHint', className: 'dsdel-page-hint' },
                root === ''
                  ? translate('pageRootDefaultHint', defaultRootValue() || '-')
                  : translate('pageRootCustomHint')),
            ),
          ),
        )
      }

      // A quiet link to the repository, last in the card. It is a nudge, not a
      // setting, so it never competes with the controls above it — and it is a
      // plain anchor, so clicking it opens the page instead of switching tabs here.
      children.push(h('div', { key: 'star', className: 'dsdel-star' },
        h('span', { key: 'ask' }, translate('starAsk')),
        h('a', {
          key: 'cta',
          className: 'dsdel-star-link',
          href: 'https://github.com/DDDMUC/dsh-delete-session',
          target: '_blank',
          rel: 'noreferrer',
        }, translate('starCta'))))

      return h('div', { className: 'dsdel-page' }, children)
    }

    // --- plugin ------------------------------------------------------------------

    function apply(ctx) {
      ensureStyle()
      // Capability bits other plugins read. Announced before any slot registers,
      // so a relocate plugin that boots after this one finds it in place; the
      // event covers the reverse order.
      if (typeof window !== 'undefined') {
        window.__DSH_DELETE_SESSION__ = { supportsBulkMove: true }
        try {
          if (typeof window.dispatchEvent === 'function' && typeof window.Event === 'function') {
            window.dispatchEvent(new window.Event('dsh-session-delete:ready'))
          }
        } catch {
          // a host without DOM events still reads the global
        }
      }

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
        // The save-path picker is a second overlay: the settings card cannot host
        // a modal of its own.
        slots.inject('shell.overlay', () => slots.register(
          { name: 'shell.overlay', id: `${NS}-picker`, order: 1, locale: NS },
          QuarantinePicker,
        ))
        // The plugin page card.
        slots.inject('plugins.row.config', () => slots.register(
          { name: 'plugins.row.config', key: `${NS}#${NS}` },
          AskBeforeDeleteOption,
        ))
        // The batch bar rides the official footer seat, so the host owns its
        // position and the row it shares with the account chip.
        slots.inject('sidebar.footer.action', () => slots.register(
          { name: 'sidebar.footer.action', id: `${NS}-bulkbar`, order: 30, locale: NS },
          BulkBar,
        ))

        // Leaving the mode disconnects the row observer and strips the checkboxes.
        return () => {
          exitSelection()
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
