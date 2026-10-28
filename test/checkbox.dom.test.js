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

  // `[class*="_footArea"]` - how the bar finds the host's sidebar footer.
  const classContains = /^\[class\*="([^"]*)"\]$/.exec(selector)
  if (classContains !== null) return node.className.includes(classContains[1])

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
    // Viewport height: the docked bar is anchored to the footer's bottom edge,
    // so the distance has to be computed against a real number.
    innerHeight: 800,
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
    constructor(callback) {
      this.callback = callback
      this.target = null
      this.options = null
      observers.push(this)
    }
    observe(target, options) { this.target = target === undefined ? null : target; this.options = options === undefined ? null : options }
    disconnect() { this.target = null }
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
    const href = String(url)
    requests.push({ url: href, init })
    // The artifact scan answers with whatever plan the test supplied; every
    // other route answers with a bare success.
    if (href.endsWith('/dsh-delete-session/artifacts')) {
      const plan = options.plan ?? { created: [], modified: [], refused: [], truncated: false, warnings: [] }
      return { ok: true, status: 200, json: async () => ({ ok: true, ...plan }) }
    }
    // The subagent sessions behind one conversation.
    if (href.endsWith('/dsh-delete-session/children')) {
      const children = options.children ?? []
      return { ok: true, status: 200, json: async () => ({ ok: true, children }) }
    }
    // The folder picker asks for one directory listing per navigation.
    if (href.endsWith('/dsh-delete-session/browse')) {
      const asked = JSON.parse((init && init.body) || '{}')
      const fallback = { path: 'C:/ws', parent: 'C:/', entries: [], roots: [], truncated: false, defaultRoot: 'C:/home' }
      const listing = typeof options.browse === 'function' ? options.browse(asked.path) : (options.browse ?? fallback)
      return { ok: true, status: 200, json: async () => ({ ok: true, ...listing }) }
    }
    // The native dialog route. `unsupported` models a platform without one, which
    // is what makes the client fall back to the in-page picker.
    if (href.endsWith('/dsh-delete-session/pick')) {
      const pick = options.pick ?? { cancelled: true, path: null }
      if (pick.unsupported === true) {
        return { ok: false, status: 200, json: async () => ({ ok: false, code: 'unsupported', error: '宿主没有 directoryPicker 服务' }) }
      }
      // A browse deployment: the host has no OS chooser to raise, so it tells the
      // page to draw its own picker. Normal for a remote client.
      if (pick.browse === true) {
        return { ok: false, status: 200, json: async () => ({ ok: false, code: 'browse', error: '浏览式宿主' }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, ...pick }) }
    }
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
    // Mirrors dsh-client-locale: a non-string entry is handed back untouched, and
    // only string templates interpolate `{name}` from a params object. Returning
    // a function as-is is exactly what makes the plugin fall back to its own
    // dictionary, which is how parameterised strings keep their arguments.
    translate: (namespace, key, params) => {
      const value = locales[namespace]?.zh?.[key]
      if (value === undefined) return key
      if (typeof value !== 'string') return value
      if (!params) return value
      return value.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
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

  // Mirrors `dsh-client-locale`: a function-valued entry is handed back
  // UNTOUCHED (the caller invokes it), and a string is returned as-is when no
  // params are given. Invoking here would hide the difference that once broke
  // the real host.
  const t = (key, a, b) => {
    const value = locales[NS]?.zh?.[key]
    if (value === undefined) return key
    if (typeof value === 'function') return value
    if (a === undefined) return value
    const params = a !== null && typeof a === 'object' ? a : { n: a, done: a, total: b, ok: a, fail: b, path: a }
    return value.replace(/{(w+)}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
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
/** The host wraps the session rows in this container; the plugin watches it. */
function mountList(harness) {
  const list = harness.document.createElement('div')
  list.className = 'hHd-Xa_regionArea'
  harness.document.body.appendChild(list)
  return list
}

function mountRow(harness, session = SESSION_A, parent = null) {
  const row = harness.document.createElement('div')
  row.className = 'session_row'
  row.setAttribute('role', 'treeitem')
  row.setAttribute('data-row-key', `session:${session.id}`)
  ;(parent ?? harness.document.body).appendChild(row)
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

const FOOTER_SLOT = 'sidebar.footer.action'

/**
 * The batch bar is a slot occupant now: render the registered component the way
 * the host would and inspect the element tree it returns. `null` means the
 * footer is unoccupied, which is what "not selecting" looks like.
 */
const footerEntry = (harness) =>
  harness.slotRegistrations.find((entry) => entry.spec.name === FOOTER_SLOT) ?? null

const bar = (harness) => {
  const entry = footerEntry(harness)
  if (entry === null) return null
  const node = entry.Component({})
  return node === null || node === undefined ? null : node
}

const barChild = (harness, key) => {
  const node = bar(harness)
  if (node === null || node.props === undefined) return null
  return findByKey(node.props.children, key)[0] ?? null
}

/** Invoke a bar button the way the host would dispatch a click. */
const clickBar = (node) => node.props.onClick({ stopPropagation() {} })

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
  assert.equal(deleteCalls(harness), 0, 'opening the dialog deletes nothing yet')
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
  assert.equal(deleteCalls(harness), 1, 'and still deletes nothing until confirmed')
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
  assert.ok(bar(harness), 'the bar exists')
  assert.equal(totalCheckboxes(harness), 2)

  // Cancel is the bar's non-danger button.
  clickBar(barCancel(harness))
  await flush()

  assert.equal(totalCheckboxes(harness), 0, 'no checkbox survives the mode')
  assert.deepEqual(rowCheckboxes(harness), [0, 0])
  assert.equal(bar(harness), null, 'and the footer is empty again')
})

// --- the two modes must not leak into each other ----------------------------

test('entering, leaving, then deleting plants nothing', async () => {
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)
  mountRow(harness, SESSION_B)

  selectRow(harness).element.props.onSelect()
  await flush()
  clickBar(barCancel(harness))
  await flush()

  // Leaving the mode removed the observer that decorates; a later delete must
  // not bring the mode - or its checkboxes - back.
  await decorateViaSingleDelete(harness, SESSION_A)

  assert.equal(totalCheckboxes(harness), 0, 'the mode leaves no residue behind')
  assert.equal(bar(harness), null, 'the footer stays empty')
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

// --- the plugin page: artifact + ask settings (slot plugins.row.config) -----

const OFF_KEY = 'dsh-delete-session:artifacts-off'
const AUTO_KEY = 'dsh-delete-session:artifacts-auto'
const SCOPE_KEY = 'dsh-delete-session:artifact-scope'

const rowConfig = (harness) =>
  harness.slotRegistrations.find((entry) => entry.spec.name === 'plugins.row.config') ?? null
// The registration carries no `locale`, so the host injects no `t` into this
// entry. Rendering it exactly that way is what keeps the module-level fallback
// honest - a card that only worked with an injected `t` would crash in the app.
const pageCard = (harness, view = 'page') => rowConfig(harness).Component({ view })
// The settings belonging to the master switch live in a nested container, so the
// walk descends into any element that carries a children list.
/** Only the delete request itself: opening the dialog now reads one thing. */
const deleteCalls = (harness) =>
  harness.requests.filter((call) => call.url === '/dsh-delete-session/delete').length
const collectChecks = (nodes, harness, out = []) => {
  for (const node of nodes || []) {
    if (node === null || node === undefined) continue
    if (node.type === harness.primitives.Checkbox) out.push(node)
    else if (node.props && Array.isArray(node.props.children)) collectChecks(node.props.children, harness, out)
  }
  return out
}
const pageChecks = (harness) => collectChecks(pageCard(harness).props.children, harness)
const pageCheckbox = (harness) => pageChecks(harness)[0]
// Selected by their key, not by position: adding a switch to the card must not
// silently retarget these assertions at a different control.
const pageCheck = (harness, key) => findByKey(pageCard(harness).props.children, key)[0]
const offCheckbox = (harness) => pageCheck(harness, 'off')
const recycleCheckbox = (harness) => pageCheck(harness, 'recycle')
const autoCheckbox = (harness) => pageCheck(harness, 'auto')
const scopeCreatedCheckbox = (harness) => pageCheck(harness, 'scopeCreated')
const scopeAllCheckbox = (harness) => pageCheck(harness, 'scopeAll')

/** The body the delete route received, or null when it was never called. */
const deleteBody = (harness) => {
  const entry = harness.requests.find((call) => call.url === '/dsh-delete-session/delete')
  return entry === undefined ? null : JSON.parse(entry.init.body)
}

test('the plugin page registers a row.config entry under the bundle#row key', async () => {
  const harness = await loadPlugin()
  const entry = rowConfig(harness)
  assert.ok(entry, 'a plugins.row.config entry is registered')
  assert.equal(entry.spec.key, 'dsh-delete-session#dsh-delete-session')
})

test('the row.config summary reports the artifact settings, not the ask toggle', async () => {
  const harness = await loadPlugin()
  // The produced-files feature ships off, so that is what the summary says.
  assert.equal(pageCard(harness, 'summary'), '不处理产出文件')

  localStorage.setItem(SKIP_KEY, '1')
  assert.equal(pageCard(harness, 'summary'), '不处理产出文件', 'the ask toggle no longer drives the summary')
  localStorage.removeItem(SKIP_KEY)

  localStorage.setItem(OFF_KEY, '0')
  assert.equal(pageCard(harness, 'summary'), '产出文件先询问')
  localStorage.setItem(AUTO_KEY, '1')
  assert.equal(pageCard(harness, 'summary'), '产出文件自动隔离')
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

test(
  'the dialog offers no way to change whether a delete asks',
  async () => {
    // The switch lives on the plugin page only. A dialog that could flip it
    // would let one click silently change every later delete.
    const harness = await loadPlugin()
    mountRow(harness, SESSION_A)

    const { element } = deleteRow(harness, SESSION_A)
    element.props.onSelect({ shiftKey: false })

    assert.equal(dialogParts(harness).skip, null, "the dialog carries no don't-ask-again control")
    assert.equal(
      pageCheckbox(harness).props.checked,
      true,
      'and the page remains the only place the setting is read from',
    )
  },
)
// --- produced files: the opt-in feature -------------------------------------

const PLAN = {
  created: [
    { path: 'C:/ws/new-a.md', displayPath: 'C:/ws/new-a.md', ops: 1 },
    { path: 'C:/ws/new-b.md', displayPath: 'C:/ws/new-b.md', ops: 1 },
  ],
  modified: [
    { path: 'C:/ws/old-c.md', displayPath: 'C:/ws/old-c.md', ops: 2 },
  ],
  refused: [{ path: 'C:/elsewhere/x.md', reason: '不在该对话的工作目录内，已跳过' }],
  truncated: false,
  warnings: [],
}

/** The artifact section's rendered element, or null when it is absent. */
const artifactSection = (harness) => {
  const modal = dialogElement(harness)
  if (modal === null || modal === undefined) return null
  const kids = modal.props.children || []
  // The `createElement` stub keeps `key` inside props, the way the rest of this
  // file reads it.
  return kids.find((node) => node && node.props && node.props.key === 'artifacts') ?? null
}

/** One rendered tick row per listed artifact. */
const artifactRows = (harness) => {
  const section = artifactSection(harness)
  if (section === null) return []
  return (section.props.children || []).filter((node) => node && node.type === 'label')
}

const artifactInputs = (harness) => artifactRows(harness).map((label) => label.props.children[0])

/** Open the dialog through the real menu row and let the scan settle. */
async function openArtifactDialog(harness, session = SESSION_A) {
  const { element } = deleteRow(harness, session)
  element.props.onSelect({ shiftKey: false })
  await tick()
  await tick()
  return dialogParts(harness)
}

test('the produced-files feature ships off: no scan, no section, no quarantine field', async () => {
  const harness = await loadPlugin({ plan: PLAN })
  mountRow(harness, SESSION_A)
  const parts = await openArtifactDialog(harness)

  assert.ok(parts, 'the dialog opened')
  assert.equal(artifactSection(harness), null, 'no artifact section while the feature is off')
  assert.equal(
    harness.requests.filter((call) => call.url === '/dsh-delete-session/artifacts').length,
    0,
    'no scan was requested',
  )

  parts.confirm.props.onClick()
  await tick()
  const body = deleteBody(harness)
  assert.equal(body.sessionId, SESSION_A.id)
  assert.equal('quarantine' in body, false, 'the delete request is byte-identical to the previous version')
})

test('the page hides the artifact sub-controls while the master switch is on', async () => {
  const harness = await loadPlugin()
  assert.equal(pageChecks(harness).length, 4, 'ask, recycle, subagents and the master switch render')
  assert.equal(offCheckbox(harness).props.checked, true, 'the master switch starts ticked')
})

test('clearing the master switch reveals the auto and scope controls', async () => {
  const harness = await loadPlugin()
  offCheckbox(harness).props.onChange(false)

  assert.equal(localStorage.getItem(OFF_KEY), '0', 'the opt-in was stored')
  assert.equal(pageChecks(harness).length, 8, 'the sub-controls render once enabled')
  assert.equal(autoCheckbox(harness).props.checked, false, 'asking is the default once enabled')
  assert.equal(scopeCreatedCheckbox(harness).props.checked, true, 'created-only is the default scope')
  assert.equal(scopeAllCheckbox(harness).props.checked, false)
})

test('the scope controls are mutually exclusive', async () => {
  const harness = await loadPlugin()
  localStorage.setItem(OFF_KEY, '0')

  scopeAllCheckbox(harness).props.onChange(true)
  assert.equal(localStorage.getItem(SCOPE_KEY), 'all')
  assert.equal(scopeAllCheckbox(harness).props.checked, true)
  assert.equal(scopeCreatedCheckbox(harness).props.checked, false)

  scopeCreatedCheckbox(harness).props.onChange(true)
  assert.equal(localStorage.getItem(SCOPE_KEY), 'created')
  assert.equal(scopeCreatedCheckbox(harness).props.checked, true)

  // Unticking never clears the selection: one scope is always in force.
  scopeCreatedCheckbox(harness).props.onChange(false)
  assert.equal(localStorage.getItem(SCOPE_KEY), 'created')
})

test('with the feature on the dialog scans and lists the created files', async () => {
  const harness = await loadPlugin({ plan: PLAN })
  localStorage.setItem(OFF_KEY, '0')
  mountRow(harness, SESSION_A)

  const parts = await openArtifactDialog(harness)
  assert.ok(parts, 'the dialog opened')
  assert.equal(
    harness.requests.filter((call) => call.url === '/dsh-delete-session/artifacts').length,
    1,
    'exactly one scan went out',
  )
  assert.ok(artifactSection(harness), 'the artifact section rendered')
  assert.equal(artifactRows(harness).length, 2, 'the created-only scope lists two rows')
  assert.equal(artifactInputs(harness).every((input) => input.props.checked === true), true, 'all preselected')
})

test('ask mode sends the ticked paths and drops the unticked ones', async () => {
  const harness = await loadPlugin({ plan: PLAN })
  localStorage.setItem(OFF_KEY, '0')
  mountRow(harness, SESSION_A)

  const parts = await openArtifactDialog(harness)
  artifactInputs(harness)[0].props.onChange({ target: { checked: false } })

  parts.confirm.props.onClick()
  await tick()

  const body = deleteBody(harness)
  assert.equal(body.quarantine.scope, 'created')
  assert.deepEqual(body.quarantine.paths, ['C:/ws/new-b.md'], 'only the still-ticked row was sent')
})

test('auto mode sends only the scope so the host takes its own full set', async () => {
  const harness = await loadPlugin({ plan: PLAN })
  localStorage.setItem(OFF_KEY, '0')
  localStorage.setItem(AUTO_KEY, '1')
  mountRow(harness, SESSION_A)

  const parts = await openArtifactDialog(harness)
  assert.equal(artifactRows(harness).length, 0, 'auto mode renders no tick rows')

  parts.confirm.props.onClick()
  await tick()

  const body = deleteBody(harness)
  assert.deepEqual(body.quarantine, { scope: 'created', skipGit: true }, 'no path list is sent in auto mode')
})

test('the "created and changed" scope lists and sends the changed rows too', async () => {
  const harness = await loadPlugin({ plan: PLAN })
  localStorage.setItem(OFF_KEY, '0')
  localStorage.setItem(SCOPE_KEY, 'all')
  mountRow(harness, SESSION_A)

  const parts = await openArtifactDialog(harness)
  assert.equal(artifactRows(harness).length, 3, 'created rows plus the changed row')

  parts.confirm.props.onClick()
  await tick()

  const body = deleteBody(harness)
  assert.equal(body.quarantine.scope, 'all')
  assert.deepEqual(
    [...body.quarantine.paths].sort(),
    ['C:/ws/new-a.md', 'C:/ws/new-b.md', 'C:/ws/old-c.md'].sort(),
  )
})

test('a scan failure is shown in the dialog and still allows a plain delete', async () => {
  const harness = await loadPlugin()
  localStorage.setItem(OFF_KEY, '0')
  mountRow(harness, SESSION_A)

  // Break only the scan route.
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/artifacts')) {
      harness.requests.push({ url: String(url), init })
      return { ok: false, status: 500, json: async () => ({ ok: false, error: 'boom' }) }
    }
    return originalFetch(url, init)
  }

  const parts = await openArtifactDialog(harness)
  const section = artifactSection(harness)
  assert.ok(section, 'the section is still rendered')
  assert.equal(section.props.role, 'alert', 'the failure is announced')

  parts.confirm.props.onClick()
  await tick()
  const body = deleteBody(harness)
  // The plan never loaded, so nothing may be quarantined by accident.
  assert.deepEqual(body.quarantine, { scope: 'created', paths: [], skipGit: true })
})

// --- the two "don't ask again" paths must not silently skip the feature ------

test('ask mode keeps the dialog when asking was turned off, so the list is never skipped', async () => {
  const harness = await loadPlugin({ plan: PLAN })
  localStorage.setItem(OFF_KEY, '0')   // produced-files on
  localStorage.setItem(SKIP_KEY, '1')  // "don't ask again" on
  mountRow(harness, SESSION_A)

  const { element } = deleteRow(harness)
  element.props.onSelect({ shiftKey: false })
  await tick()
  await tick()

  // The file list only exists in the dialog, so skipping it would make the
  // feature do nothing at all - worse than either asking or not.
  assert.ok(dialogElement(harness), 'the dialog still opens')
  assert.ok(artifactSection(harness), 'with the file list in it')
  assert.equal(deleteBody(harness), null, 'and nothing was deleted behind the user')
})

test('auto mode with asking turned off deletes straight away and still quarantines', async () => {
  const harness = await loadPlugin({ plan: PLAN })
  localStorage.setItem(OFF_KEY, '0')
  localStorage.setItem(AUTO_KEY, '1')
  localStorage.setItem(SKIP_KEY, '1')
  mountRow(harness, SESSION_A)

  const { element } = deleteRow(harness)
  element.props.onSelect({ shiftKey: false })
  await tick()

  assert.equal(dialogElement(harness), null, 'no dialog in auto mode')
  const body = deleteBody(harness)
  assert.ok(body, 'the delete went out')
  assert.deepEqual(body.quarantine, { scope: 'created' }, 'the feature is not silently skipped')
})

// --- the configurable save path ---------------------------------------------

const ROOT_KEY = 'dsh-delete-session:quarantine-root'

/** Depth-first search for rendered elements carrying one key. */
const findByKey = (nodes, key, out = []) => {
  for (const node of nodes || []) {
    if (!node || !node.props) continue
    if (node.props.key === key) {
      out.push(node)
      continue
    }
    if (Array.isArray(node.props.children)) findByKey(node.props.children, key, out)
  }
  return out
}
const pageRootInput = (harness) => findByKey(pageCard(harness).props.children, 'rootInput')[0]
const pageRootReset = (harness) => findByKey(pageCard(harness).props.children, 'reset')[0]
const pageRootBrowse = (harness) => findByKey(pageCard(harness).props.children, 'browse')[0]

const browseRequests = (harness) =>
  harness.requests.filter((call) => call.url === '/dsh-delete-session/browse')
const artifactsBody = (harness) => {
  const entry = harness.requests.find((call) => call.url === '/dsh-delete-session/artifacts')
  return entry === undefined ? null : JSON.parse(entry.init.body)
}

const pickerEntry = (harness) =>
  harness.slotRegistrations.find((entry) => entry.spec.id === 'dsh-delete-session-picker') ?? null
const pickerElement = (harness) => pickerEntry(harness).Component({ t: harness.t })

test('the settings card defaults to the host path and names it', async () => {
  const harness = await loadPlugin({
    browse: { path: 'C:/home', parent: null, entries: [], roots: [], truncated: false, defaultRoot: 'C:/home' },
  })
  localStorage.setItem(OFF_KEY, '0')

  const input = pageRootInput(harness)
  assert.ok(input, 'the field renders with the feature on')
  assert.equal(input.props.value, '', 'an empty value means "use the host default"')

  // The host default arrives from the picker route, so the first render only
  // arms the request; the placeholder names it once that settles.
  await tick()
  await tick()
  assert.equal(pageRootInput(harness).props.placeholder, 'C:/home')

  assert.equal(localStorage.getItem(ROOT_KEY), null, 'nothing is stored until the user chooses')
})

test('a typed save path is stored and sent with the scan and the delete', async () => {
  const harness = await loadPlugin({ plan: PLAN })
  localStorage.setItem(OFF_KEY, '0')
  mountRow(harness, SESSION_A)

  pageRootInput(harness).props.onChange({ target: { value: 'D:\\quarantine' } })
  assert.equal(localStorage.getItem(ROOT_KEY), 'D:\\quarantine')

  const parts = await openArtifactDialog(harness)
  assert.equal(artifactsBody(harness).root, 'D:\\quarantine', 'the scan knows where files would go')

  parts.confirm.props.onClick()
  await tick()
  assert.equal(deleteBody(harness).root, 'D:\\quarantine', 'and so does the delete')
})

test('"use default" clears the stored path and omits it from the requests', async () => {
  const harness = await loadPlugin({ plan: PLAN })
  localStorage.setItem(OFF_KEY, '0')
  localStorage.setItem(ROOT_KEY, 'D:\\quarantine')
  mountRow(harness, SESSION_A)

  pageRootReset(harness).props.onClick()
  assert.equal(localStorage.getItem(ROOT_KEY), null, 'the override is gone')

  const parts = await openArtifactDialog(harness)
  assert.equal('root' in artifactsBody(harness), false, 'the scan falls back to the default')

  parts.confirm.props.onClick()
  await tick()
  assert.equal('root' in deleteBody(harness), false, 'and so does the delete')
})

test('the browse button opens a picker that walks directories and commits one', async () => {
  const listing = (target) => {
    if (target === 'C:/ws') {
      return {
        path: 'C:/ws',
        parent: 'C:/',
        entries: [{ name: 'keep', path: 'C:/ws/keep' }, { name: 'other', path: 'C:/ws/other' }],
        roots: [],
        truncated: false,
        defaultRoot: 'C:/home',
      }
    }
    return { path: target, parent: 'C:/ws', entries: [], roots: [], truncated: false, defaultRoot: 'C:/home' }
  }
  // No native dialog on this platform, so the in-page picker is the fallback.
  const harness = await loadPlugin({ browse: listing, pick: { unsupported: true } })
  localStorage.setItem(OFF_KEY, '0')
  localStorage.setItem(ROOT_KEY, 'C:/ws')

  pageRootBrowse(harness).props.onClick()
  await tick()
  await tick()

  const modal = pickerElement(harness)
  assert.ok(modal, 'the picker opened')
  const rows = findByKey(modal.props.children || [], 'C:/ws/keep')
  assert.equal(rows.length, 1, 'the folders are listed')

  // Walking into a folder re-asks the host.
  rows[0].props.onClick()
  await tick()
  await tick()
  assert.equal(browseRequests(harness).at(-1).init.body, JSON.stringify({ path: 'C:/ws/keep' }))
  assert.equal(pickerElement(harness).props.children.length > 0, true, 'the listing re-rendered')

  // Committing writes the preference and closes the picker.
  const footer = pickerElement(harness).props.footer
  footer[1].props.onClick()
  assert.equal(localStorage.getItem(ROOT_KEY), 'C:/ws/keep', 'the chosen folder is stored')
  assert.equal(pickerElement(harness), null, 'the picker closed')
})

// --- dsh-session-relocate integration ---------------------------------------
//
// That plugin publishes a bulk-move face on `window`. When it is there, one more
// button appears between cancel and delete; when it is not, the bar is exactly
// what it was before and no other logic changes.

const barButtons = (harness) => {
  const node = bar(harness)
  if (node === null || node.props === undefined) return []
  return (node.props.children || []).filter((child) => child !== null && child !== undefined
    && child.props !== undefined && String(child.props.className || '').includes('dsdel-bar-btn'))
}
const barMove = (harness) => barChild(harness, 'move')
const barCancel = (harness) => barChild(harness, 'cancel')
const barDelete = (harness) => barChild(harness, 'delete')
const barCount = (harness) => barChild(harness, 'count')
const toasts = (harness) => harness.document.querySelectorAll('.dsdel-toast').map((el) => el.textContent)

function installRelocate(moveSelection) {
  globalThis.window.__DSH_SESSION_RELOCATE__ = { version: '0.2.0', supportsBulkMove: true, moveSelection }
}

async function enterMulti(harness) {
  selectRow(harness).element.props.onSelect()
  await flush()
}

function clickRowIn(harness, row) {
  harness.document.dispatchToDocument('click', { target: row, preventDefault() {}, stopPropagation() {} })
}

test('without dsh-session-relocate the bar keeps exactly cancel and delete', async () => {
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)
  await enterMulti(harness)

  assert.equal(barMove(harness), null, 'no move button is offered')
  assert.deepEqual(barButtons(harness).map((el) => el.props.children), ['取消', '删除'])
})

test('a relocate plugin that does not claim bulk move changes nothing', async () => {
  const harness = await loadPlugin()
  globalThis.window.__DSH_SESSION_RELOCATE__ = { version: '0.2.0', supportsBulkMove: false, moveSelection: async () => ({}) }
  mountRow(harness, SESSION_A)
  await enterMulti(harness)
  assert.deepEqual(barButtons(harness).map((el) => el.props.children), ['取消', '删除'])
})

test('with dsh-session-relocate the move button sits between cancel and delete', async () => {
  const harness = await loadPlugin()
  installRelocate(async (ids) => ({ moved: 0, failed: 0, skipped: 0, total: ids.length, results: [] }))
  mountRow(harness, SESSION_A)
  await enterMulti(harness)

  assert.deepEqual(barButtons(harness).map((el) => el.props.children), ['取消', '移动', '删除'], 'left to right')
})

test('the move button is disabled until something is selected', async () => {
  const harness = await loadPlugin()
  installRelocate(async (ids) => ({ moved: 0, failed: 0, skipped: 0, total: ids.length, results: [] }))
  const first = mountRow(harness, SESSION_A)
  await enterMulti(harness)

  assert.equal(barMove(harness).props.disabled, true, 'nothing selected')
  assert.equal(barDelete(harness).props.disabled, true, 'and delete agrees')
  assert.equal(barCancel(harness).props.disabled, false, 'cancel is always live')

  clickRowIn(harness, first)
  await flush()
  assert.equal(barMove(harness).props.disabled, false, 'one selection is enough')
})

test('a move reports progress, then summarises, exits and refreshes', async () => {
  const harness = await loadPlugin()
  let seen = null
  let finish
  const done = new Promise((resolve) => { finish = resolve })
  installRelocate(async (ids, hooks) => {
    seen = { ids, hooks }
    return done
  })

  const first = mountRow(harness, SESSION_A)
  const second = mountRow(harness, SESSION_B)
  await enterMulti(harness)
  clickRowIn(harness, first)
  clickRowIn(harness, second)
  await flush()

  clickBar(barMove(harness))
  await flush()

  assert.deepEqual(seen.ids, [SESSION_A.id, SESSION_B.id], 'the whole selection is handed over')
  assert.equal(barCount(harness).props.children, '正在移动 0/2…')
  assert.equal(barMove(harness).props.disabled, true, 'inert while the move runs')
  assert.equal(barDelete(harness).props.disabled, true)

  seen.hooks.onProgress(1, 2)
  assert.equal(barCount(harness).props.children, '正在移动 1/2…')

  finish({ moved: 2, failed: 0, skipped: 0, total: 2, results: [] })
  await flush()
  await flush()

  assert.deepEqual(toasts(harness), ['已移动 2 个'], 'one summary line')
  assert.equal(bar(harness), null, 'multi-select exited')
})

test('a partial move reports both numbers', async () => {
  const harness = await loadPlugin()
  installRelocate(async (ids) => ({ moved: 1, failed: 2, skipped: 0, total: ids.length, results: [] }))
  const first = mountRow(harness, SESSION_A)
  await enterMulti(harness)
  clickRowIn(harness, first)
  await flush()

  clickBar(barMove(harness))
  await flush()
  await flush()

  assert.deepEqual(toasts(harness), ['已移动 1 个 / 2 个失败'])
})

test('cancelling the target picker keeps the selection and says nothing', async () => {
  const harness = await loadPlugin()
  installRelocate(async () => ({ canceled: true }))
  const first = mountRow(harness, SESSION_A)
  await enterMulti(harness)
  clickRowIn(harness, first)
  await flush()

  clickBar(barMove(harness))
  await flush()
  await flush()

  assert.deepEqual(toasts(harness), [], 'nothing happened, so nothing is reported')
  assert.ok(bar(harness), 'multi-select is still open')
  assert.equal(barCount(harness).props.children, '已选 1 个', 'the count is back')
  assert.equal(barMove(harness).props.disabled, false, 'the retry is available')
})

test('a throwing relocate call ends the batch and reports the error', async () => {
  const harness = await loadPlugin()
  installRelocate(async () => { throw new Error('relocate exploded') })
  const first = mountRow(harness, SESSION_A)
  await enterMulti(harness)
  clickRowIn(harness, first)
  await flush()

  clickBar(barMove(harness))
  await flush()
  await flush()

  assert.ok(bar(harness), 'still in multi-select')
  assert.equal(toasts(harness).length, 1, 'the failure is reported')
  assert.match(toasts(harness)[0], /relocate exploded/)
})

test('Escape stays inert while a move is running', async () => {
  const harness = await loadPlugin()
  let finish
  installRelocate(async () => new Promise((resolve) => { finish = resolve }))
  const first = mountRow(harness, SESSION_A)
  await enterMulti(harness)
  clickRowIn(harness, first)
  await flush()

  clickBar(barMove(harness))
  await flush()

  harness.document.dispatchToDocument('keydown', { key: 'Escape', stopPropagation() {} })
  await flush()
  assert.ok(bar(harness), 'Escape is ignored mid-move')

  finish({ moved: 1, failed: 0, skipped: 0, total: 1, results: [] })
  await flush()
  await flush()
  assert.equal(bar(harness), null, 'and the mode ends when the move does')
})

// --- the result contract is enforced, not guessed ---------------------------

test('the older "cancelled" spelling of the cancel flag is still honoured', async () => {
  const harness = await loadPlugin()
  installRelocate(async () => ({ cancelled: true }))
  const first = mountRow(harness, SESSION_A)
  await enterMulti(harness)
  clickRowIn(harness, first)
  await flush()

  clickBar(barMove(harness))
  await flush()
  await flush()

  assert.deepEqual(toasts(harness), [], 'silent, exactly like the "canceled" spelling')
  assert.ok(bar(harness), 'still in multi-select')
})

test('a result without the agreed counts is reported instead of guessed', async () => {
  const harness = await loadPlugin()
  // The shape an earlier draft used: no total. Substituting `total - failed` would
  // make "genuinely zero failures" and "field missing" look identical.
  installRelocate(async () => ({ moved: 1, failed: 0 }))
  const first = mountRow(harness, SESSION_A)
  await enterMulti(harness)
  clickRowIn(harness, first)
  await flush()

  clickBar(barMove(harness))
  await flush()
  await flush()

  assert.equal(toasts(harness).length, 1)
  assert.match(toasts(harness)[0], /移动结果缺少字段：total/)
})

// --- capability bits --------------------------------------------------------

test('the plugin announces itself so a relocate plugin can stand down', async () => {
  await loadPlugin()
  assert.equal(globalThis.window.__DSH_DELETE_SESSION__?.supportsBulkMove, true, 'the capability bit is set')
})

// --- the hint under "ask before deleting" must match what actually happens ---

const pageHint = (harness, key) => findByKey(pageCard(harness).props.children, key)[0]

test('with asking off, the hint changes when the file list still needs a dialog', async () => {
  const harness = await loadPlugin()
  localStorage.setItem(SKIP_KEY, '1')

  // Feature off: nothing else opens a dialog, so "delete straight away" is true.
  assert.equal(pageHint(harness, 'askHint').props.children, '删除会话会直接执行，不再询问。')

  // Feature on in ask mode: the list lives in the dialog, so it still opens.
  localStorage.setItem(OFF_KEY, '0')
  assert.equal(
    pageHint(harness, 'askHint').props.children,
    '删除会话仍会弹窗——产出文件要先列清单给你勾选。',
    'the promise must match the behaviour',
  )

  // Feature on in auto mode: no list to show, so straight delete is true again.
  localStorage.setItem(AUTO_KEY, '1')
  assert.equal(pageHint(harness, 'askHint').props.children, '删除会话会直接执行，不再询问。')
})

test('with asking on, the hint is the plain confirmation one', async () => {
  const harness = await loadPlugin()
  localStorage.setItem(OFF_KEY, '0')
  assert.equal(pageHint(harness, 'askHint').props.children, '每次删除会话前都会弹出确认框。')
})

// --- the native folder dialog -----------------------------------------------
//
// The browser cannot hand a page a filesystem path, so the host raises the OS
// dialog instead. The in-page picker stays as the fallback for platforms without
// one, which the test above already covers.

test('the folder button stores what the system dialog returned', async () => {
  const harness = await loadPlugin({ pick: { cancelled: false, path: 'D:/quarantine' } })
  localStorage.setItem(OFF_KEY, '0')

  pageRootBrowse(harness).props.onClick()
  await tick()
  await tick()

  assert.equal(localStorage.getItem(ROOT_KEY), 'D:/quarantine', 'the chosen folder is stored')
  assert.deepEqual(toasts(harness), ['已打开系统文件夹对话框，请在弹出的窗口里选择', '保存位置已更新'])
})

test('cancelling the system dialog changes nothing', async () => {
  const harness = await loadPlugin({ pick: { cancelled: true, path: null } })
  localStorage.setItem(OFF_KEY, '0')

  pageRootBrowse(harness).props.onClick()
  await tick()
  await tick()

  assert.equal(localStorage.getItem(ROOT_KEY), null, 'no choice was recorded')
  assert.deepEqual(toasts(harness), ['已打开系统文件夹对话框，请在弹出的窗口里选择'], 'only the "it opened" note')
  assert.equal(pickerElement(harness), null, 'and no fallback picker was raised')
})

test('a failing system dialog is reported, not swallowed', async () => {
  const harness = await loadPlugin()
  localStorage.setItem(OFF_KEY, '0')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/dsh-delete-session/pick')) {
      harness.requests.push({ url: String(url), init })
      return { ok: false, status: 500, json: async () => ({ ok: false, code: 'shell', error: 'shell exploded' }) }
    }
    return originalFetch(url, init)
  }

  pageRootBrowse(harness).props.onClick()
  await tick()
  await tick()

  assert.equal(localStorage.getItem(ROOT_KEY), null)
  assert.match(toasts(harness).at(-1), /shell exploded/)
})

