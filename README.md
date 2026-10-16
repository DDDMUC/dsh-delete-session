# dsh-delete-session

**DeepSeek Harness 会话删除插件 —— 在侧边栏会话菜单里直接删除会话。** 给 DeepSeek Harness (dsh) Web 侧边栏的会话 `...` 菜单（重命名 / 分叉 / 归档）补上「删除会话」：确认一次后可直接删除，真正删除会话日志、工作区记账与宿主内存中的会话状态。

[中文](#中文) · [English](#english)

---

## 中文

<div align="center">
  <a href="https://raw.githubusercontent.com/DDDMUC/dsh-delete-session/main/assets/menu.jpg">
    <img src="https://raw.githubusercontent.com/DDDMUC/dsh-delete-session/main/assets/menu.jpg" alt="侧边栏会话菜单里的删除会话" width="820" />
  </a>
  <br>
  <sub>▲ 侧边栏会话菜单里的「删除会话」（红色）—— 此图摄于 v0.1.x，尚未反映槽位迁移（「多选」与「删除会话」两行已移到「归档会话」正下方），待重拍</sub>
</div>

### 为什么需要它

DSH 侧边栏的会话菜单只有**重命名 / 分叉 / 归档**——归档只是把会话藏起来，**不删数据**；而插件dsh-web里的全家桶里的「会话归档管理」在设置深处，删一个会话要跳好几个界面。

这个插件把「删除」放回你最常点的位置：会话行的 `...` 菜单。

### 特性

- **菜单内删除** —— 注册进宿主的官方槽位 `sidebar.workspaces.session.menu.item`，紧挨「归档会话」下方多出「删除会话」；会话 ID 由宿主直接注入，永远作用于你点的那一行，**不会切换当前会话**
- **风险确认** —— 每次删除弹出确认对话框（宿主 `Modal`），显示会话标题与 ID；可勾选「不再询问，以后直接删除」
- **确认一次后可跳过** —— 对话框里勾选「不再询问，以后直接删除」，之后点菜单项直接删除（左下角 toast 提示）；**按住 Shift 点击**可临时恢复弹窗；清除 `localStorage['dsh-delete-session:skip-confirm']` 可永久恢复
- **多选批量删除** —— 会话菜单里的「多选」进入选择模式：每行左侧出现勾选圈，点整行即勾选（不会打开会话），底部操作条显示「已选 N 个 / 取消 / 删除」；点删除**立即批量执行**（无确认弹窗、无全选、所有行都可选）：被选中的行**乐观隐藏**、操作条实时显示「正在删除 x/N…」、客户端以 6 路并发请求宿主（不同会话并行、工作区记账串行），完成后 toast 汇总并刷新列表；失败的行立即恢复显示并保持选中，方便直接重试；Esc 或「取消」退出
- **真正的删除** —— 停止运行中的 agent（cancel + 等待空闲）→ flush / detach 活跃会话 → 删除磁盘会话目录（原始 ID 与 `session-` 前缀两种写法）→ 持久化服务复核 → 清理工作区记账，侧栏不会残留「未分组」孤儿，并连带清理项目缓存行（`$DSH_HOME/storages/*/sessions/<id>.json`），不留无法再显示的幽灵记录
- **删除后回到新会话** —— 若删除的正是当前打开的会话，自动切到一个全新会话（不再落到已不可用的邻居页——那种页面 composer 会被禁用、侧栏也列不出来，看起来像「没删掉」）
- **默认安全** —— 宿主路由仅限本机回环（回环 socket + 回环 Host 头 + 同源校验）；被 DSH 打开占用的会话会被明确拒绝（409），绝不与活跃写者竞争
- **中英双语** —— 菜单项与对话框跟随 DSH 界面语言（zh / en）
- **零依赖** —— 不引入任何 DSH SDK，所有服务（`sessions` / `sessionPersistence` / `agents` / `workspaceRegistry` / `webServer`）都在调用时通过 cordis 上下文获取

### 安装

npm（推荐）：

```sh
dsh plugin --profile web add dsh-delete-session
```

或从 GitHub 仓库直接安装：

```sh
dsh plugin --profile web add github:DDDMUC/dsh-delete-session
```

重启 `dsh web` 后生效。

### 使用

1. 把鼠标移到侧边栏的会话行，点 `...`（会话操作）
2. 选择底部的「删除会话」
3. 首次：直接点「删除」确认（想省事可先勾选「不再询问，以后直接删除」）
4. 之后：直接删除，左下角出现 toast 提示
5. 批量删除：会话菜单 →「多选」→ 勾选多个会话 → 底部「删除」；Esc 或「取消」退出选择模式

<div align="center">
  <a href="https://raw.githubusercontent.com/DDDMUC/dsh-delete-session/main/assets/dialog.jpg">
    <img src="https://raw.githubusercontent.com/DDDMUC/dsh-delete-session/main/assets/dialog.jpg" alt="删除确认对话框" width="560" />
  </a>
  <br>
  <sub>▲ 删除确认对话框 —— 此图摄于 v0.1.x，仍带 v0.1.10 起已取消的「我已了解」勾选框，且未反映迁移后的宿主 Modal，待重拍</sub>
</div>

### 工作原理

接入方式全部走宿主公开的槽位契约，不抓 DOM、不碰 React 内部：

| 槽位 | 用途 |
| --- | --- |
| `sidebar.workspaces.session.menu.item` | 两条菜单行：`dsh-delete-session-multi`（order 409，「多选」）与 `dsh-delete-session`（order 410，「删除会话」，危险色）。官方行是 pin 100 / rename 200 / fork 300 / archive 400 / session-id 450，所以 410 正好落在「归档会话」正下方 |
| `shell.overlay` | 确认对话框，用宿主的 `Modal` primitive 渲染（不再自建 backdrop） |
| `plugins.row.config` | 插件管理页里的「删除时询问」开关 |

- `src/index.js`（宿主）：注册两条仅限回环的路由 `POST /dsh-delete-session/delete` `{ sessionId }` 与 `POST /dsh-delete-session/delete-many` `{ sessionIds }`，执行删除链路
- `src/client.js`（浏览器）：经典客户端 bundle（`__ModuleLoader__`），菜单行用 `MenuItemButton` 渲染以继承宿主样式并加入菜单的键盘遍历；状态放在一个模块级 store 里，槽位组件与 DOM 层共用
- **唯一保留的 DOM 层**：多选勾选框。`sidebar.session.row.leading` 是宿主 `showStatus ? <SessionStatusDots/> : renderSlot(...)` 的 **else 分支**，会话一忙槽位就被顶掉——而批量删除恰恰最常发生在「刚跑完一批」时，所以勾选框仍是对 `[role="treeitem"]` 的 DOM 装饰。行身份取自宿主自己的 `data-row-key="session:<id>"`，**不再遍历 React fiber**
- 删除链路：停 agent → flush / detach 活跃会话 → 写所有权探测（被占用 → 409）→ 删除目录（两种 ID 写法 + 复核）→ 清理工作区记账与投影缓存

### 测试

- `test/checkbox.dom.test.js` —— 24 项（`node --test`，零依赖）：把真实的 `src/client.js` 跑在一个可读的 DOM 实现上，经由用户真正会碰的入口驱动——即它**注册进槽位的那些组件**、它们渲染出的元素树、以及它自己生成的 DOM。断言 **「存在 `.dsdel-check` ⟺ 多选模式开启」**，外加接入契约本身（槽位 id / order / props、对话框确实用宿主 `Modal`、菜单经 `useMenuOpenState` 关闭、`apply()` 时不再安装任何菜单扫描 observer、行身份只认 `data-row-key` 而不认 fiber、`locale` 晚到时字典仍会注册、删除行向宿主申请 `danger` 样式、插件页卡片在宿主不注入 `t` 时仍能渲染）
- 覆盖的回归：单条删除（`deleteNow` / 对话框确认）会调用 `scheduleDecorate()`，而 v0.1.8 之前 `decorateRows()` **无条件**给每一行插入勾选框、且没有末尾清扫，于是删掉一个会话后所有行都长出了圆勾选框、底部操作条却仍然隐藏——一个「半开」的多选状态
- 这个测试是有意义的，不是空跑，两个方向都验过：把 `decorateRows()` 恢复成旧写法（逐行守卫与末尾清扫**同时**去掉）会让 **6 项**失败；改成「永不插入勾选框」会让 **5 项**失败
- 运行：`npm test`（或直接 `node test/checkbox.dom.test.js`，后者不需要 `node --test` 起子进程）
- **尚未验证的一环（诚实说明）**：与真实 DSH 界面的耦合——真实 DOM 结构、真实 CSS 布局、真实菜单卡片高度、以及 React 调和器在重渲染会话行时是否会丢弃注入的勾选框——只能由真实浏览器验证。槽位契约与 primitive 导出已在本机 0.2.1-alpha.4 上静态核对，但**渲染结果没有跑过浏览器**

### 已知限制

- 被 DSH 当前打开占用的会话：删除会自动等待写所有权释放（通常几秒）后完成；极少数仍被占用的情况会提示稍后重试或重启 DSH
- 多选勾选框仍是对会话行的 DOM 装饰，依赖宿主 `data-row-key="session:<id>"` 这一属性；核心 UI 若改名，多选会静默失效（**菜单与对话框不受影响**，它们走官方槽位）。其余行装饰（`.dsdel-bar` 操作条、toast）同理
- 删除不可恢复：没有回收站，也没有撤销
- 批量删除为客户端 6 路并发 + 乐观隐藏：不同会话并行删除，宿主端写所有权等待缩短为 200ms × 12（单条最长约 2.2s），多个被占用的会话也并行等待；同一工作区记账变更仍串行，避免并发写交错

### 兼容性

- **宿主半**在 DSH `0.2.1-alpha.4` 上实测通过（回环 socket / Host 头 / 跨站 Origin 守卫，会话 id 校验，405 与 404 路径，共 6 项；用手工 `curl` 逐条核对，**仓库内暂未带这部分的自动化用例**）
- **客户端半**在 DSH `0.1.5-rc.1` / `0.1.7-alpha.2` 上实测通过（0.1.7 起不再导出 `SettingsProvider`；本插件不依赖 DSH SDK，无需改动）。槽位迁移后的版本已对本机 `0.2.1-alpha.4` 的槽位契约、`order` 语义与 `MenuItemButton` / `Modal` / `Button` / `Checkbox` 导出做过静态核对，但**没有在浏览器里实跑过**
- 宿主链路对缺少服务的旧版本会退化为纯文件系统清理

如果这个插件帮到了你，欢迎给仓库点个 ⭐（[GitHub](https://github.com/DDDMUC/dsh-delete-session)）——星标是开发者继续维护的最大动力，感谢支持！

### License

MIT

---

## English

<div align="center">
  <a href="https://raw.githubusercontent.com/DDDMUC/dsh-delete-session/main/assets/menu.jpg">
    <img src="https://raw.githubusercontent.com/DDDMUC/dsh-delete-session/main/assets/menu.jpg" alt="Delete session in the sidebar session menu" width="820" />
  </a>
  <br>
  <sub>▲ "Delete session" (red) in the sidebar session menu — captured on v0.1.x, before the slot migration (the "Select multiple" and "Delete session" rows now sit directly under "Archive session"); to be re-shot</sub>
</div>

### Why you need it

The DSH sidebar session menu only offers **Rename / Fork / Archive** — archive merely hides a session and keeps every byte on disk, while the session archive manager inside the dsh-web plugin suite lives deep in Settings and takes several screens to reach.

This plugin puts Delete back where you already click: the session row's `...` menu.

### Features

- **Delete from the menu** — registered into the host's official `sidebar.workspaces.session.menu.item` slot, directly below "Archive session"; the session id is injected by the host, so the action always targets the row you clicked and **never switches the active conversation**
- **Risk consent** — every delete opens a confirmation dialog (the host's `Modal`) with the session title and id, offering a "Don't ask again" tick
- **Confirm once, then skip** — tick "Don't ask again" and later deletes run directly from the menu (a toast reports the result); **hold Shift while clicking** to force the dialog back, or clear `localStorage['dsh-delete-session:skip-confirm']` to restore it permanently
- **Multi-select batch delete** — "Select multiple" in the session menu enters selection mode: every row gets a round checkbox, clicking a row toggles it (it never opens the conversation), and a bottom bar shows "N selected / Cancel / Delete". Delete runs **immediately** (no confirm dialog, no select-all, every row selectable): selected rows are hidden optimistically, the bar shows live progress ("Deleting x/N..."), and the client runs 6 concurrent requests (independent sessions in parallel, workspace accounting serialized), then reports a toast summary; failed rows reappear immediately and stay selected for a quick retry; Esc or Cancel exits
- **Real deletion** — stops a running agent (cancel + quiescence), flushes and detaches the live session, removes the on-disk session directories (both the raw and `session-` prefixed id), verifies through the persistence service, then cleans workspace accounting so no orphan shows up under "Ungrouped", and removes the session's projection-cache rows (`$DSH_HOME/storages/*/sessions/<id>.json`) so no ghost the sidebar can no longer show is left behind
- **Leaves a fresh session behind** — when the deleted session is the one the main view is showing, the app switches to a brand-new session instead of a stale neighbour (an unavailable row with a disabled composer that the sidebar cannot even list, which reads as "the delete did not work")
- **Safe by default** — the host route is loopback-only (loopback socket, loopback Host header, same-origin check); a session still held open by DSH is refused with 409 instead of racing the active writer
- **Bilingual** — the menu items and dialog follow the DSH interface language (zh / en)
- **Zero dependencies** — no DSH SDK imports; every service (`sessions`, `sessionPersistence`, `agents`, `workspaceRegistry`, `webServer`) is resolved through the cordis context at call time

### Install

From npm (recommended):

```sh
dsh plugin --profile web add dsh-delete-session
```

Or straight from the GitHub repository:

```sh
dsh plugin --profile web add github:DDDMUC/dsh-delete-session
```

Restart `dsh web` to apply.

### Usage

1. Hover a session row in the sidebar and click `...` (session actions)
2. Pick "Delete session" at the bottom
3. First time: just press Delete (tick "Don't ask again" first if you like)
4. Afterwards: the session is deleted directly, with a toast
5. Batch delete: session menu -> "Select multiple" -> tick rows -> "Delete" in the bottom bar; Esc or Cancel exits

<div align="center">
  <a href="https://raw.githubusercontent.com/DDDMUC/dsh-delete-session/main/assets/dialog.jpg">
    <img src="https://raw.githubusercontent.com/DDDMUC/dsh-delete-session/main/assets/dialog.jpg" alt="Delete confirmation dialog" width="560" />
  </a>
  <br>
  <sub>▲ The confirmation dialog — captured on v0.1.x, still showing the "I understand" tick removed in v0.1.10 and not the host Modal; to be re-shot</sub>
</div>

### How it works

Integration goes entirely through the host's public slot contract — no DOM scraping, no React internals:

| Slot | Purpose |
| --- | --- |
| `sidebar.workspaces.session.menu.item` | Two rows: `dsh-delete-session-multi` (order 409, "Select multiple") and `dsh-delete-session` (order 410, "Delete session", danger colour). The shipped rows are pin 100 / rename 200 / fork 300 / archive 400 / session-id 450, so 410 lands directly under "Archive session" |
| `shell.overlay` | The confirmation dialog, rendered with the host's `Modal` primitive (no hand-built backdrop) |
| `plugins.row.config` | The "ask before deleting" switch on the plugin manager page |

- `src/index.js` (host): two loopback-only routes, `POST /dsh-delete-session/delete` `{ sessionId }` and `POST /dsh-delete-session/delete-many` `{ sessionIds }`, run the deletion pipeline
- `src/client.js` (browser): a classic client bundle (`__ModuleLoader__`). The menu rows render through `MenuItemButton` so they inherit host styling and join the menu's keyboard walk; state lives in one module-level store shared by the slot components and the DOM layer
- **The one remaining DOM layer**: the multi-select checkboxes. `sidebar.session.row.leading` is the *else* branch of the host's `showStatus ? <SessionStatusDots/> : renderSlot(...)`, so it disappears the moment a row is busy — exactly when a batch delete is most likely. Those checkboxes therefore stay a DOM decoration over `[role="treeitem"]`, with row identity taken from the host's own `data-row-key="session:<id>"`, **never from a React fiber walk**
- Pipeline: stop agent → flush / detach live session → write-lease probe (busy → 409) → remove directories (both id spellings + verification) → clean workspace accounting and projection caches

### Tests

- `test/checkbox.dom.test.js` — 24 cases (`node --test`, zero dependencies): it runs the real `src/client.js` against a readable DOM implementation and drives it only through surfaces a user touches — the components it **registers into slots**, the element trees those render, and the DOM it builds. It asserts that **a `.dsdel-check` exists if and only if multi-select is on**, plus the integration contract itself (slot ids / orders / props, the dialog really using the host `Modal`, the menu being dismissed through `useMenuOpenState`, `apply()` installing no menu-scanning observer at all, row identity coming only from `data-row-key` and never from a fiber, the dictionaries still being registered when `locale` arrives late, the delete row asking the host for its `danger` tone, and the plugin page card still rendering when the host injects no `t`)
- The regression it covers: a plain single delete (`deleteNow` / the dialog's confirm handler) calls `scheduleDecorate()`, and before v0.1.8 `decorateRows()` planted a checkbox on **every** row unconditionally with no trailing sweep — so after deleting one session every row grew a round checkbox while the batch bar stayed hidden, a "half-on" multi-select state
- The test earns its keep, verified in both directions: restoring `decorateRows()` to the old shape (dropping the per-row guard *and* the trailing sweep together) fails **6** of its cases, and a fix that never plants checkboxes fails **5**
- Run it with `npm test` (or `node test/checkbox.dom.test.js` directly, which needs no `node --test` child process)
- **Not verified (honest note):** the coupling to the real DSH UI — real DOM structure, real CSS layout, the real menu card height, and whether React's reconciler drops injected checkboxes when it re-renders a session row — can only be checked in a real browser. The slot contract and the primitive exports were statically checked against DSH 0.2.1-alpha.4 on the developer's machine, but **nothing has been rendered in a browser**

### Known limitations

- A session DSH currently holds open: the delete waits for the write lease to be released (usually a few seconds) and then completes; in the rare case it stays busy, the dialog asks you to retry later or restart DSH
- The multi-select checkboxes are still a DOM decoration over session rows and depend on the host's `data-row-key="session:<id>"` attribute; if core UI renames it, multi-select goes silently inert (**the menu and dialog are unaffected** — they use official slots). The same applies to the other row decoration (the `.dsdel-bar` action bar and the toast)
- Deletion is permanent: there is no trash bin and no undo
- Batch delete uses 6-way client concurrency with optimistic hiding: independent sessions delete in parallel and the host write-lease wait is shortened to 200ms x 12 (max ~2.2s per item), so busy sessions wait in parallel too; workspace accounting stays serialized so concurrent deletions never interleave on the same store

### Compatibility

- The **host half** is verified on DSH `0.2.1-alpha.4` (loopback socket / Host header / cross-origin guards, session-id validation, and the 405 and 404 paths — 6 cases, checked by hand with `curl`; **the repo ships no automated case for these yet**)
- The **browser half** is verified on DSH `0.1.5-rc.1` and `0.1.7-alpha.2`. The slot-migrated version has had its slot contract, `order` semantics and the `MenuItemButton` / `Modal` / `Button` / `Checkbox` exports statically checked against `0.2.1-alpha.4`, but it **has not been exercised in a browser**
- On older versions without the services, the host pipeline degrades to filesystem cleanup

If this plugin has been helpful, a ⭐ on [GitHub](https://github.com/DDDMUC/dsh-delete-session) would mean a lot — it is the biggest motivation for the developer to keep maintaining it. Thank you!

### License

MIT
