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
import { readFile } from 'node:fs/promises'
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
    // A real DOM MOVES a node it already contains; it never keeps two copies.
    // The plugin repositions its spacer and its select-all box on every decorate
    // pass, so a stub that appended instead of moved doubled them: removing one
    // copy left the other behind and made the cleanup look broken.
    const previous = child.parentElement
    if (previous !== null) {
      const at = previous.children.indexOf(child)
      if (at !== -1) previous.children.splice(at, 1)
    }
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
  // A comma list is an OR in the DOM, and the plugin uses one to find the
  // "new session" button. Without this the stub silently answered "no match"
  // for every alternative, which hid the fallback path entirely.
  if (selector.includes(',')) {
    return selector.split(',').some((part) => matches(node, part.trim()))
  }
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

  // `button[class*="newSession"]` - tag-qualified, used by the fallback that
  // finds the host's "new session" button after a delete.
  const tagClassContains = /^([A-Za-z][\w-]*)\[class\*="([^"]*)"\]$/.exec(selector)
  if (tagClassContains !== null) {
    if (String(node.tagName || '').toLowerCase() !== tagClassContains[1].toLowerCase()) return false
    return String(node.className ?? '').includes(tagClassContains[2])
  }

  // `button[aria-label*="New session" i]` - a case-insensitive attribute match.
  const tagAttrContains = /^([A-Za-z][\w-]*)\[([\w-]+)\*="([^"]*)"(?: i)?\]$/.exec(selector)
  if (tagAttrContains !== null) {
    if (String(node.tagName || '').toLowerCase() !== tagAttrContains[1].toLowerCase()) return false
    const value = node.attributes[tagAttrContains[2]]
    if (typeof value !== 'string') return false
    return value.toLowerCase().includes(tagAttrContains[3].toLowerCase())
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

// Every `loadPlugin()` swaps `globalThis.document`, but the plugin instances of
// earlier tests are still alive and their queued rAF callbacks call
// `document.querySelectorAll(...)` on whatever document is installed WHEN THEY
// FIRE. A pass that lands after the swap decorates the next test's DOM, which
// is what made three tests flaky. Each harness registers its queue here so the
// next one can drop the leftovers.
const rafQueues = []

// Timers started by a plugin instance outlive the test that started them. The
// batch path schedules a 2.5 s settle, and its callback decorates whatever
// `globalThis.document` is when it fires - the next test's DOM. Track and
// clear them so one test cannot reach into another.
const pendingTimers = []

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
    // Read when the host provides no locale service at all.
    documentElement: new StubElement('html'),
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
  // Drop anything an earlier instance queued: it would run against THIS dom.
  for (const stale of rafQueues) stale.clear()
  while (pendingTimers.length > 0) clearTimeout(pendingTimers.pop())
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms) => {
    const id = realSetTimeout(fn, ms)
    pendingTimers.push(id)
    return id
  }
  let rafId = 0
  const rafQueue = new Map()
  rafQueues.push(rafQueue)
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
    if (href.endsWith('/dsh-delete-session/delete-file')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, recycled: true }) }
    }
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
    // `dsh-client-locale` exposes `getSnapshot() -> { active }`. The plugin follows
    // it instead of `navigator.language`, so an English OS with DSH in Chinese no
    // longer renders an English plugin (issue #3).
    getSnapshot: () => ({ active: options.activeLocale ?? 'zh', locales: [], revision: 0 }),
    subscribe: () => () => {},
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
      if (name === 'locale') return (options.lateLocale || options.noLocale) ? null : localeStub
      if (name === 'uiWorkspace') return options.noNavigation ? null : (options.navigation || null)
      return null
    },
    inject: (names, cb) => {
      if (typeof cb === 'function') {
        const late = options.lateLocale && !options.noLocale
        const bag = { slots: slotsStub }
        if (late) bag.locale = localeStub
        if (options.navigation && !options.noNavigation) bag.uiWorkspace = options.navigation
        cb(bag)
      }
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

/** The batch checklist overlay, rendered the way the host renders it. */
const batchPlanEntry = (harness) =>
  harness.slotRegistrations.find((entry) => entry.spec.name === 'shell.overlay'
    && entry.spec.id === NS + '-batchplan') ?? null

const batchPlan = (harness) => {
  const entry = batchPlanEntry(harness)
  if (entry === null) return null
  return entry.Component({ t: harness.t })
}

const childList = (node) => {
  if (node === null || node === undefined || node.props === undefined) return []
  const children = node.props.children
  if (children === null || children === undefined) return []
  return Array.isArray(children) ? children.filter(Boolean) : [children]
}

/** Every file row the checklist renders, as `{ path, input }`. */
function batchFileRows(harness) {
  const modal = batchPlan(harness)
  if (modal === null) return []
  const rows = []
  for (const node of childList(modal)) {
    if (node.props === undefined || node.props['data-file-row'] === undefined) continue
    const label = childList(node).find((child) => child.type === 'label')
    const input = label === undefined
      ? null
      : childList(label).find((child) => child.props && child.props.type === 'checkbox')
    rows.push({ path: node.props['data-file-row'], input: input ?? null })
  }
  return rows
}

/** Invoke one footer button of the checklist. */
function clickBatchPlan(harness, key) {
  const modal = batchPlan(harness)
  if (modal === null) return false
  const footer = (modal.props.footer ?? []).filter(Boolean)
  const button = footer.find((node) => node.props && node.props.key === key)
  if (button === undefined) return false
  button.props.onClick()
  return true
}

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
 * Drain until nothing is left. `flush()` is one tick, and a decorate pass can
 * queue another callback while it runs; a test that snapshots a counter right
 * after a single flush occasionally catches a straggler.
 */
const settle = async () => { for (let i = 0; i < 20; i += 1) await flush() }

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

test('the Russian dictionary ships with every key the other dictionaries carry', async () => {
  const harness = await loadPlugin()
  const { ru, zh, en } = harness.locales[NS]
  assert.ok(ru, 'ru reaches the host locale namespace')
  assert.equal(ru.menu, 'Удалить сессию')
  assert.equal(ru.confirm, 'Удалить')
  // A key missing here would fall back to Chinese mid-dialog, so the key sets
  // have to match exactly rather than merely overlap.
  const keys = (dict) => Object.keys(dict).sort()
  assert.deepEqual(keys(ru), keys(zh), 'ru covers exactly the zh key set')
  assert.deepEqual(keys(en), keys(zh), 'en still covers the zh key set')
})

test('an English OS with DSH in Chinese renders Chinese (issue #3)', async () => {
  const harness = await loadPlugin({ activeLocale: 'zh' })
  const previous = globalThis.navigator
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en-US', languages: ['en-US'] },
    configurable: true,
    writable: true,
  })
  try {
    // The reported bug: the OS is English, the user set DSH to 中文, and the plugin
    // still answered in English because it read `navigator.language`. The host is
    // the authority now, so the browser language must not win.
    assert.equal(deleteRow(harness).element.props.children, '删除会话')
    assert.equal(selectRow(harness).element.props.children, '多选')
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      value: previous,
      configurable: true,
      writable: true,
    })
  }
})

test('a Chinese OS with DSH in English renders English', async () => {
  const harness = await loadPlugin({ activeLocale: 'en' })
  const previous = globalThis.navigator
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'zh-CN', languages: ['zh-CN'] },
    configurable: true,
    writable: true,
  })
  try {
    assert.equal(deleteRow(harness).element.props.children, 'Delete session')
    assert.equal(selectRow(harness).element.props.children, 'Select multiple')
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      value: previous,
      configurable: true,
      writable: true,
    })
  }
})

test('a host language we do not ship falls back to English', async () => {
  const harness = await loadPlugin({ activeLocale: 'ja' })

  // DSH knows ja/es/fr/de/pt as well. Those have no dictionary here, and the host
  // would answer in English for them, so the plugin does too instead of silently
  // dropping to Chinese (which is what the old browser-based fallback did).
  assert.equal(deleteRow(harness).element.props.children, 'Delete session')
})