// --- the dialog must not pay for work it cannot use --------------------------

const scans = (harness) => harness.requests.filter((entry) => String(entry.url).includes('/artifacts'))

test('auto mode never scans, because the answer is thrown away', async () => {
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)
  localStorage.setItem(OFF_KEY, '0')
  localStorage.setItem(AUTO_KEY, '1')

  const { element } = deleteRow(harness)
  element.props.onSelect({ shiftKey: false })
  await flush()

  assert.equal(scans(harness).length, 0, 'quarantine is sent as { scope } and the host derives the set')
  assert.ok(dialogParts(harness), 'the dialog still opens straight away')
})

test('ask mode still scans, because its list is the whole point', async () => {
  const harness = await loadPlugin({
    plan: { created: [{ path: 'C:/ws/a.md', displayPath: 'a.md' }], modified: [], refused: [], truncated: false },
  })
  mountRow(harness, SESSION_A)
  localStorage.setItem(OFF_KEY, '0')

  const { element } = deleteRow(harness)
  element.props.onSelect({ shiftKey: false })
  await flush()

  assert.equal(scans(harness).length, 1, 'the listing is what the user ticks')
})

test('the counts render as numbers, not as the dictionary function', async () => {
  // The locale contract hands a function entry back untouched; rendering it
  // without calling it printed "(created, modified) => ..." into the dialog.
  // `harness.t` deliberately calls such entries so ordinary tests can read text,
  // so the contract path is driven here with a translator that behaves like the
  // host's: strings (interpolated) or the raw entry, nothing else.
  const hostTranslator = (key) => {
    const value = harness.locales[NS]?.zh?.[key]
    return value === undefined ? key : value
  }
  const harness = await loadPlugin({
    plan: {
      created: [{ path: 'C:/ws/a.md', displayPath: 'a.md' }, { path: 'C:/ws/b.md', displayPath: 'b.md' }],
      modified: [{ path: 'C:/ws/c.md', displayPath: 'c.md' }],
      refused: [],
      truncated: false,
    },
  })
  mountRow(harness, SESSION_A)
  localStorage.setItem(OFF_KEY, '0')

  const { element } = deleteRow(harness)
  element.props.onSelect({ shiftKey: false })
  await flush()

  const modal = overlayEntry(harness).Component({ t: hostTranslator })
  const kids = modal.props.children.filter(Boolean)
  const artifactsNode = kids.find((node) => node.props.key === 'artifacts')
  const countNode = artifactsNode.props.children.find((node) => node.props.key === 'count')

  assert.equal(typeof countNode.props.children, 'string', 'the count is text, not a function')
  assert.match(countNode.props.children, /新建 2 个 · 改过 1 个/)
})

