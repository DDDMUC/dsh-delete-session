// dsh-delete-session - host half.
//
// Loopback-only HTTP routes serve the client half:
//
//   POST /dsh-delete-session/delete   { sessionId }
//
// Deletion pipeline, kept consistent with the live DSH services so in-memory
// state and on-disk units cannot disagree after the request returns:
//
//   1. stop a running agent (cancel + time-boxed quiescence) when one exists;
//   2. flush and detach the live session so its async dispose cannot rewrite
//      the log directory after we remove it, and wait for the persistence
//      retirement that session/disposed starts;
//   3. take the persistence write lease briefly: a busy lease means the
//      session is still open in DSH, so the request is refused with 409
//      instead of racing the active writer;
//   4. remove every on-disk session directory (raw id and session- prefix);
//   5. verify through the persistence service and a directory re-scan;
//   6. detach the session from workspace accounting so the sidebar drops the
//      row instead of re-grouping an orphan under "Ungrouped".
//
// The plugin imports nothing from the DSH SDK: every service is resolved
// through the cordis context at call time, so the module loads on any profile
// and degrades to the filesystem path when a service is absent.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

/** The asynchronous face of `fs`, used wherever a blocking call could stall the server. */
const fsp = fs.promises
/** The same underlying call as `fs.realpathSync.native`, just not blocking. */
const realpathNative = promisify(fs.realpath.native)

export const name = 'dsh-delete-session'

const ROUTE_PREFIX = '/dsh-delete-session'
const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BATCH = 100

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

// --- paths -------------------------------------------------------------------

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function sessionsRoot() {
  return path.join(dshHome(), 'sessions')
}

// A session id travels in two spellings: the raw uuid and `session-<uuid>`.
// The on-disk JSONL backend uses the prefixed form for the directory name,
// while workspace and projection rows may carry either. Clean both.
function idVariants(sessionId) {
  const out = new Set([sessionId])
  if (sessionId.startsWith('session-')) out.add(sessionId.slice('session-'.length))
  else out.add(`session-${sessionId}`)
  return [...out]
}

// Scan every workspace directory under $DSH_HOME/sessions for the session's
// directories, so the workspace-path encoding never has to be re-derived here.
function findSessionDirs(sessionId) {
  const root = sessionsRoot()
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const variants = idVariants(sessionId)
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    for (const variant of variants) {
      const candidate = path.join(root, entry.name, variant)
      try {
        if (fs.statSync(candidate).isDirectory() && !found.includes(candidate)) found.push(candidate)
      } catch {
        // keep scanning
      }
    }
  }
  return found
}

/**
 * The C# behind the cached recycle helper. One process handles every path of a
 * delete (the session directory and its cache rows), because each PowerShell
 * start costs the better part of a second and a delete used to pay it twice.
 */
const RECYCLE_CSHARP = `using System;
using System.IO;
using Microsoft.VisualBasic.FileIO;

public static class Program {
  public static int Main(string[] args) {
    int done = 0;
    foreach (string target in args) {
      try {
        if (Directory.Exists(target)) {
          FileSystem.DeleteDirectory(target, UIOption.OnlyErrorDialogs, RecycleOption.SendToRecycleBin);
        } else if (File.Exists(target)) {
          FileSystem.DeleteFile(target, UIOption.OnlyErrorDialogs, RecycleOption.SendToRecycleBin);
        }
        done++;
      } catch {
        // leave it: the caller verifies the path is gone
      }
    }
    return done == args.Length ? 0 : 1;
  }
}`

/** Bump when `RECYCLE_CSHARP` changes, so a cached build is not reused. */
const RECYCLE_EXE_VERSION = 1
const RECYCLE_TIMEOUT_MS = 60 * 1000

/** Compile the recycle helper once into the DSH cache; null when it cannot. */
async function ensureRecycleExe() {
  if (process.platform !== 'win32') return null
  const dir = path.join(dshHome(), 'cache', 'dsh-delete-session', `v${RECYCLE_EXE_VERSION}`)
  const exe = path.join(dir, 'dsh-recycle.exe')
  if (await pathExists(exe)) return exe
  const csc = findCsc()
  if (csc === null) return null
  try {
    await fsp.mkdir(dir, { recursive: true })
    const source = path.join(dir, 'recycle.cs')
    await fsp.writeFile(source, RECYCLE_CSHARP, 'utf8')
    const built = await runExecutable(csc, ['-nologo', '-target:exe', `-out:${exe}`, '-r:System.dll', '-r:Microsoft.VisualBasic.dll', source], PICK_COMPILE_TIMEOUT_MS)
    try { await fsp.rm(source, { force: true }) } catch { /* best effort */ }
    if (built.code === 0) {
      if (await pathExists(exe)) return exe
    }
  } catch {
    // fall through to the PowerShell path
  }
  return null
}
/**
 * Send paths to the Windows Recycle Bin.
 *
 * A delete has to be undoable, and the Recycle Bin is the undo the user already
 * knows. Node has no API for it, and a Node process cannot synthesize the
 * `$I`/`$R` pair the Shell owns, so one PowerShell does the work through
 * `Microsoft.VisualBasic.FileIO.FileSystem` — the supported managed wrapper of
 * "delete with undo". The script prints one verdict per path, so a partial
 * failure is reported instead of being assumed away.
 *
 * @returns `true` only when every path actually left its original location.
 */
async function sendToRecycleBin(targets) {
  if (targets.length === 0) return true
  if (process.platform !== 'win32') return false

  // The compiled helper answers in ~100 ms where one PowerShell start costs the
  // better part of a second, and it takes every path of a delete at once.
  const exe = await ensureRecycleExe()
  if (exe !== null) {
    try {
      const run = await runExecutable(exe, targets, RECYCLE_TIMEOUT_MS)
      return run.code === 0
    } catch {
      return false
    }
  }

  const list = targets.map((target) => `'${target.replace(/'/g, "''")}'`).join(', ')
  const script = [
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    `$targets = @(${list})`,
    'foreach ($target in $targets) {',
    '  try {',
    '    if (Test-Path -LiteralPath $target -PathType Container) {',
    '      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target,',
    '        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,',
    '        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)',
    '    } elseif (Test-Path -LiteralPath $target) {',
    '      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target,',
    '        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,',
    '        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)',
    '    }',
    '    [Console]::Out.WriteLine(\'OK\')',
    '  } catch {',
    '    [Console]::Out.WriteLine(\'FAIL\')',
    '  }',
    '}',
  ].join('\r\n')

  const scriptPath = path.join(os.tmpdir(), `dsh-delete-session-bin-${process.pid}-${Date.now()}.ps1`)
  const bytes = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(script, 'utf8')])
  let output
  try {
    await fsp.writeFile(scriptPath, bytes)
    output = await runPowershell(
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      PICK_TIMEOUT_MS,
    )
  } catch {
    return false
  } finally {
    try { await fsp.rm(scriptPath, { force: true }) } catch { /* best effort */ }
  }
  const ok = output.split(/\r?\n/).filter((line) => line.trim() === 'OK').length
  return ok === targets.length
}

/**
 * Move paths into a fresh `$DSH_HOME/session-trash-<stamp>` folder.
 *
 * This is the fast half of a retire: a same-volume rename costs microseconds,
 * while the shell's recycle operation costs ~600 ms. The caller reports the
 * delete as done after this, so the wait never reaches the user.
 *
 * @returns `{ moved, root }` — the source paths and the staging folder, or a null
 *   root when the folder could not be created.
 */
async function stageToTrash(targets) {
  if (targets.length === 0) return { moved: [], root: null }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 17)
  const root = path.join(dshHome(), `session-trash-${stamp}-${process.pid}-${retireCounter++}`)
  try {
    await fsp.mkdir(root, { recursive: true })
  } catch {
    return { moved: [], root: null }
  }
  const moved = []
  for (const target of targets) {
    const destination = await freeDestination(root, path.basename(target))
    if (destination === undefined) continue
    try {
      await fsp.rename(target, destination)
      moved.push(target)
      continue
    } catch {
      // A cross-volume rename fails; copy then drop the original.
    }
    try {
      await fsp.cp(target, destination, { recursive: true, force: false, errorOnExist: true })
      await fsp.rm(target, { recursive: true, force: true })
      moved.push(target)
    } catch {
      // Leave it: a path that cannot be retired is reported by the caller.
    }
  }
  return { moved, root: moved.length > 0 ? root : null }
}

