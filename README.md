# dsh-delete-session

English | [中文](README.zh.md)

Delete sessions right from the DSH Web sidebar. The session row's `...` menu
(rename / fork / archive) gets one more action: **Delete session**. A
risk-consent dialog shows the session name and id, and confirming removes the
session log, its workspace accounting and its live session state.

Built for DeepSeek Harness (DSH) Web, tested on `0.1.5-rc.1`.

## Features

- **Delete session** in the sidebar session `...` menu, without switching to
  the conversation (the session id is read from the menu's React fiber, so the
  action always targets the row you clicked).
- **Risk-consent dialog**: shows the session title and id; the confirm button
  stays disabled until the acknowledgement checkbox is ticked.
- **Confirm once, then skip**: tick "Don't ask again" in the dialog and later
  deletes run directly from the menu (a toast reports the result). Hold Shift
  while clicking to force the dialog again, or clear
  `localStorage['dsh-delete-session:skip-confirm']` to restore it permanently.
- **Real deletion**: stops a running agent (cancel + quiescence), flushes and
  detaches the live session, removes every on-disk session directory (both the
  raw and `session-` prefixed id), verifies through the persistence service,
  then detaches the session from workspace accounting so the sidebar drops the
  row instead of showing an orphan under "Ungrouped".
- **Safe by default**: the host route is loopback-only (loopback socket,
  loopback Host header, same-origin check); a session still held open by DSH
  is refused with a clear message instead of racing the active writer.
- **Bilingual**: the menu item and dialog follow the DSH interface language
  (zh / en) when the locale service is present, with a browser-language
  fallback.

## Install

```sh
dsh plugin --profile web add github:DDDMUC/dsh-delete-session
```

Then restart `dsh web`. The item appears in the sidebar session `...` menu.

## How it works

- `src/index.js` (host) registers one loopback-only route:
  `POST /dsh-delete-session/delete` `{ sessionId }`.
- `src/client.js` (browser) is a classic client bundle: it watches for the
  portalled session menu (`body > [role="menu"]`), walks the React fiber chain
  to the session node (`props.node.id`), clones a native menu row for styling,
  and opens the confirmation dialog.
- No DSH SDK imports: every service (`sessions`, `sessionPersistence`,
  `agents`, `workspaceRegistry`, `webServer`) is resolved through the cordis
  context at call time, and the plugin degrades to filesystem cleanup when a
  service is absent.

## Known limitations

- A session that DSH currently holds open cannot be deleted: the runtime
  exposes no public way to release the write ownership, so the request is
  refused with a message asking to restart DSH and retry.
- The sidebar menu injection is a DOM shim. Core UI changes to the menu markup
  or the row fiber shape may require a plugin update; the menu item is simply
  not injected when the contract changes, and nothing else breaks.
- Deletion is permanent. There is no trash bin and no undo.

## License

MIT
