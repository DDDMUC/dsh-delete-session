// Offline tests for the produced-files half: log classification, the safety
// filters, and the quarantine move.
//
// These drive src/index.js directly - no DSH process, no browser, no network.
// The one seam they stub is `sessionPersistence`, because reading a real session
// log is the caller's job and not what this file is about.
//
//   node test/artifacts.host.test.js      (or: npm test)
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { internals } from '../src/index.js'

const { classifyPaths, collectSessionPaths, planArtifacts, quarantineFiles, runQuarantine, toolTarget } = internals
const { claimQuarantineDirectory, freeDestination, identityKey, insidePath, listDirectories, resolveQuarantineRoot } = internals

/** A real session id: runQuarantine validates the shape before touching anything. */
const SESSION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const SESSION_B = '0f8fad5b-d9cb-469f-a165-70867728950e'

// --- scratch trees ----------------------------------------------------------

const roots = []

function scratch(label) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `dsdel-${label}-`)))
  roots.push(dir)
  return dir
}

after(() => {
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* already gone */ }
  }
})

// Pin the DSH home for the entire file. `dshHome()` reads the environment at
// call time, so any test that reached it without redirecting would move files
// into the real `~/.dsh`. A mutation run did exactly that once (it disabled the
// id guard, which let one test fall through to the move), so the redirect now
// covers every test rather than only the ones that think they need it.
const HOME_ROOT = scratch('home-root')
process.env.DSH_HOME = HOME_ROOT

// The redirect above is the only thing standing between these tests and the real
// ~/.dsh, so it is re-asserted before every test rather than trusted once: a
// test that parks DSH_HOME somewhere and fails to put it back would otherwise
// hand the next test the real home.
beforeEach(() => {
  assert.equal(process.env.DSH_HOME, HOME_ROOT, 'every test must run against the scratch home')
  assert.ok(HOME_ROOT.startsWith(os.tmpdir()), 'the scratch home must live under tmp, got ' + HOME_ROOT)
})