// --- the dialog must not threaten a deletion it no longer performs -----------

test('the dialog says the session goes to the Recycle Bin, not that it is gone forever', async () => {
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)

  const { element } = deleteRow(harness)
  element.props.onSelect({ shiftKey: false })

  const desc = dialogParts(harness).desc
  assert.match(desc, /回收站/, 'the Recycle Bin is named as the destination')
  assert.doesNotMatch(desc, /永久删除/, 'it is no longer a permanent delete')
  assert.doesNotMatch(desc, /不可恢复/, 'and it no longer claims to be unrecoverable')
})

test('the folder row can open the quarantine folder in the file manager', async () => {
  const harness = await loadPlugin()
  localStorage.setItem(OFF_KEY, '0')
  localStorage.setItem(ROOT_KEY, 'D:/quarantine')

  const openButton = findByKey(pageCard(harness).props.children, 'open')[0]
  assert.ok(openButton, 'an open button sits beside the folder buttons')

  openButton.props.onClick()
  await tick()
  await tick()

  const reveal = harness.requests.filter((call) => call.url === '/dsh-delete-session/reveal')
  assert.equal(reveal.length, 1, 'one reveal request went out')
  assert.equal(JSON.parse(reveal[0].init.body).path, 'D:/quarantine')
  assert.match(toasts(harness).at(-1), /已在文件管理器中打开/)
})