/** Keeps two retires in the same millisecond out of one staging folder. */
let retireCounter = 0

/** The staging move alone, for callers that just want the paths out of the way. */
async function moveToSessionTrash(targets) {
  return (await stageToTrash(targets)).moved
}

/**
 * Retire paths for good. The caller gets control back as soon as the paths are
 * out of their original location — a same-volume rename — and the Recycle Bin
 * move finishes in the background.
 *
 * That order is deliberate: the shell's recycle operation costs ~600 ms, which
 * is exactly the wait a delete should not have. If the background call fails, the
 * paths are still in `session-trash-<stamp>` and recoverable by hand; nothing is
 * ever unlinked.
 */
async function retirePaths(targets) {
  if (targets.length === 0) return []
  const staged = await stageToTrash(targets)
  if (staged.root !== null) {
    // Fire and forget: never awaited, never allowed to reject into the caller.
    try {
      sendToRecycleBin([staged.root]).catch(() => {})
    } catch {
      // the staged copy stays where it is
    }
  }
  return staged.moved
}

async function retireSessionDirs(sessionId) {
  return retirePaths(findSessionDirs(sessionId))
}

// Deleting the on-disk directory is not enough: projection caches keep a
// per-session JSON row (`$DSH_HOME/storages/<store>/sessions/<id>.json`) that
// would linger as a ghost — the sidebar list is directory-backed, so the row
// can never be shown or deleted again (issue: "can't delete anymore"). Retire
// the session's cache units together with its directories.
function findSessionCaches(sessionId) {
  const storesRoot = path.join(dshHome(), 'storages')
  const found = []
  let stores
  try {
    stores = fs.readdirSync(storesRoot, { withFileTypes: true })
  } catch {
    return found
  }
  const names = idVariants(sessionId).map((variant) => `${variant}.json`)
  for (const store of stores) {
    if (!store.isDirectory()) continue
    const dir = path.join(storesRoot, store.name, 'sessions')
    let entries
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!names.includes(entry)) continue
      found.push(path.join(dir, entry))
    }
  }
  return found
}

async function retireSessionCaches(sessionId) {
  return retirePaths(findSessionCaches(sessionId))
}

// --- live state --------------------------------------------------------------

// Stop a running agent before its session disappears: cancel the active turn
// and wait, time-boxed, so a stuck driver never blocks the deletion.
async function quiesceAgent(ctx, sessionId) {
  const agents = ctx.get('agents')
  if (!agents || typeof agents.get !== 'function') return false
  const agent = agents.get(sessionId)
  if (!agent) return false
  try {
    if (typeof agent.cancel === 'function') agent.cancel({ kind: 'user' })
  } catch {
    // agent may already be settling
  }
  if (typeof agent.whenIdle === 'function') {
    try {
      await Promise.race([agent.whenIdle(), new Promise((resolve) => setTimeout(resolve, 10000))])
    } catch {
      // proceed with deletion anyway
    }
  }
  return true
}

// Flush a live session, then detach its entered record so DSH emits
// host/session-removed and the client list drops the row. The persistence
// retirement started by session/disposed is awaited before the caller unlinks
// anything, because its final drain could otherwise recreate the directory.
async function flushAndDetach(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  let flushed = false
  let detached = false
  if (sessions) {
    for (const variant of idVariants(sessionId)) {
      const live = typeof sessions.get === 'function' ? sessions.get(variant) : undefined
      if (!live) continue
      if (typeof sessions.flush === 'function') {
        try {
          await sessions.flush(live)
          flushed = true
        } catch {
          // the log is removed anyway
        }
      }
      try {
        const entered = sessions.store && typeof sessions.store.get === 'function' ? sessions.store.get(variant) : undefined
        if (entered && typeof entered.detach === 'function') {
          entered.detach()
          detached = true
        }
      } catch {
        // best effort: the directory removal below is the authority
      }
    }
  }
  const sp = ctx.get('sessionPersistence')
  try {
    const retirement = sp && sp.retirements && typeof sp.retirements.get === 'function' ? sp.retirements.get(sessionId) : undefined
    if (retirement && typeof retirement.then === 'function') await retirement
  } catch {
    // no retirement registry: nothing to wait for
  }
  return { flushed, detached }
}

// Probe the persistence write lease. Holding it proves no active writer is
// around; it is released immediately. Detaching a live session releases its
// lease asynchronously (session/disposed starts a persistence retirement), so
// the probe is retried with a short backoff before the request is refused -
// in practice the first click then succeeds without forcing anything.
// The backoff is short (200ms x 12 = ~2.2s worst case) so a batch containing
// live sessions stays responsive while the lease retirement lands.
const BUSY_RETRY_ATTEMPTS = 12
const BUSY_RETRY_DELAY_MS = 200

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function assertNoActiveWriter(ctx, sessionId) {
  const sp = ctx.get('sessionPersistence')
  if (!sp || typeof sp.open !== 'function') return false
  for (let attempt = 1; attempt <= BUSY_RETRY_ATTEMPTS; attempt += 1) {
    let handle = null
    let busy = false
    try {
      handle = await sp.open(sessionId, 'write')
    } catch (error) {
      const message = String((error && error.message) || error)
      if (/own|busy|lock|hold|writer/i.test(message)) {
        busy = true
      } else {
        return false
      }
    } finally {
      try {
        if (handle && typeof handle.close === 'function') await handle.close()
      } catch {
        // lease release failure is harmless: the directory is removed next
      }
    }
    if (!busy) return true
    if (attempt < BUSY_RETRY_ATTEMPTS) await sleep(BUSY_RETRY_DELAY_MS)
  }
  throw new HttpError(409, 'busy', 'session is currently open in DSH')
}

// Bounded concurrency for batch deletes. Different sessions are independent
// (agent quiesce, lease probe and directory sweep all key off the session id),
// so the pipeline runs in parallel through a small pool. The one shared
// mutation - workspace accounting - is serialized through withWorkspaceLock so
// two deletions can never interleave on the same store.
//
// 6 is measured, not guessed: on 64 sessions of ~2MB the wall time was
// 281ms at 4, 189ms at 6 and 142ms at 8 (the I/O parallelism saturates around
// 8), so 6 keeps a ~33% gain over 4 while staying below the saturation knee
// and limiting the number of simultaneous lease-probe loops.
const BATCH_CONCURRENCY = 6

let workspaceLock = Promise.resolve()
function withWorkspaceLock(fn) {
  const run = workspaceLock.then(fn, fn)
  workspaceLock = run.then(() => undefined, () => undefined)
  return run
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = []
  for (let i = 0; i < Math.min(limit, items.length); i += 1) {
    runners.push((async () => {
      while (true) {
        const index = cursor
        cursor += 1
        if (index >= items.length) return
        results[index] = await worker(items[index], index)
      }
    })())
  }
  await Promise.all(runners)
  return results
}

async function detachFromWorkspace(ctx, sessionId) {
  const workspace = ctx.get('workspaceRegistry')
  if (!workspace) return false
  const variants = idVariants(sessionId)
  let touched = false
  try {
    if (typeof workspace.list === 'function') {
      for (const entry of workspace.list()) {
        if (!entry || !Array.isArray(entry.sessionIds)) continue
        if (!variants.some((variant) => entry.sessionIds.includes(variant))) continue
        try {
          await entry.detachSession(sessionId)
          touched = true
        } catch {
          // keep going: the header index cleanup below still applies
        }
      }
    }
  } catch {
    // registry unavailable
  }
  try {
    if (workspace.sessionPaths && typeof workspace.sessionPaths.delete === 'function') {
      for (const variant of variants) workspace.sessionPaths.delete(variant)
    }
  } catch {
    // private map absent on this version
  }
  try {
    if (workspace.headers && typeof workspace.headers.delete === 'function') {
      for (const variant of variants) workspace.headers.delete(variant)
    }
  } catch {
    // private map absent on this version
  }
  return touched
}