function writeAt(root, relative, content = 'x') {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

/** One tool call plus its successful result, the shape the classifier consumes. */
function call(callId, name, args) {
  return { type: 'tool/call', data: { callId, name, arguments: JSON.stringify(args) } }
}
function result(callId, ok = true) {
  return {
    type: 'tool/result',
    data: ok
      ? { message: { toolCallId: callId } }
      : { message: { toolCallId: callId, isError: true }, error: { name: 'FsError', code: 'FS_FAILED' } },
  }
}

/** Rows the way classifyPaths wants them. */
function rows(paths) {
  const map = new Map()
  for (const p of paths) map.set(p, { path: p, ops: 1 })
  return map
}

/**
 * The identity key the classifier stores for a path that does not exist yet. The
 * tests below use synthetic paths (never touched on disk), so the key falls back
 * to a case-folded resolved spelling on Windows.
 */
function folded(p) {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** A context whose persistence service replays fixed events for one session. */
function stubCtx({ cwd, events = [], statFails = false }) {
  return {
    get(name) {
      if (name !== 'sessionPersistence') return undefined
      return {
        async stat() {
          if (statFails) throw new Error('no record')
          return { header: cwd === undefined ? {} : { cwd } }
        },
        async open() {
          return {
            async read() { return { events } },
            async close() {},
          }
        },
      }
    },
  }
}

// --- toolTarget -------------------------------------------------------------

test('toolTarget resolves absolute and cwd-relative write targets', () => {
  const cwd = path.resolve(os.tmpdir(), 'some-workspace')
  const absolute = path.resolve(cwd, 'a.md')

  assert.deepEqual(toolTarget('write', JSON.stringify({ file_path: absolute, content: 'x' }), cwd), {
    path: absolute,
    writes: true,
  })
  assert.deepEqual(toolTarget('edit', JSON.stringify({ file_path: 'sub/b.md' }), cwd), {
    path: path.resolve(cwd, 'sub/b.md'),
    writes: true,
  })
  // str_replace_editor spells the key `path`.
  assert.deepEqual(toolTarget('str_replace_editor', JSON.stringify({ path: 'c.md' }), cwd), {
    path: path.resolve(cwd, 'c.md'),
    writes: true,
  })
  assert.deepEqual(toolTarget('read', JSON.stringify({ file_path: 'd.md' }), cwd), {
    path: path.resolve(cwd, 'd.md'),
    writes: false,
  })
})

test('toolTarget ignores tools with no path, bad JSON, and an unknown cwd for relative paths', () => {
  const cwd = path.resolve(os.tmpdir(), 'some-workspace')
  assert.equal(toolTarget('bash', JSON.stringify({ command: 'ls' }), cwd), undefined)
  assert.equal(toolTarget('write', 'not json', cwd), undefined)
  assert.equal(toolTarget('write', JSON.stringify({ file_path: 'rel.md' }), undefined), undefined)
  assert.equal(toolTarget('write', JSON.stringify({ file_path: '' }), cwd), undefined)
})

// --- collectSessionPaths ----------------------------------------------------

test('a write with no earlier successful read created the file', async () => {
  const cwd = path.resolve(os.tmpdir(), 'ws')
  const events = [
    call('c1', 'write', { file_path: 'fresh.md' }), result('c1'),
    call('c2', 'read', { file_path: 'old.md' }), result('c2'),
    call('c3', 'write', { file_path: 'old.md' }), result('c3'),
  ]
  const { created, modified } = await collectSessionPaths(events, cwd)
  assert.deepEqual([...created.keys()], [folded(path.resolve(cwd, 'fresh.md'))])
  assert.deepEqual([...modified.keys()], [folded(path.resolve(cwd, 'old.md'))])
})

test('a failed write changes nothing', async () => {
  const cwd = path.resolve(os.tmpdir(), 'ws')
  const events = [
    call('c1', 'write', { file_path: 'ghost.md' }), result('c1', false),
  ]
  const { created, modified } = await collectSessionPaths(events, cwd)
  assert.equal(created.size, 0)
  assert.equal(modified.size, 0)
})

test('a failed read does not make a later write count as an edit', async () => {
  const cwd = path.resolve(os.tmpdir(), 'ws')
  const events = [
    call('c1', 'read', { file_path: 'new.md' }), result('c1', false),
    call('c2', 'write', { file_path: 'new.md' }), result('c2'),
  ]
  const { created, modified } = await collectSessionPaths(events, cwd)
  assert.deepEqual([...created.keys()], [folded(path.resolve(cwd, 'new.md'))])
  assert.equal(modified.size, 0)
})

test('an edit alone is a modification, never a creation', async () => {
  const cwd = path.resolve(os.tmpdir(), 'ws')
  const events = [
    call('c1', 'read', { file_path: 'doc.md' }), result('c1'),
    call('c2', 'edit', { file_path: 'doc.md' }), result('c2'),
  ]
  const { created, modified } = await collectSessionPaths(events, cwd)
  assert.equal(created.size, 0)
  assert.deepEqual([...modified.keys()], [folded(path.resolve(cwd, 'doc.md'))])
})

test('repeat writes to one path collapse into one row with an op count', async () => {
  const cwd = path.resolve(os.tmpdir(), 'ws')
  const events = [
    call('c1', 'write', { file_path: 'a.md' }), result('c1'),
    call('c2', 'write', { file_path: 'a.md' }), result('c2'),
    call('c3', 'write', { file_path: 'a.md' }), result('c3'),
  ]
  const { created } = await collectSessionPaths(events, cwd)
  assert.equal(created.size, 1)
  assert.equal(created.get(folded(path.resolve(cwd, 'a.md'))).ops, 3)
})

test('results that match no call are ignored', async () => {
  const cwd = path.resolve(os.tmpdir(), 'ws')
  const { created, modified } = await collectSessionPaths([result('nope')], cwd)
  assert.equal(created.size, 0)
  assert.equal(modified.size, 0)
})

// --- classifyPaths ----------------------------------------------------------

test('classifyPaths keeps only existing regular files strictly inside the working directory', async () => {
  const cwd = scratch('cwd')
  const home = scratch('home')
  const inside = writeAt(cwd, 'keep.md', 'hello')
  const nested = writeAt(cwd, 'sub/nested.md', 'hi')
  const dir = path.join(cwd, 'adir')
  fs.mkdirSync(dir)
  const outside = writeAt(scratch('elsewhere'), 'outside.md', 'no')

  const { allowed, refused } = await classifyPaths(
    rows([inside, nested, dir, outside, path.join(cwd, 'missing.md')]),
    cwd,
    home,
  )

  const allowedPaths = allowed.map((row) => row.path).sort()
  assert.deepEqual(allowedPaths, [nested, inside].sort())

  const reasons = new Map(refused.map((row) => [row.path, row.reason]))
  assert.equal(reasons.get(dir), '不是普通文件，已跳过')
  assert.equal(reasons.get(outside), '不在该对话的工作目录内，已跳过')
  assert.equal(reasons.get(path.join(cwd, 'missing.md')), '文件已不存在')
})

test('classifyPaths refuses files inside the DSH home even when the workspace sits there too', async () => {
  // A file under the DSH home is only reachable through the home branch when the
  // working directory is itself below the home — otherwise the containment check
  // rejects it first, which is the case the previous test covers.
  const home = scratch('home')
  const cwd = path.join(home, 'workspace')
  fs.mkdirSync(cwd, { recursive: true })
  const file = writeAt(cwd, 'inside.md', 'x')

  const { allowed, refused } = await classifyPaths(rows([file]), cwd, home)
  assert.equal(allowed.length, 0)
  assert.equal(refused.length, 1)
  assert.equal(refused[0].reason, '位于 DSH 数据目录内，已跳过')
})

test('classifyPaths refuses everything when the session recorded no working directory', async () => {
  const home = scratch('home')
  const gone = path.join(scratch('cwd'), 'a.md')
  const { allowed, refused } = await classifyPaths(rows([gone]), undefined, home)
  assert.equal(allowed.length, 0)
  assert.equal(refused.length, 1)
  assert.equal(refused[0].reason, '会话未记录工作目录，无法安全定位')
})

test('classifyPaths refuses everything when the working directory is gone', async () => {
  const cwd = scratch('cwd')
  const home = scratch('home')
  const file = writeAt(scratch('elsewhere'), 'a.md')
  fs.rmSync(cwd, { recursive: true, force: true })
  const { allowed, refused } = await classifyPaths(rows([file]), cwd, home)
  assert.equal(allowed.length, 0)
  assert.equal(refused[0].reason, '会话工作目录已不存在，无法校验归属')
})

test('classifyPaths never lets a sibling with a shared prefix through', async () => {
  const parent = scratch('parent')
  const cwd = path.join(parent, 'project')
  fs.mkdirSync(cwd)
  // `project-evil` shares the `project` prefix but is not inside it.
  const sibling = path.join(parent, 'project-evil.md')
  fs.writeFileSync(sibling, 'x')
  const home = scratch('home')

  const { allowed, refused } = await classifyPaths(rows([sibling]), cwd, home)
  assert.equal(allowed.length, 0)
  assert.equal(refused[0].reason, '不在该对话的工作目录内，已跳过')
})

test('classifyPaths refuses a symlink whose target lies outside the working directory', async () => {
  const cwd = scratch('cwd')
  const home = scratch('home')
  const outside = writeAt(scratch('elsewhere'), 'secret.md', 'x')
  const link = path.join(cwd, 'link.md')
  try {
    fs.symlinkSync(outside, link)
  } catch {
    return
  }

  // Containment must be judged on the resolved target: the link sits inside the
  // working directory, but the file it names does not.
  const { allowed, refused } = await classifyPaths(rows([link]), cwd, home)
  assert.equal(allowed.length, 0, 'a link out of the tree is not this session file')
  assert.equal(refused[0].reason, '不在该对话的工作目录内，已跳过')
})

// --- quarantineFiles --------------------------------------------------------

test('quarantineFiles moves files into a timestamped tree and keeps their structure', async () => {
  const cwd = scratch('cwd')
  const home = scratch('home')
  const top = writeAt(cwd, 'notes.md', 'top-content')
  const deep = writeAt(cwd, path.join('sub', 'deep.txt'), 'deep-content')

  const outcome = await quarantineFiles([top, deep], cwd, home)

  assert.equal(outcome.failed.length, 0)
  assert.equal(outcome.moved.length, 2)
  // The originals are gone and the copies carry the same bytes.
  assert.equal(fs.existsSync(top), false)
  assert.equal(fs.existsSync(deep), false)
  const movedTop = path.join(outcome.directory, 'notes.md')
  const movedDeep = path.join(outcome.directory, 'sub', 'deep.txt')
  assert.equal(fs.readFileSync(movedTop, 'utf8'), 'top-content')
  assert.equal(fs.readFileSync(movedDeep, 'utf8'), 'deep-content')
  // The directory lives under the DSH home and is named for the operation.
  assert.ok(outcome.directory.startsWith(home))
  assert.match(path.basename(outcome.directory), /^purge-quarantine-/)
})

test('quarantineFiles reports a missing target instead of throwing', async () => {
  const cwd = scratch('cwd')
  const home = scratch('home')
  const outcome = await quarantineFiles([path.join(cwd, 'never-existed.md')], cwd, home)
  assert.equal(outcome.moved.length, 0)
  assert.equal(outcome.failed.length, 1)
})

// --- runQuarantine ----------------------------------------------------------

test('runQuarantine drops paths the plan never offered', async () => {
  const home = scratch('home')
  const cwd = scratch('cwd')
  const touched = writeAt(cwd, 'touched.md', 'mine')
  const bystander = writeAt(cwd, 'bystander.md', 'not this conversation')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const ctx = stubCtx({
      cwd,
      events: [call('c1', 'write', { file_path: 'touched.md' }), result('c1')],
    })
    // A tampered request appends a path the scan never listed.
    const outcome = await runQuarantine(ctx, SESSION_ID, {
      scope: 'created',
      paths: [touched, bystander],
    })
    assert.equal(outcome.selected, 1, 'only the planned file was selected')
    assert.equal(outcome.dropped, 1, 'the unplanned path was dropped')
    assert.equal(fs.existsSync(bystander), true, 'the bystander was never touched')
    assert.equal(fs.existsSync(touched), false, 'the planned file moved')
  } finally {
    process.env.DSH_HOME = previous
  }
})

test('runQuarantine honours the scope: created only versus created plus changed', async () => {
  const home = scratch('home')
  const cwd = scratch('cwd')
  const createdFile = writeAt(cwd, 'new.md', 'new')
  const changedFile = writeAt(cwd, 'old.md', 'old')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const events = [
      call('c1', 'write', { file_path: 'new.md' }), result('c1'),
      call('c2', 'read', { file_path: 'old.md' }), result('c2'),
      call('c3', 'edit', { file_path: 'old.md' }), result('c3'),
    ]
    const createdOnly = await runQuarantine(stubCtx({ cwd, events }), SESSION_ID, { scope: 'created' })
    assert.equal(createdOnly.selected, 1)
    assert.equal(fs.existsSync(createdFile), false)
    assert.equal(fs.existsSync(changedFile), true, 'a changed pre-existing file stays under created scope')

    const all = await runQuarantine(stubCtx({ cwd, events }), SESSION_ID, { scope: 'all' })
    assert.equal(all.selected, 1, 'only the changed file is left to move')
    assert.equal(fs.existsSync(changedFile), false)
  } finally {
    process.env.DSH_HOME = previous
  }
})