test('opening with no stored root falls back to the host default', async () => {
  const harness = await loadPlugin()
  localStorage.setItem(OFF_KEY, '0')
  // The default path is fetched on the first render; mount, then let it settle.
  pageCard(harness)
  await tick()
  await tick()

  const openButton = findByKey(pageCard(harness).props.children, 'open')[0]
  openButton.props.onClick()
  await tick()
  await tick()

  const reveal = harness.requests.filter((call) => call.url === '/dsh-delete-session/reveal')
  assert.equal(reveal.length, 1)
  assert.equal(JSON.parse(reveal[0].init.body).path, 'C:/home', 'the default the host reported is used')
})

// --- the git switch ---------------------------------------------------------

const SKIP_GIT_KEY = 'dsh-delete-session:skip-git'

test('skipping git repositories is on by default', async () => {
  const harness = await loadPlugin()
  localStorage.setItem(OFF_KEY, '0')

  const box = findByKey(pageCard(harness).props.children, 'skipGit')[0]
  assert.ok(box, 'the switch renders with the artifact controls')
  assert.equal(box.props.checked, true, 'it starts on, so a project is never carried away by default')
  assert.equal(box.props.label, '跳过 git 仓库内的文件')
})

test('turning the git switch off is stored and sent with the delete', async () => {
  const harness = await loadPlugin({ plan: { created: [{ path: 'C:/ws/a.md', displayPath: 'a.md' }], modified: [], refused: [], truncated: false } })
  localStorage.setItem(OFF_KEY, '0')
  mountRow(harness, SESSION_A)

  const box = findByKey(pageCard(harness).props.children, 'skipGit')[0]
  box.props.onChange(false)
  assert.equal(localStorage.getItem(SKIP_GIT_KEY), '0', 'the choice is remembered')

  const { element } = deleteRow(harness)
  element.props.onSelect({ shiftKey: false })
  await flush()
  // The dialog is open (ask mode is the default), so the delete goes out on confirm.
  dialogParts(harness).confirm.props.onClick()
  await flush()

  assert.equal(deleteBody(harness).quarantine.skipGit, false, 'the host is told to stop skipping')
})