// --- core delete -------------------------------------------------------------

async function deleteSession(ctx, sessionId) {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new HttpError(400, 'invalid', 'invalid session id')
  }
  const stopped = await quiesceAgent(ctx, sessionId)
  const { flushed, detached } = await flushAndDetach(ctx, sessionId)
  await assertNoActiveWriter(ctx, sessionId)

  // Retire the on-disk directories first. They go to the Recycle Bin, so a
  // wrong click is undoable in Explorer; only a platform without one falls back
  // to the local trash directory. If the filesystem refuses, fail before
  // touching workspace accounting so a half-deleted session cannot fall out of
  // its group into "Ungrouped".
  // One helper process for the whole job: the session directories and its cache
  // rows are retired together. Each start costs ~100 ms, and the second directory
  // pass is free when the drain recreated nothing — which is the normal case.
  const cacheFiles = findSessionCaches(sessionId)
  let removed = await retirePaths([...findSessionDirs(sessionId), ...cacheFiles])
  await new Promise((resolve) => setImmediate(resolve))
  removed = removed.concat(await retireSessionDirs(sessionId))

  const sp = ctx.get('sessionPersistence')
  if (sp && typeof sp.stat === 'function') {
    const after = await sp.stat(sessionId).catch(() => undefined)
    if (after) {
      throw new HttpError(500, 'verify-failed', 'session is still visible to the persistence service after deletion')
    }
  }
  const leftover = findSessionDirs(sessionId)
  if (leftover.length > 0) {
    throw new HttpError(500, 'verify-failed', 'session directories could not be fully removed')
  }

  // Cache rows are projection state, not the source of truth: retire them even
  // when the directories were already gone, so a deleted session cannot leave
  // a ghost behind.
  // Anything of the cache set that survived the shared call is reported, so a
  // locked row is still visible in the result.
  const cachesRemoved = cacheFiles.filter((file) => !fs.existsSync(file))

  const workspaceDetached = await withWorkspaceLock(() => detachFromWorkspace(ctx, sessionId))
  if (removed.length === 0 && !workspaceDetached && !flushed && !detached && cachesRemoved.length === 0) {
    throw new HttpError(404, 'not-found', 'session not found')
  }
  return { removed: removed.length, caches: cachesRemoved.length, stopped, flushed, detached, workspaceDetached }
}

// --- artifacts: what a session touched, and quarantining it -----------------
//
// "Produced files" is derived from the durable session log alone: the log is the
// only record that outlives a closed Session (the host's own observation state
// lives in a plugin-local WeakMap and dies with the process, and the
// `workspace/changes` summaries live in a temporary directory that disposal
// removes). Classification rests on one invariant of the default
// fs-observation-policy: `write` may not overwrite a file that was not read
// first, and `edit` requires a prior read. So a write whose path has no earlier
// successful read CREATED the file; anything else already existed.
//
// Nothing here deletes. Files are moved into a timestamped quarantine directory
// under $DSH_HOME, keeping their path relative to the session's working
// directory, so a wrong call is recoverable.

const QUARANTINE_PREFIX = 'purge-quarantine'
const MAX_LISTED = 500
/** How many path resolutions run at once: enough to hide the threadpool round trip, few enough to stay polite. */
const RESOLVE_CONCURRENCY = 16
/** How many directories the folder picker lists before saying there are more. */
const MAX_BROWSE_ENTRIES = 500
/** How long a native folder dialog may stay open before the request gives up. */
const PICK_TIMEOUT_MS = 5 * 60 * 1000

/**
 * The folder picker.
 *
 * Windows offers its modern chooser through COM (`IFileOpenDialog` +
 * `FOS_PICKFOLDERS`), and the interesting part is not the dialog but the wait
 * before it. Measured on the target machine:
 *
 *   PowerShell startup ......... ~520 ms
 *   + Windows.Forms assembly .... ~950 ms   (left over from the old
 *                                            `FolderBrowserDialog` version)
 *   compiled .exe, no console ... ~120 ms
 *
 * So the picker is a tiny executable: compiled once into the DSH home, spawned
 * directly afterwards. The PowerShell script below stays as the fallback for a
 * machine without `csc.exe`.
 *
 * The executable runs with `windowsHide`, which hides the first window it shows,
 * so a background thread calls `ShowWindow(SW_SHOW)` and raises it. That thread
 * also centres the dialog and retries, because the window reports no final size
 * on the first tick.
 */
const PICK_CSHARP = `
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;

public static class DshFolderPick {
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern IntPtr SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool SystemParametersInfoW(uint action, uint param, out RECT rect, uint winIni);
  [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
  delegate bool EnumProc(IntPtr h, IntPtr l);

  [StructLayout(LayoutKind.Sequential)]
  struct RECT { public int Left, Top, Right, Bottom; }

  static IntPtr FindDialog() {
    uint me = GetCurrentProcessId();
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid == me) {
        var cls = new StringBuilder(128, 128);
        GetClassNameW(h, cls, 128);
        if (cls.ToString().StartsWith("#32770") && found == IntPtr.Zero) found = h;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  static void Raise() {
    bool centered = false;
    for (int i = 0; i < 80; i++) {
      Thread.Sleep(150);
      IntPtr h = FindDialog();
      if (h == IntPtr.Zero) continue;
      ShowWindow(h, 5);
      if (!centered) {
        RECT work, box;
        if (SystemParametersInfoW(0x0030, 0, out work, 0) && GetWindowRect(h, out box)) {
          int w = box.Right - box.Left;
          int ht = box.Bottom - box.Top;
          int availW = work.Right - work.Left;
          int availH = work.Bottom - work.Top;
          // A half-built rect would park the window off screen, so only a
          // believable size that actually fits is allowed to move it.
          if (w > 600 && ht > 300 && w < availW && ht < availH) {
            int x = work.Left + (availW - w) / 2;
            int y = work.Top + (availH - ht) / 2;
            SetWindowPos(h, (IntPtr)(-1), x, y, 0, 0, 0x0001);
            centered = true;
          }
        }
      }
      SetWindowPos(h, (IntPtr)(-1), 0, 0, 0, 0, 0x0003);
      BringWindowToTop(h);
    }
  }

  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint c, IntPtr f);
    void SetFileTypeIndex(uint i);
    void GetFileTypeIndex(out uint i);
    void Advise(IntPtr p, out uint c);
    void Unadvise(uint c);
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder(IShellItem i);
    void SetFolder(IShellItem i);
    void GetFolder(out IShellItem i);
    void GetCurrentSelection(out IShellItem i);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string n);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string n);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string t);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void GetResult(out IShellItem i);
    void AddPlace(IShellItem i, uint f);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string e);
    void Close(int hr);
    void SetClientGuid(ref Guid g);
    void ClearClientData();
    void SetFilter(IntPtr f);
  }

  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdn, out IntPtr name);
    void GetAttributes(uint mask, out uint attrs);
    void Compare(IShellItem psi, uint hint, out int order);
  }

  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  class FileOpenDialog { }

  public static string Show(string title, string okLabel) {
    var raiser = new Thread(Raise);
    raiser.IsBackground = true;
    raiser.Start();

    var dialog = (IFileOpenDialog)new FileOpenDialog();
    uint options;
    dialog.GetOptions(out options);
    dialog.SetOptions(options | 0x20u | 0x40u | 0x800u);
    if (title != null) dialog.SetTitle(title);
    if (okLabel != null) dialog.SetOkButtonLabel(okLabel);

    int hr = dialog.Show(IntPtr.Zero);
    if (hr != 0) return null;

    IShellItem item;
    dialog.GetResult(out item);
    IntPtr name;
    item.GetDisplayName(0x80058000u, out name);
    string path = Marshal.PtrToStringUni(name);
    Marshal.FreeCoTaskMem(name);
    return path;
  }
}`