test('runQuarantine returns null when the caller asked for no quarantine', async () => {
  assert.equal(await runQuarantine({}, SESSION_ID, undefined), null)
  assert.equal(await runQuarantine({}, SESSION_ID, null), null)
})

// --- planArtifacts ----------------------------------------------------------

test('planArtifacts reports created and changed files plus every skip reason', async () => {
  const home = scratch('home')
  const cwd = scratch('cwd')
  const createdFile = writeAt(cwd, 'new.md', 'new')
  const changedFile = writeAt(cwd, 'old.md', 'old')
  const outside = writeAt(scratch('elsewhere'), 'outside.md', 'no')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const ctx = stubCtx({
      cwd,
      events: [
        call('c1', 'write', { file_path: 'new.md' }), result('c1'),
        call('c2', 'read', { file_path: 'old.md' }), result('c2'),
        call('c3', 'edit', { file_path: 'old.md' }), result('c3'),
        call('c4', 'write', { file_path: outside }), result('c4'),
      ],
    })
    const plan = await planArtifacts(ctx, 'session-x')
    assert.equal(plan.cwd, cwd)
    assert.deepEqual(plan.created.map((row) => row.path), [createdFile])
    assert.deepEqual(plan.modified.map((row) => row.path), [changedFile])
    assert.ok(plan.refused.some((row) => row.path === outside && row.reason === '不在该对话的工作目录内，已跳过'))
    assert.equal(plan.truncated, false)
  } finally {
    process.env.DSH_HOME = previous
  }
})