test('the scan itself is told whether to skip git files', async () => {
  // The listing and the move must agree: a file hidden by the scan would
  // otherwise still be a candidate when the host derives the set itself.
  const harness = await loadPlugin()
  localStorage.setItem(OFF_KEY, '0')
  mountRow(harness, SESSION_A)

  const { element } = deleteRow(harness)
  element.props.onSelect({ shiftKey: false })
  await flush()

  assert.equal(artifactsBody(harness).skipGit, true, 'the scan carries the flag')
})

// --- the recycle-bin switch -------------------------------------------------

const RECYCLE_KEY = 'dsh-delete-session:recycle'

test('deleting to the system trash is on by default', async () => {
  const harness = await loadPlugin()
  const box = recycleCheckbox(harness)
  assert.ok(box, 'the switch renders with the delete controls')
  assert.equal(box.props.checked, true, 'a wrong click stays undoable until told otherwise')
  assert.equal(box.props.label, '删除至回收站')
})

test('the default sentence promises the Recycle Bin', async () => {
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)
  const { element } = deleteRow(harness)
  element.props.onSelect({ shiftKey: false })

  const desc = dialogParts(harness).desc
  assert.match(desc, /回收站/)
  assert.doesNotMatch(desc, /永久删除|不可恢复/)
})

