// Regression tests for the multi-select checkbox, against a small DOM stub.
//
// The shipped defect (fixed in v0.1.8, "only plant multi-select checkboxes
// inside multi-select"): a plain single delete calls scheduleDecorate(), and
// decorateRows() planted a `.dsdel-check` on every session row *unconditionally*.
// So after deleting one session - or after any decorate pass at all - every row
// grew a round checkbox while the batch bar stayed hidden. The user was left in a
// half-on multi-select: rows looked selectable, clicking them did nothing the
// mode explained, and nothing cleared it because `selecting` was false.
//
// The invariant under test is the one the fix encodes:
//
//   a `.dsdel-check` exists  <=>  multi-select mode is active.
//
// The static checker cannot see this: it is a state machine over DOM mutations.
// Driving the real bundle is the only way to catch a re-introduction, so this
// file loads src/client.js and reaches the plugin only through the surfaces a
// user touches - the injected session-menu items and the DOM it builds. No
// browser, no React, no DSH server, no tokens.
//
//   node --test "test/*.test.js"
import assert from 'node:assert/strict'
import { test } from 'node:test'

// --- a DOM small enough to read, complete enough to run the plugin ----------

class StubElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentElement = null
    this.style = {}
    this.attributes = {}
    this.listeners = new Map()
    this._classes = new Set()
    // `dataset.x` and `data-x` are the same thing in the DOM, and the plugin
    // relies on that: it marks its own <style> through dataset and looks it up
    // later with an attribute selector. Two detached objects would hide it.
    this.dataset = new Proxy(
      {},
      {
        set: (target, key, value) => {
          target[key] = value
          this.attributes[`data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`] = String(value)
          return true
        },
      },
    )
    this.type = ''
    this.disabled = false
    this.checked = false
    this._text = ''
    this.innerHTML = ''
  }

  get classList() {
    const set = this._classes
    return {
      add: (...names) => names.forEach((name) => set.add(name)),
      remove: (...names) => names.forEach((name) => set.delete(name)),
      // `toggle(name, force)` is how the checkbox reflects selection; a stub that
      // ignored the force argument would hide exactly the bug under test.
      toggle: (name, force) => {
        const on = force === undefined ? !set.has(name) : Boolean(force)
        if (on) set.add(name)
        else set.delete(name)
        return on
      },
      contains: (name) => set.has(name),
    }
  }

  get className() {
    return [...this._classes].join(' ')
  }

  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean))
  }

  get firstChild() {
    return this.children[0] ?? null
  }

  get firstElementChild() {
    return this.children[0] ?? null
  }

  get textContent() {
    return this._text
  }

  set textContent(value) {
    this._text = String(value)
    this.children = []
  }

  appendChild(child) {
    child.parentElement = this
    this.children.push(child)
    return child
  }

  insertBefore(child, reference) {
    child.parentElement = this
    const index = reference === null || reference === undefined ? this.children.length : this.children.indexOf(reference)
    if (index === -1) this.children.push(child)
    else this.children.splice(index, 0, child)
    return child
  }

  remove() {
    if (this.parentElement === null) return
    const index = this.parentElement.children.indexOf(this)
    if (index !== -1) this.parentElement.children.splice(index, 1)
    this.parentElement = null
  }

  /** Detached shallow clone; the plugin clones a native menu row with `false`. */
  cloneNode() {
    const copy = new StubElement(this.tagName)
    copy.className = this.className
    for (const [name, value] of Object.entries(this.attributes)) copy.attributes[name] = value
    return copy
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
  }

  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }

  removeEventListener() {}

  /** Dispatch the listeners registered for `type`. */
  fire(type, extra) {
    const event = {
      type,
      target: this,
      preventDefault() {},
      stopPropagation() {},
      ...(extra ?? {}),
    }
    for (const handler of this.listeners.get(type) ?? []) handler(event)
    return event
  }

  querySelector(selector) {
    return walk(this).filter((node) => matches(node, selector))[0] ?? null
  }

  querySelectorAll(selector) {
    return walk(this).filter((node) => matches(node, selector))
  }

  closest(selector) {
    let node = this
    while (node !== null && node !== undefined) {
      if (matches(node, selector)) return node
      node = node.parentElement
    }
    return null
  }
}

/** Pre-order traversal: document order, so `[0]` is the first in the tree. */
function walk(root) {
  const out = []
  const visit = (node) => {
    for (const child of node.children) {
      out.push(child)
      visit(child)
    }
  }
  visit(root)
  return out
}

