# dsh-delete-session
- **拖到页脚删除** —— 把侧边栏里的对话直接拖到页脚那一条，整条变红并显示「松手删除「标题」」，松手即按「删除时询问」的设置走：开着就弹确认框，关着就直接删；多选模式下拖动仍是宿主的行排序，不会被接管

**DeepSeek Harness 会话删除插件 —— 在侧边栏会话菜单里直接删除会话。**

给 DSH Web 侧边栏的会话 `...` 菜单（重命名 / 分叉 / 归档）补上「删除会话」，并可选地把这个对话产出的文件一起收走。
删除默认进**系统回收站**，点错了能还原；想彻底抹掉就在设置里关掉那个开关。

[中文](#中文) · [English](#english)

---

## 中文

### 为什么需要它

DSH 侧边栏的会话菜单只有**重命名 / 分叉 / 归档**——归档只是把会话藏起来，**不删数据**；而插件全家桶里的「会话归档管理」在设置深处，删一个会话要跳好几个界面。

这个插件把「删除」放回你最常点的位置：会话行的 `...` 菜单。

### 特性

- **菜单内删除** —— 注册进宿主官方槽位 `sidebar.workspaces.session.menu.item`，紧挨「归档会话」下方多出「删除会话」；会话 ID 由宿主直接注入，永远作用于你点的那一行，**不会切换当前会话**
- **删除至系统回收站（默认开）** —— 会话日志、工作区记账与投影缓存一并进**系统回收站**：Windows 回收站、macOS 废纸篓、Linux 的 `gio trash`。删错了从回收站还原即可。设置页可以关掉它，关掉后就是**直接从硬盘移除，不可恢复**
- **对话框文案跟随开关** —— 勾选时写「并放进系统回收站」，取消勾选时写「永久删除…不可恢复」。你看到的永远是你实际会得到的
- **风险确认** —— 每次删除弹出确认对话框，显示会话标题与 ID。要不要弹这个框**只在设置页改**，弹窗里没有快捷勾选；**按住 Shift 点击**可以临时强制弹窗
- **子会话一起删** —— 子代理是**独立会话**（独立目录、独立日志），父会话删掉后它们会变成孤儿留在磁盘上。现在删除对话时会处理它派生的子会话：设置里勾选「同时删除子会话」就一起删；不勾选则弹窗列出子会话，由你勾选要删哪些（默认全选）
- **多选批量删除** —— 会话菜单「多选」进入选择模式：勾选多行后，侧边栏页脚那一行（官方 `sidebar.footer.action` 槽位）会出现操作条（「已选 N 个 / 取消 / 删除」），位置由宿主排列，退出选择模式即消失；点删除立即批量执行，被选中的行乐观隐藏、操作条实时显示进度，客户端 6 路并发、工作区记账串行；失败的行恢复显示并保持选中，方便重试；Esc 退出
- **产出文件隔离（可选，默认关闭）** —— 打开后，删除会话时还能把这个对话在工作目录里产出的文件**移进隔离夹**，而不是直接删掉；范围可选「仅新建」或「新建的和改过的」，模式可选「全部直接隔离」或「先列清单由你勾选」
- **跳过 git 仓库内的文件（默认开）** —— 在项目里干过活的对话，产出文件里往往就是项目源码。开启后仓库内的文件一律不碰，避免删一个对话把项目搬空
- **删除后回到新会话** —— 若删除的正是当前打开的会话，自动切到一个全新会话，而不是落到已不可用的邻居页
- **默认安全** —— 宿主路由仅限本机回环（回环 socket + 回环 Host 头 + 同源校验）；被 DSH 打开占用的会话会被明确拒绝（409），绝不与活跃写者竞争
- **中英双语** —— 菜单项、对话框与设置页跟随 DSH 界面语言（zh / en）
- **零依赖** —— 不引入任何 DSH SDK，所有服务（`sessions` / `sessionPersistence` / `agents` / `workspaceRegistry` / `webServer`）都在调用时通过 cordis 上下文获取

### 安装

npm（推荐）：

```sh
dsh plugin --profile web add dsh-delete-session
```

或从 GitHub 直接安装：

```sh
dsh plugin --profile web add github:DDDMUC/dsh-delete-session
```

重启 `dsh web` 后生效。

### 使用

1. 鼠标移到侧边栏的会话行，点 `...`
2. 选择「删除会话」
3. 首次会弹确认框；不想再看到它，去插件管理页关掉「删除时询问」
4. 删错了：打开系统回收站，找到 `session-<id>` 与 `session-<id>.json`，还原即可
5. 批量：会话菜单 →「多选」→ 勾选多个 → 底部「删除」；Esc 或「取消」退出

### 设置项一览

插件管理页 → dsh-delete-session：

| 设置 | 默认 | 作用 |
| --- | --- | --- |
| 删除时询问 | 开 | 关掉后点菜单项直接删，不弹框（但产出文件选「先列清单」时仍会弹，清单只在对话框里） |
| **删除至回收站** | **开** | 开：进系统回收站，可还原。关：直接从硬盘移除，不可恢复 |
| 不处理产出文件 | 开 | 打开本项表示**不**处理产出文件，与旧版行为一致 |
| 产出文件默认全部进隔离夹 | 关 | 关：先列清单由你勾选；开：整批自动移走，不列清单也不扫描 |
| 范围：仅新建 / 新建的和改过的 | 仅新建 | 只动对话自己创建的文件，还是连它改写过的既有文件一起 |
| **跳过 git 仓库内的文件** | **开** | 仓库内的文件一律不碰 |
| **同时删除子会话** | **关** | 开：删对话时把它派生的子代理会话一起删掉。关：弹窗列出子会话，由你勾选 |
| 隔离夹保存位置 | 空（= `$DSH_HOME`） | 可手输、可点「选择文件夹…」调系统对话框、可点「打开」在资源管理器里定位 |

> 「选择文件夹…」用的是宿主自己的 `ctx.directoryPicker`：本地桌面弹系统对话框，远程/浏览式宿主自动退回页面内的目录列表。插件不再自带任何自绘或自编译的选择器。

### 删除之后文件在哪

| 平台 | 去处 |
| --- | --- |
| Windows | 系统回收站（`Microsoft.VisualBasic.FileIO.FileSystem` 的 SendToRecycleBin） |
| macOS | 废纸篓（Finder，经 `osascript`） |
| Linux | 桌面回收站（`gio trash`） |
| 以上不可用时 | `$DSH_HOME/session-trash-<时间戳>-<pid>-<序号>/`，手工搬回 |

顺序是**先 rename 到暂存区，再在后台送进回收站**：改路径是微秒级，而系统回收站操作要 ~600ms，所以界面不会等你。后台失败时文件仍在暂存区，不会丢。

**取消勾选「删除至回收站」后**，目录用 `rm` 直接移除，暂存区不留副本，回收站里也没有。

### 产出文件隔离

这一档**默认关闭**。打开后（插件管理页 → dsh-delete-session），删除会话时除了对话记录，还会处理**这个对话在工作目录里碰过的文件**：

| 范围 | 处理什么 |
| --- | --- |
| 仅新建的文件（默认） | 本对话自己创建的文件 |
| 新建的和改过的文件 | 再加上被本对话改写的**既有**文件 —— 移走它们会改变工作目录里原本的内容 |

- **移动，不删除**：文件进 `$DSH_HOME/purge-quarantine-<时间戳>/`，保留相对于工作目录的路径。每次删除**独占**一个新的隔离目录（同名已存在时自动让位），且**永不覆盖**已有文件
- **先算后动**：删除前由宿主端从会话日志重新推导清单；界面里勾选的结果只能缩小范围，不能扩大
- **「新建」怎么判定**：依据 `fs-observation-policy` 的不变量 —— `write` 覆盖既有文件前必须先成功 `read` 它，所以"首次写之前没有成功读过"就是新建。判定按**文件身份**而非路径拼写：软链接别名、Windows 上仅大小写不同的写法，都算同一个文件
- **四道安全过滤**：必须是普通文件、真实路径严格在工作目录内、不在 `$DSH_HOME` 内、必须仍然存在；被跳过的一律在对话框里列出原因
- **批量删除不走这一档**：只有单条删除会处理产出文件

### 与 dsh-session-relocate 协作（可选）

装了 [dsh-session-relocate](https://github.com/DDDMUC/dsh-session-relocate) 时，多选底栏会多出「移动」，可以把选中的会话整批搬到另一个工作区。

两边靠一组公开能力位对接，缺任一侧都只是少一个按钮，不影响删除：

- 本插件在 `apply()` 时设置 `window.__DSH_DELETE_SESSION__ = { supportsBulkMove: true }`，并派发 `dsh-session-delete:ready`
- relocate 据此隐藏自己那套批量入口，并暴露 `window.__DSH_SESSION_RELOCATE__.moveSelection(ids, { onProgress })`
- 返回值固定为 `{ canceled?, moved, failed, skipped, total, results }`；缺字段会被当作错误报出来，不做兜底猜测

### 速度

| 操作 | 耗时 |
| --- | --- |
| 删除（勾选回收站） | ~60 ms 返回，回收站在后台完成 |
| 删除（不勾选） | ~10 ms |
| 打开系统文件夹对话框 | ~120 ms（编译过的 helper），首次编译在插件加载时后台完成 |
| 产出文件扫描 | 1000 次工具调用的长会话约 20 ms |

两个 helper（选目录、送回收站）是首次使用时用 `csc.exe` 编译成小 exe 缓存在 `$DSH_HOME/cache/dsh-delete-session/`；插件加载时就后台编译好，第一次点击不用等。没有 `csc` 的机器自动回退到 PowerShell 路径，只是慢一些。

### 测试

```
node test/artifacts.host.test.js   # 59 项，宿主半
node test/checkbox.dom.test.js     # 67 项，客户端半
```

客户端测试把真实的 `src/client.js` 跑在一个可读的 DOM 实现上，经由**注册进槽位的组件**、它们渲染出的元素树、以及插件自己生成的 DOM 来驱动。宿主测试驱动真实的 `src/index.js`，覆盖"新建 vs 改过"的判定、每一道安全过滤、隔离移动保留目录结构、git 跳过、回收站与直接删除的分支。

两条测试都做过**变异验证**：把实现改回旧写法或改坏，对应断言必须变红。这一步抓出过几条"看起来测了、其实没测到"的地方（例如扫描请求里的字段、宿主侧的开关分支）。

### 已知限制

- **macOS 首次使用会请求 Finder 自动化权限**，拒绝后文件留在暂存目录，不会假装删掉
- 被 DSH 打开占用的会话：删除会自动等待写所有权释放（通常几秒）后完成；极少数仍被占用时提示稍后重试或重启 DSH
- 多选勾选框仍是对会话行的 DOM 装饰，依赖宿主 `data-row-key="session:<id>"`；核心 UI 若改名，多选会静默失效（**菜单与对话框不受影响**，它们走官方槽位）
- 产出文件清理默认关闭，打开后仍有几条边界：`bash` / `pwsh` 里创建的文件（`npm run build`、`git clone`、`> file`）**永远检测不到**；**目录永不移走**；清单上限 500 条；**没有还原界面**，隔离夹靠手工搬回
- 「新建 vs 改过」的判定依赖 `fs-observation-policy` 保持启用
- 批量删除（多选）**不**处理产出文件，也**不**处理子会话
- 暂存目录与隔离夹**没有自动清理**，会一直堆在 `$DSH_HOME` 下

### 兼容性

- **宿主半**在 DSH `0.2.1-rc.2` 上实测通过：回环 socket、Host 头、跨站 Origin 守卫、会话 ID 校验、405/404 路径
- **客户端半**在 DSH `0.2.1-rc.2` 上实测通过；槽位迁移后的版本已在浏览器里实跑
- 宿主链路对缺少服务的旧版本会退化为纯文件系统清理

如果这个插件帮到了你，欢迎给仓库点个 ⭐（[GitHub](https://github.com/DDDMUC/dsh-delete-session)）。

### License

MIT

---

## English

### Why you need it

The DSH sidebar session menu offers **Rename / Fork / Archive** — and archiving only hides a session, it does not delete data. The "session archive manager" in the settings deep-dive takes several screens per session.

This plugin puts **Delete** back where you already click: the session row's `...` menu.

### Features

- **Delete from the menu** — registered through the official `sidebar.workspaces.session.menu.item` slot, right under "Archive session". The session id is injected by the host, so it always targets the row you clicked and **never switches the open session**
- **Delete to the system trash (on by default)** — the session log, workspace accounting and projection cache go to the **system trash**: the Windows Recycle Bin, the macOS Trash, or `gio trash` on Linux. A wrong click is restored from the trash. The settings page can turn it off, and then the delete removes the files from the disk for good
- **The sentence matches the switch** — checked says "…and puts them in the system trash"; unchecked says "permanently deletes… cannot be undone". What you read is what you get
- **Confirmation dialog** — shows the session title and id. Whether a delete asks is changed on the plugin page only, never from the dialog; Shift-click forces the dialog back
- **Multi-select batch delete** — enter selection mode from the session menu, tick rows, then Delete: rows hide optimistically, the bar reports progress, six requests run in parallel while workspace accounting stays serial, failures come back visible and still selected, Esc leaves
- **Produced-file quarantine (optional, off by default)** — when enabled, a delete also moves the files this conversation produced in its working directory into a quarantine folder instead of destroying them. Scope: files it created, or those plus files it rewrote. Mode: list them for you to tick, or move the whole set
- **Skip files inside git repositories (on by default)** — a conversation that worked in a project produces that project's source. With this on, nothing inside a repository is touched
- **Lands on a fresh session** — deleting the session you are looking at switches to a new one instead of an unusable neighbour page
- **Safe by default** — host routes are loopback-only (loopback socket, loopback Host header, same-origin check); a session the host still holds open is refused with 409 rather than raced
- **Bilingual** — menu rows, dialog and settings follow the DSH UI language (zh / en)
- **Zero dependencies** — no DSH SDK import; `sessions`, `sessionPersistence`, `agents`, `workspaceRegistry` and `webServer` are all resolved from the cordis context at call time

### Install

```sh
dsh plugin --profile web add dsh-delete-session
```

or straight from GitHub:

```sh
dsh plugin --profile web add github:DDDMUC/dsh-delete-session
```

Restart `dsh web` afterwards.

### Usage

1. Hover a session row in the sidebar and click `...`
2. Pick "Delete session"
3. Confirm; to stop seeing the dialog, turn off "Ask before deleting" on the plugin page
4. Deleted by mistake? Open the system trash, restore `session-<id>` and `session-<id>.json`
5. Batch: session menu → "Select multiple" → tick rows → Delete; Esc leaves

### Settings

Plugin manager → dsh-delete-session:

| Setting | Default | Effect |
| --- | --- | --- |
| Ask before deleting | On | Off deletes straight from the menu. Ask mode for produced files still opens the dialog, because the list lives there |
| **Delete to the system trash** | **On** | On: the trash, restorable. Off: removed from the disk for good |
| Do not handle produced files | On | Ticked means the produced-file feature is off and a delete behaves like the old version |
| Move every produced file automatically | Off | Off lists them for you to tick; on moves the whole set with no listing and no scan |
| Scope: created only / created and changed | created only | Whether files this conversation rewrote are included |
| **Skip files inside git repositories** | **On** | Nothing inside a repository is touched |
| Quarantine folder | empty (= `$DSH_HOME`) | Typed, chosen with the system folder dialog, or opened in the file manager |

### Where the files go

| Platform | Destination |
| --- | --- |
| Windows | The Recycle Bin (`Microsoft.VisualBasic.FileIO.FileSystem`, SendToRecycleBin) |
| macOS | The Trash, through Finder via `osascript` |
| Linux | The desktop trash, through `gio trash` |
| None available | `$DSH_HOME/session-trash-<stamp>-<pid>-<n>/`, moved back by hand |

The order is **rename into a staging folder, then hand it to the trash in the background**: a rename costs microseconds while the shell's trash operation costs ~600 ms, so the UI never waits for it. If the background call fails the files simply stay staged.

**With "Delete to the system trash" unchecked**, the directory is removed outright: nothing staged, nothing in the trash.

### Produced-file quarantine

Off by default. When enabled, a delete also handles the files this conversation touched inside its working directory:

| Scope | What moves |
| --- | --- |
| Only files it created (default) | Files this conversation created |
| Created and changed | Plus pre-existing files it rewrote — moving them changes what was already there |

- **Moved, never deleted**: into `$DSH_HOME/purge-quarantine-<stamp>/`, keeping the path relative to the working directory. Every delete claims its own folder and never overwrites an existing file
- **Derived first, then moved**: the host re-derives the list from the session log; ticking in the dialog can only narrow it
- **How "created" is decided**: from the `fs-observation-policy` invariant — a `write` that overwrites must be preceded by a successful `read`, so "first write with no successful read before it" means created. Identity, not spelling: symlink aliases and case-only differences on Windows are the same file
- **Four safety filters**: a regular file, its real path strictly inside the working directory, outside `$DSH_HOME`, and still present. Anything skipped is listed with its reason
- **Batch delete never touches produced files**

### Interop with dsh-session-relocate (optional)

With [dsh-session-relocate](https://github.com/DDDMUC/dsh-session-relocate) installed, the multi-select bar gains a "Move" button that relocates the selected sessions to another workspace.

The two sides meet over public capability bits; either side missing just means one button fewer:

- This plugin sets `window.__DSH_DELETE_SESSION__ = { supportsBulkMove: true }` in `apply()` and dispatches `dsh-session-delete:ready`
- Relocate uses that to hide its own bulk entry and exposes `window.__DSH_SESSION_RELOCATE__.moveSelection(ids, { onProgress })`
- The result is fixed at `{ canceled?, moved, failed, skipped, total, results }`; missing fields are reported as an error rather than guessed

### Speed

| Operation | Cost |
| --- | --- |
| Delete (trash on) | returns in ~60 ms, the trash finishes in the background |
| Delete (trash off) | ~10 ms |
| System folder dialog | ~120 ms with the compiled helper; the first compile runs at plugin load |
| Produced-file scan | ~20 ms for a 1000-tool-call session |

Both helpers (folder picker, trash) are compiled once with `csc.exe` into `$DSH_HOME/cache/dsh-delete-session/` and reused. The compilation starts in the background when the plugin loads, so the first click does not pay for it. A machine without `csc` falls back to the PowerShell path — slower, same behaviour.

### Tests

```
node test/artifacts.host.test.js   # 59, host half
node test/checkbox.dom.test.js     # 67, client half
```

The client tests run the real `src/client.js` against a readable DOM, driven through the components it registers into slots, the element tree they render and the DOM the plugin produces. The host tests drive the real `src/index.js`: created-vs-changed classification, every safety filter, quarantine moving with directory structure, git skipping, and the trash/permanent branches.

Both suites are **mutation-checked**: reverting an implementation or breaking it must turn the matching assertions red. That step has caught several "looks tested, isn't" spots — the scan request field, and the host-side switch branch among them.

### Known limitations

- **macOS asks for Finder automation permission the first time**; denied, the files stay in the staging folder rather than pretending the delete happened
- A session the host holds open is waited for (usually seconds); in rare cases it asks you to retry or restart DSH
- The multi-select tick is still a DOM decoration on session rows and depends on `data-row-key="session:<id>"`. If core UI renames it, multi-select goes quiet (the menu and dialog are unaffected — they use official slots)
- Produced-file handling is off by default and still has edges: files created inside `bash` / `pwsh` (`npm run build`, `git clone`, `> file`) are **never detected**; **directories are never moved**; the list caps at 500; there is **no restore UI** — move files back from the quarantine by hand
- Created-vs-changed depends on `fs-observation-policy` staying enabled
- Batch delete does **not** handle produced files, and does **not** touch child sessions
- Staging and quarantine folders **are never cleaned up automatically**

### Compatibility

- **Host half** verified on DSH `0.2.1-rc.2`: loopback socket, Host header, cross-origin guard, session id validation, 405/404 paths
- **Client half** verified on DSH `0.2.1-rc.2`; the post-migration version has been exercised in a real browser
- Against older hosts that lack a service, the delete path degrades to plain filesystem cleanup

If this plugin helped, a ⭐ on [GitHub](https://github.com/DDDMUC/dsh-delete-session) is appreciated.

### License

MIT