test('unchecking it switches both the sentence and the request to a hard delete', async () => {
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)

  recycleCheckbox(harness).props.onChange(false)
  assert.equal(localStorage.getItem(RECYCLE_KEY), '0', 'the choice is remembered')

  const { element } = deleteRow(harness)
  element.props.onSelect({ shiftKey: false })

  const desc = dialogParts(harness).desc
  assert.match(desc, /永久删除/, 'the sentence now says what an unchecked box means')
  assert.doesNotMatch(desc, /回收站/, 'and no longer promises a recoverable delete')

  dialogParts(harness).confirm.props.onClick()
  await flush()
  assert.equal(deleteBody(harness).recycle, false, 'the host is told to remove it outright')
})

// --- subagent sessions: ticked in the dialog, or taken with the parent ------

const SYNC_CHILDREN_KEY = 'dsh-delete-session:sync-children'
const CHILDREN = [
  { id: 'session-child-one', depth: 1, cwd: 'E:\\work' },
  { id: 'session-child-two', depth: 2, cwd: 'E:\\work' },
]

const childChecks = (harness) => {
  const modal = dialogElement(harness)
  if (modal === null) return []
  const section = (modal.props.children ?? []).filter(Boolean).find((node) => node.props.key === 'children')
  return section === undefined ? [] : collectChecks([section], harness)
}

test('the page offers to take child sessions with their parent, on by default', async () => {
  const harness = await loadPlugin()
  const box = pageCheck(harness, 'syncChildren')

  assert.ok(box, 'the switch renders with the other delete controls')
  assert.equal(box.props.checked, true, 'taking them along is the default')
  assert.equal(box.props.label, '同时删除子会话')

  box.props.onChange(true)
  assert.equal(localStorage.getItem(SYNC_CHILDREN_KEY), '1', 'the choice is remembered')
})

test('with the switch off the dialog lists the children, ticked, for you to narrow', async () => {
  const harness = await loadPlugin({ children: CHILDREN })
  localStorage.setItem(SYNC_CHILDREN_KEY, '0')
  mountRow(harness, SESSION_A)

  const { element } = deleteRow(harness, SESSION_A)
  element.props.onSelect({ shiftKey: false })
  await flush()

  const checks = childChecks(harness)
  assert.equal(checks.length, 2, 'every child is offered')
  assert.deepEqual(checks.map((c) => c.props.checked), [true, true], 'they start ticked')
})

test('unticking a child keeps it out of the delete', async () => {
  const harness = await loadPlugin({ children: CHILDREN })
  localStorage.setItem(SYNC_CHILDREN_KEY, '0')
  mountRow(harness, SESSION_A)

  const { element } = deleteRow(harness, SESSION_A)
  element.props.onSelect({ shiftKey: false })
  await flush()

  childChecks(harness)[0].props.onChange(false)
  dialogParts(harness).confirm.props.onClick()
  await flush()

  assert.deepEqual(deleteBody(harness).childSessionIds, ['session-child-two'], 'only the remaining tick is deleted')
})

test('with the switch on the children ride along without asking', async () => {
  const harness = await loadPlugin({ children: CHILDREN })
  localStorage.setItem(SYNC_CHILDREN_KEY, '1')
  mountRow(harness, SESSION_A)

  const { element } = deleteRow(harness, SESSION_A)
  element.props.onSelect({ shiftKey: false })
  await flush()

  assert.equal(childChecks(harness).length, 0, 'no list when the switch already answered')

  dialogParts(harness).confirm.props.onClick()
  await flush()

  assert.deepEqual(
    deleteBody(harness).childSessionIds,
    ['session-child-one', 'session-child-two'],
    'every child goes with the parent',
  )
})

// --- the quiet repository link at the bottom of the page --------------------

test('the page ends with a quiet link to the repository', async () => {
  const harness = await loadPlugin()
  const card = pageCard(harness)
  const star = findByKey(card.props.children, 'star')[0]

  assert.ok(star, 'the star line renders with the card')
  assert.match(star.props.className, /dsdel-star\b/)

  const [ask, cta] = star.props.children
  assert.equal(ask.props.children, '⭐ 顺手留颗 Star，作者能高兴一整天')
  assert.equal(cta.type, 'a', 'the call to action is a real link')
  assert.equal(cta.props.href, 'https://github.com/DDDMUC/dsh-delete-session')
  assert.equal(cta.props.target, '_blank')
  assert.equal(cta.props.rel, 'noreferrer')
  assert.equal(cta.props.children, '行，给你一颗 Star')
})

// --- the batch bar occupies the official footer seat ------------------------
//
// It used to be a floating card injected into `document.body`, and for a while it
// measured the sidebar footer and covered it. Both were the same mistake: a plugin
// guessing at host layout. The bar is a slot occupant now - the host places it, so
// there is nothing to measure, dock, hide or restore.

test('the bar registers into the official footer slot with a locale', async () => {
  const harness = await loadPlugin()
  const entry = footerEntry(harness)

  assert.ok(entry, 'the footer seat is occupied by a registration')
  assert.equal(entry.spec.id, 'dsh-delete-session-bulkbar')
  assert.equal(entry.spec.locale, NS, 'and it asks for the plugin locale namespace')
  assert.equal(typeof entry.Component, 'function')
})

test('the footer stays empty until multi-select starts', async () => {
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)

  assert.equal(bar(harness), null, 'nothing is rendered into the footer outside the mode')

  selectRow(harness).element.props.onSelect()
  await flush()

  assert.ok(bar(harness), 'and it appears the moment the mode starts')
})

test('the footer is empty again once the mode ends', async () => {
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)

  selectRow(harness).element.props.onSelect()
  await flush()
  assert.ok(bar(harness), 'the bar is there while selecting')

  clickBar(barCancel(harness))

  assert.equal(bar(harness), null, 'and leaves the footer as it found it')
})