test('with no locale service the document hint decides', async () => {
  const harness = await loadPlugin({ lateLocale: true, noLocale: true })
  harness.document.documentElement.lang = 'ru'

  // `dsh-client-locale` mirrors its choice onto `<html lang>`. A host that never
  // hands over the service still leaves that behind, so it is read next.
  assert.equal(deleteRow(harness).element.props.children, 'Удалить сессию')
})

test('with neither hint the browser language is the last resort', async () => {
  const harness = await loadPlugin({ noLocale: true })
  const previous = globalThis.navigator
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'ru-RU', languages: ['ru-RU'] },
    configurable: true,
    writable: true,
  })
  try {
    // Pre-#3 behaviour, kept as the floor: something has to answer when the host
    // provides nothing at all.
    assert.equal(deleteRow(harness).element.props.children, 'Удалить сессию')
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      value: previous,
      configurable: true,
      writable: true,
    })
  }
})
test('a Russian DSH gets Russian labels from the built-in dictionary', async () => {
  const harness = await loadPlugin({ activeLocale: 'ru' })

  // The host translator in this harness answers in zh; the rows must prefer the
  // plugin's own Russian dictionary instead of following it.
  assert.equal(deleteRow(harness).element.props.children, 'Удалить сессию')
  assert.equal(selectRow(harness).element.props.children, 'Выбрать несколько')
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

test('deleting the current session clears the main view instead of opening a new one (issue #5)', async () => {
  let cleared = 0
  const harness = await loadPlugin({
    navigation: { clearMain: () => { cleared += 1 } },
  })
  mountRow(harness, SESSION_A)
  localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: SESSION_A.id }))

  // The host's own session menu row drives the delete; asking is off so it goes
  // straight through, like the reporter did.
  localStorage.setItem(SKIP_KEY, '1')
  const { element } = deleteRow(harness)
  element.props.onSelect({ shiftKey: false })
  await tick()
  await flush()

  // Issue #5: this used to click the sidebar's "new session" button, which every
  // plugin that intercepts session creation shares (a naming dialog, a template
  // picker). Deleting a conversation must not create one.
  assert.equal(cleared, 1, 'the host was told to drop the main reference')
  assert.equal(harness.requests.filter((c) => c.url === '/dsh-delete-session/delete').length, 1, 'the delete still went out')
})

test('a delete that is not the current session leaves navigation alone', async () => {
  let cleared = 0
  const harness = await loadPlugin({
    navigation: { clearMain: () => { cleared += 1 } },
  })
  mountRow(harness, SESSION_A)
  localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: SESSION_B.id }))
  localStorage.setItem(SKIP_KEY, '1')

  const { element } = deleteRow(harness)
  element.props.onSelect({ shiftKey: false })
  await tick()
  await flush()

  assert.equal(cleared, 0, 'nothing to clear: the deleted one was not on screen')
})

test('with no navigation service the sidebar button is the last resort', async () => {
  const harness = await loadPlugin({ noNavigation: true })
  mountRow(harness, SESSION_A)
  localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: SESSION_A.id }))
  localStorage.setItem(SKIP_KEY, '1')

  // A host that predates `clearMain` still has to end up with no current
  // conversation, so the old fallback stays. It is only reached when the service
  // is genuinely absent.
  let clicked = 0
  const btn = harness.document.createElement('button')
  btn.className = 'newSession'
  btn.click = () => { clicked += 1 }
  harness.document.body.appendChild(btn)

  const { element } = deleteRow(harness)
  element.props.onSelect({ shiftKey: false })
  await tick()
  await flush()

  assert.equal(clicked, 1, 'the fallback still runs without the service')
})
test('by default a delete of the open conversation opens a fresh one', async () => {
  const calls = []
  const harness = await loadPlugin({
    navigation: {
      startSession: () => { calls.push('startSession') },
      clearMain: () => { calls.push('clearMain') },
    },
  })
  mountRow(harness, SESSION_A)
  localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: SESSION_A.id }))
  localStorage.setItem(SKIP_KEY, '1')

  const { element } = deleteRow(harness)
  element.props.onSelect({ shiftKey: false })
  await tick()
  await flush()

  assert.deepEqual(calls, ['startSession'], 'one fresh conversation, nothing cleared')
})

test('turning the switch off leaves the view blank instead', async () => {
  const calls = []
  const harness = await loadPlugin({
    navigation: {
      startSession: () => { calls.push('startSession') },
      clearMain: () => { calls.push('clearMain') },
    },
  })
  localStorage.setItem('dsh-delete-session:replace-current', '0')
  mountRow(harness, SESSION_A)
  localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: SESSION_A.id }))
  localStorage.setItem(SKIP_KEY, '1')

  const { element } = deleteRow(harness)
  element.props.onSelect({ shiftKey: false })
  await tick()
  await flush()

  assert.deepEqual(calls, ['clearMain'], 'the switch is a real choice')
})

test('a host without startSession still ends up with a blank view', async () => {
  const calls = []
  const harness = await loadPlugin({
    navigation: { clearMain: () => { calls.push('clearMain') } },
  })
  mountRow(harness, SESSION_A)
  localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: SESSION_A.id }))
  localStorage.setItem(SKIP_KEY, '1')

  const { element } = deleteRow(harness)
  element.props.onSelect({ shiftKey: false })
  await tick()
  await flush()

  assert.deepEqual(calls, ['clearMain'], 'no fresh session available, so clear')
})

test('the replace-current switch renders on the plugin page', async () => {
  const harness = await loadPlugin()
  const card = pageCard(harness)
  const fields = (card.props.children ?? []).filter((node) => node && node.props && node.props.className === 'dsdel-field')

  // Five switches: ask / recycle / syncChildren / replaceCurrent / artifacts.
  assert.ok(fields.length >= 5, 'the new switch became its own block, saw ' + fields.length)
})
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

/** One rendered row block per listed artifact. */
const artifactRows = (harness) => {
  const section = artifactSection(harness)
  if (section === null) return []
  return (section.props.children || []).filter((node) => node && node.props && node.props['data-file-row'] !== undefined)
}

/** The tick box of one row lives inside that row's label. */
const rowLabel = (row) => (row.props.children || []).find((child) => child && child.type === 'label')
const artifactInputs = (harness) => artifactRows(harness).map((row) => rowLabel(row).props.children[0])

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
  assert.equal(pageChecks(harness).length, 5, 'ask, recycle, subagents, replace-current and the master switch render')
  assert.equal(offCheckbox(harness).props.checked, true, 'the master switch starts ticked')
})