/** The compiled form: the class above plus an entry point that prints one path. */
const PICK_EXE_SOURCE = PICK_CSHARP + `

public static class Program {
  public static int Main(string[] args) {
    string picked = DshFolderPick.Show(args.Length > 0 ? args[0] : null, args.Length > 1 ? args[1] : null);
    if (picked == null) return 1;
    // Written as UTF-8 bytes rather than through Console.Out: its encoding
    // depends on a console this process does not own, and paths are not ASCII.
    byte[] bytes = System.Text.Encoding.UTF8.GetBytes(picked);
    using (System.IO.Stream stdout = Console.OpenStandardOutput()) {
      stdout.Write(bytes, 0, bytes.Length);
      stdout.Flush();
    }
    return 0;
  }
}`

/** The fallback for a host without `csc.exe`: the same class through PowerShell. */
const PICK_SCRIPT = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$source = @'
${PICK_CSHARP}
'@
Add-Type -TypeDefinition $source
$picked = [DshFolderPick]::Show('选择隔离夹保存位置', '选择此文件夹')
if ($picked) { [Console]::Out.Write($picked) }
`

/** Bump when `PICK_EXE_SOURCE` changes, so a cached build is not reused. */
const PICK_EXE_VERSION = 1
/** Compiling once is slow; it happens on the first ever pick only. */
const PICK_COMPILE_TIMEOUT_MS = 60 * 1000

/** The C# compiler that ships with .NET Framework, if this machine has it. */
function findCsc() {
  const windir = process.env.WINDIR || 'C:\\Windows'
  for (const flavor of ['Framework64', 'Framework']) {
    const candidate = path.join(windir, 'Microsoft.NET', flavor, 'v4.0.30319', 'csc.exe')
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // try the next flavour
    }
  }
  return null
}

/**
 * Compile the picker once into `$DSH_HOME/cache/dsh-delete-session`, then reuse
 * it. Returns null when this machine cannot compile, so the caller falls back to
 * the PowerShell path rather than failing the pick.
 */
async function ensurePickerExe() {
  if (process.platform !== 'win32') return null
  const dir = path.join(dshHome(), 'cache', 'dsh-delete-session', `v${PICK_EXE_VERSION}`)
  const exe = path.join(dir, 'dsh-folder-pick.exe')
  if (await pathExists(exe)) return exe
  const csc = findCsc()
  if (csc === null) return null
  try {
    await fsp.mkdir(dir, { recursive: true })
    const source = path.join(dir, 'picker.cs')
    await fsp.writeFile(source, PICK_EXE_SOURCE, 'utf8')
    const built = await runExecutable(csc, ['-nologo', '-target:exe', `-out:${exe}`, '-r:System.dll', source], PICK_COMPILE_TIMEOUT_MS)
    try { await fsp.rm(source, { force: true }) } catch { /* best effort */ }
    if (built.code === 0) {
      if (await pathExists(exe)) return exe
    }
  } catch {
    // fall through to the PowerShell path
  }
  return null
}

/** Run a program and collect its output, leaving the meaning of the exit to the caller. */
function runExecutable(program, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { windowsHide: true })
    let out = ''
    let err = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      finish(reject, new HttpError(504, 'timeout', '等待系统对话框超时'))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf8') })
    child.on('error', (error) => {
      finish(reject, new HttpError(500, 'spawn', `无法启动 ${path.basename(program)}：${String((error && error.message) || error)}`))
    })
    child.on('close', (code) => finish(resolve, { code, stdout: out, stderr: err }))
  })
}

/** Argument keys carrying the target path, per writing tool. */
const WRITE_TOOL_PATHS = {
  write: ['file_path', 'path'],
  edit: ['file_path', 'path'],
  str_replace_editor: ['path', 'file_path'],
  create_file: ['file_path', 'path'],
}

/** Argument keys carrying the target path, per reading tool. */
const READ_TOOL_PATHS = {
  read: ['file_path', 'path'],
  read_file: ['file_path', 'path'],
}

/**
 * Resolve the target path one tool call names.
 * @param name - tool name.
 * @param argumentsJson - the model's raw argument JSON.
 * @param cwd - the session's recorded working directory, for relative paths.
 * @returns the absolute path and whether the tool writes, or undefined.
 */
function toolTarget(name, argumentsJson, cwd) {
  const writes = Object.prototype.hasOwnProperty.call(WRITE_TOOL_PATHS, name)
  const keys = writes ? WRITE_TOOL_PATHS[name] : READ_TOOL_PATHS[name]
  if (keys === undefined) return undefined
  let args
  try {
    args = JSON.parse(typeof argumentsJson === 'string' ? argumentsJson : '')
  } catch {
    return undefined
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  const raw = keys.map((key) => args[key]).find((value) => typeof value === 'string' && value.trim() !== '')
  if (raw === undefined) return undefined
  let absolute
  if (path.isAbsolute(raw)) absolute = raw
  else if (cwd === undefined) return undefined
  else absolute = path.resolve(cwd, raw)
  return { path: absolute, writes }
}

/** Read a stored session's events through the persistence seam. */
async function readSessionEvents(ctx, sessionId) {
  const sp = ctx.get('sessionPersistence')
  if (!sp || typeof sp.open !== 'function') {
    return { events: [], warning: '持久化服务不可用，无法读取会话日志' }
  }
  let handle = null
  try {
    handle = await sp.open(sessionId, 'read')
    const result = await handle.read()
    const events = Array.isArray(result && result.events) ? result.events : []
    return { events, warning: undefined }
  } catch (error) {
    return { events: [], warning: `读取会话日志失败：${String((error && error.message) || error)}` }
  } finally {
    try {
      if (handle && typeof handle.close === 'function') await handle.close()
    } catch {
      // a close failure must not change the plan
    }
  }
}

/**
 * Identity of one path for "have we seen this file before?" purposes. The real
 * path when it resolves, so a symlink alias and its target count as the same
 * file; otherwise a case-folded resolved path on Windows, whose filesystem does
 * not distinguish `Foo.md` from `foo.md`. Comparing spellings instead would let
 * a write through an alias look like a creation.
 * @param absolute - the path a tool call named.
 * @param cache - optional per-scan memo; without it the resolution cost scales
 *   with log length rather than with the number of distinct files.
 * @returns a stable key for the file, not for the spelling.
 */
async function identityKey(absolute, cache) {
  if (cache !== undefined) {
    const hit = cache.get(absolute)
    if (hit !== undefined) return hit
  }
  let key
  try {
    key = await realpathNative(absolute)
  } catch {
    const resolved = path.resolve(absolute)
    key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  if (cache !== undefined) cache.set(absolute, key)
  return key
}

/**
 * Every path this session's writing tools touched, split by whether the session
 * created it or found it already there.
 * @param events - stored session events, in order.
 * @param cwd - the session's recorded working directory.
 * @param cache - optional per-scan memo for path resolution, shared across calls.
 * @returns `{ created, modified }`, keyed by file identity, each row `{ path, identity, ops }`.
 */
async function collectSessionPaths(events, cwd, cache) {
  const pending = new Map()
  const read = new Set()
  const created = new Map()
  const modified = new Map()
  const memo = cache !== undefined ? cache : new Map()

  // Resolve every distinct path the log names first, together. A long session
  // names the same handful of files thousands of times, so awaiting per call
  // would buy one threadpool round trip per mention; this buys one per file.
  const named = new Set()
  for (const event of events) {
    const data = event && event.data
    if (!data || typeof data !== 'object' || event.type !== 'tool/call') continue
    const target = toolTarget(typeof data.name === 'string' ? data.name : '', data.arguments, cwd)
    if (target !== undefined) named.add(target.path)
  }
  await runWithConcurrency([...named], RESOLVE_CONCURRENCY, async (absolute) => {
    await identityKey(absolute, memo)
  })

  const commit = (call) => {
    // A file the session created and later edited stays "created": one identity
    // must never sit in both buckets, or a scope=all run would target it twice
    // and report a spurious failure for the second attempt.
    const alreadyCreated = created.get(call.identity)
    if (alreadyCreated !== undefined) {
      alreadyCreated.ops += 1
      return
    }
    const bucket = call.existedBefore ? modified : created
    const prior = bucket.get(call.identity)
    if (prior !== undefined) prior.ops += 1
    else bucket.set(call.identity, { path: call.path, identity: call.identity, ops: 1 })
  }

  for (const event of events) {
    const data = event && event.data
    if (!data || typeof data !== 'object') continue

    if (event.type === 'tool/call') {
      const name = typeof data.name === 'string' ? data.name : ''
      const target = toolTarget(name, data.arguments, cwd)
      // Existence is decided at call time, against the reads that already
      // succeeded - the policy's own ordering - and on identity, so an alias of
      // a file the session read is still an edit.
      if (target !== undefined) {
        const identity = await identityKey(target.path, memo)
        pending.set(data.callId, {
          path: target.path,
          identity,
          writes: target.writes,
          existedBefore: read.has(identity),
        })
      }
      continue
    }

    if (event.type !== 'tool/result') continue
    const message = data.message
    const callId = message && typeof message.toolCallId === 'string' ? message.toolCallId : undefined
    if (callId === undefined) continue
    const call = pending.get(callId)
    if (call === undefined) continue
    pending.delete(callId)
    if (data.error !== undefined || (message && message.isError === true)) continue
    if (call.writes) commit(call)
    else read.add(call.identity)
  }

  return { created, modified }
}

/**
 * Whether `child` is strictly inside `parent`, comparing real paths. Folded on
 * Windows, where the filesystem ignores case: a realpath does not normalise the
 * case of a prefix that still matches a differently-spelled spelling.
 */
function insidePath(parent, child) {
  if (parent === child) return false
  const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
  const base = fold(parent)
  const prefix = base.endsWith(path.sep) ? base : base + path.sep
  return fold(child).startsWith(prefix)
}

/**
 * Is this directory inside a git working tree? A `.git` entry marks the root —
 * a directory in a normal clone, a file in a worktree or a submodule.
 *
 * The walk memoises per directory: one plan can span hundreds of files that share
 * a handful of folders, and each miss would otherwise stat every level again.
 */
async function isInsideGitRepo(directory, cache) {
  let current = path.resolve(directory)
  const walked = []
  for (;;) {
    if (cache.has(current)) {
      const verdict = cache.get(current)
      for (const dir of walked) cache.set(dir, verdict)
      return verdict
    }
    walked.push(current)
    try {
      const marker = await fsp.stat(path.join(current, '.git'))
      if (marker.isDirectory() || marker.isFile()) {
        for (const dir of walked) cache.set(dir, true)
        return true
      }
    } catch {
      // no .git here; keep walking up
    }
    const parent = path.dirname(current)
    if (parent === current) {
      for (const dir of walked) cache.set(dir, false)
      return false
    }
    current = parent
  }
}

/**
 * Keep only the paths that may actually be moved: an existing regular file whose
 * real path is strictly inside the session's working directory and outside the
 * DSH home. Every rejection carries its reason.
 * @param rows - candidate rows `{ path, ops }`.
 * @param cwd - the session's recorded working directory.
 * @param home - resolved DSH home.
 * @param options - `{ skipGit }`: also refuse files inside a git working tree.
 * @returns `{ allowed, refused }`.
 */
async function classifyPaths(rows, cwd, home, options) {
  const allowed = []
  const refused = []
  const skipGit = options !== undefined && options !== null && options.skipGit === true
  const gitCache = new Map()
  const list = [...rows.values()]
  if (cwd === undefined) {
    for (const row of list) refused.push({ path: row.path, reason: '会话未记录工作目录，无法安全定位' })
    return { allowed, refused }
  }
  let realCwd
  try {
    realCwd = await fsp.realpath(cwd)
  } catch {
    for (const row of list) refused.push({ path: row.path, reason: '会话工作目录已不存在，无法校验归属' })
    return { allowed, refused }
  }
  let realHome = home
  try {
    realHome = await fsp.realpath(home)
  } catch {
    // an absent home cannot contain anything that exists
  }
  // Resolve each row's stat and real path together rather than one after another:
  // a long session can list hundreds of files, and awaiting them serially turns
  // one threadpool round trip into hundreds. `runWithConcurrency` keeps the order.
  const verdicts = await runWithConcurrency(list, RESOLVE_CONCURRENCY, async (row) => {
    let info
    try {
      info = await fsp.stat(row.path)
    } catch {
      return { refuse: { path: row.path, reason: '文件已不存在' } }
    }
    if (!info.isFile()) return { refuse: { path: row.path, reason: '不是普通文件，已跳过' } }
    let real
    try {
      real = await fsp.realpath(row.path)
    } catch {
      return { refuse: { path: row.path, reason: '无法解析真实路径，已跳过' } }
    }
    if (!insidePath(realCwd, real)) {
      return { refuse: { path: row.path, reason: '不在该对话的工作目录内，已跳过' } }
    }
    if (insidePath(realHome, real)) {
      return { refuse: { path: row.path, reason: '位于 DSH 数据目录内，已跳过' } }
    }
    if (skipGit && await isInsideGitRepo(path.dirname(real), gitCache)) {
      return { refuse: { path: row.path, reason: '位于 git 仓库内，已跳过' } }
    }
    return { allow: { path: real, displayPath: row.path, ops: row.ops, bytes: info.size, mtime: info.mtimeMs } }
  })
  for (const verdict of verdicts) {
    if (verdict.allow !== undefined) allowed.push(verdict.allow)
    else refused.push(verdict.refuse)
  }
  return { allowed, refused }
}

/**
 * Build the artifact plan for one session.
 * @param ctx - host plugin context.
 * @param sessionId - validated session id.
 * @returns `{ cwd, created, modified, refused, truncated, warnings }`.
 */
async function planArtifacts(ctx, sessionId, cache, options) {
  const home = dshHome()
  const warnings = []
  const sp = ctx.get('sessionPersistence')
  let cwd
  if (sp && typeof sp.stat === 'function') {
    try {
      const snapshot = await sp.stat(sessionId)
      let header = null
      if (snapshot !== null && typeof snapshot === 'object') {
        header = snapshot.header !== null && typeof snapshot.header === 'object' ? snapshot.header : snapshot
      }
      if (header && typeof header.cwd === 'string' && header.cwd !== '') cwd = header.cwd
    } catch (error) {
      warnings.push(`未找到该会话的存储记录：${String((error && error.message) || error)}`)
    }
  }
  const { events, warning } = await readSessionEvents(ctx, sessionId)
  if (warning !== undefined) warnings.push(warning)
  const { created, modified } = await collectSessionPaths(events, cwd, cache)
  const createdPlan = await classifyPaths(created, cwd, home, options)
  const modifiedPlan = await classifyPaths(modified, cwd, home, options)
  const refused = [...createdPlan.refused, ...modifiedPlan.refused]
  return {
    // Stamped so a caller handing this plan back cannot smuggle in another
    // session's list: runQuarantine refuses a plan that does not belong here.
    sessionId,
    cwd,
    created: createdPlan.allowed.slice(0, MAX_LISTED),
    modified: modifiedPlan.allowed.slice(0, MAX_LISTED),
    refused: refused.slice(0, MAX_LISTED),
    truncated: createdPlan.allowed.length > MAX_LISTED
      || modifiedPlan.allowed.length > MAX_LISTED
      || refused.length > MAX_LISTED,
    warnings,
  }
}

/**
 * Claim a quarantine directory under the DSH home. The name carries second
 * resolution only, so two deletes can land on the same name; an exclusive mkdir
 * (never `recursive: true`, which would happily reuse an existing tree) decides
 * the winner and the loser retries with a suffix. Two runs therefore can never
 * share a tree, which is what stops one run's file from overwriting another's.
 * @param home - resolved DSH home.
 * @returns the claimed directory, or undefined when none could be claimed.
 */
async function claimQuarantineDirectory(home) {
  // A fresh home has no quarantine root yet; creating it is the only write this
  // side does outside the quarantine tree, and it keeps a missing home from
  // turning into a silent "cannot claim" on the very first delete.
  try {
    await fsp.mkdir(home, { recursive: true })
  } catch {
    return undefined
  }
  const base = `${QUARANTINE_PREFIX}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = path.join(home, attempt === 0 ? base : `${base}-${attempt}`)
    try {
      await fsp.mkdir(candidate, { recursive: false })
      return candidate
    } catch (error) {
      if (error && error.code === 'EEXIST') continue
      return undefined
    }
  }
  return undefined
}

