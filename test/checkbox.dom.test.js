// Regression tests for the multi-select checkbox, plus the integration contract
// that the slot migration introduced.
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
// user touches - the slots it registers into, the menu rows and dialog those
// components render, and the DOM it builds. No browser, no DSH server, no tokens.
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

  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
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

const NS = 'dsh-delete-session'
const SKIP_KEY = 'dsh-delete-session:skip-confirm'
const MENU_SLOT = 'sidebar.workspaces.session.menu.item'

const SESSION_A = { id: 'session-aaaa1111-2222-4333-8444-555555555555', title: 'first session' }
const SESSION_B = { id: 'session-bbbb1111-2222-4333-8444-555555555555', title: 'second session' }

let bundleFactory = null

/**
 * The bundle registers through `window.__ModuleLoader__` once per process and ESM
 * caching means a second `import()` never re-runs it. Caching the factory is also
 * what gives each test its own instance: calling it builds fresh closures over
 * whatever stubs are installed now.
 */
async function loadPlugin(options = {}) {
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

  // Every React surface is now a slot occupant: two session-menu rows, the
  // confirmation dialog in shell.overlay, and the plugin page card. Capture each
  // registration so a test can render it the way the host would.
  const slotRegistrations = []
  const slotsStub = {
    inject: (name, fn) => { fn() },
    register: (spec, Component) => { slotRegistrations.push({ spec, Component }); return () => {} },
  }

  // The plugin registers its locale namespace; capturing it gives the tests the
  // real strings and proves the registration happened.
  const locales = {}
  const localeStub = {
    register: (namespace, dictionaries) => { locales[namespace] = dictionaries },
    translate: (namespace, key) => {
      const value = locales[namespace]?.zh?.[key]
      return typeof value === 'function' ? value() : value ?? key
    },
  }

  // `useSyncExternalStore` is modelled as "render once, re-read on the next call",
  // which is exactly how these tests drive a component: call it again after an
  // action and assert on the tree it returns.
  const reactStub = {
    Fragment: Symbol.for('react.fragment'),
    useState: (initial) => [initial, () => {}],
    useEffect: (effect) => effect(),
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
    // React semantics: positional children win, but with none a `children` given
    // inside the props object is kept as-is (the plugin passes the Modal's
    // children that way, so a stub that overwrote it would hide the whole dialog).
    createElement: (type, props, ...children) => ({
      type,
      props: children.length === 0
        ? { ...(props || {}) }
        : { ...(props || {}), children: children.length === 1 ? children[0] : children },
    }),
  }
  const primitivesStub = {
    Button: (props) => ({ type: 'Button', props }),
    Checkbox: (props) => ({ type: 'Checkbox', props }),
    MenuItemButton: (props) => ({ type: 'MenuItemButton', props }),
    Modal: (props) => ({ type: 'Modal', props }),
  }
  const requireStub = (id) => {
    if (id === 'react') return reactStub
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
    throw new Error('unexpected client require: ' + id)
  }

  if (bundleFactory === null) await import(new URL('../src/client.js', import.meta.url).href)
  const plugin = bundleFactory(requireStub)
  plugin.apply({
    get: (name) => {
      if (name === 'slots') return slotsStub
      // `lateLocale` models a host where the locale service is only reachable
      // through ctx.inject, which is the path that used to skip registration.
      if (name === 'locale') return options.lateLocale ? null : localeStub
      return null
    },
    inject: (names, cb) => {
      if (typeof cb === 'function') cb(options.lateLocale ? { slots: slotsStub, locale: localeStub } : { slots: slotsStub })
    },
    effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
  })

  const t = (key, a, b) => {
    const value = locales[NS]?.zh?.[key]
    return typeof value === 'function' ? value(a, b) : value ?? key
  }

  return { document, requests, rows, observers, slotRegistrations, locales, primitives: primitivesStub, t }
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
 * Attach a row carrying the host's own drag-and-drop key. Row identity now comes
 * from `data-row-key`, not from a React fiber; without this the plugin finds no
 * id and skips the row, which would make every assertion below pass vacuously.
 */
function mountRow(harness, session = SESSION_A) {
  const row = harness.document.createElement('div')
  row.className = 'session_row'
  row.setAttribute('role', 'treeitem')
  row.setAttribute('data-row-key', `session:${session.id}`)
  harness.document.body.appendChild(row)
  harness.rows.push(row)
  return row
}

// --- driving the registered slots -------------------------------------------

const menuEntry = (harness, id) =>
  harness.slotRegistrations.find((entry) => entry.spec.name === MENU_SLOT && entry.spec.id === id) ?? null

const overlayEntry = (harness) =>
  harness.slotRegistrations.find((entry) => entry.spec.name === 'shell.overlay') ?? null

/** Render the "Delete session" row the way the host renders a menu entry. */
function deleteRow(harness, session = SESSION_A) {
  const entry = menuEntry(harness, NS)
  assert.ok(entry, 'the delete row is registered in the session menu slot')
  const menuOpen = []
  const element = entry.Component({
    sessionId: session.id,
    displayTitle: session.title,
    useMenuOpenState: () => [false, (value) => menuOpen.push(value)],
    t: harness.t,
  })
  return { element, menuOpen }
}

/** Render the "Select multiple" row. */
function selectRow(harness) {
  const entry = menuEntry(harness, `${NS}-multi`)
  assert.ok(entry, 'the multi-select row is registered in the session menu slot')
  const menuOpen = []
  const element = entry.Component({
    useMenuOpenState: () => [false, (value) => menuOpen.push(value)],
    t: harness.t,
  })
  return { element, menuOpen }
}

/** The element tree the dialog slot occupant renders, or null while closed. */
function dialogElement(harness) {
  const entry = overlayEntry(harness)
  assert.ok(entry, 'the dialog is registered in the shell.overlay slot')
  return entry.Component({ t: harness.t })
}

/** Pull the pieces out of the rendered Modal element tree. */
function dialogParts(harness) {
  const modal = dialogElement(harness)
  if (modal === null || modal === undefined) return null
  const kids = (modal.props.children ?? []).filter(Boolean)
  const buttons = (modal.props.footer?.props?.children ?? []).filter(Boolean)
  const byKey = (key) => kids.find((node) => node.props.key === key) ?? null
  const skipLabel = byKey('skip')
  return {
    modal,
    type: modal.type,
    title: modal.props.title,
    open: modal.props.open,
    desc: byKey('desc')?.props.children ?? null,
    skip: skipLabel === null ? null : skipLabel.props.children[0],
    error: byKey('error'),
    cancel: buttons[0],
    confirm: buttons[1],
  }
}

const rowCheckboxes = (harness) =>
  harness.rows.map((row) => row.querySelectorAll(':scope > .dsdel-check').length)

const totalCheckboxes = (harness) => harness.document.querySelectorAll('.dsdel-check').length

const selectedCheckboxes = (harness) =>
  harness.document.querySelectorAll('.dsdel-check').filter((el) => el.classList.contains('dsdel-check-on')).length

const bar = (harness) =>
  walk(harness.document.body).find((node) => node._classes.has('dsdel-bar')) ?? null

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Let the queued rAF decorate passes drain. */
const flush = async () => { await tick() }

/**
 * Fire the observers multi-select installed. Outside the mode the plugin installs
 * none at all now that the menu is a slot rather than a portalled DOM node, so an
 * outside pass has to go through a delete path instead (see decorateViaSingleDelete).
 */
function observerPass(harness) {
  for (const observer of harness.observers) observer.callback()
}

/**
 * Run one decorate pass outside multi-select, through the real user route.
 *
 * `decorateRows()` is a private closure and is deliberately not reachable from a
 * test. Outside the mode no observer decorates either, so the only passes are the
 * plugin's own internal calls from the delete paths. This drives the delete row
 * and the dialog it opens, whose confirm handler is the exact call site the bug
 * shipped from.
 */
async function decorateViaSingleDelete(harness, session = SESSION_A) {
  const { element } = deleteRow(harness, session)
  element.props.onSelect({ shiftKey: false })
  const parts = dialogParts(harness)
  assert.ok(parts, 'the delete dialog opened')
  parts.confirm.props.onClick()
  await tick()
}

// --- the integration contract the slot migration introduced -----------------

test('the two menu rows register into the official session-menu slot', async () => {
  const harness = await loadPlugin()
  const del = menuEntry(harness, NS)
  const multi = menuEntry(harness, `${NS}-multi`)

  assert.ok(del, 'a delete row is registered')
  assert.ok(multi, 'a multi-select row is registered')
  // A package-namespaced id keeps the rows beside the shipped
  // pin(100)/rename(200)/fork(300)/archive(400)/session-id(450).
  assert.equal(del.spec.id, 'dsh-delete-session')
  assert.equal(multi.spec.id, 'dsh-delete-session-multi')
  assert.equal(del.spec.order, 410, 'the delete row sits directly under archive (400)')
  assert.equal(multi.spec.order, 409, 'the multi-select row sits above the delete row')
  assert.equal(del.spec.locale, NS, 'labels come from the package locale namespace')
})

test('the dialog registers into shell.overlay and renders the host Modal', async () => {
  const harness = await loadPlugin()
  const entry = overlayEntry(harness)
  assert.ok(entry, 'a shell.overlay entry is registered')
  assert.equal(entry.spec.id, 'dsh-delete-session-dialog')

  assert.equal(dialogElement(harness), null, 'nothing renders while no delete is pending')

  const { element } = deleteRow(harness)
  element.props.onSelect({ shiftKey: false })
  const parts = dialogParts(harness)
  assert.ok(parts, 'the dialog renders once a delete is requested')
  assert.equal(parts.type, harness.primitives.Modal, 'it is the host Modal primitive, not a hand-built backdrop')
  assert.equal(parts.open, true)
  assert.equal(parts.title, '删除会话')
  assert.equal(parts.cancel.type, harness.primitives.Button)
  assert.equal(parts.confirm.type, harness.primitives.Button)
})

test('the menu rows dismiss the menu through the injected hook', async () => {
  const harness = await loadPlugin()
  const del = deleteRow(harness)
  del.element.props.onSelect({ shiftKey: false })
  assert.deepEqual(del.menuOpen, [false], 'the delete row closes the menu after acting')

  const multi = selectRow(harness)
  multi.element.props.onSelect()
  assert.deepEqual(multi.menuOpen, [false], 'the multi-select row closes the menu after acting')
})

test('the plugin no longer scans the DOM for a portalled menu', async () => {
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)
  // The old build installed a MutationObserver on body at apply() time to hunt
  // for `body > [role="menu"]`. The only observer left is the one multi-select
  // installs for row decoration.
  assert.equal(harness.observers.length, 0, 'no observer is installed before multi-select starts')
})