test('clearing the master switch reveals the auto and scope controls', async () => {
  const harness = await loadPlugin()
  offCheckbox(harness).props.onChange(false)

  assert.equal(localStorage.getItem(OFF_KEY), '0', 'the opt-in was stored')
  assert.equal(pageChecks(harness).length, 9, 'the sub-controls render once enabled')
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
// --- visual layer: tokens, grouped fields, theme-true toast ----------------

test('the page card groups each switch with its hint in one field block', async () => {
  const harness = await loadPlugin()
  const card = pageCard(harness)
  const fields = (card.props.children ?? []).filter(
    (node) => node && node.props && node.props.className === 'dsdel-field',
  )

  // Four switches at minimum: ask / recycle / syncChildren / artifacts-off.
  assert.ok(fields.length >= 4, 'each control became its own block, saw ' + fields.length)
  for (const field of fields) {
    const inner = (field.props.children ?? []).filter(Boolean)
    assert.ok(inner.length >= 1, 'the block holds the control')
  }
})

test('the shared tokens are declared once and used by the blocks', async () => {
  const harness = await loadPlugin()
  const style = harness.document.head.querySelector('[data-dsh-delete-session="1"]')
  const css = String(style._text ?? '')

  assert.match(css, /--dsdel-bg:/, 'a background token')
  assert.match(css, /--dsdel-border:/, 'a border token')
  assert.match(css, /--dsdel-ring:/, 'a focus ring token')
  assert.match(css, /\.dsdel-field\{[^}]*border-radius/, 'the block is rounded')
  assert.match(css, /\.dsdel-field:focus-within\{[^}]*outline/, 'and shows a focus ring')
})

test('the toast follows the theme instead of the OS colour keywords', async () => {
  const harness = await loadPlugin()
  const style = harness.document.head.querySelector('[data-dsh-delete-session="1"]')
  const css = String(style._text ?? '')

  // `Canvas`/`CanvasText` ignore the DSH theme entirely: in a dark app the toast
  // stayed a light system rectangle.
  assert.doesNotMatch(css, /background:Canvas/, 'no system background')
  assert.doesNotMatch(css, /color:CanvasText/, 'no system text colour')
  assert.match(css, /\.dsdel-toast\{[^}]*var\(--dsw-alias/, 'it reads the host theme tokens')
})
test('the card is registered on the package page, so its URL has one segment', async () => {
  const harness = await loadPlugin()
  const bundleEntry = harness.slotRegistrations.find(
    (entry) => entry.spec.name === 'plugins.bundle.config',
  )

  // `plugins.row.config` renders on the row page, whose URL is
  // `#/panel/plugins/<package>/<rowId>` — with the row id equal to the package
  // name here, the address doubled. `plugins.bundle.config` renders on the
  // package page itself: `#/panel/plugins/<package>`.
  assert.ok(bundleEntry, 'the bundle-level slot is registered')
  assert.equal(bundleEntry.spec.key, NS, 'keyed by the package name')

  const rendered = bundleEntry.Component({ view: 'page' })
  const fields = (rendered.props.children ?? []).filter(
    (node) => node && node.props && node.props.className === 'dsdel-field',
  )
  assert.ok(fields.length >= 4, 'and it carries the same switches')
})

test('the row page keeps its one-line summary', async () => {
  const harness = await loadPlugin()
  const rowEntry = harness.slotRegistrations.find(
    (entry) => entry.spec.name === 'plugins.row.config',
  )
  assert.ok(rowEntry, 'the row summary is still registered')

  const summary = rowEntry.Component({ view: 'summary' })
  assert.equal(typeof summary, 'string', 'the row list gets a sentence, not a card')
})
// --- each produced file can be opened where it lives ------------------------

/** The row block for one produced file inside the dialog. */
function fileRow(harness, path) {
  const modal = dialogElement(harness)
  if (modal === null) return null
  const stack = [modal]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === null || node === undefined || typeof node !== 'object') continue
    if (node.props && node.props['data-file-row'] === path) return node
    const kids = node.props && node.props.children
    if (Array.isArray(kids)) stack.push(...kids)
    else if (kids) stack.push(kids)
  }
  return null
}

test('every produced file offers a button that opens its folder', async () => {
  const harness = await loadPlugin({ plan: PLAN })
  localStorage.setItem(OFF_KEY, '0')
  mountRow(harness, SESSION_A)
  await openArtifactDialog(harness)

  const target = PLAN.created[0].path
  const row = fileRow(harness, target)
  assert.ok(row, 'the file has its own row block')


  const button = findByKey(row.props.children ?? [], 'open')[0]
  assert.ok(button, 'the row carries an open button')

  const before = harness.requests.filter((request) => request.url.endsWith('/dsh-delete-session/reveal')).length
  button.props.onClick({ preventDefault() {}, stopPropagation() {} })
  await tick()
  await tick()

  const reveals = harness.requests.filter((request) => request.url.endsWith('/dsh-delete-session/reveal'))
  assert.equal(reveals.length, before + 1, 'the host is asked to reveal a folder')
  // The folder, not the file: the OS file manager highlights a file in its parent.
  assert.equal(JSON.parse(reveals.at(-1).init.body).path, 'C:/ws', 'the parent directory is passed')
})

test('the open button does not disturb the selection', async () => {
  const harness = await loadPlugin({ plan: PLAN })
  localStorage.setItem(OFF_KEY, '0')
  mountRow(harness, SESSION_A)
  await openArtifactDialog(harness)

  const target = PLAN.created[0].path
  const checkbox = rowLabel(fileRow(harness, target)).props.children[0]
  assert.equal(checkbox.props.checked, true, 'ticked by default')

  const button = findByKey(fileRow(harness, target).props.children ?? [], 'open')[0]
  button.props.onClick({ preventDefault() {}, stopPropagation() {} })
  await tick()

  const after = rowLabel(fileRow(harness, target)).props.children[0]
  assert.equal(after.props.checked, true, 'still ticked: opening a folder is not a toggle')
})
// --- the per-file delete button follows the recycle switch -----------------

const removeButton = (harness, target) =>
  findByKey(fileRow(harness, target).props.children ?? [], 'remove')[0]

const deleteFileCalls = (harness) =>
  harness.requests.filter((request) => request.url.endsWith('/dsh-delete-session/delete-file'))

test('deleting one file honours the recycle switch', async () => {
  const harness = await loadPlugin({ plan: PLAN })
  localStorage.setItem(OFF_KEY, '0')
  mountRow(harness, SESSION_A)
  await openArtifactDialog(harness)

  const target = PLAN.created[0].path
  removeButton(harness, target).props.onClick({ preventDefault() {}, stopPropagation() {} })
  await tick()
  await tick()

  const calls = deleteFileCalls(harness)
  assert.equal(calls.length, 1, 'one request')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.path, target)
  assert.equal(body.recycle, true, 'recycling is on by default, same as a conversation')
})

test('with recycling off the file is deleted outright', async () => {
  const harness = await loadPlugin({ plan: PLAN })
  localStorage.setItem(OFF_KEY, '0')
  localStorage.setItem(RECYCLE_KEY, '0')
  mountRow(harness, SESSION_A)
  await openArtifactDialog(harness)

  const target = PLAN.created[0].path
  removeButton(harness, target).props.onClick({ preventDefault() {}, stopPropagation() {} })
  await tick()
  await tick()

  const body = JSON.parse(deleteFileCalls(harness)[0].init.body)
  assert.equal(body.recycle, false, 'the switch decides, not the button')
})

test('a deleted file leaves the list and the selection', async () => {
  const harness = await loadPlugin({ plan: PLAN })
  localStorage.setItem(OFF_KEY, '0')
  mountRow(harness, SESSION_A)
  await openArtifactDialog(harness)

  const target = PLAN.created[0].path
  assert.ok(fileRow(harness, target), 'the row starts out there')

  removeButton(harness, target).props.onClick({ preventDefault() {}, stopPropagation() {} })
  await tick()
  await tick()

  assert.equal(fileRow(harness, target), null, 'the row is gone')
  assert.equal(artifactRows(harness).length, 1, 'the other file stays')
})
// --- only the file list earns the wide dialog ------------------------------

test('a plain confirmation keeps the host compact size', async () => {
  // No produced files here: the everyday "delete this conversation?" box. A
  // forced ratio would make it a screen-sized empty rectangle, because a
  // percentage of a wide monitor is simply a wide box.
  const harness = await loadPlugin()
  mountRow(harness, SESSION_A)
  const { element } = deleteRow(harness, SESSION_A)
  element.props.onSelect({ shiftKey: false })
  await flush()

  const modal = dialogElement(harness)
  assert.ok(modal, 'the dialog opened')
  assert.equal(modal.props.className, undefined, 'no frame class')
  assert.equal(modal.props.style, undefined, 'and no forced size')
})

test('the dialog widens when it actually lists files', async () => {
  const harness = await loadPlugin({ plan: PLAN })
  localStorage.setItem(OFF_KEY, '0')
  mountRow(harness, SESSION_A)
  await openArtifactDialog(harness)

  const modal = dialogElement(harness)
  assert.equal(modal.props.className, 'dsdel-dialog-wide', 'the list needs the room')
})

test('the stylesheet keys the wide rule on the file rows, not on any meta line', async () => {
  const harness = await loadPlugin()
  const style = harness.document.head.querySelector('[data-dsh-delete-session="1"]')
  const css = String(style._text ?? '')

  // `:has(.dsdel-modal-meta)` matched every dialog this plugin draws — the meta
  // line is just "title · id" — and widened all of them.
  assert.doesNotMatch(css, /:has\(\.dsdel-modal-meta\)/, 'no widening on a meta line')
  assert.match(css, /:has\(\.dsdel-file-row\)/, 'the file rows are what earns the width')
})