test('the bar reads the count from the store, not from the DOM', async () => {
  const harness = await loadPlugin()
  const first = mountRow(harness, SESSION_A)
  mountRow(harness, SESSION_B)

  selectRow(harness).element.props.onSelect()
  await flush()

  assert.equal(barCount(harness).props.children, '已选 0 个', 'nothing selected yet')

  harness.document.dispatchToDocument('click', {
    target: first,
    preventDefault() {},
    stopPropagation() {},
  })
  await flush()

  assert.equal(barCount(harness).props.children, '已选 1 个', 'the same store the rows write to')
})

test('the plugin no longer injects a bar element into the document', async () => {
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)

  selectRow(harness).element.props.onSelect()
  await flush()

  // Render the occupant first: a component that only misbehaves when the host
  // actually mounts it would otherwise slip past this check.
  assert.ok(bar(harness), 'the footer occupant renders')

  const injected = walk(harness.document.body).filter((node) => node._classes.has('dsdel-bar'))
  assert.deepEqual(injected, [], 'no DOM bar: the footer slot is the only home')
})

// --- the bar replaces the account row instead of stacking above it ----------

test('selecting puts a marker on the page so the account row can step aside', async () => {
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)

  selectRow(harness).element.props.onSelect()
  await flush()

  // The bar shares the sidebar foot with the account chip, so leaving the chip in
  // place stacks two rows. The marker is what lets one stylesheet rule hide it,
  // instead of measuring the host's box and covering it.
  assert.equal(harness.document.body._classes.has('dsdel-selecting'), true, 'the page is marked')
})

test('leaving selection takes the marker away again', async () => {
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)

  selectRow(harness).element.props.onSelect()
  await flush()
  clickBar(barCancel(harness))

  assert.equal(harness.document.body._classes.has('dsdel-selecting'), false, 'the account row comes back')
})

test('the injected stylesheet hides the account row while the marker is on', async () => {
  const harness = await loadPlugin()
  // `ensureStyle` tags its <style> through `dataset.dshDeleteSession = '1'`.
  const style = harness.document.head.querySelector('[data-dsh-delete-session="1"]')
  assert.ok(style, 'the plugin injected its stylesheet')
  const css = String(style._text ?? '')

  // The foot stacks the action row, the usage card and the account row; only the
  // action row survives, so the bar ends the sidebar where the account row did.
  assert.match(
    css,
    /body\.dsdel-selecting \[class\*="_footArea"\] > \*:not\(\[class\*="_footerActions"\]\)/,
    'the usage card and the account row step aside',
  )
  // The other footer buttons live in a slot container marked `display: contents`.
  // They are named POSITIVELY — by the attributes their own plugins set — never by
  // "everything except the bar": the bar is not a direct child of that container,
  // and an exclusion rule hid it together with its Cancel button.
  assert.match(
    css,
    /body\.dsdel-selecting \[data-slot="sidebar\.footer\.action"\] > \[data-dsh-plugin\]/,
    'other plugins\' footer buttons are named one by one',
  )
  assert.doesNotMatch(
    css,
    /\[data-slot="sidebar\.footer\.action"\] > \*:not\(/,
    'no exclusion rule may touch that slot — it cannot tell the bar apart',
  )
  assert.match(css, /display:\s*none/, 'both rules hide rather than shift')
})

test('the stylesheet never hides the bar itself', async () => {
  const harness = await loadPlugin()
  const style = harness.document.head.querySelector('[data-dsh-delete-session="1"]')
  const css = String(style._text ?? '')

  // Nothing may hide the footer by exclusion. Three attempts at "everything
  // except the bar" took the bar itself down, because the bar is not a direct
  // child of the container those rules addressed.
  assert.doesNotMatch(
    css,
    /\[class\*="_footerActions"\] > \*:not\(\.dsdel-bar\)/,
    'no rule may target the bar as a direct child of the action row',
  )
  assert.doesNotMatch(
    css,
    /\[class\*="_footerActions"\] > \*:not\(:has/,
    'nor hide the action row wholesale',
  )
  assert.doesNotMatch(
    css,
    /\[data-slot="sidebar\.footer\.action"\] > \*:not\(\.dsdel-bar\)/,
    'nor the slot container by exclusion',
  )
  // The bar itself must be addressed by nothing but its own appearance rules.
  assert.doesNotMatch(
    css,
    /body\.dsdel-selecting [^{]*\.dsdel-bar\b(?!-)/,
    'no selecting-state rule names the bar at all',
  )
})

test('an interpolating host translator never receives our function entries', async () => {
  const harness = await loadPlugin()
  const dict = harness.locales[NS].zh
  // `dsh-client-locale` interpolates whatever it finds as soon as params are
  // given: it calls `template.replace(...)`. Handing it a function-valued entry
  // throws "template.replace is not a function", and a slot entry that throws is
  // replaced by the host's `data-slot-error` anchor — the bar vanishes whole.
  const strict = (key, params) => {
    const value = dict[key]
    if (value === undefined) return key
    if (params === undefined) return value
    return value.replace(/\{(\w+)\}/g, (match, name) => (params && name in params ? String(params[name]) : match))
  }

  mountRow(harness, SESSION_A)
  selectRow(harness).element.props.onSelect()
  await flush()

  const node = footerEntry(harness).Component({ t: strict })
  assert.ok(node, 'the bar still renders')
  assert.equal(node.props.children[0].props.children, '已选 0 个', 'and the count is formatted locally')
})

test('a placeholder string is interpolated locally, not by the host', async () => {
  const harness = await loadPlugin({ children: CHILDREN })
  localStorage.setItem(SYNC_CHILDREN_KEY, '0')
  const dict = harness.locales[NS].zh
  const strict = (key, params) => {
    const value = dict[key]
    if (value === undefined) return key
    if (params === undefined) return value
    return value.replace(/{(w+)}/g, (match, name) => (params && name in params ? String(params[name]) : match))
  }

  const row = mountRow(harness, SESSION_A)
  const { element } = deleteRow(harness, SESSION_A)
  element.props.onSelect({ shiftKey: false })
  await flush()

  // `childrenHint` is the one template-with-placeholder in the dictionary; the
  // host must not be asked to fill it, or it would receive a function entry.
  const dialogEntry = harness.slotRegistrations.find(
    (entry) => entry.spec.name === 'shell.overlay' && entry.spec.id === `${NS}-dialog`,
  )
  const modal = dialogEntry.Component({ t: strict })
  const kids = (modal.props.children ?? []).filter(Boolean)
  const section = kids.find((child) => child.props && child.props.key === 'children')
  assert.ok(section, 'the child list renders')
  assert.equal(section.props.children[0].props.children, '这个对话有 2 个子会话（子代理），勾选的会一起删除。')
  assert.ok(row)
})

test('the bar buttons keep their width instead of wrapping', async () => {
  const harness = await loadPlugin()
  const style = harness.document.head.querySelector('[data-dsh-delete-session="1"]')
  const css = String(style._text ?? '')

  // In a flex row the buttons are the only shrinkable things next to a growing
  // count, so a long progress label squeezed them into two-character columns.
  assert.match(css, /\.dsdel-bar-btn\{[^}]*flex:0 0 auto/, 'buttons never shrink')
  assert.match(css, /\.dsdel-bar-btn\{[^}]*white-space:nowrap/, 'and never wrap their label')
  assert.match(css, /\.dsdel-bar-count\{[^}]*text-overflow:ellipsis/, 'the count gives way instead')
})

// --- drag a session onto the footer bar to delete it ------------------------

/** Drag one mounted row the way the host starts a session drag. */
const startRowDrag = (harness, row) => harness.document.dispatchToDocument('dragstart', {
  target: row,
  preventDefault() {},
  stopPropagation() {},
})

const dropEvent = () => ({ preventDefault() {}, stopPropagation() {}, dataTransfer: { dropEffect: '' } })

test('dragging a session row turns the footer into a drop target', async () => {
  const harness = await loadPlugin()
  const row = mountRow(harness, SESSION_A)

  assert.equal(bar(harness), null, 'the footer is untouched before the drag')

  startRowDrag(harness, row)
  await flush()

  const node = bar(harness)
  assert.ok(node, 'the bar appears while a session is being dragged')
  assert.match(String(node.props.className), /\bdsdel-drop\b/, 'as a drop target, not the selection bar')
  assert.equal(harness.document.body._classes.has('dsdel-selecting'), true, 'and the account row steps aside')
})

test('hovering the bar shows that releasing will delete', async () => {
  const harness = await loadPlugin()
  const row = mountRow(harness, SESSION_A)

  startRowDrag(harness, row)
  await flush()
  assert.doesNotMatch(String(bar(harness).props.className), /dsdel-drop-over/, 'not armed yet')

  bar(harness).props.onDragOver(dropEvent())
  await flush()

  const node = bar(harness)
  assert.match(String(node.props.className), /dsdel-drop-over/, 'armed once the pointer is over it')
  const text = JSON.stringify(node.props.children)
  assert.match(text, /松手删除/, 'and the line says so')
})

test('leaving the bar disarms it again', async () => {
  const harness = await loadPlugin()
  const row = mountRow(harness, SESSION_A)

  startRowDrag(harness, row)
  await flush()
  bar(harness).props.onDragOver(dropEvent())
  await flush()
  bar(harness).props.onDragLeave(dropEvent())
  await flush()

  assert.doesNotMatch(String(bar(harness).props.className), /dsdel-drop-over/)
})

test('dropping asks first unless the user turned asking off', async () => {
  const harness = await loadPlugin()
  const row = mountRow(harness, SESSION_A)

  startRowDrag(harness, row)
  await flush()
  bar(harness).props.onDrop(dropEvent())
  await flush()

  assert.ok(dialogParts(harness), 'the confirmation dialog opens — the same rule as the menu row')
  assert.equal(deleteCalls(harness), 0, 'and nothing is deleted yet')
})

test('dropping deletes straight away when asking is off', async () => {
  const harness = await loadPlugin()
  localStorage.setItem(SKIP_KEY, '1')
  const row = mountRow(harness, SESSION_A)

  startRowDrag(harness, row)
  await flush()
  bar(harness).props.onDrop(dropEvent())
  await flush()

  assert.equal(deleteCalls(harness), 1, 'one delete goes out')
  assert.equal(dialogParts(harness), null, 'with no dialog')
})

test('ending the drag without dropping puts the footer back', async () => {
  const harness = await loadPlugin()
  const row = mountRow(harness, SESSION_A)

  startRowDrag(harness, row)
  await flush()
  harness.document.dispatchToDocument('dragend', { target: row, preventDefault() {}, stopPropagation() {} })
  await flush()

  assert.equal(bar(harness), null, 'the footer is empty again')
  assert.equal(harness.document.body._classes.has('dsdel-selecting'), false, 'and the account row is back')
})

test('a drag started during multi-select is left alone', async () => {
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)
  selectRow(harness).element.props.onSelect()
  await flush()

  const barBefore = bar(harness)
  assert.match(String(barBefore.props.className), /\bdsdel-bar\b/)

  startRowDrag(harness, harness.rows[0])
  await flush()

  assert.doesNotMatch(String(bar(harness).props.className), /\bdsdel-drop\b/, 'reordering inside the mode is not a delete')
})

// --- performance: the decorate pass must stay cheap --------------------------

test('the row observer watches the session list, not the whole document', async () => {
  const harness = await loadPlugin()
  const list = mountList(harness)
  mountRow(harness, SESSION_A, list)
  selectRow(harness).element.props.onSelect()
  await flush()

  const observer = harness.observers[0]
  assert.ok(observer, 'multi-select installs one observer')
  // Observing `document.body` means every streamed token in the transcript wakes
  // this callback. The list is the only subtree that can gain or lose rows.
  assert.equal(
    observer.target,
    list,
    'the list container is the observation root',
  )
})

test('a mutation with no added or removed nodes schedules no pass', async () => {
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)
  selectRow(harness).element.props.onSelect()
  await flush()

  const observer = harness.observers[0]
  let scanned = 0
  const realQuery = harness.document.querySelectorAll.bind(harness.document)
  harness.document.querySelectorAll = (selector) => {
    if (selector === '[role="treeitem"]') scanned += 1
    return realQuery(selector)
  }

  // A character-data mutation: text streaming, nothing structural.
  observer.callback([{ type: 'characterData', addedNodes: [], removedNodes: [] }])
  await flush()
  assert.equal(scanned, 0, 'no row scan for a text-only mutation')

  // A structural one still has to run.
  observer.callback([{ type: 'childList', addedNodes: [harness.rows[0]], removedNodes: [] }])
  await flush()
  assert.equal(scanned, 1, 'one scan when a row arrives')
})

test('the decorate pass does not run a selector engine over every row', async () => {
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)
  selectRow(harness).element.props.onSelect()
  await flush()

  const row = harness.rows[0]
  let rowSelectors = 0
  const realQuery = row.querySelector.bind(row)
  row.querySelector = (selector) => { rowSelectors += 1; return realQuery(selector) }

  harness.observers[0].callback([{ type: 'childList', addedNodes: [row], removedNodes: [] }])
  await flush()

  // The checkbox is always the first element child; a per-row selector call per
  // frame is the pass's dominant cost with a long list.
  assert.equal(rowSelectors, 0, 'the checkbox is found without querying')
})