function matches(node, selector) {
  // `:scope > .dsdel-check` - a DIRECT child. The plugin uses this to tell its
  // own row checkbox apart from anything nested, so depth has to be respected.
  const scoped = /^:scope > \.([\w-]+)$/.exec(selector)
  if (scoped !== null) return node._classes.has(scoped[1])

  // `.dsdel-bar-btn:not(.dsdel-bar-danger)` - how the bar finds its Cancel.
  const negated = /^\.([\w-]+):not\(\.([\w-]+)\)$/.exec(selector)
  if (negated !== null) return node._classes.has(negated[1]) && !node._classes.has(negated[2])

  if (selector.startsWith('.') && !selector.includes(':') && !selector.includes('[')) {
    return node._classes.has(selector.slice(1))
  }

  const attrEquals = /^\[([\w-]+)="([^"]*)"\]$/.exec(selector)
  if (attrEquals !== null) return node.attributes[attrEquals[1]] === attrEquals[2]

  const attrOnly = /^\[([\w-]+)\]$/.exec(selector)
  if (attrOnly !== null) return attrOnly[1] in node.attributes

  return false
}

// --- harness ----------------------------------------------------------------

const SESSION_A = { id: 'session-aaaa1111-2222-4333-8444-555555555555', title: 'first session' }
const SESSION_B = { id: 'session-bbbb1111-2222-4333-8444-555555555555', title: 'second session' }

let bundleFactory = null

/**
 * The bundle registers through `window.__ModuleLoader__` once per process and ESM
 * caching means a second `import()` never re-runs it. Caching the factory is also
 * what gives each test its own instance: calling it builds fresh closures over
 * whatever stubs are installed now.
 */
async function loadPlugin() {
  const requests = []
  const rows = []
  const observers = []

  // Document-level listeners matter: multi-select installs a CAPTURE-phase click
  // handler on `document` to turn a row click into a toggle. A stub that dropped
  // it would make the mode look inert and the toggle untestable.
  const documentListeners = new Map()
  const document = {
    body: new StubElement('body'),
    head: new StubElement('head'),
    createElement: (tag) => new StubElement(tag),
    addEventListener(type, handler) {
      const list = documentListeners.get(type) ?? []
      list.push(handler)
      documentListeners.set(type, list)
    },
    removeEventListener(type, handler) {
      const list = documentListeners.get(type)
      if (list === undefined) return
      const index = list.indexOf(handler)
      if (index !== -1) list.splice(index, 1)
    },
    dispatchEvent() {},
    /** Fire the document-level listeners, as a real bubbling click would. */
    dispatchToDocument(type, event) {
      for (const handler of [...(documentListeners.get(type) ?? [])]) handler(event)
    },
    querySelector: (selector) => document.querySelectorAll(selector)[0] ?? null,
    querySelectorAll(selector) {
      if (selector === 'body > [role="menu"]') {
        return document.body.children.filter((node) => node.getAttribute('role') === 'menu')
      }
      if (selector === '[role="treeitem"]') {
        return walk(document.body).filter((node) => node.getAttribute('role') === 'treeitem')
      }
      if (selector === 'style[data-dsh-delete-session]') {
        return walk(document.head).filter((node) => 'data-dsh-delete-session' in node.attributes)
      }
      // Everything else is a class sweep (`.dsdel-check`, `.dsdel-row-pending`).
      return walk(document.body).filter((node) => matches(node, selector))
    },
  }

  globalThis.document = document
  globalThis.window = {
    __ModuleLoader__: { load: ({ factory }) => { bundleFactory = factory } },
    location: { reload() {} },
    dispatchEvent() {},
    Event: class { constructor(type) { this.type = type } },
  }
  globalThis.localStorage = makeStorage()
  // Node exposes `navigator` as a getter-only global, so it needs defining rather
  // than assigning. The plugin reads it only to pick zh vs en.
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'zh-CN', languages: ['zh-CN'] },
    configurable: true,
    writable: true,
  })
  globalThis.MutationObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this) }
    observe() {}
    disconnect() {}
  }
  // The plugin coalesces decorate passes through rAF. Run the callback on a real
  // microtask-free tick rather than synchronously: `scheduleDecorate` assigns the
  // return value to `decorateRaf` AFTER calling requestAnimationFrame, so a
  // synchronous stub would leave `decorateRaf` permanently truthy and silently
  // swallow every later pass. That is a harness artefact, and it would hide the
  // very regression this file exists to catch.
  let rafId = 0
  const rafQueue = new Map()
  globalThis.requestAnimationFrame = (fn) => {
    const id = ++rafId
    rafQueue.set(id, fn)
    queueMicrotask(() => {
      if (!rafQueue.has(id)) return
      rafQueue.delete(id)
      fn()
    })
    return id
  }
  globalThis.cancelAnimationFrame = (id) => { rafQueue.delete(id) }
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init })
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }

  if (bundleFactory === null) await import(new URL('../src/client.js', import.meta.url).href)
  const plugin = bundleFactory()
  plugin.apply({
    get: () => null,
    inject: () => {},
    effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
  })

  return { document, requests, rows, observers }
}

function makeStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
    clear: () => map.clear(),
  }
}

/**
 * Attach a row with a React fiber chain carrying `node.id`, exactly the contract
 * `sessionIdFromRow` walks. Without this the plugin finds no id and skips the row,
 * which would make every assertion below pass vacuously.
 */
function mountRow(harness, session = SESSION_A) {
  const row = harness.document.createElement('div')
  row.className = 'session_row'
  row.setAttribute('role', 'treeitem')
  row.__reactFiber$test = { memoizedProps: { node: { id: session.id, title: session.title } }, return: null }
  harness.document.body.appendChild(row)
  harness.rows.push(row)
  return row
}

/**
 * Open a session menu the way the host portals one: `body > [role="menu"]`, whose
 * fiber chain reaches a component holding `node.id`. Returns the injected items.
 */
function openSessionMenu(harness, session = SESSION_A) {
  const menu = harness.document.createElement('div')
  menu.setAttribute('role', 'menu')
  menu.__reactFiber$test = { memoizedProps: { node: { id: session.id, title: session.title } }, return: null }
  const viewport = harness.document.createElement('div')
  viewport.setAttribute('role', 'presentation')
  const native = harness.document.createElement('button')
  native.className = 'menu_item'
  native.setAttribute('role', 'menuitem')
  viewport.appendChild(native)
  menu.appendChild(viewport)
  harness.document.body.appendChild(menu)

  // The plugin installed a MutationObserver to scan for portalled menus; firing
  // it is how the real host would tell the plugin the menu exists.
  for (const observer of harness.observers) observer.callback()
  return {
    menu,
    selectItem: viewport.querySelector('[data-dsh-delete-session="select"]'),
    deleteItem: viewport.querySelector('[data-dsh-delete-session="1"]'),
  }
}

/**
 * Fire the observers the plugin installed. Useful only *inside* multi-select,
 * where enterSelection() registered one whose callback runs decorateRows. Outside
 * the mode the sole observer scans for menus and decorates nothing, so an outside
 * pass has to go through a delete path instead (see decorateViaSingleDelete).
 */
function observerPass(harness) {
  for (const observer of harness.observers) observer.callback()
}
const rowCheckboxes = (harness) =>
  harness.rows.map((row) => row.querySelectorAll(':scope > .dsdel-check').length)

const totalCheckboxes = (harness) => harness.document.querySelectorAll('.dsdel-check').length

const selectedCheckboxes = (harness) =>
  harness.document.querySelectorAll('.dsdel-check').filter((el) => el.classList.contains('dsdel-check-on')).length

const bar = (harness) =>
  walk(harness.document.body).find((node) => node._classes.has('dsdel-bar')) ?? null

/** The consent dialog the plugin appended to the body, if it is open. */
const dialog = (harness) =>
  walk(harness.document.body).find((node) => node._classes.has('dsdel-dialog')) ?? null