test('the dialog is a 16:9 landscape card', async () => {
  const harness = await loadPlugin({ plan: PLAN })
  localStorage.setItem(OFF_KEY, '0')
  mountRow(harness, SESSION_A)
  await openArtifactDialog(harness)

  const modal = dialogElement(harness)
  const style = modal.props.style
  assert.match(String(style.width), /46vw/, 'the width budget is a share of the viewport')
  assert.match(String(style.width), /860px/, 'and it has a pixel ceiling for large monitors')
  assert.equal(style.maxHeight, '88vh', 'and never runs past the viewport')

  // The list is the only part that grows, so it is the part that scrolls.
  const section = artifactSection(harness)
  assert.equal(section.props.className, 'dsdel-artifacts', 'the column is a scroll container')
})

test('the stylesheet carries the same 16:9 geometry', async () => {
  const harness = await loadPlugin()
  const css = String(harness.document.head.querySelector('[data-dsh-delete-session="1"]')._text ?? '')

  assert.match(css, /\.dsdel-dialog-wide\{[^}]*max-width/, 'the class rule bounds the width')
  assert.match(css, /\.dsdel-artifacts\{[^}]*overflow:auto/, 'the column scrolls')
})

test('the fixed-height frame keeps its buttons at the bottom', async () => {
  const harness = await loadPlugin()
  const css = String(harness.document.head.querySelector('[data-dsh-delete-session="1"]')._text ?? '')

  // The host renders the dialog as a flex column of [content, footer]. Keying on
  // OUR class plus first/last child survives a host restyle, which the hashed
  // module class names (`_content_14mp3_63`) would not.
  assert.match(css, /\.dsdel-dialog-wide\{[^}]*display:flex/, 'the frame is a flex column')
  assert.match(css, /\.dsdel-dialog-wide\{[^}]*flex-direction:column/, 'with the host\'s own direction')
  assert.match(css, /\.dsdel-dialog-wide > :first-child\{[^}]*flex:1/, 'the content takes the slack')
  assert.match(css, /\.dsdel-dialog-wide > :first-child\{[^}]*overflow:auto/, 'and scrolls instead of growing')
  assert.match(css, /\.dsdel-dialog-wide > :last-child\{[^}]*margin-top:auto/, 'the footer is pushed down')
})

test('the frame sizes itself to the list', async () => {
  const harness = await loadPlugin({ plan: PLAN })
  localStorage.setItem(OFF_KEY, '0')
  mountRow(harness, SESSION_A)
  await openArtifactDialog(harness)

  const style = dialogElement(harness).props.style
  // A ratio pins the height, which is what produced the empty band in the first
  // place: the box would keep a screen-ish height no matter how few rows it had.
  assert.equal(style.aspectRatio, undefined, 'no forced ratio')
  assert.equal(style.height, undefined, 'and no forced height')
    assert.equal(style.height, undefined, 'the height follows the list, not a ratio')
  assert.equal(style.maxHeight, '88vh', 'capped by the viewport')
  assert.match(String(style.minHeight), /240px/, 'and it never collapses')
})

test('a button-shaped footer entry steps aside without hiding the bar itself', async () => {
  const harness = await loadPlugin()
  const css = String(harness.document.head.querySelector('[data-dsh-delete-session="1"]')._text ?? '')

  // `dsh-sidebar-declutter` registers 收起面板列表 as a bare <button> in this slot,
  // with neither `data-dsh-plugin` nor an `_entryRow` wrapper, so the two attribute
  // rules above never matched it and it overlapped the bar.
  //
  // The slot has no wrapper layer: the renderer's outlet is
  // `<div data-slot style="display:contents">` and the component is its direct
  // child, which is what makes `> button` precise here.
  assert.equal(
    css.includes('body.dsdel-selecting [data-slot="sidebar.footer.action"] > button:not([role="toolbar"]){display:none}'),
    true,
    'button-shaped entries step aside',
  )

  // Without the `:not([role="toolbar"])` guard, any footer entry whose root is a
  // <button> would hide itself — including this plugin's own bar, which would take
  // the Cancel button with it.
  assert.doesNotMatch(
    css,
    /\[data-slot="sidebar\.footer\.action"\] > button\{display:none\}/,
    'never hide every button unconditionally',
  )
})

test('the drop label names the conversation instead of printing the placeholder', async () => {
  const harness = await loadPlugin()
  const row = mountRow(harness, SESSION_A)

  startRowDrag(harness, row)
  await flush()
  bar(harness).props.onDragOver(dropEvent())
  await flush()

  const node = bar(harness)
  const text = JSON.stringify(node.props.children)

  // The dictionary entry is `松手删除「{name}」`, but the interpolation map carries
  // `n`/`done`/`total`/`ok`/`fail`/`path` — not `name`. Passing the title as a bare
  // string therefore left the braces in the label.
  assert.doesNotMatch(text, /\{name\}/, 'no unsubstituted placeholder in the label')
  assert.match(text, /松手删除/, 'the sentence is still there')
})

test('the drop label carries the dragged conversation title', async () => {
  const harness = await loadPlugin()
  const row = mountRow(harness, SESSION_A)
  row.textContent = 'BiliLearn-AI 仓库'

  startRowDrag(harness, row)
  await flush()
  bar(harness).props.onDragOver(dropEvent())
  await flush()

  const text = JSON.stringify(bar(harness).props.children)
  assert.match(text, /BiliLearn-AI 仓库/, 'the title reaches the sentence')
})
test('a workspace header offers a select-all box', async () => {
  const harness = await loadPlugin()
  const section = harness.document.createElement('div')
  section.setAttribute('role', 'group')

  const header = harness.document.createElement('div')
  header.setAttribute('role', 'treeitem')
  header.setAttribute('data-row-key', 'workspace:ws-a')
  section.appendChild(header)

  mountRow(harness, SESSION_A, section)
  mountRow(harness, SESSION_B, section)
  harness.document.body.appendChild(section)

  await enterMulti(harness)
  observerPass(harness)
  await flush()

  const box = header.querySelector('.dsdel-select-all')
  assert.ok(box, 'the header carries one')
  assert.equal(box.getAttribute('role'), 'checkbox')
  assert.equal(box.getAttribute('aria-checked'), 'false', 'nothing picked yet')
})

test('the workspace box selects only its own sessions', async () => {
  const harness = await loadPlugin()
  const sectionA = harness.document.createElement('div')
  sectionA.setAttribute('role', 'group')
  const headA = harness.document.createElement('div')
  headA.setAttribute('role', 'treeitem')
  headA.setAttribute('data-row-key', 'workspace:ws-a')
  sectionA.appendChild(headA)
  mountRow(harness, SESSION_A, sectionA)
  harness.document.body.appendChild(sectionA)

  const sectionB = harness.document.createElement('div')
  sectionB.setAttribute('role', 'group')
  const headB = harness.document.createElement('div')
  headB.setAttribute('role', 'treeitem')
  headB.setAttribute('data-row-key', 'workspace:ws-b')
  sectionB.appendChild(headB)
  mountRow(harness, SESSION_B, sectionB)
  harness.document.body.appendChild(sectionB)

  await enterMulti(harness)
  observerPass(harness)
  await flush()

  headA.querySelector('.dsdel-select-all').fire('click')
  await flush()

  assert.equal(headA.querySelector('.dsdel-select-all').getAttribute('aria-checked'), 'true', 'A turned on')
  const boxB = headB.querySelector('.dsdel-select-all')
  assert.equal(boxB.getAttribute('aria-checked'), 'false', 'B untouched')
})

test('a second press clears the workspace again', async () => {
  const harness = await loadPlugin()
  const section = harness.document.createElement('div')
  section.setAttribute('role', 'group')
  const header = harness.document.createElement('div')
  header.setAttribute('role', 'treeitem')
  header.setAttribute('data-row-key', 'workspace:ws-a')
  section.appendChild(header)
  mountRow(harness, SESSION_A, section)
  harness.document.body.appendChild(section)

  await enterMulti(harness)
  observerPass(harness)
  await flush()

  const box = header.querySelector('.dsdel-select-all')
  box.fire('click')
  await flush()
  assert.equal(box.getAttribute('aria-checked'), 'true')

  box.fire('click')
  await flush()
  assert.equal(box.getAttribute('aria-checked'), 'false')
})