/** Whether a path exists, without throwing. */
async function pathExists(target) {
  try {
    await fsp.access(target)
    return true
  } catch {
    return false
  }
}

/**
 * A destination inside the quarantine tree that does not already exist. The
 * move itself must never overwrite: a quarantine that silently replaced an
 * earlier copy would destroy the only surviving copy of the file it replaced.
 * @param directory - claimed quarantine directory.
 * @param relative - path relative to the session's working directory.
 * @returns a free absolute path, or undefined when every name was taken.
 */
async function freeDestination(directory, relative) {
  const first = path.join(directory, relative)
  if (!(await pathExists(first))) return first
  const dir = path.dirname(first)
  const ext = path.extname(first)
  const stem = path.basename(first, ext)
  for (let n = 1; n < 10000; n += 1) {
    const candidate = path.join(dir, `${stem}-${n}${ext}`)
    if (!(await pathExists(candidate))) return candidate
  }
  return undefined
}

/**
 * Move the chosen files into a timestamped quarantine directory under the DSH
 * home, preserving each path relative to the session's working directory. Files
 * are moved, never removed, and an existing quarantine entry is never replaced,
 * so a wrong call is always recoverable by hand.
 *
 * Every step is asynchronous on purpose: a cross-device move copies, and a
 * synchronous copy inside the request handler would freeze the event loop, which
 * means every other session's traffic stalls behind one large quarantine.
 *
 * @param targets - absolute file paths to move.
 * @param cwd - the session's recorded working directory.
 * @param home - resolved DSH home.
 * @returns `{ directory, moved, failed }`.
 */