test('the locale namespace is registered even when the locale service arrives late', async () => {
  const harness = await loadPlugin({ lateLocale: true })
  assert.ok(harness.locales[NS], 'the namespace was registered through the inject path')
  assert.equal(harness.locales[NS].zh.multiSelect, '多选')
  assert.equal(harness.locales[NS].zh.menu, '删除会话')

  // The rows must render real labels, not raw keys, on that path too.
  assert.equal(deleteRow(harness).element.props.children, '删除会话')
  assert.equal(selectRow(harness).element.props.children, '多选')
})

test('the delete row asks the host for its danger styling', async () => {
  const harness = await loadPlugin()
  const { element } = deleteRow(harness)
  // ui-primitives' MenuItemButton takes a real `danger` parameter; colouring the
  // label by hand would leave the icon unstyled, which is the regression this
  // guards.
  assert.equal(element.props.danger, true, 'the row uses the host danger tone')
  assert.equal(element.type, harness.primitives.MenuItemButton, 'the row renders through the host primitive')
  // The migration must not change how the menu looks, so no separator is added.
  // This guards against re-introducing the separator on a later pass.
  assert.equal(selectRow(harness).element.props.separatorBefore, undefined, 'no separator is injected')
})

test('the delete row reads its session id from the host props, not from a fiber', async () => {
  const harness = await loadPlugin()
  const row = mountRow(harness, SESSION_A)
  // Give the row a fiber-shaped property and NO data-row-key: the plugin must
  // ignore React internals entirely now.
  row.__reactFiber$test = { memoizedProps: { node: { id: SESSION_A.id } }, return: null }

  assert.equal(totalCheckboxes(harness), 0)

  const { element } = deleteRow(harness, SESSION_A)
  await flush()
  element.props.onSelect({ shiftKey: false })
  const parts = dialogParts(harness)
  assert.ok(parts, 'the dialog opened for the id the host injected')
  assert.equal(harness.requests.length, 0, 'opening the dialog sends nothing yet')
})