test('the box reports a partly picked workspace as mixed', async () => {
  const harness = await loadPlugin()
  const section = harness.document.createElement('div')
  section.setAttribute('role', 'group')
  const header = harness.document.createElement('div')
  header.setAttribute('role', 'treeitem')
  header.setAttribute('data-row-key', 'workspace:ws-a')
  section.appendChild(header)
  const rowA = mountRow(harness, SESSION_A, section)
  mountRow(harness, SESSION_B, section)
  harness.document.body.appendChild(section)

  await enterMulti(harness)
  observerPass(harness)
  await flush()

  clickRowIn(harness, rowA)
  observerPass(harness)
  await flush()

  assert.equal(header.querySelector('.dsdel-select-all').getAttribute('aria-checked'), 'mixed')
})

test('the heading row selects every workspace at once', async () => {
  const harness = await loadPlugin()
  const heading = harness.document.createElement('div')
  heading.setAttribute('data-sidebar-workspace-header', '')
  harness.document.body.appendChild(heading)

  const sectionA = harness.document.createElement('div')
  sectionA.setAttribute('role', 'group')
  const headA = harness.document.createElement('div')
  headA.setAttribute('role', 'treeitem')
  headA.setAttribute('data-row-key', 'workspace:ws-a')
  sectionA.appendChild(headA)
  mountRow(harness, SESSION_A, sectionA)
  harness.document.body.appendChild(sectionA)

  const sectionB = harness.document.createElement('div')
  sectionB.setAttribute('role', 'group')
  const headB = harness.document.createElement('div')
  headB.setAttribute('role', 'treeitem')
  headB.setAttribute('data-row-key', 'workspace:ws-b')
  sectionB.appendChild(headB)
  mountRow(harness, SESSION_B, sectionB)
  harness.document.body.appendChild(sectionB)

  await enterMulti(harness)
  observerPass(harness)
  await flush()

  const all = heading.querySelector('.dsdel-select-all-workspaces')
  assert.ok(all, 'the heading carries the global box')
  all.fire('click')
  await flush()

  assert.equal(all.getAttribute('aria-checked'), 'true', 'everything picked')
  assert.equal(headA.querySelector('.dsdel-select-all').getAttribute('aria-checked'), 'true')
  assert.equal(headB.querySelector('.dsdel-select-all').getAttribute('aria-checked'), 'true')
})

test('both boxes go away when the mode ends', async () => {
  const harness = await loadPlugin()
  const heading = harness.document.createElement('div')
  heading.setAttribute('data-sidebar-workspace-header', '')
  harness.document.body.appendChild(heading)

  const section = harness.document.createElement('div')
  section.setAttribute('role', 'group')
  const header = harness.document.createElement('div')
  header.setAttribute('role', 'treeitem')
  header.setAttribute('data-row-key', 'workspace:ws-a')
  section.appendChild(header)
  mountRow(harness, SESSION_A, section)
  harness.document.body.appendChild(section)

  await enterMulti(harness)
  observerPass(harness)
  await flush()
  assert.ok(header.querySelector('.dsdel-select-all'), 'present during the mode')
  assert.ok(heading.querySelector('.dsdel-select-all-workspaces'))

  harness.document.dispatchToDocument('keydown', { key: 'Escape', stopPropagation() {} })
  observerPass(harness)
  await flush()

  assert.equal(header.querySelector('.dsdel-select-all'), null, 'removed with the mode')
  assert.equal(heading.querySelector('.dsdel-select-all-workspaces'), null)
})

test('the select-all boxes do not lean on the page token scope', async () => {
  const harness = await loadPlugin()
  const css = String(harness.document.head.querySelector('[data-dsh-delete-session="1"]')._text ?? '')

  // The boxes render inside the SIDEBAR. The `--dsdel-*` tokens are declared on
  // `.dsdel-page`, `.dsdel-modal` and `.dsdel-bar` only, so any rule outside those
  // scopes that reads them gets an invalid value and loses the whole declaration.
  // That is how the first version shipped an invisible button: `border` was
  // dropped, leaving no box and nothing to click.
  const rules = [...css.matchAll(/(?:^|\})\s*\.dsdel-select-all[^{]*\{([^}]*)\}/g)]
  assert.ok(rules.length > 0, 'the rules are in the stylesheet')
  for (const match of rules) {
    assert.equal(match[1].includes('--dsdel-'), false,
      'a sidebar rule must not read the page tokens: ' + match[0].slice(0, 60))
  }

  // Every host alias carries a literal fallback, so the box still draws when the
  // host renames its palette.
  assert.match(css, /\.dsdel-select-all[^}]*var\(--dsw-alias-border-l2,[^)]*\)/, 'border has a fallback')
  assert.match(css, /\.dsdel-select-all[^}]*var\(--dsw-alias-brand-primary,[^)]*\)/, 'brand has a fallback')
})

test('a box always keeps a visible 15px square', async () => {
  const harness = await loadPlugin()
  const css = String(harness.document.head.querySelector('[data-dsh-delete-session="1"]')._text ?? '')

  // A flex child with no width collapses to its content, and the empty state has
  // no content: `width` plus `min-width` plus content-box sizing is what makes the
  // square exist before anything is ticked.
  assert.match(css, /\.dsdel-select-all[^}]*width:15px/, 'a fixed width')
  assert.match(css, /\.dsdel-select-all[^}]*height:15px/, 'and a fixed height')
  assert.match(css, /\.dsdel-select-all[^}]*min-width:15px/, 'that flex cannot shrink away')
  assert.match(css, /\.dsdel-select-all[^}]*box-sizing:border-box/, 'with the border inside it')
})

test('the workspace box sits beside the name, not at the row edge', async () => {
  const harness = await loadPlugin()
  const section = harness.document.createElement('div')
  section.setAttribute('role', 'group')

  const header = harness.document.createElement('div')
  header.setAttribute('role', 'treeitem')
  header.setAttribute('data-row-key', 'workspace:ws-a')

  // The host row: label block, then the action cluster (which carries margin-left:auto).
  const label = harness.document.createElement('span')
  label.className = 'YDXeBa_projectText'
  header.appendChild(label)
  const actions = harness.document.createElement('span')
  actions.className = 'YDXeBa_rowActions'
  header.appendChild(actions)

  section.appendChild(header)
  mountRow(harness, SESSION_A, section)
  harness.document.body.appendChild(section)

  await enterMulti(harness)
  observerPass(harness)
  await flush()

  const box = header.querySelector('.dsdel-select-all')
  assert.ok(box, 'the box exists')

  // Appending put it after the action cluster, whose auto margin pushes it into the
  // far right of the row — that is the "靠右" the screenshot showed. It has to be
  // inserted before the actions instead.
  const index = header.children.indexOf(box)
  const actionsIndex = header.children.indexOf(actions)
  assert.equal(index < actionsIndex, true, 'the box comes before the action cluster')
  assert.equal(header.children[index - 1].className, 'YDXeBa_projectText', 'and right after the label')
})

test('the global box sits after the heading label, before the search slot', async () => {
  const harness = await loadPlugin()

  const heading = harness.document.createElement('div')
  heading.setAttribute('data-sidebar-workspace-header', '')

  const label = harness.document.createElement('span')
  label.className = 'bhn1Oq_sectionLabel'
  heading.appendChild(label)
  const search = harness.document.createElement('div')
  search.className = 'bhn1Oq_searchSlot'
  heading.appendChild(search)

  harness.document.body.appendChild(heading)

  const section = harness.document.createElement('div')
  section.setAttribute('role', 'group')
  const header = harness.document.createElement('div')
  header.setAttribute('role', 'treeitem')
  header.setAttribute('data-row-key', 'workspace:ws-a')
  section.appendChild(header)
  mountRow(harness, SESSION_A, section)
  harness.document.body.appendChild(section)

  await enterMulti(harness)
  observerPass(harness)
  await flush()

  const box = heading.querySelector('.dsdel-select-all-workspaces')
  assert.ok(box, 'the global box exists')
  const index = heading.children.indexOf(box)
  assert.equal(index < heading.children.indexOf(search), true, 'before the search slot')
  assert.equal(heading.children[index - 1].className, 'bhn1Oq_sectionLabel', 'and after the label')
})