const dialogParts = (harness) => {
  const box = dialog(harness)
  if (box === null) return null
  const nodes = walk(box)
  const checkboxes = nodes.filter((node) => node.tagName === 'INPUT' && node.type === 'checkbox')
  const buttons = nodes.filter((node) => node._classes.has('dsdel-btn'))
  return {
    box,
    consent: checkboxes[0] ?? null,
    skip: checkboxes[1] ?? null,
    cancel: buttons.find((b) => !b._classes.has('dsdel-danger')) ?? null,
    confirm: buttons.find((b) => b._classes.has('dsdel-danger')) ?? null,
    title: nodes.find((node) => node._classes.has('dsdel-title'))?.textContent ?? null,
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Let the queued rAF decorate passes drain. */
const flush = async () => { await tick() }

/**
 * Run one decorate pass outside multi-select, through the real user route.
 *
 * `decorateRows()` is a private closure and is deliberately not reachable from a
 * test. Outside the mode no observer decorates either, so the only passes are the
 * plugin's own internal calls from the delete paths. This drives the consent
 * dialog, whose confirm handler is the exact call site the bug shipped from.
 */
async function decorateViaSingleDelete(harness, session = SESSION_A) {
  const { deleteItem } = openSessionMenu(harness, session)
  assert.ok(deleteItem, 'the Delete item was injected into the session menu')
  deleteItem.fire('click')
  const parts = dialogParts(harness)
  assert.ok(parts, 'the consent dialog opened')
  parts.consent.checked = true
  parts.consent.fire('change')
  parts.confirm.fire('click')
  await tick()
}

// --- the regression ---------------------------------------------------------

test('a single delete plants no checkbox on any row (the v0.1.8 regression)', async () => {
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)
  mountRow(harness, SESSION_B)

  // Deleting one session runs the plugin's own decorate pass with `selecting`
  // false. Pre-fix, decorateRows() inserted a `.dsdel-check` into every row here
  // and left the batch bar hidden - the half-on multi-select the user reported.
  await decorateViaSingleDelete(harness, SESSION_A)

  assert.equal(totalCheckboxes(harness), 0, 'no checkbox may exist while multi-select is off')
  assert.deepEqual(rowCheckboxes(harness), [0, 0], 'no row carries a stray checkbox')
  assert.equal(bar(harness), null, 'and no batch bar was built')
})

test('deleting one session through the dialog leaves no half-on multi-select', async () => {
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)
  const otherRow = mountRow(harness, SESSION_B)

  const { deleteItem } = openSessionMenu(harness, SESSION_A)
  assert.ok(deleteItem, 'the Delete item was injected into the session menu')

  deleteItem.fire('click')
  const parts = dialogParts(harness)
  assert.ok(parts, 'the consent dialog opened')
  assert.equal(parts.confirm.disabled, true, 'confirm starts locked')

  parts.consent.checked = true
  parts.consent.fire('change')
  assert.equal(parts.confirm.disabled, false, 'consent unlocks confirm')

  parts.confirm.fire('click')
  await tick()

  // This is the assertion the old build failed: the confirm handler added the id
  // to pendingRemoval and called scheduleDecorate(), and that pass grew a
  // checkbox on EVERY row while the batch bar stayed hidden.
  assert.equal(totalCheckboxes(harness), 0, 'a single delete never grows checkboxes')
  assert.deepEqual(rowCheckboxes(harness), [0, 0])
  assert.equal(bar(harness), null, 'the batch bar is never built outside the mode')
  assert.equal(
    otherRow.classList.contains('dsdel-row-pending'),
    false,
    'the untouched row is not optimistically hidden',
  )
  assert.equal(
    harness.requests.filter((call) => call.url === '/dsh-delete-session/delete').length,
    1,
    'exactly one delete request went out',
  )
})

// --- the healthy path must still work (the fix is not "never show a checkbox") ---

test('multi-select still plants exactly one checkbox per selectable row', async () => {
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)
  mountRow(harness, SESSION_B)

  const { selectItem } = openSessionMenu(harness, SESSION_A)
  assert.ok(selectItem, 'the multi-select item was injected')
  selectItem.fire('click')
  await flush()

  assert.deepEqual(rowCheckboxes(harness), [1, 1], 'one checkbox per row, and only one')
  assert.equal(totalCheckboxes(harness), 2)
  assert.ok(bar(harness), 'the batch bar exists in selection mode')
  assert.equal(selectedCheckboxes(harness), 0, 'nothing is selected yet')
})

test('a later decorate pass reuses the checkbox instead of stacking another', async () => {
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)
  mountRow(harness, SESSION_B)

  openSessionMenu(harness, SESSION_A).selectItem.fire('click')
  await flush()
  const before = harness.rows.map((row) => row.querySelectorAll(':scope > .dsdel-check')[0])

  // In selection mode the observer installed by enterSelection() calls
  // scheduleDecorate; firing it is how a host re-render reaches decorateRows.
  // An implementation that inserted unconditionally would leave two per row.
  observerPass(harness)
  observerPass(harness)
  await flush()

  const after = harness.rows.map((row) => row.querySelectorAll(':scope > .dsdel-check')[0])
  assert.deepEqual(rowCheckboxes(harness), [1, 1], 'still exactly one per row')
  assert.deepEqual(after, before, 'the same element is reused, never rebuilt')
})