test('shift-click forces the dialog even after asking was turned off', async () => {
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)
  localStorage.setItem(SKIP_KEY, '1')

  // Plain select honours the opt-out and deletes straight away.
  const plain = deleteRow(harness)
  plain.element.props.onSelect({ shiftKey: false })
  await tick()
  assert.equal(dialogElement(harness), null, 'no dialog when asking is off')
  assert.equal(harness.requests.length, 1, 'the delete went out immediately')

  // Shift-click always asks.
  const forced = deleteRow(harness)
  forced.element.props.onSelect({ shiftKey: true })
  assert.ok(dialogParts(harness), 'shift-click brings the dialog back')
  assert.equal(harness.requests.length, 1, 'and still sends nothing until confirmed')
})

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

  const { element } = deleteRow(harness, SESSION_A)
  element.props.onSelect({ shiftKey: false })
  const parts = dialogParts(harness)
  assert.ok(parts, 'the delete dialog opened')
  assert.equal(parts.confirm.props.disabled, false, 'confirm is ready without an ack')

  parts.confirm.props.onClick()
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

  selectRow(harness).element.props.onSelect()
  await flush()

  assert.deepEqual(rowCheckboxes(harness), [1, 1], 'one checkbox per row, and only one')
  assert.equal(totalCheckboxes(harness), 2)
  assert.ok(bar(harness), 'the batch bar exists in selection mode')
  assert.equal(selectedCheckboxes(harness), 0, 'nothing is selected yet')
  assert.equal(harness.observers.length, 1, 'multi-select installs exactly one row observer')
})