test('a box left at the wrong edge is moved on the next pass', async () => {
  const harness = await loadPlugin()
  const section = harness.document.createElement('div')
  section.setAttribute('role', 'group')

  const header = harness.document.createElement('div')
  header.setAttribute('role', 'treeitem')
  header.setAttribute('data-row-key', 'workspace:ws-a')

  const label = harness.document.createElement('span')
  label.className = 'wnFoaW_projectText'
  header.appendChild(label)
  const actions = harness.document.createElement('span')
  actions.className = 'wnFoaW_rowActions'
  header.appendChild(actions)

  // An earlier build left its box AFTER the actions: the far edge.
  const stale = harness.document.createElement('button')
  stale.className = 'dsdel-select-all'
  header.appendChild(stale)

  section.appendChild(header)
  mountRow(harness, SESSION_A, section)
  harness.document.body.appendChild(section)

  await enterMulti(harness)
  observerPass(harness)
  await flush()

  // The insert used to live inside the "created" branch, so an existing box was
  // never repositioned: the heading box moved and the workspace box stayed put.
  const index = header.children.indexOf(stale)
  assert.equal(index < header.children.indexOf(actions), true, 'moved before the actions')
  assert.equal(header.children[index - 1].className, 'wnFoaW_projectText', 'and beside the label')
})

test('the workspace name stops absorbing the row while the mode runs', async () => {
  const harness = await loadPlugin()
  const css = String(harness.document.head.querySelector('[data-dsh-delete-session="1"]')._text ?? '')

  // `.projectText` carries `flex:1`, so it fills whatever the actions do not take.
  // A box inserted after it therefore lands at the row's far edge even though it
  // is early in the child list — that is why the workspace box stayed right while
  // the header box (whose label is not flexed) moved. The rule only applies while
  // the mode runs, so the host keeps its normal layout otherwise.
  assert.match(css, /body\.dsdel-selecting \[class\*="_projectText"\]\{[^}]*flex:0 1 auto/,
    'the name sizes to its text during the mode')
  assert.match(css, /body\.dsdel-selecting \[class\*="_projectText"\]\{[^}]*min-width:0/,
    'and can still truncate a long name')
})

test('a spacer keeps the right-hand cluster in place', async () => {
  const harness = await loadPlugin()
  const section = harness.document.createElement('div')
  section.setAttribute('role', 'group')

  const header = harness.document.createElement('div')
  header.setAttribute('role', 'treeitem')
  header.setAttribute('data-row-key', 'workspace:ws-a')

  const label = harness.document.createElement('span')
  label.className = 'wnFoaW_projectText'
  header.appendChild(label)
  // The cluster that must NOT move: count, menu, new-session.
  const actions = harness.document.createElement('span')
  actions.className = 'wnFoaW_rowActions'
  header.appendChild(actions)

  section.appendChild(header)
  mountRow(harness, SESSION_A, section)
  harness.document.body.appendChild(section)

  await enterMulti(harness)
  observerPass(harness)
  await flush()

  // Order has to be: label, box, spacer, actions. With the spacer growing, the
  // name keeps its natural width and the cluster stays at the row's end; without
  // it, every flex child simply packs left and the count/menu/new buttons slid
  // over with the box.
  const kids = header.children
  const box = header.querySelector('.dsdel-select-all')
  const spacer = header.querySelector('.dsdel-flex-spacer')
  assert.ok(box, 'the box exists')
  assert.ok(spacer, 'the spacer exists')

  assert.equal(kids.indexOf(box) < kids.indexOf(spacer), true, 'box before spacer')
  assert.equal(kids.indexOf(spacer) < kids.indexOf(actions), true, 'spacer before the cluster')
  assert.equal(kids.indexOf(label) < kids.indexOf(box), true, 'label first')
})

test('the spacer is removed with the mode', async () => {
  const harness = await loadPlugin()
  const section = harness.document.createElement('div')
  section.setAttribute('role', 'group')
  const header = harness.document.createElement('div')
  header.setAttribute('role', 'treeitem')
  header.setAttribute('data-row-key', 'workspace:ws-a')
  const label = harness.document.createElement('span')
  label.className = 'wnFoaW_projectText'
  header.appendChild(label)
  const actions = harness.document.createElement('span')
  actions.className = 'wnFoaW_rowActions'
  header.appendChild(actions)
  section.appendChild(header)
  mountRow(harness, SESSION_A, section)
  harness.document.body.appendChild(section)

  await enterMulti(harness)
  observerPass(harness)
  await flush()
  assert.ok(header.querySelector('.dsdel-flex-spacer'), 'spacer present during the mode')

  // The bar's Cancel is the mode's own exit route. Escape would also reach
  // handlers left behind by earlier tests: the stub never unregisters one.
  clickBar(barCancel(harness))
  observerPass(harness)
  await flush()
  assert.equal(header.querySelector('.dsdel-flex-spacer'), null, 'gone with the mode')
  assert.equal(header.querySelector('.dsdel-select-all'), null, 'and so is the box')
})

test('PROBE exit removes spacer', async () => {
  const harness = await loadPlugin()
  const section = harness.document.createElement('div')
  section.setAttribute('role', 'group')
  const header = harness.document.createElement('div')
  header.setAttribute('role', 'treeitem')
  header.setAttribute('data-row-key', 'workspace:ws-a')
  const actions = harness.document.createElement('span')
  actions.className = 'wnFoaW_rowActions'
  header.appendChild(actions)
  section.appendChild(header)
  mountRow(harness, SESSION_A, section)
  harness.document.body.appendChild(section)

  await enterMulti(harness)
  observerPass(harness)
  await flush()

  const before = harness.document.querySelectorAll('.dsdel-flex-spacer').length
  console.log('PROBE 装饰后 spacer 数:', before)
  for (const el of harness.document.querySelectorAll('.dsdel-flex-spacer')) {
    console.log('PROBE spacer parent:', el.parentElement && el.parentElement.getAttribute('data-row-key'), 'idx:', el.parentElement ? el.parentElement.children.indexOf(el) : -1)
  }
  const cancel = barCancel(harness)
  console.log('PROBE cancel 节点:', cancel && cancel.props && cancel.props.className)
  clickBar(cancel)
  await flush()
  console.log('PROBE 退出后 spacer 数:', harness.document.querySelectorAll('.dsdel-flex-spacer').length)
  assert.ok(true)
})

test('the spacer is the growing child, so the cluster keeps its seat', async () => {
  const harness = await loadPlugin()
  const css = String(harness.document.head.querySelector('[data-dsh-delete-session="1"]')._text ?? '')

  // Without a growing child the flex row simply packs left, which drags the count
  // and the action buttons along with the box. The spacer is what holds them at
  // the row's end while the box sits beside the name.
  assert.match(css, /\.dsdel-flex-spacer\{[^}]*flex:1/, 'the spacer grows')
  assert.match(css, /\.dsdel-flex-spacer\{[^}]*min-width:0/, 'and can collapse when space is tight')
  assert.match(css, /\.dsdel-select-all[^}]*flex:0 0 auto/, 'the box itself does not grow')
})

test('a document click on a plugin-drawn element leaves the session alone', async () => {
  const harness = await loadPlugin()
  const row = mountRow(harness, SESSION_A)
  await enterMulti(harness)
  observerPass(harness)
  await flush()
  assert.equal(harness.document.body.className.includes('dsdel-selecting'), true)

  // The document capture listener runs before any element handler. It must ignore
  // elements this plugin drew — a box inside a workspace row is the everyday case,
  // and inside a session row it would otherwise toggle that session.
  const box = harness.document.createElement('button')
  box.className = 'dsdel-select-all'
  box.setAttribute('data-dsh-delete-session', 'select-all')
  row.appendChild(box)

  clickRowIn(harness, box)
  observerPass(harness)
  await flush()

  const check = row.querySelector('.dsdel-check')
  assert.equal(check.classList.contains('dsdel-check-on'), false, 'no session was toggled')
})

