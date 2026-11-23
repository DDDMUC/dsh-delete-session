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
      selectAllGroup: '全选这个工作区',
      selectAllWorkspaces: '全选所有工作区',
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
      batchDoneQuarantine: (n, m) => `已删除 ${n} 个会话，${m} 个文件已移入隔离夹`,
      batchDoneQuarantineFailed: (n, ok, fail) => `已删除 ${n} 个会话，隔离 ${ok} 个、${fail} 个失败`,
      batchPlanTitle: '这批会话的产出文件',
      batchPlanScanning: (done, total) => `正在读取会话记录… ${done}/${total}`,
      batchPlanSummary: (sessions, files) => `${sessions} 个会话，共 ${files} 个文件`,
      batchPlanAll: (picked, total) => `全选（已选 ${picked}/${total}）`,
      batchPlanSession: (picked, total) => `这个小节已选 ${picked}/${total}`,
      batchPlanEmpty: '这些会话都没有产出文件，删除只清理对话记录。',
      batchAskArtifacts: '这批会话的产出文件没有处理：批量删除不列逐文件清单。要处理它们，请单个删除，或在插件页改成「产出文件默认全部进隔离夹」。',
      batchFailed: '批量删除失败：',
      pageAsk: '删除时询问',
      pageRecycle: '删除至回收站',
      pageSyncChildren: '同时删除子会话',
      dropHint: '拖到这里删除',
      dropRelease: '松手删除「{name}」',
      dropFallback: '这个对话',
      starAsk: '⭐ 顺手留颗 Star，作者能高兴一整天',
      starCta: '行，给你一颗 Star',
      pageSyncChildrenOn: '删除对话时，把它派生的子代理会话一起删掉。',
      pageSyncChildrenOff: '不勾选时，删除前会列出子会话，由你勾选要删哪些。',
      pageReplaceCurrent: '删完打开一个新会话',
      pageReplaceCurrentOn: '删掉的如果正是当前打开的那个，顺手开一个新的，主视图不会空着。',
      pageReplaceCurrentOff: '删掉的如果正是当前打开的那个，主视图留空，什么都不新建。',
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
      pickerFailed: '选择文件夹失败：',
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
      artifactOpenFolder: '打开所在文件夹',
      artifactDeleteFile: '删除这个文件',
      fileDeleted: '文件已删除',
      fileRecycled: '文件已移入回收站',
      fileDeleteFailed: '删除文件失败：',
      revealFailed: '打开文件夹失败：',
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
      selectAllGroup: 'Select every session in this workspace',
      selectAllWorkspaces: 'Select every session in every workspace',
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
      batchDoneQuarantine: (n, m) => `Deleted ${n} session(s), ${m} file(s) moved to quarantine`,
      batchDoneQuarantineFailed: (n, ok, fail) => `Deleted ${n} session(s), ${ok} quarantined and ${fail} failed`,
      batchPlanTitle: 'Produced files in these sessions',
      batchPlanScanning: (done, total) => `Reading the session logs… ${done}/${total}`,
      batchPlanSummary: (sessions, files) => `${sessions} sessions, ${files} files`,
      batchPlanAll: (picked, total) => `Select all (${picked}/${total} ticked)`,
      batchPlanSession: (picked, total) => `${picked}/${total} ticked in this session`,
      batchPlanEmpty: 'None of these sessions produced files; deleting them only clears the conversation logs.',
      batchAskArtifacts: 'The produced files of these sessions were left alone: a batch has no per-file checklist. Delete them one by one, or switch the plugin page to "move every produced file to quarantine".',
      batchFailed: 'Batch delete failed: ',
      pageAsk: 'Ask before deleting',
      pageRecycle: 'Delete to the Recycle Bin',
      pageSyncChildren: 'Delete child sessions too',
      dropHint: 'Drop here to delete',
      dropRelease: 'Release to delete \'{name}\'',
      dropFallback: 'this conversation',
      starAsk: '⭐ A star would make the author\'s day',
      starCta: 'Fine — have one',
      pageSyncChildrenOn: 'A delete also removes the subagent sessions it spawned.',
      pageSyncChildrenOff: 'When off, the dialog lists the child sessions and you tick the ones to delete.',
      pageReplaceCurrent: 'Open a new conversation after deleting',
      pageReplaceCurrentOn: 'If the conversation you are viewing is the one deleted, a fresh one opens instead of leaving the view blank.',
      pageReplaceCurrentOff: 'If the conversation you are viewing is the one deleted, the view stays blank and nothing is created.',
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
      pickerFailed: 'Could not open the folder picker: ',
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
      artifactOpenFolder: 'Open containing folder',
      artifactDeleteFile: 'Delete this file',
      fileDeleted: 'File deleted',
      fileRecycled: 'File moved to the recycle bin',
      fileDeleteFailed: 'Could not delete the file: ',
      revealFailed: 'Could not open the folder: ',
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

    const ru = {
      menu: 'Удалить сессию',
      multiSelect: 'Выбрать несколько',
      selectAllGroup: 'Выбрать все сессии этой рабочей папки',
      selectAllWorkspaces: 'Выбрать все сессии во всех рабочих папках',
      title: 'Удалить сессию',
      descRecycle: 'Сессия и все её записи (журнал, учёт рабочей папки и статистика) будут убраны из списка и перемещены в системную корзину.',
      descPermanent: 'Сессия и все её записи (журнал, учёт рабочей папки и статистика) будут удалены безвозвратно. Отменить это нельзя.',
      cancel: 'Отмена',
      confirm: 'Удалить',
      deleting: 'Удаление…',
      done: 'Сессия удалена',
      failed: 'Не удалось удалить: ',
      busy: 'Сессия сейчас открыта в DSH, удаление не завершилось. Повторите через момент (обычно пара секунд) или перезапустите DSH и попробуйте снова.',
      notFound: 'Сессия не найдена (возможно, она уже удалена).',
      untitled: 'Сессия без названия',
      cancelSelect: 'Отмена',
      selectedCount: (n) => `Выбрано: ${n}`,
      batchRunning: (done, total) => `Удаление ${done}/${total}…`,
      moveSelected: 'Переместить',
      batchMoving: (done, total) => `Перемещение ${done}/${total}…`,
      batchMoved: (ok, fail) => (fail > 0 ? `Перемещено ${ok}, не удалось ${fail}` : `Перемещено ${ok}`),
      moveBadResult: (fields) => `В ответе о перемещении нет полей: ${fields}`,
      deleteSelected: 'Удалить',
      batchDone: (n) => `Удалено сессий: ${n}`,
      batchPartial: (ok, fail) => `Удалено ${ok}, не удалось ${fail}`,
      batchDoneQuarantine: (n, m) => `Удалено сессий: ${n}, файлов в карантине: ${m}`,
      batchDoneQuarantineFailed: (n, ok, fail) => `Удалено сессий: ${n}, в карантине ${ok}, не удалось ${fail}`,
      batchPlanTitle: 'Файлы этих сессий',
      batchPlanScanning: (done, total) => `Читаю журналы сессий… ${done}/${total}`,
      batchPlanSummary: (sessions, files) => `${sessions} сессий, ${files} файлов`,
      batchPlanAll: (picked, total) => `Выбрать все (${picked}/${total})`,
      batchPlanSession: (picked, total) => `В этой сессии отмечено ${picked}/${total}`,
      batchPlanEmpty: 'Ни одна из этих сессий не создавала файлов; удаление очистит только журналы диалогов.',
      batchAskArtifacts: 'Файлы этих сессий не обработаны: пакетное удаление не показывает список файлов. Удаляйте по одному или переключите страницу плагина на «все созданные файлы в карантин». ',
      batchFailed: 'Массовое удаление не удалось: ',
      pageAsk: 'Спрашивать перед удалением',
      pageRecycle: 'Удалять в корзину',
      pageSyncChildren: 'Удалять и дочерние сессии',
      dropHint: 'Перетащите сюда, чтобы удалить',
      dropRelease: 'Отпустите, чтобы удалить «{name}»',
      dropFallback: 'этот диалог',
      starAsk: '⭐ Звёздочка на GitHub сделает автору день',
      starCta: 'Ладно, держи звезду',
      pageSyncChildrenOn: 'Удаление сессии удаляет и порождённые ею сессии субагентов.',
      pageSyncChildrenOff: 'Если выключено, перед удалением появится список дочерних сессий и вы отметите, какие удалить.',
      pageReplaceCurrent: 'Открывать новый диалог после удаления',
      pageReplaceCurrentOn: 'Если удалён тот диалог, который открыт, вместо пустого экрана откроется новый.',
      pageReplaceCurrentOff: 'Если удалён тот диалог, который открыт, экран останется пустым, ничего не создаётся.',
      childrenHint: 'У этого диалога {n} дочерних сессий (субагентов). Отмеченные удалятся вместе с ним.',
      pageRecycleOn: 'Сессия попадёт в системную корзину, её можно восстановить.',
      pageRecycleOff: 'Сессия сразу удаляется с диска, восстановить её нельзя.',
      pageHintAsk: 'Перед каждым удалением сессии показывать подтверждение.',
      pageHintAuto: 'Удалять сессию сразу, не спрашивая.',
      // The produced-file list only exists inside the dialog, so ask mode keeps a
      // delete dialog even when the confirmation above is turned off.
      pageHintAutoWithArtifacts: 'Диалог всё равно откроется: сначала нужно показать список созданных файлов.',
      pageSummaryAsk: 'Спрашивать перед удалением',
      pageSummaryAuto: 'Удалять не спрашивая',
      pageArtifactsOff: 'Не трогать созданные файлы (как сейчас)',
      pageHintArtifactsOff: 'Удаление сессии убирает только её записи и не касается файлов в рабочей папке.',
      pageHintArtifactsOn: 'При удалении сессии разбираются и файлы, которые она трогала в рабочей папке.',
      pageArtifactsAuto: 'Сразу отправлять созданные файлы в карантин',
      pageHintArtifactsAuto: 'Все файлы из области ниже переносятся в карантин без вопросов.',
      pageHintArtifactsAsk: 'При удалении появится список файлов, и вы отметите, какие переносить.',
      pageScopeCreated: 'Только созданные файлы',
      pageScopeAll: 'Созданные и изменённые файлы',
      pageScopeCreatedHint: 'Затрагиваются только файлы, созданные этим диалогом; изменённые им существующие файлы не трогаются.',
      pageScopeAllHint: 'Сюда входят и существующие файлы, которые этот диалог переписал: их перенос изменит то, что уже было в рабочей папке.',
      pageSkipGit: 'Пропускать файлы внутри git-репозитория',
      pageSkipGitOn: 'Обрабатываются только файлы вне git-репозиториев; код из репозитория не переносится.',
      pageSkipGitOff: 'Файлы из репозитория тоже уйдут в карантин: удалив диалог, поработавший в проекте, можно унести и исходники.',
      pageSummaryArtifactsOff: 'Созданные файлы не трогаются',
      pageSummaryArtifactsAuto: 'Созданные файлы — в карантин',
      pageSummaryArtifactsAsk: 'Созданные файлы — спросить',
      pageRootLabel: 'Где хранить карантин',
      pageRootPlaceholder: 'Пусто — путь по умолчанию',
      pageRootBrowse: 'Выбрать папку…',
      pageRootOpen: 'Открыть',
      rootOpened: 'Открыто в файловом менеджере',
      rootOpenFailed: 'Не удалось открыть: ',
      pickerOpening: 'Системный диалог открыт — выберите папку в его окне',
      pickerFailed: 'Не удалось открыть выбор папки: ',
      pageRootReset: 'По умолчанию',
      pageRootDefaultHint: (path) => `Используется путь по умолчанию: ${path}`,
      pageRootCustomHint: 'Карантин создаётся здесь: по подпапке с отметкой времени на каждое удаление',
      pickerTitle: 'Куда переносить файлы в карантин',
      pickerLoading: 'Чтение…',
      pickerEmpty: 'Здесь нет подпапок',
      pickerChoose: 'Выбрать эту папку',
      pickerTruncated: 'Подпапок слишком много: показаны первые 500',
      pickerDefault: (path) => `Путь по умолчанию: ${path}`,
      rootSet: 'Место сохранения обновлено',
      artifactSection: 'Файлы, созданные этим диалогом',
      artifactOpenFolder: 'Открыть папку',
      artifactDeleteFile: 'Удалить этот файл',
      fileDeleted: 'Файл удалён',
      fileRecycled: 'Файл перемещён в корзину',
      fileDeleteFailed: 'Не удалось удалить файл: ',
      revealFailed: 'Не удалось открыть папку: ',
      artifactLoading: 'Сканирование…',
      artifactFailed: 'Сканирование не удалось: ',
      artifactNone: 'Нечего обрабатывать.',
      artifactCount: (created, modified) => `Создано: ${created} · изменено: ${modified}`,
      artifactAutoNote: (n) => `После удаления в карантин уйдёт файлов: ${n}`,
      artifactAutoOnly: 'Созданные файлы уходят в карантин автоматически, здесь они не перечисляются.',
      artifactRefused: (n) => `Пропущено ещё: ${n}`,
      artifactSelected: (n) => `Выбрано: ${n}`,
      artifactMore: (n) => `Не показано ещё: ${n}`,
      artifactTruncated: 'Список сокращён: всё, что не показано, останется нетронутым.',
      artifactScopeCreated: 'Область: только созданные',
      artifactScopeAll: 'Область: созданные + изменённые',
      artifactModifiedWarn: 'Изменённые существующие файлы (по умолчанию не отмечены):',
      doneQuarantine: (n) => `Сессия удалена, файлов в карантине: ${n}`,
      doneQuarantineFailed: (ok, fail) => `Сессия удалена, в карантине ${ok}, не удалось ${fail}`,
    }

    let sessionsSvc = null
    let localeSvc = null
    /** `uiWorkspace`: the host's own "this conversation is closed" face. */
    let navigationSvc = null
    /** Kept so the navigation service can be looked up lazily, outside apply(). */
    let hostCtx = null

    /** Languages this plugin ships dictionaries for. */
    const SHIPPED = ['zh', 'en', 'ru']

    /**
     * The language DSH itself is showing, or null when the host offers none.
     *
     * `dsh-client-locale` provides a `locale` service: `getSnapshot()` returns
     * `{ active }` and `subscribe()` fires on every change. It also mirrors the
     * choice onto `document.documentElement.lang`, which covers the case where the
     * service is not reachable but the page has already been localised.
     */
    function hostLang() {
      if (localeSvc !== null && typeof localeSvc.getSnapshot === 'function') {
        try {
          const snapshot = localeSvc.getSnapshot()
          const active = snapshot && typeof snapshot.active === 'string' ? snapshot.active : null
          if (active !== null) return active
        } catch { /* fall through to the document hint */ }
      }
      if (typeof document !== 'undefined' && document.documentElement) {
        const html = document.documentElement.lang
        if (typeof html === 'string' && html !== '') return html
      }
      return null
    }

    /**
     * Which of our dictionaries to read.
     *
     * The host is authoritative and the browser is the fallback: following
     * `navigator.language` alone meant an English OS rendered an English plugin
     * even with DSH switched to 中文. A host language we do not ship (DSH knows
     * ja/es/fr/de/pt as well) falls back to Russian for ru, English for the rest,
     * because the host would also answer in one of those two.
     */
    function browserLang() {
      const host = hostLang()
      if (host !== null) {
        const primary = String(host).toLowerCase().split('-')[0]
        if (primary === 'zh' || primary === 'en' || primary === 'ru') return primary
        return primary === 'ru' ? 'ru' : 'en'
      }
      if (typeof navigator === 'undefined') return 'zh'
      for (const tag of (navigator.languages || []).concat([navigator.language])) {
        const primary = String(tag || '').toLowerCase().split('-')[0]
        if (SHIPPED.indexOf(primary) !== -1) return primary
      }
      return 'zh'
    }

    const dictionaries = { zh, en, ru }

    // The dictionary the built-in lookup reads: the browser's language when it is
    // one we ship, the historical zh fallback otherwise.
    function activeDictionary() {
      return dictionaries[browserLang()] || zh
    }

    // The DOM decoration layer (row checkboxes, batch bar, toast) is not a slot
    // occupant, so it has no injected `t`; it uses the built-in dictionaries and
    // honours the registered `locale` namespace when the host provides one.
    // Slot components receive the host-injected `t` and use that instead.
    function t(key, a, b) {
      // A Russian browser reads the plugin's own dictionary first: DSH ships no
      // ru locale, so the host translator would answer in Chinese or English and
      // the Russian strings registered below would never be seen.
      if (browserLang() === 'ru') {
        const own = activeDictionary()[key]
        if (own !== undefined) return typeof own === 'function' ? own(a, b) : own
      }
      if (localeSvc && typeof localeSvc.translate === 'function') {
        try {
          const text = localeSvc.translate(NS, key)
          if (typeof text === 'string' && text !== key) return text
        } catch {
          // fall back to the built-in dictionaries
        }
      }
      const value = activeDictionary()[key]
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
        const dict = activeDictionary()
        const local = dict[key]
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

    /**
     * The translator every slot component renders through.
     *
     * The plugin ships its own dictionaries and follows the host's language
     * (issue #3), so its dictionary is asked first for every language it carries,
     * not just Russian. Deferring to the injected `t` for zh/en would split one
     * language across two authorities: with DSH set to English the menu would say
     * "Delete session" while the bar and the dialog stayed Chinese. Keys this
     * plugin does not ship still go to the host.
     */
    function slotTranslator(injected) {
      const raw = typeof injected === 'function' ? injected : t
      return localizedTranslator(raw)
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
      /**
       * The aggregated file checklist a batch in asking mode shows before it
       * deletes anything: { scanning, scanned, total, error, sessions[] }.
       * Asking means the user picks the files, and a batch of sessions has no
       * per-session dialog to pick them in - so the choice is made here, once.
       */
      batchPlan: null,
      /** Folder-picker state while it is open, else null. */
      picker: null,
      /** The host's default quarantine root, fetched once so the card can name it. */
      defaultRoot: null,
      /**
       * The session being dragged over the footer, or null. `over` arms the drop:
       * the bar only says "松手删除" once the pointer is actually on it.
       */
      drag: null,
    }

    const listeners = new Set()

    function buildSnapshot() {
      return {
        dialog: state.dialog,
        selecting: state.selecting,
        selected: state.selected,
        pending: state.pending,
        batch: state.batch,
        batchPlan: state.batchPlan,
        picker: state.picker,
        defaultRoot: state.defaultRoot,
        drag: state.drag,
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
    /** Whether deleting the open conversation opens a fresh one afterwards. */
    const REPLACE_KEY = 'dsh-delete-session:replace-current'
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

    /**
     * The `quarantine` payload a delete should carry, or undefined for "do not
     * touch any file".
     *
     * Only `auto` mode can answer this without a dialog: asking means handing the
     * user a per-file checklist, which a batch of sessions has nowhere to put.
     * The batch path used to skip this entirely, so a user who had switched the
     * feature on got a silent no-op instead of a quarantine.
     */
    function quarantinePlan() {
      if (artifactsOff() || !artifactsAuto()) return undefined
      return { scope: artifactScope() }
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
      return readPref(SYNC_CHILDREN_KEY, '1') !== '0'
    }

    /**
     * Whether a delete of the OPEN conversation is followed by a new one.
     *
     * On by default: a DSH sitting on a deleted conversation is a dead end, and
     * most people would rather keep working than stare at an empty screen. It is
     * a choice, though - "leave me on a blank view" has to be reachable.
     */
    function replaceCurrent() {
      return readPref(REPLACE_KEY, '1') !== '0'
    }

    function setReplaceCurrent(on) {
      // Written as '0' rather than cleared, like the child-session switch: the
      // default is on, so a removed key would read back as on again.
      writePref(REPLACE_KEY, on ? '1' : '0')
    }

    function setSyncChildren(on) {
      // "Off" is written as '0' rather than cleared: the default is now on, so a
      // removed key would read back as on again.
      writePref(SYNC_CHILDREN_KEY, on ? '1' : '0')
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

    /** Drop one row from the dialog after its file left the disk. */
    function forgetFile(sessionId, target) {
      const dialog = state.dialog
      if (dialog === null || dialog.sessionId !== sessionId) return
      const artifacts = dialog.artifacts
      if (artifacts === null || artifacts.plan === null) return
      artifacts.selected.delete(target)
      const keep = (row) => row.path !== target
      artifacts.plan = {
        ...artifacts.plan,
        created: (artifacts.plan.created || []).filter(keep),
        modified: (artifacts.plan.modified || []).filter(keep),
      }
      publish()
    }

    /** Delete one produced file, then drop its row. */
    function deleteOneFile(sessionId, target) {
      const recycle = recycleSession()
      postDeleteFile(sessionId, target, recycle).then((data) => {
        forgetFile(sessionId, target)
        toast(t(data && data.recycled === true ? 'fileRecycled' : 'fileDeleted'))
      }).catch((reason) => {
        toast(t('fileDeleteFailed') + String((reason && reason.message) || reason), true)
      })
    }

    /**
     * Delete one produced file. The recycle choice is the same preference that
     * governs a conversation delete, so the two never disagree.
     */
    function postDeleteFile(sessionId, target, recycle) {
      return fetch('/dsh-delete-session/delete-file', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, path: target, recycle }),
      }).then(async (res) => {
        let data = {}
        try { data = await res.json() } catch { /* keep {} */ }
        if (!res.ok || !data.ok) throw new Error((data && data.error) || `HTTP ${res.status}`)
        return data
      })
    }

/**
     * Show one produced file's folder. The host validates that the path is a
     * directory; the browser has no path module, so the parent is taken with a
     * plain last-separator split — Windows separators included.
     */
    function revealParent(filePath) {
      const text = String(filePath === null || filePath === undefined ? '' : filePath).replace(/[\\/]+$/, '')
      const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
      const parent = cut > 0 ? text.slice(0, cut) : text
      if (parent === '') return
      postReveal(parent).catch((reason) => {
        toast(t('revealFailed') + String((reason && reason.message) || reason), true)
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

    // Deleting the session the main view is showing has to leave the app with no
    // current conversation. It used to click the sidebar's "new session" button,
    // which is wrong twice over: that button is the USER entry point, so every
    // plugin that intercepts a new session (a naming dialog, a template picker,
    // a preset workspace) fires on a delete; and the visible result of a delete
    // became "a new conversation was created".
    //
    // The host has a way to express exactly this: `uiWorkspace.clearMain()`
    // drops the main reference, releases its retain, resets the persisted
    // `dsh.sessions.current` pointer and clears the panel. Archiving the current
    // conversation and a failed `startSession` both go through it, so it is the
    // sanctioned "nothing is open" state rather than a side effect of ours.
    function deletedVariants(id) {
      return id.startsWith('session-') ? [id, id.slice('session-'.length)] : [id, `session-${id}`]
    }

    /** The navigation service, looked up lazily so a late one is still found. */
    function navigationApi() {
      if (navigationSvc !== null) return navigationSvc
      const holder = hostCtx
      if (holder === null || typeof holder.get !== 'function') return navigationSvc
      try {
        const svc = holder.get('uiWorkspace')
        if (svc !== null && svc !== undefined) navigationSvc = svc
      } catch { /* optional service */ }
      return navigationSvc
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

      const api = navigationApi()

      // The switch is a real choice: open a fresh conversation, or leave the view
      // blank. Both go through the host - neither guesses at a button.
      if (replaceCurrent() && api !== null && typeof api.startSession === 'function') {
        try {
          api.startSession()
          return
        } catch { /* older build: fall through to clearing */ }
      }

      // Tell the host, which owns the pointer and the retain.
      if (api !== null && typeof api.clearMain === 'function') {
        try {
          api.clearMain()
          return
        } catch { /* older build: fall through */ }
      }

      // No such service (a host that predates it): the old route, kept so the
      // view is never left pointing at a conversation that no longer exists.
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
      '.dsdel-toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:2147483601;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#2b2b2b));color:var(--dsw-alias-label-primary,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));padding:9px 16px;border-radius:10px;font-size:12.5px;line-height:18px;box-shadow:0 10px 28px rgba(0,0,0,.24);max-width:min(92vw,460px);cursor:pointer;animation:dsdel-toast-in .16s cubic-bezier(.2,.8,.3,1)}',
      '@keyframes dsdel-toast-in{from{opacity:0;transform:translate(-50%,6px)}to{opacity:1;transform:translate(-50%,0)}}',
      '@media (prefers-reduced-motion:reduce){.dsdel-toast{animation:none}.dsdel-field{transition:none}}',
      '.dsdel-check{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.5));background:transparent;flex:none;margin-right:8px;box-sizing:border-box;cursor:pointer}',
      // The two select-all boxes sit where the host puts them: inside each
      // workspace header row, and inside the `工作区 N` heading above all of them.
      //
      // They live in the SIDEBAR, outside the `.dsdel-page` / `.dsdel-modal` /
      // `.dsdel-bar` token scope, so every rule here reads a host alias with its
      // own fallback. Reaching for `var(--dsdel-border)` was the bug: an unknown
      // custom property voids the whole declaration, which left the box with no
      // border, no content and nothing to click on.

      // The spacer is the only child that grows, so the right-hand cluster keeps
      // its place at the row's end while the box stays beside the name.
      '.dsdel-flex-spacer{flex:1 1 auto;min-width:0;align-self:center;height:1px}',
      '.dsdel-select-all,.dsdel-select-all-workspaces{flex:0 0 auto;box-sizing:border-box;width:15px;height:15px;min-width:15px;margin:0 0 0 6px;padding:0;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.45));border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary,#666);font-size:10px;line-height:1;cursor:pointer;opacity:1;visibility:visible;align-self:center}',
      '.dsdel-select-all:hover,.dsdel-select-all-workspaces:hover{border-color:var(--dsw-alias-brand-primary,#4c8dff);color:var(--dsw-alias-brand-primary,#4c8dff)}',
      '.dsdel-select-all[aria-checked="true"],.dsdel-select-all-workspaces[aria-checked="true"]{background:var(--dsw-alias-brand-primary,#4c8dff);border-color:var(--dsw-alias-brand-primary,#4c8dff);color:#fff}',
      '.dsdel-select-all[aria-checked="mixed"],.dsdel-select-all-workspaces[aria-checked="mixed"]{border-color:var(--dsw-alias-brand-primary,#4c8dff);color:var(--dsw-alias-brand-primary,#4c8dff)}',
      '.dsdel-select-all:focus-visible,.dsdel-select-all-workspaces:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4c8dff);outline-offset:1px}',
      // While the mode runs, let the workspace name size to its own text. With
      // `flex:1` it fills the row, so the select-all box inserted after it was
      // pushed to the far edge even though it sits early in the child list.
      'body.dsdel-selecting [class*="_projectText"]{flex:0 1 auto;min-width:0}',
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
      // A third shape: entries with no wrapper at all. The slot outlet is
      // `display:contents` and the component is its direct child, so a bare
      // <button> registration (dsh-sidebar-declutter's 收起面板列表) carries
      // neither `data-dsh-plugin` nor an `_entryRow`, and the two rules above
      // missed it. `> button` reaches exactly that shape.
      //
      // The `:not([role="toolbar"])` guard is not decoration: this plugin's own
      // bar announces itself with role="toolbar", so an unguarded `> button`
      // would hide the bar itself if its root ever became a <button>.
      'body.dsdel-selecting [data-slot="sidebar.footer.action"] > button:not([role="toolbar"]){display:none}',
      '.dsdel-drop{border:1px dashed var(--dsw-alias-border-l2,rgba(128,128,128,.4));border-radius:8px;color:var(--dsw-alias-label-secondary,inherit)}',
      '.dsdel-drop-over{border-color:var(--dsw-alias-state-error-primary,#e5484d);border-style:solid;background:rgba(229,72,77,.10);color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.dsdel-drop-icon{display:inline-flex;flex:0 0 auto;align-items:center}',
      '.dsdel-drop-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsdel-bar-count{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary,inherit)}',
      '.dsdel-bar-btn{flex:0 0 auto;white-space:nowrap;appearance:none;min-height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:var(--dsw-alias-fill-elevated,rgba(128,128,128,.08));color:var(--dsw-alias-label-primary,inherit);border-radius:8px;font-size:13px;cursor:pointer}',
      '.dsdel-bar-btn:focus-visible{outline:2px solid var(--dsdel-ring);outline-offset:1px}',
      '.dsdel-bar-btn:disabled{opacity:.5;cursor:default}',
      '.dsdel-bar-danger{border-color:var(--dsw-alias-state-error-primary,#e5484d);background:var(--dsw-alias-state-error-primary,#e5484d);color:#fff}',
      // One token layer for every surface this plugin draws. Everything below
      // reads these rather than repeating a fallback per rule: the host theme then
      // reaches the whole plugin through one block, which is the point of exposing
      // tokens at all.
      '.dsdel-page,.dsdel-modal,.dsdel-bar{--dsdel-bg:var(--dsw-alias-fill-elevated,rgba(127,127,127,.06));--dsdel-bg-hover:var(--dsw-alias-fill-hover,rgba(127,127,127,.10));--dsdel-border:var(--dsw-alias-border-l2,rgba(127,127,127,.28));--dsdel-label:var(--dsw-alias-label-primary,inherit);--dsdel-label-dim:var(--dsw-alias-label-secondary,#666);--dsdel-label-faint:var(--dsw-alias-label-tertiary,#888);--dsdel-danger:var(--dsw-alias-state-error-primary,#e5484d);--dsdel-radius:10px;--dsdel-radius-sm:8px;--dsdel-ring:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c8dff) 45%,transparent);--dsdel-shadow:0 1px 2px rgba(0,0,0,.04)}',
      '.dsdel-page{display:flex;flex-direction:column;gap:8px}',
      // Each switch and its explanation read as one block, so a card with eight
      // controls stops looking like one long column of tick boxes.
      '.dsdel-field{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border:1px solid var(--dsdel-border);border-radius:var(--dsdel-radius);background:var(--dsdel-bg);box-shadow:var(--dsdel-shadow);transition:background .12s ease,border-color .12s ease}',
      '.dsdel-field:hover{background:var(--dsdel-bg-hover)}',
      '.dsdel-field:focus-within{outline:2px solid var(--dsdel-ring);outline-offset:1px}',
      '.dsdel-page-hint{margin:0;color:var(--dsdel-label-faint);font-size:12.5px;line-height:19px;letter-spacing:.01em}',
      // One produced file per row: tick on the left, path in the middle, a folder
      // button on the right. The button sits outside the label so a click opens
      // the folder instead of toggling the tick.
      '.dsdel-file-row{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:var(--dsdel-radius-sm);transition:background .12s ease}',
      '.dsdel-file-row:hover{background:var(--dsdel-bg-hover)}',
      '.dsdel-file-label{display:flex;align-items:center;gap:8px;flex:1;min-width:0;cursor:pointer}',
      '.dsdel-file-path{flex:1;min-width:0;word-break:break-all;font-size:13px;line-height:20px;color:var(--dsdel-label)}',
      '.dsdel-file-open{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:26px;height:26px;padding:0;border:1px solid transparent;border-radius:var(--dsdel-radius-sm);background:transparent;color:var(--dsdel-label-dim);cursor:pointer;transition:background .12s ease,color .12s ease,border-color .12s ease}',
      '.dsdel-file-open:hover{background:var(--dsdel-bg);border-color:var(--dsdel-border);color:var(--dsdel-label)}',
      '.dsdel-file-open:focus-visible{outline:2px solid var(--dsdel-ring);outline-offset:1px}',
      '.dsdel-file-remove:hover{background:color-mix(in srgb,var(--dsdel-danger) 12%,transparent);border-color:color-mix(in srgb,var(--dsdel-danger) 40%,transparent);color:var(--dsdel-danger)}',
      '.dsdel-star{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-tertiary,#8b93a1);padding:2px 2px 0;}',
      '.dsdel-star-link{color:var(--dsw-alias-brand-primary,#4d76e6);text-decoration:underline;}',
      '.dsdel-root-input{flex:1 1 220px;min-width:160px;min-height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-secondary,#d0d0d0);border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:13px}',
      '.dsdel-picker-path{margin:0 0 8px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#666);word-break:break-all}',
      // A wider confirmation dialog: the class reaches it when `Modal` forwards
      // `className`, and the `:has()` rule catches the host-owned container when
      // it does not. Both are harmless if the other one is the one that applies.
      '.dsdel-dialog-wide{width:min(46vw,860px)!important;max-width:min(46vw,860px)!important;min-height:min(240px,88vh)!important;max-height:88vh!important;display:flex;flex-direction:column;overflow:hidden}',
      '.dsdel-dialog-wide > :first-child{flex:1 1 auto;min-height:0;overflow:auto}',
      '.dsdel-dialog-wide > :last-child{flex:0 0 auto;margin-top:auto}',
      '.dsdel-artifacts{overflow:auto;overscroll-behavior:contain;padding-right:2px}',
      '.dsdel-batch-row{padding-left:22px}',
      '[role="dialog"]:has(.dsdel-file-row),[aria-modal="true"]:has(.dsdel-file-row){width:min(46vw,860px);max-width:min(46vw,860px);min-height:min(240px,88vh);max-height:88vh}',
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

    // --- drag a session onto the footer to delete it ---------------------------
    //
    // The id comes from the host's own `data-row-key`, never from `dataTransfer`:
    // the official drag only reorders, and a dragover payload is unreadable anyway.
    // The gesture ends in the same place as the menu row - the confirmation dialog
    // unless the user turned asking off - so there is exactly one delete policy.

    /** The row under the pointer, with the title the drop target can name. */
    function draggedSession(event) {
      const target = event === null || event === undefined ? null : event.target
      const row = target && typeof target.closest === 'function'
        ? target.closest('[role="treeitem"]')
        : null
      const sessionId = sessionIdFromRow(row)
      if (sessionId === null) return null
      const text = row !== null && typeof row.textContent === 'string' ? row.textContent.trim() : ''
      const title = text === '' ? null : text.slice(0, 40)
      return { sessionId, title }
    }

    function onDragStartCapture(event) {
      // Inside multi-select a drag is the host reordering rows; deleting on drop
      // would make the mode quietly destructive.
      if (state.selecting) return
      const info = draggedSession(event)
      if (info === null) return
      state.drag = { sessionId: info.sessionId, title: info.title, over: false }
      syncFooterMode()
      publish()
    }

    function onDragEndCapture() {
      if (state.drag === null) return
      state.drag = null
      syncFooterMode()
      publish()
    }

    /** Drop on the bar: same policy as the menu row. */
    function dropToDelete() {
      const drag = state.drag
      if (drag === null) return
      state.drag = null
      syncFooterMode()
      publish()
      const needsDialog = !artifactsOff() && !artifactsAuto()
      if (skipConfirm() && !needsDialog) deleteNow({ sessionId: drag.sessionId })
      else openDeleteDialog(drag.sessionId, drag.title)
    }

    // --- select a whole workspace ----------------------------------------------
    //
    // The sidebar groups sessions under `[data-row-key="workspace:<key>"]` headers,
    // and the host renders the `工作区 N` heading above all of them as
    // `[data-sidebar-workspace-header]`. Both get a checkbox of their own while the
    // mode runs: one per group, one for every group together.
    //
    // Group membership is read off the DOM rather than asked from the host: a
    // session row and its workspace row are siblings inside the same section
    // element, so a subtree query from the header finds exactly that group.

    const GROUP_BUTTON = 'dsdel-select-all'
    const SPACER = 'dsdel-flex-spacer'
    const ALL_BUTTON = 'dsdel-select-all-workspaces'
    const WORKSPACE_ROWS_HEADER = '[data-sidebar-workspace-header]'

    /**
     * Position of `node` among `parent`'s element children, or -1.
     *
     * `children` is an HTMLCollection in a browser and a plain array in the test
     * stub. HTMLCollection has no `indexOf`, so the call has to be spelled out.
     */
    function childIndex(parent, node) {
      if (parent === null || parent === undefined) return -1
      const kids = parent.children
      if (kids === null || kids === undefined) return -1
      for (let i = 0; i < kids.length; i += 1) {
        if (kids[i] === node) return i
      }
      return -1
    }

    /** `data-row-key` of a sidebar row, or null. */
    function rowKeyOf(node) {
      if (node === null || node === undefined || typeof node.getAttribute !== 'function') return null
      return node.getAttribute('data-row-key')
    }

    /**
     * The session ids under one workspace header row.
     *
     * The row is not always a direct child of its section: the host may wrap it
     * (a hover card, a drag shell), and a subtree query from that wrapper finds
     * no sessions at all. So the ancestors are climbed until one of them owns
     * session rows — that ancestor is the section.
     */
    /**
     * Rows that sit directly in `node`, looking one level into a wrapper.
     *
     * The host wraps the workspace row in `HoverCard`'s <span>, so the row's
     * `parentElement` is that span and not the group section. Whatever contains
     * the rows also has to be read through it.
     *
     * A `div[role="group"]` child is a NESTED workspace: it is skipped, or a
     * parent's select-all would sweep in its children's sessions.
     */
    function ownRows(node) {
      const rows = []
      const visit = (parent, depth) => {
        if (parent === null || parent === undefined || parent.children === undefined) return
        for (const child of parent.children) {
          const key = typeof child.getAttribute === 'function' ? child.getAttribute('data-row-key') : null
          if (key !== null) { rows.push(child); continue }
          if (depth >= 2) continue
          if (typeof child.getAttribute === 'function' && child.getAttribute('role') === 'group') continue
          visit(child, depth + 1)
        }
      }
      visit(node, 0)
      return rows
    }

    /**
     * The session ids under one workspace header row.
     *
     * Climbed rather than assumed: a wrapper span put every id out of reach, so
     * the box ended up with an empty list and `toggleGroup` returned without
     * doing anything. The climb stops as soon as it reaches a container holding
     * more than one workspace, which is the shared list — grabbing there would
     * hand this group every other group's sessions.
     */
    function sessionsUnderWorkspace(headRow) {
      let node = headRow.parentElement
      for (let depth = 0; depth < 6; depth += 1) {
        if (node === null || node === undefined) return []
        const rows = ownRows(node)
        let workspaces = 0
        const ids = []
        for (const row of rows) {
          const key = rowKeyOf(row)
          if (typeof key !== 'string') continue
          if (key.startsWith('workspace:')) workspaces += 1
          else if (key.startsWith('session:')) ids.push(key.slice('session:'.length))
        }
        if (workspaces > 1) return []
        if (ids.length > 0) return ids
        node = node.parentElement
      }
      return []
    }


    /**
     * The tri-state a select-all box shows: every id in, none in, or something
     * between. `mixed` is what tells a user their group is partly ticked.
     */
    function groupState(ids) {
      if (ids.length === 0) return 'false'
      let picked = 0
      for (const id of ids) if (state.selected.has(id)) picked += 1
      if (picked === 0) return 'false'
      return picked === ids.length ? 'true' : 'mixed'
    }

    /** Ticking a full or partly ticked box clears the group; an empty one fills it. */
    function toggleGroup(ids) {
      if (ids.length === 0) return
      const fill = groupState(ids) !== 'true'
      for (const id of ids) {
        if (fill) state.selected.add(id)
        else state.selected.delete(id)
      }
      publish()
    }

    /**
     * Place (or refresh) one of the two boxes. `host` gets nothing appended twice:
     * the element is looked up by class first, so a decorate pass after a host
     * re-render reuses the box it already owns.
     */
    /**
     * Place (or refresh) one of the two boxes.
     *
     * `anchor` is the class of the element the box should sit IN FRONT OF: the
     * host pushes its right-hand actions out with an auto margin, so appending at
     * the end drops the box at the row's far edge. Inserting before those actions
     * puts it right after the label, which is where it reads as part of the
     * heading.
     */
        function placeGroupBox(host, className, label, ids, anchor) {
      if (host === null || host === undefined) return
      let box = typeof host.querySelector === 'function' ? host.querySelector('.' + className) : null
      const created = box === null
      if (created) {
        box = document.createElement('button')
        box.setAttribute('type', 'button')
        box.className = className
        box.setAttribute('role', 'checkbox')
        box.addEventListener('click', (event) => {
          // The workspace header toggles its group on click; this box must not.
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
          toggleGroup(box.__dsdelIds || [])
        })
      }

      // The anchor is a comma list, tried one at a time: a document-order match
      // could otherwise pick a later sibling than the caller meant.
      let before = null
      if (anchor !== undefined && anchor !== null) {
        for (const selector of String(anchor).split(',')) {
          const found = host.querySelector(selector.trim())
          if (found !== null && found !== undefined) { before = found; break }
        }
      }

      // ALWAYS insert, not only on creation. A box placed by an earlier decorate
      // pass (or an earlier build) kept its old seat forever, because the insert
      // sat inside the `created` branch: the header box moved on the next pass and
      // the workspace box did not. `insertBefore` on an existing child just moves
      // it, so this is idempotent.
      // One flex child has to absorb the free space, or the whole right-hand
      // cluster (count, menu, new-session) slides left with the box. The spacer
      // takes that job so the name can stay at its natural width.
      let spacer = host.querySelector('.' + SPACER)
      if (before !== null && before !== undefined) {
        if (spacer === null) {
          spacer = document.createElement('span')
          spacer.className = SPACER
          spacer.setAttribute('aria-hidden', 'true')
          spacer.setAttribute('data-dsh-delete-session', 'spacer')
        }
        // Only touch the DOM when something is actually out of place. Every
        // `insertBefore` is a real mutation, and the list observer counted it as
        // a change: moving the box on every pass fed the observer its own work,
        // so a new pass was scheduled for the next frame, forever. A click that
        // landed while the box was detached and re-attached never completed,
        // which is why it took a dozen taps to hit it once.
        const boxAt = childIndex(host, box)
        const spacerAt = childIndex(host, spacer)
        const beforeAt = childIndex(host, before)
        if (boxAt === -1 || spacerAt === -1 || beforeAt === -1
          || boxAt !== spacerAt - 1 || beforeAt !== spacerAt + 1) {
          host.insertBefore(spacer, before)
          host.insertBefore(box, spacer)
        }
      } else if (created) {
        host.appendChild(box)
      }

      box.setAttribute('aria-label', label)
      box.setAttribute('data-dsh-delete-session', 'select-all')
      const state_ = groupState(ids)
      box.setAttribute('aria-checked', state_)
      box.textContent = state_ === 'true' ? '✓' : (state_ === 'mixed' ? '−' : '')
      box.__dsdelIds = ids
    }
    function decorateSelectAll(rows) {
      if (!state.selecting) {
        for (const el of document.querySelectorAll('.' + GROUP_BUTTON)) el.remove()
        for (const el of document.querySelectorAll('.' + ALL_BUTTON)) el.remove()
        for (const el of document.querySelectorAll('.' + SPACER)) el.remove()
        return
      }
      const headings = document.querySelectorAll(WORKSPACE_ROWS_HEADER)
      if (headings.length > 0) {
        const every = []
        for (const row of rows) {
          const key = rowKeyOf(row)
          if (typeof key === 'string' && key.startsWith('session:')) every.push(key.slice('session:'.length))
        }
        // In the heading the label is followed by the search slot; inserting before
        // it keeps the box beside the words instead of inside the action cluster.
        // The heading row is: label, search slot, options, add. The box goes after
        // the label, before the first action it can find.
        placeGroupBox(headings[0], ALL_BUTTON, t('selectAllWorkspaces'), every,
          '[class*="_searchSlot"], [class*="_headerActions"]')
      }
      for (const row of rows) {
        const key = rowKeyOf(row)
        if (typeof key !== 'string' || !key.startsWith('workspace:')) continue
        // The workspace row is: folder, chevron, label block, then the actions. The
        // actions carry `margin-left:auto`, so anything appended after them lands at
        // the far edge; inserting before them keeps the box beside the name.
        placeGroupBox(row, GROUP_BUTTON, t('selectAllGroup'), sessionsUnderWorkspace(row),
          '[class*="_rowActions"]')
      }
    }

    function decorateRows() {
      if (typeof document === 'undefined') return
      const rows = document.querySelectorAll('[role="treeitem"]')
      rows.forEach((row) => {
        const id = sessionIdFromRow(row)
        if (!id) return
        // Checkboxes belong to multi-select only: a single delete (or any other
        // decorate pass outside the mode) must not plant them on every row.
        // The checkbox is always the row's first element child, so it is read
        // through the pointer. `querySelector` here ran twice per row per frame,
        // which is the pass's dominant cost once the list is long.
        const first = row.firstElementChild
        const existing = first !== null && first !== undefined
          && first.classList
          && first.classList.contains(DEL_CHECK)
          ? first
          : null
        if (!state.selecting) {
          if (existing !== null) existing.remove()
        } else {
          let check = existing
          if (!check) {
            check = document.createElement('span')
            check.className = DEL_CHECK
            check.setAttribute('data-dsh-delete-session', 'check')
            row.insertBefore(check, row.firstChild)
          }
          check.classList.toggle('dsdel-check-on', state.selected.has(id))
        }
        row.classList.toggle('dsdel-row-pending', state.pending.has(id))
      })
      decorateSelectAll(rows)
      if (!state.selecting) {
        document.querySelectorAll('.dsdel-check').forEach((el) => el.remove())
      }
    }
    /**
     * A mutation batch only matters when a node came or went. Text streaming
     * inside the transcript produces characterData records forever; scheduling a
     * full row scan for those would burn a frame's budget on every token.
     */
    /** True for the nodes this plugin itself inserts into the sidebar. */
    function isOwnNode(node) {
      if (node === null || node === undefined || typeof node.getAttribute !== 'function') return false
      return node.getAttribute('data-dsh-delete-session') !== null
    }

    function allOwnNodes(list) {
      if (list === null || list === undefined || list.length === 0) return true
      for (const node of list) if (!isOwnNode(node)) return false
      return true
    }

    function onRowMutations(records) {
      if (records === undefined || records === null) return scheduleDecorate()
      for (const record of records) {
        const added = record === null || record === undefined ? null : record.addedNodes
        const removed = record === null || record === undefined ? null : record.removedNodes
        const hasAdded = added !== null && added !== undefined && added.length > 0
        const hasRemoved = removed !== null && removed !== undefined && removed.length > 0
        if (!hasAdded && !hasRemoved) continue
        // Its own boxes and spacers are not a reason to scan again. Counting
        // them made every pass schedule the next one: a loop that kept moving
        // the box out from under the cursor.
        if (allOwnNodes(added) && allOwnNodes(removed)) continue
        scheduleDecorate()
        return
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
      // A session dragged over the sidebar turns the footer into a drop target.
      if (view.drag !== null && view.drag !== undefined) {
        const armed = view.drag.over === true
        const name = view.drag.title === null || view.drag.title === undefined
          ? translate('dropFallback')
          : view.drag.title
        return h('div', {
          className: armed ? 'dsdel-bar dsdel-drop dsdel-drop-over' : 'dsdel-bar dsdel-drop',
          role: 'toolbar',
          onDragOver: (event) => {
            if (event && typeof event.preventDefault === 'function') event.preventDefault()
            if (event && event.dataTransfer) {
              try { event.dataTransfer.dropEffect = 'move' } catch { /* read-only */ }
            }
            if (state.drag !== null && state.drag.over !== true) {
              state.drag.over = true
              publish()
            }
          },
          onDragLeave: () => {
            if (state.drag !== null && state.drag.over !== false) {
              state.drag.over = false
              publish()
            }
          },
          onDrop: (event) => {
            if (event && typeof event.preventDefault === 'function') event.preventDefault()
            if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
            dropToDelete()
          },
        },
          h('span', { key: 'icon', className: 'dsdel-drop-icon' }, glyph(TRASH_PATHS)),
          h('span', { key: 'text', className: 'dsdel-drop-text' },
            armed ? translate('dropRelease', { name }) : translate('dropHint')),
        )
      }
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
            beginBatchDelete()
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
      const target = e.target && typeof e.target.closest === 'function' ? e.target : null
      // Anything this plugin drew handles its own click. Its document listener
      // runs first (capture), so without this guard a click on a select-all box
      // inside a workspace treeitem is swallowed as if the row itself was clicked.
      if (target !== null && target.closest('[data-dsh-delete-session]') !== null) return
      const row = target === null ? null : target.closest('[role="treeitem"]')
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

    /** The footer is ours while selecting or while a session is dragged over it. */
    function syncFooterMode() {
      markSelecting(state.selecting || state.drag !== null)
    }

    function enterSelection() {
      if (state.selecting) return
      state.selecting = true
      state.selected.clear()
      ensureStyle()
      syncFooterMode()
      document.addEventListener('click', onSelectClickCapture, true)
      document.addEventListener('keydown', onSelectKeydown, true)
      if (typeof MutationObserver === 'function') {
        rowObserver = new MutationObserver(onRowMutations)
        // Observation root is the list, not the document: the transcript below
        // streams tokens continuously and would otherwise wake this on every one.
        const list = typeof document.querySelector === 'function'
          ? document.querySelector(LIST_SELECTOR)
          : null
        rowObserver.observe(list !== null && list !== undefined ? list : document.body, {
          childList: true,
          subtree: true,
        })
      }
      publish()
    }

    function exitSelection(options) {
      if (!state.selecting) return
      state.selecting = false
      state.selected.clear()
      state.batch = null
      state.batchPlan = null
      const keepPending = !!(options && options.keepPending)
      if (!keepPending) {
        state.pending.clear()
        document.querySelectorAll('.dsdel-row-pending').forEach((el) => el.classList.remove('dsdel-row-pending'))
      }
      syncFooterMode()
      document.removeEventListener('click', onSelectClickCapture, true)
      document.removeEventListener('keydown', onSelectKeydown, true)
      if (rowObserver) { rowObserver.disconnect(); rowObserver = null }
      document.querySelectorAll('.dsdel-check').forEach((el) => el.remove())
      // Take the select-all boxes and their spacer with the mode, now rather than
      // on the next decorate pass: the spacer grows, so a frame of it left behind
      // would visibly shove the row's right-hand cluster to the left.
      for (const cls of [GROUP_BUTTON, ALL_BUTTON, SPACER]) {
        document.querySelectorAll('.' + cls).forEach((el) => el.remove())
      }
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

    /** How many sessions one checklist scan reads at a time. */
    const SCAN_CONCURRENCY = 4

    /**
     * The bar's Delete: straight through in auto/off mode, a checklist in asking
     * mode.
     *
     * Asking means the user chooses the files, and the single path honours that by
     * showing a list inside the confirmation dialog. A batch has no such dialog -
     * it deletes several sessions at once - so leaving it out was the whole of
     * issue #4: the feature was on, the files stayed put, and the only signal was
     * a toast afterwards. Here the choice is made once, over every session in the
     * selection, before anything is deleted.
     */
    function beginBatchDelete() {
      if (state.batch !== null || state.batchPlan !== null) return
      if (state.selected.size === 0) return
      if (artifactsOff() || artifactsAuto()) {
        runBatchDelete()
        return
      }
      startBatchScan()
    }

    /** The title the sidebar row shows, for naming a session in the checklist. */
    function titleForSession(id) {
      if (typeof document === 'undefined') return null
      const key = `session:${id}`
      let row = null
      try {
        for (const candidate of document.querySelectorAll('[role="treeitem"]')) {
          if (rowKeyOf(candidate) === key) { row = candidate; break }
        }
      } catch { /* no DOM: fall back to the id */ }
      const text = row !== null && typeof row.textContent === 'string' ? row.textContent.trim() : ''
      return text === '' ? null : text.slice(0, 60)
    }

    /**
     * Read every selected session's plan, then show the checklist.
     *
     * The scan is read-only and per-session, so it runs concurrently with a small
     * pool: one long-lived conversation can name hundreds of paths, and a batch of
     * twenty would otherwise serialize twenty of those scans in front of the
     * dialog.
     */
    function startBatchScan() {
      const ids = [...state.selected]
      const scope = artifactScope()
      const skipGit = skipGitRepos()
      state.batchPlan = {
        scanning: true,
        scanned: 0,
        error: null,
        scope,
        skipGit,
        sessions: ids.map((id) => ({
          id,
          title: titleForSession(id),
          loading: true,
          error: null,
          plan: null,
          selected: new Set(),
        })),
      }
      publish()

      let cursor = 0
      const worker = async () => {
        while (true) {
          const index = cursor
          cursor += 1
          const plan = state.batchPlan
          if (plan === null || index >= plan.sessions.length) return
          const entry = plan.sessions[index]
          try {
            const artifacts = await postArtifacts(entry.id)
            // The dialog may have been closed while this was in flight.
            const current = state.batchPlan
            if (current === null) return
            entry.plan = artifacts
            entry.selected = new Set(candidatePaths(artifacts, scope))
          } catch (reason) {
            const current = state.batchPlan
            if (current === null) return
            entry.error = String((reason && reason.message) || reason)
          }
          entry.loading = false
          if (state.batchPlan !== null) state.batchPlan.scanned += 1
          publish()
        }
      }
      const workers = []
      for (let i = 0; i < Math.min(SCAN_CONCURRENCY, ids.length); i += 1) workers.push(worker())
      Promise.all(workers).then(() => {
        if (state.batchPlan !== null) {
          state.batchPlan.scanning = false
          publish()
        }
      })
    }

    function closeBatchPlan() {
      if (state.batchPlan === null) return
      state.batchPlan = null
      publish()
    }

    /** Files offered across the whole checklist. */
    function batchPlanFiles(plan) {
      const rows = []
      for (const session of plan.sessions) {
        if (session.plan === null) continue
        for (const row of batchRows(session.plan, plan.scope)) rows.push({ session, row })
      }
      return rows
    }

    /** The rows one session offers at the current scope. */
    function batchRows(plan, scope) {
      if (plan === null || plan === undefined) return []
      return scope === 'all' ? [...plan.created, ...plan.modified] : [...plan.created]
    }

    function toggleBatchSession(session) {
      const rows = batchRows(session.plan, state.batchPlan === null ? 'created' : state.batchPlan.scope)
      const all = rows.every((row) => session.selected.has(row.path))
      for (const row of rows) {
        if (all) session.selected.delete(row.path)
        else session.selected.add(row.path)
      }
      publish()
    }

    function toggleBatchAll() {
      const plan = state.batchPlan
      if (plan === null) return
      const files = batchPlanFiles(plan)
      const all = files.every(({ session, row }) => session.selected.has(row.path))
      for (const { session, row } of files) {
        if (all) session.selected.delete(row.path)
        else session.selected.add(row.path)
      }
      publish()
    }

    /** Confirm the checklist: run the delete with each session's own file list. */
    function confirmBatchPlan() {
      const plan = state.batchPlan
      if (plan === null || plan.scanning) return
      const paths = {}
      for (const session of plan.sessions) {
        // A session whose scan failed carries no list, and an empty array means
        // "move nothing" - so it is left out entirely and its files stay put.
        if (session.error !== null) continue
        paths[session.id] = [...session.selected]
      }
      state.batchPlan = null
      publish()
      runBatchDelete(paths)
    }

    function runBatchDelete(pathsById) {
      if (state.batch !== null) return
      const ids = [...state.selected]
      if (ids.length === 0) return
      state.batch = { kind: 'delete', total: ids.length, done: 0, failed: 0 }
      state.selected.clear()
      for (const id of ids) state.pending.add(id)
      publish()

      // The same switch the single path honours; without this every request went
      // out with no `quarantine` field and the files stayed where they were.
      //
      // In asking mode the checklist already produced an explicit list per session
      // (issue #4): sending `{ scope }` there would move the whole derived set and
      // quietly ignore what the user ticked.
      const derived = quarantinePlan()
      const listed = pathsById !== undefined && pathsById !== null
      const scope = artifactScope()
      const skipGit = skipGitRepos()
      const quarantineFor = (id) => {
        if (!listed) return derived
        const paths = pathsById[id]
        if (!Array.isArray(paths)) return undefined
        return { scope, paths, skipGit }
      }
      // Asking mode with no checklist (the caller skipped it) still has to be
      // honest about the files it is not moving.
      const askOnly = !listed && !artifactsOff() && !artifactsAuto()
      let movedFiles = 0
      let failedFiles = 0
      const failedIds = []
      let cursor = 0
      const worker = async () => {
        while (true) {
          const index = cursor
          cursor += 1
          if (index >= ids.length) return
          const id = ids[index]
          try {
            const result = await postDelete(id, quarantineFor(id))
            const outcome = result && result.quarantine ? result.quarantine : null
            if (outcome !== null) {
              movedFiles += outcome.moved.length
              failedFiles += outcome.failed.length
            }
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
          // The files are reported with the count, so a user who moved a hundred
          // of them sees that number instead of a bare "deleted".
          if (failedFiles > 0) {
            toast(t('batchDoneQuarantineFailed', ok, movedFiles, failedFiles), true)
          } else if (movedFiles > 0) {
            toast(t('batchDoneQuarantine', ok, movedFiles))
          } else {
            toast(t('batchDone', ok))
          }
          if (askOnly) toast(t('batchAskArtifacts'), true)
          exitSelection({ keepPending: true })
          settlePendingSoon()
        } else {
          for (const id of failedIds) state.selected.add(id)
          toast(t('batchPartial', ok, failed), true)
          if (askOnly) toast(t('batchAskArtifacts'), true)
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
      const quarantine = quarantinePlan()
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
          // Two host answers mean "use the page picker instead": `unsupported`
          // (no directoryPicker service at all) and `browse` (the service exists
          // but serves listings, which is what a remote client gets). Neither is
          // a failure, so neither may surface as a toast.
          if (reason && (reason.code === 'unsupported' || reason.code === 'browse')) {
            openPicker()
            return
          }
          // Nothing was deleted here, so the delete wording would mislead.
          toast(t('pickerFailed') + String((reason && reason.message) || reason), true)
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

    /** The sidebar list container; hashed class name, matched by its suffix. */
    const LIST_SELECTOR = '[class*="_regionArea"]'
    /** Marks a row checkbox this plugin planted. */
    const DEL_CHECK = 'dsdel-check'

    /** Inline glyphs for the two rows; the host exposes no matching pair. */
    const TRASH_PATHS = ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13', 'M9 7V4h6v3']
    /** A folder, for "show this file where it lives". */
    const FOLDER_PATHS = ['M3 6a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z']
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
    function SelectMultipleMenuItem({ useMenuOpenState, t: injected }) {
      const translate = slotTranslator(injected)
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
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, t: injected }) {
      const translate = slotTranslator(injected)
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
          elements.push(h('div', {
            key: `row:${row.path}`,
            'data-file-row': row.path,
            className: 'dsdel-file-row',
          },
            h('label', {
              key: 'label',
              className: 'dsdel-file-label',
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
              h('span', { key: 'path', className: 'dsdel-file-path' }, row.displayPath || row.path),
            ),
            // Delete just this file. Same destination rule as the conversation
            // switch: the system trash when recycling is on, gone when it is not.
            h('button', {
              key: 'remove',
              type: 'button',
              className: 'dsdel-file-open dsdel-file-remove',
              title: translate('artifactDeleteFile'),
              'aria-label': translate('artifactDeleteFile'),
              onClick: (event) => {
                if (event && typeof event.preventDefault === 'function') event.preventDefault()
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                deleteOneFile(state.dialog === null ? '' : state.dialog.sessionId, row.path)
              },
            }, glyph(TRASH_PATHS)),
            // One folder per row. What moves is the file, so the thing worth
            // looking at before deciding is where it lives. The button is a
            // SIBLING of the label: inside it, a click would toggle the tick box.
            h('button', {
              key: 'open',
              type: 'button',
              className: 'dsdel-file-open',
              title: translate('artifactOpenFolder'),
              'aria-label': translate('artifactOpenFolder'),
              onClick: (event) => {
                if (event && typeof event.preventDefault === 'function') event.preventDefault()
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                revealParent(row.path)
              },
            }, glyph(FOLDER_PATHS)),
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
      return h('div', { key: 'artifacts', className: 'dsdel-artifacts' }, elements)
    }

    /**
     * The batch file checklist (issue #4).
     *
     * Asking mode gives the single delete a per-file list inside its confirmation
     * dialog. A batch has no such dialog, so the equivalent is one aggregated list
     * over every selected session, shown before anything is deleted. Sessions are
     * grouped so the user can tell whose files are whose, and a session with
     * nothing to move is listed rather than hidden - "this one has no produced
     * files" is information, not noise.
     */
    function BatchPlanDialog({ t: injected }) {
      const translate = localizedTranslator(injected)
      const view = useSnapshot()
      const plan = view.batchPlan
      if (plan === null) return null

      const files = batchPlanFiles(plan)
      const picked = files.filter(({ session, row }) => session.selected.has(row.path)).length
      const children = []

      if (plan.error !== null) {
        children.push(h('p', { key: 'error', className: 'dsdel-modal-error', role: 'alert' }, plan.error))
      }

      // The overall progress line. Scanning every session is a real wait on a
      // long selection, and a dialog that appears frozen reads as a hang.
      if (plan.scanning) {
        children.push(h('p', { key: 'scanning', className: 'dsdel-modal-meta' },
          translate('batchPlanScanning', plan.scanned, plan.sessions.length)))
      } else {
        children.push(h('p', { key: 'summary', className: 'dsdel-modal-meta' },
          translate('batchPlanSummary', plan.sessions.length, files.length)))
      }

      // One line for the whole list: ticking them one by one across twenty
      // sessions is the thing that made the single dialog worth having.
      if (files.length > 0) {
        children.push(h('div', { key: 'all', className: 'dsdel-file-row' },
          h('label', { key: 'label', className: 'dsdel-file-label' },
            h('input', {
              type: 'checkbox',
              className: 'dsdel-batch-all',
              checked: picked === files.length,
              onChange: () => toggleBatchAll(),
            }),
            h('span', { key: 'text', className: 'dsdel-file-path' },
              translate('batchPlanAll', picked, files.length)),
          ),
        ))
      }

      for (const session of plan.sessions) {
        const rows = batchRows(session.plan, plan.scope)
        const label = session.title === null || session.title === undefined
          ? session.id
          : `${session.title}  ·  ${session.id}`
        children.push(h('p', {
          key: `head:${session.id}`,
          className: 'dsdel-modal-text',
          style: { marginTop: '10px', fontWeight: 600 },
        }, label))

        if (session.loading) {
          children.push(h('p', { key: `load:${session.id}`, className: 'dsdel-modal-meta' },
            translate('artifactLoading')))
          continue
        }
        if (session.error !== null) {
          children.push(h('p', { key: `err:${session.id}`, className: 'dsdel-modal-error', role: 'alert' },
            translate('artifactFailed') + session.error))
          continue
        }
        if (rows.length === 0) {
          children.push(h('p', { key: `none:${session.id}`, className: 'dsdel-modal-meta' },
            translate('artifactNone')))
          continue
        }

        const all = rows.every((row) => session.selected.has(row.path))
        children.push(h('div', { key: `all:${session.id}`, className: 'dsdel-file-row' },
          h('label', { key: 'label', className: 'dsdel-file-label' },
            h('input', {
              type: 'checkbox',
              checked: all,
              onChange: () => toggleBatchSession(session),
            }),
            h('span', { key: 'text', className: 'dsdel-file-path' },
              translate('batchPlanSession', session.selected.size, rows.length)),
          ),
        ))
        for (const row of rows.slice(0, ARTIFACT_ROWS_SHOWN)) {
          children.push(h('div', {
            key: `row:${session.id}:${row.path}`,
            'data-file-row': row.path,
            className: 'dsdel-file-row dsdel-batch-row',
          },
            h('label', { key: 'label', className: 'dsdel-file-label' },
              h('input', {
                type: 'checkbox',
                checked: session.selected.has(row.path),
                onChange: (e) => {
                  if (e && e.target && e.target.checked) session.selected.add(row.path)
                  else session.selected.delete(row.path)
                  publish()
                },
              }),
              h('span', { key: 'path', className: 'dsdel-file-path' }, row.displayPath || row.path),
            ),
          ))
        }
        if (rows.length > ARTIFACT_ROWS_SHOWN) {
          children.push(h('p', { key: `more:${session.id}`, className: 'dsdel-modal-meta' },
            translate('artifactMore', rows.length - ARTIFACT_ROWS_SHOWN)))
        }
        if (session.plan.refused !== undefined && session.plan.refused.length > 0) {
          children.push(h('p', { key: `ref:${session.id}`, className: 'dsdel-modal-meta' },
            translate('artifactRefused', session.plan.refused.length)))
        }
      }

      return h(primitives.Modal, {
        open: true,
        onClose: () => closeBatchPlan(),
        closeLabel: translate('cancel'),
        title: translate('batchPlanTitle'),
        footer: [
          h(primitives.Button, {
            key: 'cancel',
            variant: 'outline',
            onClick: () => closeBatchPlan(),
            children: translate('cancel'),
          }),
          h(primitives.Button, {
            key: 'confirm',
            variant: 'outline',
            className: 'dsdel-danger-btn',
            disabled: plan.scanning,
            onClick: () => confirmBatchPlan(),
            children: translate('confirm'),
          }),
        ],
        children,
      })
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

      // The file list sizes its own frame: a short list gets a short dialog, a
      // long one grows until the viewport cap and then scrolls. A forced ratio
      // cannot do that — it pins the height, so the empty band under two lines
      // of text simply moves around.
      const plan = dialog.artifacts !== null && dialog.artifacts !== undefined
        ? dialog.artifacts.plan
        : null
      const listed = plan === null || plan === undefined
        ? 0
        : (plan.created || []).length + (plan.modified || []).length
      const needsFrame = listed > 0 && dialog.artifacts.auto !== true
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
        // `Modal` documents no width prop, so the class, the inline style and the
        // `:has()` rule in the stylesheet all try; whichever the host honours wins.
        // 9:16: the file list reads as a column, so the shell is a phone-shaped
        // card. Width is derived from the height budget (94vh tall at most), which
        // keeps the ratio on every window size; the list scrolls inside it.
        ...(needsFrame ? { className: 'dsdel-dialog-wide' } : {}),
        ...(needsFrame ? {
          style: {
            width: 'min(46vw, 860px)',
            maxWidth: 'min(46vw, 860px)',
            minHeight: 'min(240px, 88vh)',
            maxHeight: '88vh',
          },
        } : {}),
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
      const [replaceState, setReplaceState] = react.useState(replaceCurrent())
      const [off, setOff] = react.useState(artifactsOff())
      const [auto, setAuto] = react.useState(artifactsAuto())
      const [scope, setScope] = react.useState(artifactScope())
      const [skipGit, setSkipGit] = react.useState(skipGitRepos())
      const [root, setRoot] = react.useState(quarantineRoot())
      react.useEffect(() => subscribeSkip(() => setAsk(!skipConfirm())), [])
      react.useEffect(() => { loadDefaultRoot() }, [])
      react.useEffect(() => subscribePrefs(() => {
        setReplaceState(replaceCurrent())
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
          key: 'replaceCurrent',
          checked: replaceState,
          label: translate('pageReplaceCurrent'),
          onChange: (checked) => {
            setReplaceState(checked === true)
            setReplaceCurrent(checked === true)
          },
        }),
        h('p', { key: 'replaceCurrentHint', className: 'dsdel-page-hint' },
          translate(replaceState ? 'pageReplaceCurrentOn' : 'pageReplaceCurrentOff')),

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

      // Each control owns the nodes that explain it. Grouping them here keeps the
      // markup above flat (a switch and its hint are still two pushes) while the
      // page draws them as one block.
      const FIELD_KEYS = new Set(['ask', 'recycle', 'syncChildren', 'replaceCurrent', 'off', 'auto', 'scope', 'skipGit', 'root'])
      function groupFields(nodes) {
        const groups = []
        let current = null
        for (const node of nodes) {
          const key = node !== null && node !== undefined && node.props ? node.props.key : undefined
          if (FIELD_KEYS.has(key)) {
            current = { control: key, nodes: [node] }
            groups.push(current)
            continue
          }
          // The hint of a control is keyed `<control>Hint`; the root row keeps its
          // input, buttons and hint under the same prefix.
          if (current !== null && typeof key === 'string' && key !== 'star' && key !== 'cta'
            && key.startsWith(current.control)) {
            current.nodes.push(node)
            continue
          }
          current = null
          groups.push({ control: null, nodes: [node] })
        }
        return groups.map((group, index) => (group.control === null
          ? group.nodes[0]
          : h('div', { key: `field:${group.control}`, className: 'dsdel-field' }, ...group.nodes)))
      }

      return h('div', { className: 'dsdel-page' }, groupFields(children))
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

      hostCtx = ctx
      sessionsSvc = ctx.get('sessions') || null
      if (!sessionsSvc) {
        try { ctx.inject(['sessions'], (sub) => { sessionsSvc = sub.sessions }) } catch { /* optional */ }
      }
      localeSvc = ctx.get('locale') || null
      // `uiWorkspace` is a service, not a module: `ctx.get` is an optional lookup,
      // and a host that provides it later is covered by the inject below.
      try {
        const nav = ctx.get('uiWorkspace')
        if (nav !== null && nav !== undefined) navigationSvc = nav
      } catch { /* optional service */ }
      if (navigationSvc === null) {
        try {
          ctx.inject(['uiWorkspace'], (sub) => { navigationSvc = sub.uiWorkspace || null })
        } catch { /* optional service */ }
      }

      // Slot components are handed a `t` bound to this namespace, so the
      // dictionaries must reach the host - on BOTH arrival paths. If `locale`
      // only turns up through `ctx.inject`, a registration living on the
      // synchronous branch would never run and the menu would fall back to
      // printing raw keys ("multiSelect", "menu"). `ctx.effect` ties the
      // registration's lifetime to the plugin, matching ui-workspace.
      let localeRegistered = false
      let localeSubscribed = false
      const adoptLocale = (svc) => {
        localeSvc = svc || null
        // The bar, the dialog and the toasts are rendered by this plugin, so they
        // do not inherit the host's re-render when the language changes in the
        // settings. Piggy-backing on the service's own notification keeps them in
        // step with the menu rows, which the host and re-render itself.
        if (localeSvc !== null && typeof localeSvc.subscribe === 'function' && !localeSubscribed) {
          localeSubscribed = true
          try {
            const off = localeSvc.subscribe(() => { try { publish() } catch { /* not mounted yet */ } })
            if (typeof ctx.effect === 'function' && typeof off === 'function') ctx.effect(() => off, `${NS}: language changes`)
          } catch { /* a host without subscribe still renders on its own */ }
        }
        if (localeRegistered || !localeSvc || typeof localeSvc.register !== 'function') return
        localeRegistered = true
        const register = () => localeSvc.register(NS, { zh, en, ru })
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
        // The drag gesture is document-wide (the row is not ours), so these are
        // plain capture listeners rather than slot handlers.
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('dragstart', onDragStartCapture, true)
          document.addEventListener('dragend', onDragEndCapture, true)
        }
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
        // The batch file checklist: the aggregated list asking mode shows before
        // it deletes several sessions (issue #4).
        slots.inject('shell.overlay', () => slots.register(
          { name: 'shell.overlay', id: `${NS}-batchplan`, order: 2, locale: NS },
          BatchPlanDialog,
        ))
        // The plugin page card, on BOTH seats the manager offers.
        //
        // `plugins.bundle.config` renders on the package page, whose address is
        // `#/panel/plugins/<package>`. `plugins.row.config` renders on the row's
        // own page, `#/panel/plugins/<package>/<rowId>` — and this bundle's row id
        // is the package name, so that address repeated itself. The row seat keeps
        // only its `summary` face, which is the one line the rows list shows.
        slots.inject('plugins.bundle.config', () => slots.register(
          { name: 'plugins.bundle.config', key: NS },
          AskBeforeDeleteOption,
        ))
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
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('dragstart', onDragStartCapture, true)
            document.removeEventListener('dragend', onDragEndCapture, true)
          }
          state.drag = null
          syncFooterMode()
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

    return { apply, __settings: { SettingsCard: AskBeforeDeleteOption } }
  },
})