test('planArtifacts degrades to a warning when the session record is unreadable', async () => {
  const home = scratch('home')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const ctx = {
      get(name) {
        if (name !== 'sessionPersistence') return undefined
        return {
          async stat() { throw new Error('no record') },
          async open() { throw new Error('no log') },
        }
      },
    }
    const plan = await planArtifacts(ctx, 'gone')
    assert.equal(plan.created.length, 0)
    assert.equal(plan.modified.length, 0)
    assert.ok(plan.warnings.length >= 2, 'both the record and the log report a warning')
  } finally {
    process.env.DSH_HOME = previous
  }
})

// --- file identity, not path spelling ---------------------------------------
//
// A write is only a creation when the file did not exist. Comparing the raw
// strings would call a write through an alias, or through a differently-cased
// spelling, a creation — and a creation is exactly what gets moved.

test('a write through a symlink alias of a file the session read is a modification', async () => {
  const cwd = scratch('cwd')
  const real = writeAt(cwd, 'real.txt', 'original')
  try {
    fs.symlinkSync(real, path.join(cwd, 'alias.txt'))
  } catch {
    // Without SeCreateSymbolicLinkPrivilege on Windows there is nothing to test.
    return
  }

  const events = [
    call('c1', 'read', { file_path: 'alias.txt' }), result('c1'),
    call('c2', 'write', { file_path: 'real.txt' }), result('c2'),
  ]
  const { created, modified } = await collectSessionPaths(events, cwd)

  assert.equal(created.size, 0, 'the alias names the very file the read observed')
  assert.deepEqual([...modified.keys()], [fs.realpathSync.native(real)])
})

test('a differently-cased spelling of a file the session read is a modification', async () => {
  const cwd = scratch('cwd')
  const real = writeAt(cwd, 'Doc.md', 'original')
  // Only a case-insensitive filesystem makes these the same file; elsewhere the
  // two spellings really are two files and calling the write a creation is right.
  if (!fs.existsSync(path.join(cwd, 'doc.md'))) return

  const events = [
    call('c1', 'read', { file_path: 'Doc.md' }), result('c1'),
    call('c2', 'write', { file_path: 'doc.md' }), result('c2'),
  ]
  const { created, modified } = await collectSessionPaths(events, cwd)

  assert.equal(created.size, 0)
  assert.deepEqual([...modified.keys()], [fs.realpathSync.native(real)])
})

test('an unread file behind an alias still counts as a creation', async () => {
  const cwd = scratch('cwd')
  const other = writeAt(cwd, 'other.txt', 'x')
  try {
    fs.symlinkSync(other, path.join(cwd, 'alias.txt'))
  } catch {
    return
  }

  const events = [
    call('c1', 'read', { file_path: 'other.txt' }), result('c1'),
    // A different file, reached through its own name: this one was never read.
    call('c2', 'write', { file_path: 'fresh.txt' }), result('c2'),
  ]
  const { created } = await collectSessionPaths(events, cwd)
  assert.deepEqual([...created.keys()], [folded(path.resolve(cwd, 'fresh.txt'))])
})

