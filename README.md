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
  <sub>▲ 侧边栏会话菜单里的「删除会话」（红色）</sub>
</div>

### 为什么需要它

DSH 侧边栏的会话菜单只有**重命名 / 分叉 / 归档**——归档只是把会话藏起来，**不删数据**；而插件dsh-web里的全家桶里的「会话归档管理」在设置深处，删一个会话要跳好几个界面。

这个插件把「删除」放回你最常点的位置：会话行的 `...` 菜单。

### 特性

- **菜单内删除** —— 侧边栏会话 `...` 菜单直接多出「删除会话」；会话 ID 从菜单的 React fiber 读取，永远作用于你点的那一行，**不会切换当前会话**
- **风险确认** —— 首次删除弹出确认对话框：显示会话标题与 ID，勾选「我已了解，永久删除」后确认按钮才可用
- **确认一次后可跳过** —— 对话框里勾选「不再询问，以后直接删除」，之后点菜单项直接删除（左下角 toast 提示）；**按住 Shift 点击**可临时恢复弹窗；清除 `localStorage['dsh-delete-session:skip-confirm']` 可永久恢复
- **真正的删除** —— 停止运行中的 agent（cancel + 等待空闲）→ flush / detach 活跃会话 → 删除磁盘会话目录（原始 ID 与 `session-` 前缀两种写法）→ 持久化服务复核 → 清理工作区记账，侧栏不会残留「未分组」孤儿
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
3. 首次：勾选「我已了解，永久删除」（想省事可同时勾选「不再询问，以后直接删除」）→ 点「删除」
4. 之后：直接删除，左下角出现 toast 提示

<div align="center">
  <a href="https://raw.githubusercontent.com/DDDMUC/dsh-delete-session/main/assets/dialog.jpg">
    <img src="https://raw.githubusercontent.com/DDDMUC/dsh-delete-session/main/assets/dialog.jpg" alt="删除确认对话框" width="560" />
  </a>
  <br>
  <sub>▲ 删除确认对话框（首次删除）</sub>
</div>

### 工作原理

- `src/index.js`（宿主）：注册一条仅限回环的路由 `POST /dsh-delete-session/delete` `{ sessionId }`，执行删除链路
- `src/client.js`（浏览器）：经典客户端 bundle——监听 portal 到 body 的会话菜单（`body > [role="menu"]`），沿 React fiber 链读取会话节点（`props.node.id`），克隆原生菜单行保持样式，弹出确认对话框
- 删除链路：停 agent → flush / detach 活跃会话 → 写所有权探测（被占用 → 409）→ 删除目录（两种 ID 写法 + 复核）→ 清理工作区记账

### 已知限制

- 被 DSH 当前打开占用的会话：删除会自动等待写所有权释放（通常几秒）后完成；极少数仍被占用的情况会提示稍后重试或重启 DSH
- 菜单注入是 DOM shim：核心 UI 若调整菜单结构或行 fiber 形状，可能不再注入菜单项（不影响其他功能）
- 删除不可恢复：没有回收站，也没有撤销

### 兼容性

- DSH `0.1.5-rc.1` 实测通过
- 宿主链路对缺少服务的旧版本会退化为纯文件系统清理

如果这个插件帮到了你，欢迎给仓库点个 ⭐（[GitHub](https://github.com/DDDMUC/dsh-delete-session)）——星标是开发者继续维护的最大动力，感谢支持！

### License

MIT

---

## English

<div align="center">
  <a href="https://raw.githubusercontent.com/DDDMUC/dsh-delete-session/main/assets/menu.jpg">
    <img src="https://raw.githubusercontent.com/DDDMUC/dsh-delete-session/main/assets/menu.jpg" alt="Delete session in the sidebar menu" width="820" />
  </a>
  <br>
  <sub>▲ "Delete session" (red) in the sidebar session menu</sub>
</div>

### Why you need it

The DSH sidebar session menu only offers **Rename / Fork / Archive** — archive merely hides a session and keeps every byte on disk, while the session archive manager inside the dsh-web plugin suite lives deep in Settings and takes several screens to reach.

This plugin puts Delete back where you already click: the session row's `...` menu.

### Features

- **Delete from the menu** — a "Delete session" row appears in the sidebar session `...` menu; the session id is read from the menu's React fiber, so the action always targets the row you clicked and **never switches the active conversation**
- **Risk consent** — the first delete opens a confirmation dialog with the session title and id; the confirm button unlocks only after ticking "I understand"
- **Confirm once, then skip** — tick "Don't ask again" and later deletes run directly from the menu (a toast reports the result); **hold Shift while clicking** to force the dialog back, or clear `localStorage['dsh-delete-session:skip-confirm']` to restore it permanently
- **Real deletion** — stops a running agent (cancel + quiescence), flushes and detaches the live session, removes the on-disk session directories (both the raw and `session-` prefixed id), verifies through the persistence service, then cleans workspace accounting so no orphan shows up under "Ungrouped"
- **Safe by default** — the host route is loopback-only (loopback socket, loopback Host header, same-origin check); a session still held open by DSH is refused with 409 instead of racing the active writer
- **Bilingual** — the menu item and dialog follow the DSH interface language (zh / en)
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
3. First time: tick "I understand - delete permanently" (tick "Don't ask again" too if you like) and confirm
4. Afterwards: the session is deleted directly, with a toast

<div align="center">
  <a href="https://raw.githubusercontent.com/DDDMUC/dsh-delete-session/main/assets/dialog.jpg">
    <img src="https://raw.githubusercontent.com/DDDMUC/dsh-delete-session/main/assets/dialog.jpg" alt="Delete confirmation dialog" width="560" />
  </a>
  <br>
  <sub>▲ The confirmation dialog (first delete)</sub>
</div>

### How it works

- `src/index.js` (host): one loopback-only route `POST /dsh-delete-session/delete` `{ sessionId }` runs the deletion pipeline
- `src/client.js` (browser): a classic client bundle — watches for the portalled session menu (`body > [role="menu"]`), walks the React fiber chain to the session node (`props.node.id`), clones a native menu row for styling, and opens the confirmation dialog
- Pipeline: stop agent → flush / detach live session → write-lease probe (busy → 409) → remove directories (both id spellings + verification) → clean workspace accounting

### Known limitations

- A session DSH currently holds open: the delete waits for the write lease to be released (usually a few seconds) and then completes; in the rare case it stays busy, the dialog asks you to retry later or restart DSH
- The menu injection is a DOM shim: core UI changes to the menu markup or row fiber shape may stop the item from being injected (nothing else breaks)
- Deletion is permanent: there is no trash bin and no undo

### Compatibility

- Tested on DSH `0.1.5-rc.1`
- On older versions without the services, the host pipeline degrades to filesystem cleanup

If this plugin has been helpful, a ⭐ on [GitHub](https://github.com/DDDMUC/dsh-delete-session) would mean a lot — it is the biggest motivation for the developer to keep maintaining it. Thank you!

### License

MIT