test('a later decorate pass reuses the checkbox instead of stacking another', async () => {
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)
  mountRow(harness, SESSION_B)

  selectRow(harness).element.props.onSelect()
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

  selectRow(harness).element.props.onSelect()
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

  selectRow(harness).element.props.onSelect()
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

  selectRow(harness).element.props.onSelect()
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

test('a row whose row key changes still gets no checkbox outside the mode', async () => {
  const harness = await loadPlugin()
  const row = mountRow(harness, SESSION_A)

  await decorateViaSingleDelete(harness, SESSION_A)
  assert.equal(row.querySelectorAll(':scope > .dsdel-check').length, 0)

  // The host re-rendered and repointed the row; the next pass must still not plant.
  row.setAttribute('data-row-key', `session:${SESSION_B.id}`)
  await decorateViaSingleDelete(harness, SESSION_B)
  assert.equal(totalCheckboxes(harness), 0, 'a changed row key does not revive the bug')
})

test('a row without a session id is skipped in both modes', async () => {
  const harness = await loadPlugin()
  const orphan = harness.document.createElement('div')
  orphan.className = 'session_row'
  orphan.setAttribute('role', 'treeitem')
  harness.document.body.appendChild(orphan)
  harness.rows.push(orphan)

  await decorateViaSingleDelete(harness, SESSION_A)
  selectRow(harness).element.props.onSelect()
  await flush()

  assert.equal(orphan.querySelectorAll(':scope > .dsdel-check').length, 0, 'no id, no checkbox')
})

test('multi-select ignores React internals: a fiber alone never makes a row selectable', async () => {
  const harness = await loadPlugin()
  const row = harness.document.createElement('div')
  row.className = 'session_row'
  row.setAttribute('role', 'treeitem')
  // Exactly the shape the old build walked: a fiber carrying `node.id`.
  row.__reactFiber$test = { memoizedProps: { node: { id: SESSION_A.id, title: SESSION_A.title } }, return: null }
  harness.document.body.appendChild(row)
  harness.rows.push(row)

  selectRow(harness).element.props.onSelect()
  await flush()

  assert.equal(
    row.querySelectorAll(':scope > .dsdel-check').length,
    0,
    'row identity comes from the host key, never from the fiber tree',
  )

  // Give it the host's own key and it becomes selectable.
  row.setAttribute('data-row-key', `session:${SESSION_A.id}`)
  observerPass(harness)
  await flush()
  assert.equal(
    row.querySelectorAll(':scope > .dsdel-check').length,
    1,
    'the host data-row-key is what makes a row selectable',
  )
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

// --- the plugin page: "ask before deleting" (slot plugins.row.config) -------

const rowConfig = (harness) =>
  harness.slotRegistrations.find((entry) => entry.spec.name === 'plugins.row.config') ?? null
// The registration carries no `locale`, so the host injects no `t` into this
// entry. Rendering it exactly that way is what keeps the module-level fallback
// honest - a card that only worked with an injected `t` would crash in the app.
const pageCheckbox = (harness, view = 'page') =>
  rowConfig(harness).Component({ view }).props.children[0]

test('the plugin page registers a row.config entry under the bundle#row key', async () => {
  const harness = await loadPlugin()
  const entry = rowConfig(harness)
  assert.ok(entry, 'a plugins.row.config entry is registered')
  assert.equal(entry.spec.key, 'dsh-delete-session#dsh-delete-session')
})

test('the row.config summary reflects the ask state', async () => {
  const harness = await loadPlugin()
  assert.equal(rowConfig(harness).Component({ view: 'summary' }), '删除前询问')
  localStorage.setItem(SKIP_KEY, '1')
  assert.equal(rowConfig(harness).Component({ view: 'summary' }), '直接删除')
  localStorage.removeItem(SKIP_KEY)
})

test('the page checkbox starts ticked and unticking it deletes without a dialog', async () => {
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)
  assert.equal(pageCheckbox(harness).props.checked, true, 'asking is the default')

  pageCheckbox(harness).props.onChange(false)
  assert.equal(localStorage.getItem(SKIP_KEY), '1', 'unticking stores the opt-out')

  const { element } = deleteRow(harness, SESSION_A)
  element.props.onSelect({ shiftKey: false })
  await tick()

  assert.equal(dialogElement(harness), null, 'no dialog opens once asking is off')
  assert.equal(
    harness.requests.filter((call) => call.url === '/dsh-delete-session/delete').length,
    1,
    'the delete goes out straight away',
  )
})

test("the dialog's don't-ask-again flips the page checkbox off", async () => {
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)
  assert.equal(pageCheckbox(harness).props.checked, true)

  const { element } = deleteRow(harness, SESSION_A)
  element.props.onSelect({ shiftKey: false })
  const parts = dialogParts(harness)
  parts.skip.props.onChange({ target: { checked: true } })
  parts.confirm.props.onClick()
  await tick()

  assert.equal(localStorage.getItem(SKIP_KEY), '1', 'the dialog stored the opt-out')
  assert.equal(pageCheckbox(harness).props.checked, false, 'the page checkbox reflects it')
})

test('ticking don\'t-ask-again and then cancelling changes nothing', async () => {
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)

  const { element } = deleteRow(harness, SESSION_A)
  element.props.onSelect({ shiftKey: false })
  const parts = dialogParts(harness)
  parts.skip.props.onChange({ target: { checked: true } })
  parts.cancel.props.onClick()
  await tick()

  assert.equal(localStorage.getItem(SKIP_KEY), null, 'the preference was never committed')
  assert.equal(dialogElement(harness), null, 'the dialog closed')
  assert.equal(harness.requests.length, 0, 'and nothing was deleted')
})