async function quarantineFiles(targets, cwd, home) {
  const moved = []
  const failed = []
  if (targets.length === 0) return { directory: null, moved, failed }

  const directory = await claimQuarantineDirectory(home)
  if (directory === undefined) {
    for (const target of targets) failed.push({ path: target, error: '无法创建隔离目录' })
    return { directory: null, moved, failed }
  }

  let realCwd = cwd
  if (typeof cwd === 'string') {
    try {
      realCwd = await fsp.realpath(cwd)
    } catch {
      // keep the recorded spelling; classifyPaths already proved containment
    }
  }
  for (const target of targets) {
    let relative = path.basename(target)
    if (typeof realCwd === 'string') {
      const candidate = path.relative(realCwd, target)
      if (candidate !== '' && !candidate.startsWith('..') && !path.isAbsolute(candidate)) relative = candidate
    }
    try {
      await fsp.mkdir(path.dirname(path.join(directory, relative)), { recursive: true })
      const destination = await freeDestination(directory, relative)
      if (destination === undefined) {
        failed.push({ path: target, error: '隔离目录内没有可用的目标文件名' })
        continue
      }
      try {
        await fsp.rename(target, destination)
      } catch {
        // A cross-device rename fails; fall back to copy-then-remove. `COPYFILE_EXCL`
        // keeps the copy from replacing anything that appeared in between.
        await fsp.copyFile(target, destination, fs.constants.COPYFILE_EXCL)
        await fsp.rm(target, { force: true })
      }
      moved.push({ from: target, to: destination })
    } catch (error) {
      failed.push({ path: target, error: String((error && error.message) || error) })
    }
  }
  return { directory, moved, failed }
}

/**
 * Quarantine the files one request selected. The candidate set is recomputed
 * here from the session log and the request's paths are intersected with it, so
 * a tampered request cannot move anything the user was not shown.
 * @param ctx - host plugin context.
 * @param sessionId - validated session id.
 * @param request - `{ scope, paths }` from the client; undefined asks for none.
 * @returns the outcome, or null when the request asked for no quarantine.
 */
async function runQuarantine(ctx, sessionId, request, knownPlan) {
  if (request === undefined || request === null || typeof request !== 'object') return null
  // Validated here as well as at the route, because `internals` exposes this
  // function and a direct caller must not be able to skip the check.
  if (!SESSION_ID_RE.test(sessionId)) throw new HttpError(400, 'invalid', 'invalid session id')
  const scope = request.scope === 'all' ? 'all' : 'created'
  // The same flag the dialog was built with, so a derived set cannot contain a
  // file the listing refused to show.
  const skipGit = request.skipGit === true
  // Re-deriving the plan is the expensive half of a delete; a caller that already
  // holds it for this session hands it over instead of paying for it twice.
  const plan = knownPlan === undefined || knownPlan === null
    ? await planArtifacts(ctx, sessionId, undefined, { skipGit })
    : knownPlan
  // A handed-in plan must be this session's plan. The route always derives it
  // from the same id, but `internals` exposes this function, and a future caller
  // passing its neighbour's plan would move files the user never saw.
  if (plan.sessionId !== sessionId) throw new HttpError(400, 'invalid', 'plan does not belong to this session')
  const candidates = scope === 'all' ? [...plan.created, ...plan.modified] : [...plan.created]
  const allowed = new Set(candidates.map((row) => row.path))
  const requested = Array.isArray(request.paths) ? request.paths : null
  const requestedStrings = requested === null ? null : new Set(requested.filter((value) => typeof value === 'string'))
  const targets = requested === null
    ? [...allowed]
    : [...requestedStrings].filter((value) => allowed.has(value))
  // Resolve the configured save path before moving a single file: a bad path must
  // stop the request, not send the files somewhere unintended.
  const rootInfo = await resolveQuarantineRoot(request.root, plan.cwd)
  if (rootInfo.error !== undefined) throw new HttpError(400, 'invalid', rootInfo.error)
  const root = rootInfo.root
  const outcome = await quarantineFiles(targets, plan.cwd, root)
  return {
    scope,
    directory: outcome.moved.length > 0 ? outcome.directory : null,
    root,
    moved: outcome.moved,
    failed: outcome.failed,
    candidates: allowed.size,
    selected: targets.length,
    dropped: requestedStrings === null ? 0 : requestedStrings.size - targets.length,
  }
}

/**
 * Decide which directory the timestamped quarantine folder is created under. An
 * empty request means the DSH home, which is what every earlier version did.
 * @param requested - the directory the client asked for, if any.
 * @param cwd - the session's working directory, used to refuse a "quarantine"
 *   that would only shuffle the files around inside the tree they came from.
 * @returns `{ root }` or `{ error }`.
 */
async function resolveQuarantineRoot(requested, cwd) {
  const home = dshHome()
  if (requested === undefined || requested === null || requested === '') return { root: home }
  if (typeof requested !== 'string') return { error: '保存路径必须是字符串' }
  if (requested.length > 4096) return { error: '保存路径过长' }
  if (!path.isAbsolute(requested)) return { error: '保存路径必须是绝对路径' }

  let real
  try {
    real = await fsp.realpath(requested)
  } catch {
    return { error: `保存路径不存在：${requested}` }
  }
  let info
  try {
    info = await fsp.stat(real)
  } catch {
    return { error: `无法读取保存路径：${requested}` }
  }
  if (!info.isDirectory()) return { error: '保存路径不是目录' }

  // The sessions store belongs to DSH; filling it with quarantined files would
  // drop them back into the one tree the delete pipeline sweeps.
  const sessionsRoot = path.join(home, 'sessions')
  if (real === sessionsRoot || insidePath(sessionsRoot, real)) {
    return { error: '不能把隔离夹设在会话存储目录内' }
  }
  if (typeof cwd === 'string') {
    let realCwd
    try {
      realCwd = await fsp.realpath(cwd)
    } catch {
      realCwd = undefined
    }
    if (realCwd !== undefined && (real === realCwd || insidePath(realCwd, real))) {
      return { error: '不能把隔离夹设在会话工作目录内' }
    }
  }
  return { root: real }
}

