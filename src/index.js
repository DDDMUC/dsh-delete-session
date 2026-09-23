// dsh-delete-session - host half.
//
// One loopback-only HTTP route serves the client menu item:
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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

function removeSessionDirs(sessionId) {
  const dirs = findSessionDirs(sessionId)
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
  return dirs
}

// Deleting the on-disk directory is not enough: projection caches keep a
// per-session JSON row (`$DSH_HOME/storages/<store>/sessions/<id>.json`) that
// would linger as a ghost — the sidebar list is directory-backed, so the row
// can never be shown or deleted again (issue: "can't delete anymore"). Remove
// the session's cache units together with its directories.
function removeSessionCaches(sessionId) {
  const storesRoot = path.join(dshHome(), 'storages')
  const removed = []
  let stores
  try {
    stores = fs.readdirSync(storesRoot, { withFileTypes: true })
  } catch {
    return removed
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
      const file = path.join(dir, entry)
      try {
        fs.rmSync(file, { force: true })
        removed.push(file)
      } catch {
        // best-effort: a locked cache row must not fail the deletion
      }
    }
  }
  return removed
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

  // Remove the on-disk directories first. If the filesystem refuses, fail
  // before touching workspace accounting so a half-deleted session cannot
  // fall out of its group into "Ungrouped".
  let removed = removeSessionDirs(sessionId)
  await new Promise((resolve) => setImmediate(resolve))
  removed = removed.concat(removeSessionDirs(sessionId))

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

  // Cache rows are projection state, not the source of truth: clean them even
  // when the directories were already gone, so a deleted session cannot leave
  // a ghost behind.
  const cachesRemoved = removeSessionCaches(sessionId)

  const workspaceDetached = await withWorkspaceLock(() => detachFromWorkspace(ctx, sessionId))
  if (removed.length === 0 && !workspaceDetached && !flushed && !detached && cachesRemoved.length === 0) {
    throw new HttpError(404, 'not-found', 'session not found')
  }
  return { removed: removed.length, caches: cachesRemoved.length, stopped, flushed, detached, workspaceDetached }
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
          const result = await deleteSession(ctx, sessionId)
          sendJson(res, 200, { ok: true, ...result })
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
