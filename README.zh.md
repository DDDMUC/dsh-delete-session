# dsh-delete-session

[English](README.md) | 中文

在 DSH Web 侧边栏直接删除会话：会话行的 `...` 菜单（重命名 / 分叉 / 归档）里会多出一项
**删除会话**。点击后弹出风险确认对话框（显示会话名称与 ID），确认后删除会话日志、
工作区记账与宿主内存中的会话状态。

为 DeepSeek Harness（DSH）Web 构建，已在 `0.1.5-rc.1` 上实测。

## 功能

- **侧边栏会话菜单里的「删除会话」**：无需切换会话（会话 ID 从菜单的 React fiber 读取，
  永远作用于你点击的那一行）。
- **风险确认对话框**：显示会话标题与 ID；勾选「我已了解，永久删除」前确认按钮不可用。
- **确认一次后可跳过弹窗**：在对话框里勾选「不再询问，以后直接删除」，之后点菜单项会直接删除（结果以 toast 提示）；按住 Shift 点击可临时强制弹窗；清除 `localStorage['dsh-delete-session:skip-confirm']` 可永久恢复弹窗。
- **真正的删除**：停止运行中的 agent（cancel + 等待空闲）、flush 并 detach 活跃会话、
  删除磁盘上的全部会话目录（原始 ID 与 `session-` 前缀两种写法）、经持久化服务复核，
  最后从工作区记账中移除，避免侧栏残留「未分组」孤儿。
- **默认安全**：宿主路由仅限本机回环（回环 socket + 回环 Host 头 + 同源校验）；
  被 DSH 打开占用中的会话会被明确拒绝，而不是与活跃写者竞争。
- **中英双语**：菜单项与对话框跟随 DSH 界面语言（存在 locale 服务时），否则按浏览器语言回退。

## 安装

```sh
dsh plugin --profile web add github:DDDMUC/dsh-delete-session
```

重启 `dsh web` 后，在侧边栏会话 `...` 菜单中即可看到「删除会话」。

## 工作原理

- `src/index.js`（宿主）：注册一条仅限回环的路由
  `POST /dsh-delete-session/delete` `{ sessionId }`。
- `src/client.js`（浏览器）：经典客户端 bundle——监听 portal 到 body 的会话菜单
  （`body > [role="menu"]`），沿 React fiber 链读取会话节点（`props.node.id`），
  克隆原生菜单行保持样式一致，然后打开确认对话框。
- 不引入任何 DSH SDK：所有服务（`sessions`、`sessionPersistence`、`agents`、
  `workspaceRegistry`、`webServer`）都在调用时通过 cordis 上下文获取；
  服务缺失时退化为纯文件系统清理。

## 已知限制

- 被 DSH 当前打开占用的会话无法删除：运行时没有公开的写所有权释放入口，
  因此会明确拒绝并提示「重启 DSH 后再试」。
- 侧边栏菜单注入是 DOM shim。核心 UI 若调整菜单结构或行 fiber 形状，可能需要插件跟进更新；
  契约变化时插件只是不再注入菜单项，不会影响其他功能。
- 删除不可恢复：没有回收站，也没有撤销。

## License

MIT