// --- quarantine collisions --------------------------------------------------
//
// The directory name resolves to the second, and a move is an overwrite unless
// it is made not to be. Two runs landing in one second must not share a tree.

test('two quarantines in one second claim separate trees and never overwrite', async () => {
  const home = scratch('home')
  const cwdA = scratch('cwd-a')
  const cwdB = scratch('cwd-b')
  const a = writeAt(cwdA, path.join('src', 'index.js'), 'A-VERSION')
  const b = writeAt(cwdB, path.join('src', 'index.js'), 'B-VERSION')

  const first = await quarantineFiles([a], cwdA, home)
  const second = await quarantineFiles([b], cwdB, home)

  assert.equal(first.failed.length, 0)
  assert.equal(second.failed.length, 0)
  assert.notEqual(first.directory, second.directory, 'each run owns its own tree')
  // Both copies survive with their own content: neither run replaced the other.
  assert.equal(fs.readFileSync(path.join(first.directory, 'src', 'index.js'), 'utf8'), 'A-VERSION')
  assert.equal(fs.readFileSync(path.join(second.directory, 'src', 'index.js'), 'utf8'), 'B-VERSION')
  assert.equal(fs.existsSync(a), false)
  assert.equal(fs.existsSync(b), false)
})

test('an occupied quarantine name is skipped rather than written into', async () => {
  const home = scratch('home')
  const cwd = scratch('cwd')
  const file = writeAt(cwd, 'notes.md', 'x')

  // Occupy the name this second's claim would want first.
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const occupied = path.join(home, `purge-quarantine-${stamp}`)
  fs.mkdirSync(occupied)

  const outcome = await quarantineFiles([file], cwd, home)

  assert.equal(outcome.moved.length, 1, 'the file still moved')
  assert.notEqual(outcome.directory, occupied, 'the pre-existing tree is never written into')
  assert.equal(fs.existsSync(path.join(occupied, 'notes.md')), false)
})

test('quarantining nothing creates no directory at all', async () => {
  const home = scratch('home')
  const outcome = await quarantineFiles([], scratch('cwd'), home)
  assert.equal(outcome.directory, null)
  assert.equal(outcome.moved.length, 0)
  // A home that stayed empty proves no stray tree was left behind.
  assert.deepEqual(fs.readdirSync(home), [])
})

// --- the helpers the move itself depends on ---------------------------------
//
// These are the pieces a mutation could quietly weaken without any end-to-end
// case noticing, so they are checked directly.

test('freeDestination never hands back a taken name', async () => {
  const directory = scratch('quarantine')
  fs.mkdirSync(path.join(directory, 'sub'), { recursive: true })
  const taken = writeAt(directory, path.join('sub', 'notes.md'), 'already here')

  const free = await freeDestination(directory, path.join('sub', 'notes.md'))
  assert.notEqual(free, taken)
  assert.equal(path.basename(free), 'notes-1.md')
  assert.equal(fs.existsSync(free), false)

  // An untouched name is returned unchanged.
  assert.equal(await freeDestination(directory, 'brand-new.md'), path.join(directory, 'brand-new.md'))
})

test('insidePath folds case where the filesystem does', () => {
  const cwd = scratch('cwd')
  const child = writeAt(cwd, 'a.md')
  assert.equal(insidePath(cwd, child), true)
  assert.equal(insidePath(cwd, cwd), false, 'a directory is not inside itself')
  assert.equal(insidePath(cwd, path.join(cwd, '..', 'elsewhere.md')), false)

  if (process.platform === 'win32') {
    // The filesystem ignores case here, so containment has to as well.
    assert.equal(insidePath(cwd.toUpperCase(), child), true)
    assert.equal(insidePath(cwd, child.toUpperCase()), true)
  }
})

test('identityKey gives an alias and its target the same key', async () => {
  const cwd = scratch('cwd')
  const real = writeAt(cwd, 'real.txt', 'x')
  try {
    fs.symlinkSync(real, path.join(cwd, 'alias.txt'))
  } catch {
    return
  }
  assert.equal(await identityKey(path.join(cwd, 'alias.txt')), await identityKey(real))
})

test('claimQuarantineDirectory never hands out a directory another run owns', async () => {
  const home = scratch('home')
  const first = await claimQuarantineDirectory(home)
  const second = await claimQuarantineDirectory(home)
  assert.ok(first)
  assert.ok(second)
  assert.notEqual(first, second, 'the second claim moved aside')
  assert.equal(fs.statSync(first).isDirectory(), true)
  assert.equal(fs.statSync(second).isDirectory(), true)
})

test('claimQuarantineDirectory creates a quarantine root that does not exist yet', async () => {
  const parent = scratch('parent')
  const home = path.join(parent, 'not-there-yet')
  const claimed = await claimQuarantineDirectory(home)
  // A missing home must not turn the first ever delete into "cannot claim".
  assert.ok(claimed, 'the root was created')
  assert.equal(fs.statSync(claimed).isDirectory(), true)
})

// --- one identity, one bucket -----------------------------------------------