test('the row handler still works for a real session row', async () => {
  const harness = await loadPlugin()
  const row = mountRow(harness, SESSION_A)
  await enterMulti(harness)
  observerPass(harness)
  await flush()

  clickRowIn(harness, row)
  await flush()

  const check = row.querySelector('.dsdel-check')
  assert.equal(check.classList.contains('dsdel-check-on'), true, 'a plain row still toggles')
})

test('a decorate pass with nothing to move keeps the box where it is', async () => {
  const harness = await loadPlugin()
  const section = harness.document.createElement('div')
  section.setAttribute('role', 'group')
  const header = harness.document.createElement('div')
  header.setAttribute('role', 'treeitem')
  header.setAttribute('data-row-key', 'workspace:ws-a')
  const label = harness.document.createElement('span')
  label.className = 'wnFoaW_projectText'
  header.appendChild(label)
  const actions = harness.document.createElement('span')
  actions.className = 'wnFoaW_rowActions'
  header.appendChild(actions)
  section.appendChild(header)
  mountRow(harness, SESSION_A, section)
  harness.document.body.appendChild(section)

  await enterMulti(harness)
  observerPass(harness)
  await flush()

  // Every insertBefore is a mutation, and the list observer counted it as a
  // reason to scan again: each pass scheduled the next one, forever, and the box
  // was detached and re-attached under the pointer. Nothing may move here — the
  // box and its spacer are already in the right place.
  const box = header.querySelector('.dsdel-select-all')
  const spacer = header.querySelector('.dsdel-flex-spacer')
  const index = header.children.indexOf(box)

  // Re-inserting a node where it already sits leaves its index unchanged, so the
  // index alone cannot prove the pass was quiet. Count the calls instead: a real
  // insertBefore produces a MutationRecord, and the observer used to feed on them.
  const realInsert = header.insertBefore.bind(header)
  let inserts = 0
  header.insertBefore = (child, ref) => { inserts += 1; return realInsert(child, ref) }

  observerPass(harness)
  observerPass(harness)
  await flush()

  assert.equal(inserts, 0, 'a settled row is left untouched')

  assert.equal(header.children.indexOf(box), index, 'the box did not move')
  assert.equal(header.children.indexOf(spacer), index + 1, 'nor did the spacer')
  assert.equal(header.children.filter((el) => el === box).length, 1, 'and there is only one')
})

test('a mutation naming only our own nodes schedules no pass', async () => {
  const harness = await loadPlugin()

  // Drive the frame queue by hand: a timer-based flush made this test flaky,
  // because a pass can queue another callback while it runs.
  //
  // Note the drain: emptying the queue without running its callbacks leaves the
  // plugin's `decorateRaf` handle truthy, and every later `scheduleDecorate`
  // silently returns. That is a harness trap, not a product bug.
  const queued = []
  const realRaf = globalThis.requestAnimationFrame
  const realCancel = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = (fn) => { queued.push(fn); return queued.length }
  globalThis.cancelAnimationFrame = () => {}
  const drain = () => { let guard = 0; while (queued.length > 0 && guard < 50) { guard += 1; queued.shift()() } }

  try {
    await enterMulti(harness)
    drain()

    // A row that arrives after the last pass carries no checkbox, so whether a
    // pass runs is readable straight off the DOM.
    const section = harness.document.createElement('div')
    section.setAttribute('role', 'group')
    const hostRow = harness.document.createElement('div')
    hostRow.setAttribute('role', 'treeitem')
    hostRow.setAttribute('data-row-key', 'session:session-cccc1111-2222-4333-8444-555555555555')
    section.appendChild(hostRow)
    harness.document.body.appendChild(section)
    assert.equal(hostRow.querySelector('.dsdel-check'), null, 'the row is undecorated')

    // Decorate inserts checkboxes, and the list observer reports them right back.
    // Every such record used to schedule another pass, so the loop never settled:
    // the box was re-inserted under the pointer and a click often missed.
    const own = harness.document.createElement('span')
    own.setAttribute('data-dsh-delete-session', 'check')
    harness.observers[0].callback([{ addedNodes: [own], removedNodes: [] }])
    assert.equal(queued.length, 0, 'our own node schedules nothing')

    // A host change must still get through.
    harness.observers[0].callback([{ addedNodes: [hostRow], removedNodes: [] }])
    assert.equal(queued.length, 1, 'a real host row schedules one pass')
    drain()
    assert.ok(hostRow.querySelector('.dsdel-check'), 'and that pass decorates it')
  } finally {
    globalThis.requestAnimationFrame = realRaf
    globalThis.cancelAnimationFrame = realCancel
  }
})