test('a browse-only host falls back to the in-page picker too', async () => {
  // The host answered `browse`: it has a listing API but no OS chooser to raise.
  // That is the normal shape for a remote client, so it must not read as an error.
  const listing = { path: 'C:/ws', parent: 'C:/', entries: [], roots: ['C:/'], truncated: false, defaultRoot: 'C:/home' }
  const harness = await loadPlugin({ browse: listing, pick: { browse: true } })
  localStorage.setItem(OFF_KEY, '0')
  localStorage.setItem(ROOT_KEY, 'C:/ws')

  pageRootBrowse(harness).props.onClick()
  await tick()
  await tick()

  assert.ok(pickerElement(harness), 'the in-page picker opened')
  assert.ok(browseRequests(harness).length > 0, 'and it asked the host for a listing')
})

test('a failing folder dialog says so instead of blaming the delete', async () => {
  const harness = await loadPlugin()
  localStorage.setItem(OFF_KEY, '0')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/dsh-delete-session/pick')) {
      harness.requests.push({ url: String(url), init })
      return {
        ok: false,
        status: 500,
        json: async () => ({ ok: false, code: 'shell', error: "Cannot read properties of undefined (reading 'aborted')" }),
      }
    }
    return originalFetch(url, init)
  }

  pageRootBrowse(harness).props.onClick()
  await tick()
  await tick()

  const last = toasts(harness).at(-1)
  assert.match(last, /选择文件夹失败/, 'the picker is named')
  assert.doesNotMatch(last, /删除失败/, 'and deleting is not blamed for it')
  assert.match(last, /aborted/, 'the host message is still carried through')
})

// --- first install: the four defaults --------------------------------------

test('a fresh install ticks all four delete switches', async () => {
  // No storage at all: this is what a new user sees on the plugin page.
  const harness = await loadPlugin()

  const expected = [
    ['ask', '删除时询问', 'ask first'],
    ['recycle', '删除至回收站', 'recycle bin'],
    ['syncChildren', '同时删除子会话', 'take the subagent sessions along'],
    ['off', '不处理产出文件（保持当前行为）', 'leave produced files alone'],
  ]

  for (const [key, label, why] of expected) {
    const box = pageCheck(harness, key)
    assert.ok(box, key + ' renders')
    assert.equal(box.props.label, label)
    assert.equal(box.props.checked, true, why)
  }
})

test('unticking "take the child sessions along" is remembered', async () => {
  const harness = await loadPlugin()
  const box = pageCheck(harness, 'syncChildren')
  assert.equal(box.props.checked, true, 'on by default')

  box.props.onChange(false)
  // The default is now "on", so the off choice has to be written explicitly:
  // deleting the key would read back as on again.
  assert.equal(localStorage.getItem(SYNC_CHILDREN_KEY), '0', 'off is written, not cleared')
})

test('a fresh install deletes the children without listing them', async () => {
  const harness = await loadPlugin({ children: CHILDREN })
  mountRow(harness, SESSION_A)

  const { element } = deleteRow(harness, SESSION_A)
  element.props.onSelect({ shiftKey: false })
  await flush()

  assert.deepEqual(childChecks(harness), [], 'no per-child ticks to narrow, because they all go')
  dialogParts(harness).confirm.props.onClick()
  await flush()

  assert.deepEqual(
    deleteBody(harness).childSessionIds,
    ['session-child-one', 'session-child-two'],
    'and the delete carries them',
  )
})