/** The drive letters Windows exposes, skipping the ones that cannot be read. */
async function listDriveRoots() {
  if (process.platform !== 'win32') return []
  const roots = []
  for (let code = 65; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`
    try {
      await fsp.access(drive)
      roots.push({ name: drive, path: drive })
    } catch {
      // absent or unreadable: not offered
    }
  }
  return roots
}

/**
 * One directory listing for the folder picker. Directories only: the picker
 * chooses where a folder is created, so files would be noise.
 * @param target - absolute directory to list; the DSH home when omitted.
 */
async function listDirectories(target) {
  const home = dshHome()
  const start = target === undefined || target === null || target === '' ? home : target
  if (typeof start !== 'string') throw new HttpError(400, 'invalid', 'path must be a string')
  if (!path.isAbsolute(start)) throw new HttpError(400, 'invalid', 'path must be absolute')

  let real
  try {
    real = await fsp.realpath(start)
  } catch {
    throw new HttpError(400, 'invalid', `目录不存在：${start}`)
  }
  let entries
  try {
    entries = await fsp.readdir(real, { withFileTypes: true })
  } catch (error) {
    throw new HttpError(400, 'invalid', `无法读取目录：${String((error && error.message) || error)}`)
  }

  const directories = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const full = path.join(real, entry.name)
    try {
      // `stat` follows a link, so a shortcut to a folder is still offered.
      const info = await fsp.stat(full)
      if (!info.isDirectory()) continue
    } catch {
      continue
    }
    directories.push({ name: entry.name, path: full })
  }
  directories.sort((a, b) => a.name.localeCompare(b.name))

  const parent = real === path.parse(real).root ? null : path.dirname(real)
  return {
    path: real,
    parent,
    entries: directories.slice(0, MAX_BROWSE_ENTRIES),
    truncated: directories.length > MAX_BROWSE_ENTRIES,
    // At a drive root, offer the other drives so Windows users are not stranded.
    roots: parent === null ? await listDriveRoots() : [],
    defaultRoot: home,
  }
}

/**
 * Run one PowerShell invocation and resolve its trimmed stdout.
 *
 * The script is passed as a file, never on stdin: `-Command -` reads stdin with
 * the console code page, and a non-ASCII byte in the script (the Chinese dialog
 * description, for one) silently killed the whole run instead of erroring.
 */
function runPowershell(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, {
      windowsHide: true,
    })
    let out = ''
    let err = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      finish(reject, new HttpError(504, 'timeout', '等待系统对话框超时'))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf8') })
    child.on('error', (error) => {
      finish(reject, new HttpError(500, 'spawn', `无法启动系统对话框：${String((error && error.message) || error)}`))
    })
    child.on('close', (code) => {
      if (code !== 0) {
        finish(reject, new HttpError(500, 'shell', `系统对话框异常退出（${code}）：${err.trim().slice(0, 300)}`))
        return
      }
      finish(resolve, out.trim())
    })
  })
}

/**
 * Open a directory in the operating system's file manager. The child is detached
 * and unreferenced so the HTTP response returns at once and the window lives on
 * its own; `explorer.exe` reports a non-zero exit even when it succeeds, so its
 * status is deliberately ignored.
 */
function revealDirectory(directory) {
  const opener = process.platform === 'win32'
    ? { program: 'explorer.exe', args: [directory] }
    : process.platform === 'darwin'
      ? { program: 'open', args: [directory] }
      : { program: 'xdg-open', args: [directory] }
  const child = spawn(opener.program, opener.args, { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
}

/**
 * The slow path: the same dialog through PowerShell. Windows PowerShell 5.1
 * reads a script file as UTF-8 only when it carries a BOM, and without one the
 * Chinese labels corrupt the run into a silent exit.
 */
async function pickFolderWithPowershell() {
  const scriptPath = path.join(os.tmpdir(), `dsh-delete-session-pick-${process.pid}-${Date.now()}.ps1`)
  const bytes = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(PICK_SCRIPT, 'utf8')])
  await fsp.writeFile(scriptPath, bytes)
  try {
    return await runPowershell(
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      PICK_TIMEOUT_MS,
    )
  } finally {
    try { await fsp.rm(scriptPath, { force: true }) } catch { /* best effort */ }
  }
}

/**
 * Raise the real Windows folder picker and return what the user chose. The
 * browser cannot hand a page a filesystem path, but this process can ask the OS.
 * @returns `{ cancelled, path }`.
 */
async function pickFolderNative() {
  if (process.platform !== 'win32') {
    throw new HttpError(501, 'unsupported', '系统文件夹对话框只支持 Windows，请改用浏览…')
  }

  // The compiled picker answers in ~120 ms; the PowerShell fallback costs a
  // second before the dialog even appears, so it is only the second choice.
  let picked = ''
  const exe = await ensurePickerExe()
  if (exe !== null) {
    const run = await runExecutable(exe, ['选择隔离夹保存位置', '选择此文件夹'], PICK_TIMEOUT_MS)
    // Exit 1 is a cancelled dialog; anything else means it never opened.
    if (run.code !== 0 && run.code !== 1) {
      throw new HttpError(500, 'shell', `系统对话框异常退出（${run.code}）`)
    }
    picked = run.code === 0 ? run.stdout : ''
  } else {
    picked = await pickFolderWithPowershell()
  }
  if (picked === '') return { cancelled: true, path: null }

  const resolved = path.resolve(picked)
  let info
  try {
    info = await fsp.stat(resolved)
  } catch {
    throw new HttpError(400, 'invalid', '选中的目录已不存在')
  }
  if (!info.isDirectory()) throw new HttpError(400, 'invalid', '选中的不是目录')
  return { cancelled: false, path: resolved }
}

// --- http --------------------------------------------------------------------

function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.')
}

function isLocalHostHeader(host) {
  if (typeof host !== 'string' || host.length === 0) return false
  const name = host.split(':')[0].replace(/^\[|\]$/g, '').toLowerCase()
  return name === 'localhost' || name === '127.0.0.1' || name === '::1'
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1e6) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

// Destructive local endpoint: loopback socket, loopback Host header, and a
// same-origin check when the browser sends Origin. Tunneled or LAN clients
// get 403 before any session data is touched.
function guard(req, res) {
  if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) {
    sendJson(res, 403, { ok: false, code: 'forbidden', error: 'loopback only' })
    return false
  }
  const host = req.headers.host
  if (!isLocalHostHeader(host)) {
    sendJson(res, 403, { ok: false, code: 'forbidden', error: 'unexpected host' })
    return false
  }
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    let originHost = null
    try {
      originHost = new URL(origin).host
    } catch {
      originHost = null
    }
    if (originHost !== host) {
      sendJson(res, 403, { ok: false, code: 'forbidden', error: 'cross-origin request' })
      return false
    }
  }
  return true
}

// --- plugin ------------------------------------------------------------------

export function apply(ctx) {
  const registerRoutes = (webServer, fiber) => {
    // Read-only scan: the dialog shows what a delete would move, before it does.
    fiber.effect(() => webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/artifacts`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, code: 'method', error: 'POST only' })
          return
        }
        let body = {}
        try {
          const raw = await readBody(req)
          if (raw) body = JSON.parse(raw)
        } catch {
          sendJson(res, 400, { ok: false, code: 'invalid', error: 'malformed JSON body' })
          return
        }
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        if (!sessionId) {
          sendJson(res, 400, { ok: false, code: 'invalid', error: 'sessionId required' })
          return
        }
        try {
          if (!SESSION_ID_RE.test(sessionId)) throw new HttpError(400, 'invalid', 'invalid session id')
          const plan = await planArtifacts(ctx, sessionId, undefined, { skipGit: body.skipGit === true })
          // A bad save path is reported alongside the plan rather than replacing
          // it: the dialog can still show the files while saying where they cannot go.
          const rootInfo = await resolveQuarantineRoot(body.root, plan.cwd)
          sendJson(res, 200, {
            ok: true,
            sessionId,
            ...plan,
            defaultRoot: dshHome(),
            quarantineRoot: rootInfo.error === undefined ? rootInfo.root : null,
            rootError: rootInfo.error === undefined ? null : rootInfo.error,
          })
        } catch (error) {
          const status = error instanceof HttpError ? error.status : 500
          const code = error instanceof HttpError ? error.code : 'internal'
          sendJson(res, status, { ok: false, code, error: String((error && error.message) || error) })
        }
      },
    }))

    // The real Windows folder dialog, raised on the user's behalf. Browsers cannot
    // hand a page a filesystem path, but this process is local, so it can.
    fiber.effect(() => webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/pick`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, code: 'method', error: 'POST only' })
          return
        }
        try {
          const picked = await pickFolderNative()
          sendJson(res, 200, { ok: true, ...picked })
        } catch (error) {
          const status = error instanceof HttpError ? error.status : 500
          const code = error instanceof HttpError ? error.code : 'internal'
          sendJson(res, status, { ok: false, code, error: String((error && error.message) || error) })
        }
      },
    }))

    // Open a folder in the OS file manager. The path is validated as an existing
    // directory first: this hands a string to Explorer, so it must never be able
    // to carry anything but a directory.
    fiber.effect(() => webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/reveal`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, code: 'method', error: 'POST only' })
          return
        }
        let body = {}
        try {
          const raw = await readBody(req)
          if (raw) body = JSON.parse(raw)
        } catch {
          sendJson(res, 400, { ok: false, code: 'invalid', error: 'malformed JSON body' })
          return
        }
        try {
          const target = typeof body.path === 'string' ? body.path.trim() : ''
          if (target === '') throw new HttpError(400, 'invalid', 'path required')
          const resolved = path.resolve(target)
          let info
          try {
            info = await fsp.stat(resolved)
          } catch {
            throw new HttpError(400, 'invalid', '目录不存在')
          }
          if (!info.isDirectory()) throw new HttpError(400, 'invalid', '不是目录')
          revealDirectory(resolved)
          sendJson(res, 200, { ok: true, path: resolved })
        } catch (error) {
          const status = error instanceof HttpError ? error.status : 500
          const code = error instanceof HttpError ? error.code : 'internal'
          sendJson(res, status, { ok: false, code, error: String((error && error.message) || error) })
        }
      },
    }))

    // Folder picker for the quarantine save path: directories only, never file
    // contents, and the same loopback guard as every other route here.
    fiber.effect(() => webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/browse`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, code: 'method', error: 'POST only' })
          return
        }
        let body = {}
        try {
          const raw = await readBody(req)
          if (raw) body = JSON.parse(raw)
        } catch {
          sendJson(res, 400, { ok: false, code: 'invalid', error: 'malformed JSON body' })
          return
        }
        try {
          const listing = await listDirectories(body.path)
          sendJson(res, 200, { ok: true, ...listing })
        } catch (error) {
          const status = error instanceof HttpError ? error.status : 500
          const code = error instanceof HttpError ? error.code : 'internal'
          sendJson(res, status, { ok: false, code, error: String((error && error.message) || error) })
        }
      },
    }))

    fiber.effect(() => webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/delete`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, code: 'method', error: 'POST only' })
          return
        }
        let body = {}
        try {
          const raw = await readBody(req)
          if (raw) body = JSON.parse(raw)
        } catch {
          sendJson(res, 400, { ok: false, code: 'invalid', error: 'malformed JSON body' })
          return
        }
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        if (!sessionId) {
          sendJson(res, 400, { ok: false, code: 'invalid', error: 'sessionId required' })
          return
        }
        try {
          // Validate before touching anything: the quarantine runs first, so an
          // unchecked id would reach the filesystem ahead of deleteSession's own
          // guard. `/artifacts` already validates at the same point.
          if (!SESSION_ID_RE.test(sessionId)) throw new HttpError(400, 'invalid', 'invalid session id')
          // Quarantine first: the session log is still there to derive the plan
          // from, and a partial move leaves the conversation intact to retry.
          const wantsQuarantine = typeof body.quarantine === 'object' && body.quarantine !== null
          // The plan handed to the move must honour the same `skipGit` the dialog
          // listed, or a file the listing refused to show would move anyway.
          const plan = wantsQuarantine
            ? await planArtifacts(ctx, sessionId, undefined, { skipGit: body.quarantine.skipGit === true })
            : null
          const quarantine = await runQuarantine(ctx, sessionId, body.quarantine, plan)
          const result = await deleteSession(ctx, sessionId)
          sendJson(res, 200, quarantine === null ? { ok: true, ...result } : { ok: true, ...result, quarantine })
        } catch (error) {
          const status = error instanceof HttpError ? error.status : 500
          const code = error instanceof HttpError ? error.code : 'internal'
          sendJson(res, status, { ok: false, code, error: String((error && error.message) || error) })
        }
      },
    }))

    fiber.effect(() => webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/delete-many`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, code: 'method', error: 'POST only' })
          return
        }
        let body = {}
        try {
          const raw = await readBody(req)
          if (raw) body = JSON.parse(raw)
        } catch {
          sendJson(res, 400, { ok: false, code: 'invalid', error: 'malformed JSON body' })
          return
        }
        const sessionIds = Array.isArray(body.sessionIds)
          ? [...new Set(body.sessionIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))]
          : []
        if (sessionIds.length === 0) {
          sendJson(res, 400, { ok: false, code: 'invalid', error: 'sessionIds required' })
          return
        }
        if (sessionIds.length > MAX_BATCH) {
          sendJson(res, 400, { ok: false, code: 'invalid', error: `too many sessions (max ${MAX_BATCH})` })
          return
        }
        // Bounded-concurrency batch: every item runs the same guarded pipeline
        // (lease retry, directory sweep, workspace accounting); independent
        // sessions run in parallel and the workspace accounting mutation is
        // serialized inside deleteSession, so a batch can never interleave two
        // deletions of the same storage.
        const results = await runWithConcurrency(sessionIds, BATCH_CONCURRENCY, async (sessionId) => {
          try {
            const result = await deleteSession(ctx, sessionId)
            return { sessionId, ok: true, removed: result.removed }
          } catch (error) {
            return {
              sessionId,
              ok: false,
              code: error instanceof HttpError ? error.code : 'internal',
              error: String((error && error.message) || error),
            }
          }
        })
        const deleted = results.filter((item) => item.ok).length
        sendJson(res, 200, { ok: true, results, deleted, failed: results.length - deleted })
      },
    }))
  }

  const webServer = ctx.get('webServer')
  if (webServer) {
    registerRoutes(webServer, ctx)
  } else {
    // A terminal-only profile never provides a web surface; register once one
    // appears instead of waiting on a service that will never arrive.
    ctx.inject(['webServer'], (sub) => registerRoutes(sub.webServer, sub))
  }
}

// Re-exported for the offline test suite, which drives the artifact plan and the
// quarantine against a scratch tree and a stubbed persistence service. Nothing
// else in the host reads this face.
export const internals = {
  ensurePickerExe,
  claimQuarantineDirectory,
  classifyPaths,
  collectSessionPaths,
  findSessionCaches,
  freeDestination,
  identityKey,
  insidePath,
  listDirectories,
  moveToSessionTrash,
  planArtifacts,
  quarantineFiles,
  resolveQuarantineRoot,
  retirePaths,
  runQuarantine,
  sendToRecycleBin,
  toolTarget,
}