test('a file the session created and then edited stays created, never both', async () => {
  const cwd = scratch('cwd')
  writeAt(cwd, 'mine.md', 'x')
  const events = [
    call('c1', 'write', { file_path: 'mine.md' }), result('c1'),
    call('c2', 'read', { file_path: 'mine.md' }), result('c2'),
    call('c3', 'edit', { file_path: 'mine.md' }), result('c3'),
  ]
  const { created, modified } = await collectSessionPaths(events, cwd)

  assert.equal(created.size, 1)
  assert.equal(modified.size, 0, 'listing it twice would make a scope=all run target it twice')
  assert.equal([...created.values()][0].ops, 2, 'both writes are still counted')
})

test('an id that is not a UUID is refused before anything is touched', async () => {
  const cwd = scratch('cwd')
  const file = writeAt(cwd, 'a.md', 'x')
  const ctx = stubCtx({ cwd, events: [call('c1', 'write', { file_path: 'a.md' }), result('c1')] })

  await assert.rejects(
    () => runQuarantine(ctx, '../../etc/passwd', { scope: 'created' }),
    (error) => error && error.status === 400,
    'the guard lives in runQuarantine too, not only at the route',
  )
  assert.equal(fs.existsSync(file), true, 'nothing was moved')
})

test('a plan handed in for another session is refused, not acted on', async () => {
  const cwdA = scratch('cwd-a')
  const cwdB = scratch('cwd-b')
  const aOnly = writeAt(cwdA, 'a-only.txt', 'A')
  const bOnly = writeAt(cwdB, 'b-only.txt', 'B')
  const ctxA = stubCtx({ cwd: cwdA, events: [call('c1', 'write', { file_path: 'a-only.txt' }), result('c1')] })
  const ctxB = stubCtx({ cwd: cwdB, events: [call('c1', 'write', { file_path: 'b-only.txt' }), result('c1')] })

  const planA = await planArtifacts(ctxA, SESSION_ID)

  await assert.rejects(
    () => runQuarantine(ctxB, SESSION_B, { scope: 'created' }, planA),
    (error) => error && error.status === 400,
    'a plan carries its owner, so it cannot be replayed against a neighbour',
  )
  assert.equal(fs.existsSync(aOnly), true, "the other session's file was never moved")
  assert.equal(fs.existsSync(bOnly), true, 'and neither was this one')
})

// --- the configurable save path ---------------------------------------------
//
// A user-chosen quarantine root must never be a place where "quarantining" means
// shuffling the files back into the tree they came from, or into the store DSH
// sweeps during a delete.

test('an empty save path falls back to the DSH home', async () => {
  for (const value of [undefined, null, '']) {
    const { root, error } = await resolveQuarantineRoot(value, undefined)
    assert.equal(error, undefined)
    assert.equal(root, process.env.DSH_HOME)
  }
})

test('a relative save path is refused', async () => {
  const { root, error } = await resolveQuarantineRoot('some/where', undefined)
  assert.equal(root, undefined)
  assert.match(error, /绝对路径/)
})

test('a save path that does not exist is refused', async () => {
  const missing = path.join(scratch('parent'), 'not-here')
  const { root, error } = await resolveQuarantineRoot(missing, undefined)
  assert.equal(root, undefined)
  assert.match(error, /不存在/)
})

test('a save path that is a file is refused', async () => {
  const file = writeAt(scratch('parent'), 'a-file.txt')
  const { root, error } = await resolveQuarantineRoot(file, undefined)
  assert.equal(root, undefined)
  assert.match(error, /不是目录/)
})

test('a save path inside the sessions store is refused', async () => {
  const sessions = path.join(process.env.DSH_HOME, 'sessions')
  fs.mkdirSync(sessions, { recursive: true })
  const { root, error } = await resolveQuarantineRoot(sessions, undefined)
  assert.equal(root, undefined)
  assert.match(error, /会话存储目录/)

  const nested = path.join(sessions, 'deep')
  fs.mkdirSync(nested, { recursive: true })
  assert.match((await resolveQuarantineRoot(nested, undefined)).error, /会话存储目录/)
})

test('a save path inside the session working directory is refused', async () => {
  const cwd = scratch('cwd')
  const inside = path.join(cwd, 'nested')
  fs.mkdirSync(inside)
  assert.match((await resolveQuarantineRoot(cwd, cwd)).error, /工作目录/)
  assert.match((await resolveQuarantineRoot(inside, cwd)).error, /工作目录/)
})

test('a usable save path comes back resolved', async () => {
  const chosen = scratch('chosen')
  const { root, error } = await resolveQuarantineRoot(chosen, scratch('cwd'))
  assert.equal(error, undefined)
  assert.equal(root, fs.realpathSync(chosen))
})