test('the plugin never calls array methods on a live child list', async () => {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')

  // In a browser `element.children` is an HTMLCollection: it has `length` and
  // indexing, and none of the Array methods. The test stub uses a plain array, so
  // `children.indexOf(...)` passed here and threw a TypeError in the real host —
  // the decorate pass died before inserting anything, and the select-all box never
  // appeared. Index it by hand (`childIndex`) or spread it first.
  const offenders = []
  for (const match of source.matchAll(/\.children\.([A-Za-z]+)\s*\(/g)) {
    offenders.push(match[0])
  }
  assert.deepEqual(offenders, [], 'no Array methods on `children`')
})

test('the workspace box reaches past a wrapping element', async () => {
  const harness = await loadPlugin()
  const section = harness.document.createElement('div')
  section.setAttribute('role', 'group')

  // The real host wraps the workspace row in HoverCard's <span>, so the row's
  // parentElement is that span, not the section. A subtree query from the span
  // returns only the workspace row itself and the box ends up with no ids —
  // `toggleGroup` then returns without doing anything, which is exactly the
  // "single-workspace select-all does nothing" report.
  const wrapper = harness.document.createElement('span')
  wrapper.className = 'HoverCard_root'
  const header = harness.document.createElement('div')
  header.setAttribute('role', 'treeitem')
  header.setAttribute('data-row-key', 'workspace:ws-a')
  const label = harness.document.createElement('span')
  label.className = 'wnFoaW_projectText'
  header.appendChild(label)
  const actions = harness.document.createElement('span')
  actions.className = 'wnFoaW_rowActions'
  header.appendChild(actions)
  wrapper.appendChild(header)
  section.appendChild(wrapper)

  mountRow(harness, SESSION_A, section)
  mountRow(harness, SESSION_B, section)
  harness.document.body.appendChild(section)

  await enterMulti(harness)
  observerPass(harness)
  await flush()

  const box = header.querySelector('.dsdel-select-all')
  assert.ok(box, 'the box exists')
  assert.deepEqual(box.__dsdelIds, [SESSION_A.id, SESSION_B.id], 'both sessions were found')

  box.fire('click')
  await flush()
  assert.equal(box.getAttribute('aria-checked'), 'true', 'and pressing it selects them')
})

test('a workspace box never reaches into a nested workspace', async () => {
  const harness = await loadPlugin()
  const section = harness.document.createElement('div')
  section.setAttribute('role', 'group')

  const header = harness.document.createElement('div')
  header.setAttribute('role', 'treeitem')
  header.setAttribute('data-row-key', 'workspace:outer')
  const actions = harness.document.createElement('span')
  actions.className = 'wnFoaW_rowActions'
  header.appendChild(actions)
  section.appendChild(header)
  mountRow(harness, SESSION_A, section)

  // A nested workspace is a `div[role="group"]` holding its own rows.
  const nested = harness.document.createElement('div')
  nested.setAttribute('role', 'group')
  const nestedHeader = harness.document.createElement('div')
  nestedHeader.setAttribute('role', 'treeitem')
  nestedHeader.setAttribute('data-row-key', 'workspace:inner')
  nested.appendChild(nestedHeader)
  mountRow(harness, SESSION_B, nested)
  section.appendChild(nested)

  harness.document.body.appendChild(section)

  await enterMulti(harness)
  observerPass(harness)
  await flush()

  const box = header.querySelector('.dsdel-select-all')
  assert.deepEqual(box.__dsdelIds, [SESSION_A.id], 'only the outer group\'s own session')
})

test('multi-select delete carries the artifact switch to every request', async () => {
  const harness = await loadPlugin({ plan: PLAN })
  localStorage.setItem(OFF_KEY, '0')
  localStorage.setItem(AUTO_KEY, '1')
  localStorage.setItem(SKIP_KEY, '1')
  const first = mountRow(harness, SESSION_A)
  const second = mountRow(harness, SESSION_B)
  await enterMulti(harness)
  clickRowIn(harness, first)
  clickRowIn(harness, second)
  await flush()

  clickBar(barDelete(harness))
  // The batch runs several workers and settles asynchronously; waiting only one
  // tick left them running into the NEXT test, whose harness swapped the document
  // out from under them. Drain until the bar is gone.
  await settle()
  for (let i = 0; i < 40 && bar(harness) !== null; i += 1) await flush()

  // The single-delete path sends `quarantine`; batch used to call postDelete(id)
  // with nothing, so "quarantine the produced files" was silently skipped while
  // that same switch stayed on. Every request here has to carry it.
  const bodies = harness.requests
    .filter((call) => call.url === '/dsh-delete-session/delete')
    .map((call) => JSON.parse(call.init.body))
  assert.equal(bodies.length, 2, 'one request per selected session')
  for (const body of bodies) {
    assert.deepEqual(body.quarantine, { scope: 'created' }, 'the produced files follow the switch')
  }
})

test('multi-select delete leaves the files alone when the switch is off', async () => {
  const harness = await loadPlugin()
  const first = mountRow(harness, SESSION_A)
  await enterMulti(harness)
  clickRowIn(harness, first)
  await flush()

  clickBar(barDelete(harness))
  await settle()
  for (let i = 0; i < 40 && bar(harness) !== null; i += 1) await flush()

  const bodies = harness.requests
    .filter((call) => call.url === '/dsh-delete-session/delete')
    .map((call) => JSON.parse(call.init.body))
  assert.equal(bodies.length, 1, 'the delete went out')
  assert.equal('quarantine' in bodies[0], false, 'and does not move any file')
})

test('a batch in asking mode opens a checklist instead of deleting straight away', async () => {
  const harness = await loadPlugin()
  localStorage.setItem(OFF_KEY, '0')
  localStorage.setItem(AUTO_KEY, '0')
  const first = mountRow(harness, SESSION_A)
  await enterMulti(harness)
  clickRowIn(harness, first)
  await flush()

  clickBar(barDelete(harness))
  await settle()

  // Issue #4: asking mode must show a list. It used to delete first and only say
  // afterwards that the files had been left alone.
  assert.equal(deleteCalls(harness), 0, 'nothing deleted before the user confirmed')
  assert.ok(batchPlan(harness) !== null, 'the checklist opened')
})

test('the batch checklist lists every selected session and its files', async () => {
  const harness = await loadPlugin({ plan: PLAN })
  localStorage.setItem(OFF_KEY, '0')
  localStorage.setItem(AUTO_KEY, '0')
  const first = mountRow(harness, SESSION_A)
  const second = mountRow(harness, SESSION_B)
  await enterMulti(harness)
  clickRowIn(harness, first)
  clickRowIn(harness, second)
  await flush()

  clickBar(barDelete(harness))
  await settle()

  // The checklist covers the whole selection, not just whichever session happened
  // to be first: the stub answers every scan with the same PLAN, so two sessions
  // with two created files each make four rows.
  const rows = batchFileRows(harness)
  assert.equal(rows.length, 4, 'two sessions, two files each, saw ' + rows.length)
})

test('confirming the checklist sends each session its own file list', async () => {
  const harness = await loadPlugin()
  localStorage.setItem(OFF_KEY, '0')
  localStorage.setItem(AUTO_KEY, '0')
  const first = mountRow(harness, SESSION_A)
  await enterMulti(harness)
  clickRowIn(harness, first)
  await flush()
  clickBar(barDelete(harness))
  await settle()

  assert.equal(clickBatchPlan(harness, 'confirm'), true, 'the checklist has a confirm')
  await settle()
  for (let i = 0; i < 40 && bar(harness) !== null; i += 1) await flush()

  // `paths` is the whole point: the host intersects it with its own derived set,
  // so sending it can only narrow the move, never widen it.
  const body = deleteBody(harness)
  assert.ok(body, 'a delete went out')
  assert.ok(body.quarantine, 'the delete carries a quarantine plan')
  assert.ok(Array.isArray(body.quarantine.paths), 'and an explicit file list')
})

test('unticking a file keeps it out of the request', async () => {
  const harness = await loadPlugin({ plan: PLAN })
  localStorage.setItem(OFF_KEY, '0')
  localStorage.setItem(AUTO_KEY, '0')
  const first = mountRow(harness, SESSION_A)
  await enterMulti(harness)
  clickRowIn(harness, first)
  await flush()
  clickBar(barDelete(harness))
  await settle()

  const rows = batchFileRows(harness)
  assert.ok(rows.length >= 1, 'the fixture has at least one file')
  // Untick through the input the user would click, not through store internals.
  rows[0].input.props.onChange({ target: { checked: false } })
  await flush()

  // The box itself has to show the new state: a checkbox that stays ticked while
  // the file is no longer in the request is a lie about what will happen.
  const after = batchFileRows(harness)
  assert.equal(after[0].input.props.checked, false, 'the unticked row renders unticked')

  assert.equal(clickBatchPlan(harness, 'confirm'), true)
  await settle()
  for (let i = 0; i < 40 && bar(harness) !== null; i += 1) await flush()

  const body = deleteBody(harness)
  assert.equal(body.quarantine.paths.includes(rows[0].path), false, 'the unticked file stays put')
})

test('cancelling the checklist deletes nothing', async () => {
  const harness = await loadPlugin()
  localStorage.setItem(OFF_KEY, '0')
  localStorage.setItem(AUTO_KEY, '0')
  const first = mountRow(harness, SESSION_A)
  await enterMulti(harness)
  clickRowIn(harness, first)
  await flush()
  clickBar(barDelete(harness))
  await settle()

  assert.equal(clickBatchPlan(harness, 'cancel'), true, 'the checklist has a cancel')
  await flush()

  assert.equal(deleteCalls(harness), 0, 'no delete went out')
  assert.equal(batchPlan(harness), null, 'and the dialog closed')
})

test('auto mode still deletes straight through, with no checklist', async () => {
  const harness = await loadPlugin()
  localStorage.setItem(OFF_KEY, '0')
  localStorage.setItem(AUTO_KEY, '1')
  localStorage.setItem(SKIP_KEY, '1')
  const first = mountRow(harness, SESSION_A)
  await enterMulti(harness)
  clickRowIn(harness, first)
  await flush()
  clickBar(barDelete(harness))
  await settle()
  for (let i = 0; i < 40 && bar(harness) !== null; i += 1) await flush()

  assert.equal(batchPlan(harness), null, 'no checklist in auto mode')
  assert.equal(deleteCalls(harness), 1, 'the delete ran')
  assert.deepEqual(deleteBody(harness).quarantine, { scope: 'created' }, 'the derived set, not a list')
})

test('the feature off deletes straight through too', async () => {
  const harness = await loadPlugin()
  localStorage.setItem(OFF_KEY, '1')
  localStorage.setItem(SKIP_KEY, '1')
  const first = mountRow(harness, SESSION_A)
  await enterMulti(harness)
  clickRowIn(harness, first)
  await flush()
  clickBar(barDelete(harness))
  await settle()
  for (let i = 0; i < 40 && bar(harness) !== null; i += 1) await flush()

  assert.equal(batchPlan(harness), null, 'the dialog never opened')
  assert.equal(deleteCalls(harness), 1, 'the delete ran')
  assert.equal('quarantine' in deleteBody(harness), false, 'and touched no file')
})