test('clicking a row toggles its checkbox on and off', async () => {
  const harness = await loadPlugin()
  const first = mountRow(harness, SESSION_A)
  mountRow(harness, SESSION_B)

  openSessionMenu(harness, SESSION_A).selectItem.fire('click')
  await flush()

  // The capture handler resolves the row from `e.target.closest('[role=treeitem]')`,
  // exactly as a click on the row's inner markup would.
  const clickRow = () => harness.document.dispatchToDocument('click', {
    target: first,
    preventDefault() {},
    stopPropagation() {},
  })

  clickRow()
  await flush()
  assert.equal(selectedCheckboxes(harness), 1, 'the first row reads as selected')

  clickRow()
  await flush()
  assert.equal(selectedCheckboxes(harness), 0, 'clicking it again deselects it')
})

test('leaving multi-select strips every checkbox', async () => {
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)
  mountRow(harness, SESSION_B)

  openSessionMenu(harness, SESSION_A).selectItem.fire('click')
  await flush()
  const control = bar(harness)
  assert.ok(control, 'the bar exists')
  assert.equal(totalCheckboxes(harness), 2)

  // Cancel is the bar's non-danger button.
  const cancel = control.querySelector('.dsdel-bar-btn:not(.dsdel-bar-danger)')
  cancel.fire('click', { stopPropagation() {} })
  await flush()

  assert.equal(totalCheckboxes(harness), 0, 'no checkbox survives the mode')
  assert.deepEqual(rowCheckboxes(harness), [0, 0])
  assert.notEqual(control.style.display, 'flex', 'the bar is hidden again')
})

// --- the two modes must not leak into each other ----------------------------

test('entering, leaving, then deleting plants nothing', async () => {
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)
  mountRow(harness, SESSION_B)

  openSessionMenu(harness, SESSION_A).selectItem.fire('click')
  await flush()
  const control = bar(harness)
  control.querySelector('.dsdel-bar-btn:not(.dsdel-bar-danger)').fire('click', { stopPropagation() {} })
  await flush()

  // Leaving the mode removed the observer that decorates; a later delete must
  // not bring the mode - or its checkboxes - back.
  await decorateViaSingleDelete(harness, SESSION_A)

  assert.equal(totalCheckboxes(harness), 0, 'the mode leaves no residue behind')
  assert.notEqual(control.style.display, 'flex', 'the bar stays hidden')
})

test('a row whose fiber changes still gets no checkbox outside the mode', async () => {
  const harness = await loadPlugin()
  const row = mountRow(harness, SESSION_A)

  await decorateViaSingleDelete(harness, SESSION_A)
  assert.equal(row.querySelectorAll(':scope > .dsdel-check').length, 0)

  // The host re-rendered and swapped the fiber; the next pass must still not plant.
  row.__reactFiber$test = { memoizedProps: { node: { id: SESSION_B.id, title: SESSION_B.title } }, return: null }
  await decorateViaSingleDelete(harness, SESSION_B)
  assert.equal(totalCheckboxes(harness), 0, 'a changed fiber does not revive the bug')
})

test('a row without a session id is skipped in both modes', async () => {
  const harness = await loadPlugin()
  const orphan = harness.document.createElement('div')
  orphan.className = 'session_row'
  orphan.setAttribute('role', 'treeitem')
  harness.document.body.appendChild(orphan)
  harness.rows.push(orphan)

  await decorateViaSingleDelete(harness, SESSION_A)
  openSessionMenu(harness, SESSION_A).selectItem.fire('click')
  await flush()

  assert.equal(orphan.querySelectorAll(':scope > .dsdel-check').length, 0, 'no id, no checkbox')
})

test('residue left by an older build is swept away by the next pass', async () => {
  const harness = await loadPlugin()
  const row = mountRow(harness, SESSION_A)
  // Simulate what the pre-fix build left behind: a checkbox while the mode is off.
  const stray = harness.document.createElement('span')
  stray.className = 'dsdel-check'
  stray.setAttribute('data-dsh-delete-session', 'check')
  row.insertBefore(stray, row.firstChild)
  assert.equal(totalCheckboxes(harness), 1)

  await decorateViaSingleDelete(harness, SESSION_A)

  assert.equal(totalCheckboxes(harness), 0, 'the sweep clears it')
  assert.equal(row.querySelectorAll(':scope > .dsdel-check').length, 0)
})