test('the picker lists directories only, sorted, with a parent', async () => {
  const dir = scratch('browse')
  fs.mkdirSync(path.join(dir, 'zeta'))
  fs.mkdirSync(path.join(dir, 'alpha'))
  writeAt(dir, 'a-file.txt')

  const listing = await listDirectories(dir)
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['alpha', 'zeta'], 'folders only, alphabetical')
  assert.equal(listing.path, fs.realpathSync(dir))
  assert.equal(listing.parent, path.dirname(fs.realpathSync(dir)))
  assert.equal(listing.defaultRoot, process.env.DSH_HOME)
  assert.deepEqual(listing.roots, [], 'no drive list below a drive root')
})

test('the picker reports a drive root without a parent and offers the drives', async () => {
  const root = path.parse(process.cwd()).root
  const listing = await listDirectories(root)
  assert.equal(listing.parent, null)
  if (process.platform === 'win32') assert.ok(listing.roots.length > 0, 'the drives are offered at the root')
})

test('the picker refuses a missing directory instead of throwing raw', async () => {
  await assert.rejects(
    () => listDirectories(path.join(scratch('parent'), 'nope')),
    (error) => error && error.status === 400 && /不存在/.test(error.message),
  )
})

test('a chosen save path is actually used for the move', async () => {
  const cwd = scratch('cwd')
  const chosen = scratch('chosen')
  const file = writeAt(cwd, 'mine.md', 'x')
  const outcome = await quarantineFiles([file], cwd, chosen)

  assert.equal(outcome.failed.length, 0)
  assert.ok(outcome.directory.startsWith(fs.realpathSync(chosen)), 'the folder landed under the chosen path')
  assert.equal(fs.readFileSync(path.join(outcome.directory, 'mine.md'), 'utf8'), 'x')
  assert.equal(fs.existsSync(file), false)
})

// --- deletion is undoable ---------------------------------------------------
//
// The Recycle Bin itself is a Windows shell operation and cannot run in a unit
// test, so these cover the fallback that runs when it is unavailable. The point
// they pin down is the one that matters: nothing is unlinked, everything moves.

test('a retired path is moved aside, never destroyed', async () => {
  const source = path.join(scratch('retire'), 'session-abc')
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(source, 'nested', 'log.jsonl'), 'the transcript')

  const moved = await internals.moveToSessionTrash([source])

  assert.deepEqual(moved, [source], 'the path was handled')
  assert.equal(fs.existsSync(source), false, 'it left its original location')
  const trash = fs.readdirSync(HOME_ROOT).find((name) => name.startsWith('session-trash-'))
  assert.ok(trash, 'a trash directory was created under the DSH home')
  const restored = path.join(HOME_ROOT, trash, 'session-abc', 'nested', 'log.jsonl')
  assert.equal(fs.readFileSync(restored, 'utf8'), 'the transcript', 'the content survived intact')
})

test('retiring two paths with the same name keeps both copies', async () => {
  const first = path.join(scratch('dup-a'), 'session-same')
  const second = path.join(scratch('dup-b'), 'session-same')
  for (const dir of [first, second]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'marker.txt'), dir)
  }

  await internals.moveToSessionTrash([first])
  await internals.moveToSessionTrash([second])

  // Each retire stages into its own folder, so the copies are searched across all
  // of them rather than assumed to share one.
  const trashes = fs.readdirSync(HOME_ROOT).filter((name) => name.startsWith('session-trash-'))
  const markers = []
  for (const trash of trashes) {
    for (const name of fs.readdirSync(path.join(HOME_ROOT, trash))) {
      if (!name.startsWith('session-same')) continue
      markers.push(fs.readFileSync(path.join(HOME_ROOT, trash, name, 'marker.txt'), 'utf8'))
    }
  }
  assert.equal(markers.length, 2, 'the second retire did not overwrite the first')
  assert.deepEqual(markers.sort(), [first, second].sort(), 'each copy kept its own original')
})

// --- skipping files that live in a git working tree -------------------------

/** A tree with one git project and one plain folder beside it. */
function gitTree() {
  const root = scratch('git-tree')
  fs.mkdirSync(path.join(root, 'proj', '.git'), { recursive: true })
  fs.mkdirSync(path.join(root, 'proj', 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  const code = path.join(root, 'proj', 'src', 'app.js')
  const note = path.join(root, 'docs', 'note.md')
  fs.writeFileSync(code, 'source')
  fs.writeFileSync(note, 'prose')
  const rows = new Map([
    [code, { path: code, ops: ['write'] }],
    [note, { path: note, ops: ['write'] }],
  ])
  return { root, code, note, rows }
}

test('skipGit leaves a repository alone and still handles the plain folder', async () => {
  const tree = gitTree()
  const { allowed, refused } = await internals.classifyPaths(tree.rows, tree.root, HOME_ROOT, { skipGit: true })

  assert.deepEqual(allowed.map((row) => row.path), [fs.realpathSync(tree.note)], 'the prose file is still available')
  assert.equal(refused.length, 1)
  assert.equal(refused[0].path, tree.code)
  assert.match(refused[0].reason, /git/)
})

test('without skipGit the repository file is handled like any other', async () => {
  const tree = gitTree()
  const { allowed, refused } = await internals.classifyPaths(tree.rows, tree.root, HOME_ROOT, { skipGit: false })

  assert.equal(allowed.length, 2, 'both files are candidates')
  assert.equal(refused.length, 0)
})

test('a .git file (worktree or submodule) counts as a repository too', async () => {
  const root = scratch('git-file')
  fs.mkdirSync(path.join(root, 'wt'), { recursive: true })
  // A worktree points at its git dir with a file, not a directory.
  fs.writeFileSync(path.join(root, 'wt', '.git'), 'gitdir: C:/elsewhere')
  const file = path.join(root, 'wt', 'index.js')
  fs.writeFileSync(file, 'x')

  const rows = new Map([[file, { path: file, ops: ['write'] }]])
  const { allowed } = await internals.classifyPaths(rows, root, HOME_ROOT, { skipGit: true })
  assert.equal(allowed.length, 0, 'the worktree file is skipped')
})

// --- the system trash on macOS and Linux ------------------------------------

test('macOS deletes through Finder, one AppleScript statement per path', () => {
  const command = internals.trashCommandFor('darwin', ['/Users/x/session-a', '/Users/x/session-b'])

  assert.equal(command.program, 'osascript')
  assert.equal(command.args.length, 4, 'two -e flags, one statement each')
  assert.equal(command.args[0], '-e')
  assert.equal(command.args[2], '-e')
  assert.match(command.args[1], /^tell application "Finder" to delete \(POSIX file "/)
  assert.match(command.args[1], /session-a"\)$/)
})

test('the AppleScript literal escapes the path it is given', () => {
  // An unescaped quote would end the string early and turn the path into code.
  const command = internals.trashCommandFor('darwin', ['C:\\tmp\\a"b'])
  const script = command.args[1]

  assert.ok(script.includes('C:\\\\tmp'), 'backslashes are doubled for AppleScript')
  assert.ok(script.includes('\\"b'), 'double quotes are escaped')
  assert.ok(script.endsWith('")'), 'the statement still closes')
})

test('Linux delegates to gio trash with every path as one argument', () => {
  const command = internals.trashCommandFor('linux', ['/home/x/session-a', '/home/x/session-a.json'])

  assert.equal(command.program, 'gio')
  assert.deepEqual(command.args, ['trash', '/home/x/session-a', '/home/x/session-a.json'])
  assert.equal(command.args.slice(1).length, 2, 'no shell, so a path cannot become an option list')
})

test('no paths means nothing to ask the platform for', async () => {
  assert.equal(await internals.sendToRecycleBin([]), true, 'an empty retire still reports success')
})

test('warming the compiled helpers never throws before anything is cached', () => {
  // Fire-and-forget: a synchronous throw here would abort plugin loading.
  assert.doesNotThrow(() => internals.warmCompiledHelpers())
})

// --- permanent delete is an explicit choice, not the default ---------------

test('removeForever takes the path off the disk and stages nothing', () => {
  const dir = path.join(scratch('forever'), 'session-gone')
  fs.mkdirSync(path.join(dir, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'nested', 'log'), 'x')
  const before = fs.readdirSync(HOME_ROOT).filter((name) => name.startsWith('session-trash-')).length

  const gone = internals.removeForever([dir])

  assert.deepEqual(gone, [dir], 'the path is reported as removed')
  assert.equal(fs.existsSync(dir), false, 'it is no longer on disk')
  const after = fs.readdirSync(HOME_ROOT).filter((name) => name.startsWith('session-trash-')).length
  assert.equal(after, before, 'a permanent delete leaves no staging copy behind')
})

test('removeForever reports only what actually went away', () => {
  const missing = path.join(scratch('forever2'), 'never-existed')
  const gone = internals.removeForever([missing])
  assert.deepEqual(gone, [], 'a path that was never there is not claimed as deleted')
})

test('the switch decides between staging for the bin and removing outright', async () => {
  const root = scratch('switch')

  const kept = path.join(root, 'recycled', 'session-keep')
  fs.mkdirSync(kept, { recursive: true })
  fs.writeFileSync(path.join(kept, 'log'), 'x')
  const stagedBefore = fs.readdirSync(HOME_ROOT).filter((n) => n.startsWith('session-trash-')).length
  await internals.retireTargets([kept], true)
  assert.equal(fs.existsSync(kept), false, 'the path left its original location')
  const stagedAfter = fs.readdirSync(HOME_ROOT).filter((n) => n.startsWith('session-trash-')).length
  assert.equal(stagedAfter, stagedBefore + 1, 'recycling stages a copy the shell can pick up')

  const gone = path.join(root, 'removed', 'session-gone')
  fs.mkdirSync(gone, { recursive: true })
  fs.writeFileSync(path.join(gone, 'log'), 'x')
  const stagedBeforePermanent = fs.readdirSync(HOME_ROOT).filter((n) => n.startsWith('session-trash-')).length
  await internals.retireTargets([gone], false)
  assert.equal(fs.existsSync(gone), false, 'the path is gone')
  const stagedAfterPermanent = fs.readdirSync(HOME_ROOT).filter((n) => n.startsWith('session-trash-')).length
  assert.equal(stagedAfterPermanent, stagedBeforePermanent, 'a permanent delete stages nothing')
})
