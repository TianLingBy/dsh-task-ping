// UI 行为自测：不用浏览器，用极简 React 渲染器把设置组件跑一遍。
// 断言两件事：
//   1. 总开关关闭时，音效/音量/邮件推送的所有控件都是 disabled（真 disabled，不是只变灰）
//   2. 总开关关闭时 show() 不再向 Host 发任何推送请求
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

let definition = null
const registry = new Map()

// ---- 极简 React ----
let hookStore = new Map()
let componentSlot = 0
let componentIndex = 0
let hookIndex = 0
let pendingEffects = []
let renderDirty = false

const Fragment = Symbol('Fragment')
const React = {
  Fragment,
  createElement(type, props, ...children) {
    const flat = children.flat()
    return { type, props: { ...(props || {}), children: flat.length <= 1 ? flat[0] : flat } }
  },
  useState(initial) {
    const key = `${componentIndex}:${hookIndex++}`
    if (!hookStore.has(key)) hookStore.set(key, typeof initial === 'function' ? initial() : initial)
    return [
      hookStore.get(key),
      (next) => {
        const value = typeof next === 'function' ? next(hookStore.get(key)) : next
        if (value !== hookStore.get(key)) {
          hookStore.set(key, value)
          renderDirty = true
        }
      },
    ]
  },
  useEffect(fn) {
    const key = `${componentIndex}:${hookIndex++}`
    pendingEffects.push({ key, fn })
  },
  useRef(initial) {
    const key = `${componentIndex}:${hookIndex++}`
    if (!hookStore.has(key)) hookStore.set(key, { current: initial })
    return hookStore.get(key)
  },
}

// ---- 渲染 ----
function renderNode(node, out) {
  if (node === null || node === undefined || node === false || node === true) return
  if (Array.isArray(node)) {
    node.forEach((child) => renderNode(child, out))
    return
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push({ type: '#text', text: String(node) })
    return
  }
  const { type, props } = node
  if (typeof type === 'function') {
    // A stable slot number per call order keeps hook state alive across re-renders.
    const slot = componentSlot++
    const savedIndex = componentIndex
    const savedHook = hookIndex
    componentIndex = slot
    hookIndex = 0
    const rendered = type(props)
    componentIndex = savedIndex
    hookIndex = savedHook
    renderNode(rendered, out)
    return
  }
  out.push({ type, props })
  renderNode(props.children, out)
}

async function renderTree(component, props) {
  hookStore = new Map()
  let out = []
  for (let pass = 0; pass < 8; pass += 1) {
    renderDirty = false
    componentSlot = 0
    componentIndex = 0
    hookIndex = 0
    out = []
    pendingEffects = []
    renderNode({ type: component, props: props || {} }, out)
    const effects = pendingEffects
    effects.forEach(({ fn }) => {
      // Do NOT call the returned cleanup here: it would flip MailSettings' `alive`
      // flag before the config fetch resolves, leaving the form empty forever.
      fn()
    })
    // The config fetch resolves on a microtask chain (`fetch → res.json → setDraft`);
    // flush both microtasks and one macrotask before deciding the tree is stable.
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    if (process.env.DEBUG_UI) console.log(`    debug pass=${pass} dirty=${renderDirty} size=${out.length}`)
    if (!renderDirty) break
  }
  return out
}

function collect(nodes, predicate) {
  return nodes.filter((node) => node.type && typeof node.type === 'string' && predicate(node))
}

// ---- 假环境 ----
const storage = new Map()
const fetchCalls = []

globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      definition = def
    },
  },
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  },
  AudioContext: undefined,
  setTimeout: (fn) => {
    if (typeof fn === 'function') return 0
    return 0
  },
}

globalThis.document = { createElement: () => ({ dataset: {} }), head: { appendChild() {} }, addEventListener() {}, removeEventListener() {} }
globalThis.Notification = { permission: 'granted' }
globalThis.Notification.prototype = {}

const mailConfig = {
  enabled: true,
  host: 'smtp.qq.com',
  port: 465,
  secure: true,
  user: 'someone@qq.com',
  pass: 'env:DSH_SMTP_PASS',
  fromName: 'DSH',
  to: 'someone@qq.com',
}

// /play 的返回由用例决定：ok / 503 / 409 / reject
let playBehavior = 'ok'
const localPlays = []

globalThis.Audio = class {
  constructor(src) {
    this.src = src
    this.volume = 1
    localPlays.push(this)
  }
  play() {
    return Promise.resolve()
  }
}

globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url: String(url), method: (options && options.method) || 'GET', body: options && options.body })
  const target = String(url)
  if (target.endsWith('/push/config')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, config: mailConfig, path: 'test' }) }
  }
  if (target.endsWith('/dsh-task-notify/play')) {
    if (playBehavior === 'reject') throw new Error('network down')
    if (playBehavior === '503') return { ok: false, status: 503, json: async () => ({}) }
    if (playBehavior === '409') return { ok: false, status: 409, json: async () => ({}) }
    return { ok: true, status: 204, json: async () => ({}) }
  }
  return { ok: true, status: 200, json: async () => ({ ok: true }) }
}

// ---- 载入客户端模块 ----
const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const requireStub = (name) => {
  if (name === 'react') return React
  return {}
}
// eslint-disable-next-line no-new-func
new Function('window', 'require', 'globalThis', source)(globalThis.window, requireStub, globalThis)

if (!definition) {
  console.error('client.js 没有通过 __ModuleLoader__.load 注册模块')
  process.exit(2)
}

const factory = definition.factory(requireStub)
const ctx = {
  effect: (fn) => {
    const cleanup = fn()
    return cleanup
  },
  slots: {
    inject: (name, register) => register(),
    register: (meta, component) => {
      registry.set(meta.name, { meta, component })
      return () => {}
    },
  },
  uiWorkspace: {},
}
factory.apply(ctx)

const settingsComponent = registry.get('settings.general.item')
if (!settingsComponent) {
  console.error('没有注册 settings.general.item 组件')
  process.exit(2)
}

function walk(list, visitor) {
  const items = Array.isArray(list) ? list : [list]
  items.forEach((node) => {
    if (!node || typeof node !== 'object') return
    visitor(node)
    if (node.props && node.props.children !== undefined && node.props.children !== null) {
      walk(node.props.children, visitor)
    }
  })
}

async function inspect(enabled) {
  storage.set('dsh-task-notify/settings', JSON.stringify({ enabled, volume: 80, sound: null }))
  fetchCalls.length = 0
  // renderTree already returns a flat list of host elements.
  const flat = await renderTree(settingsComponent.component, {})

  const switches = flat.filter((n) => n.type === 'button' && n.props && n.props.role === 'switch')
  const inputs = flat.filter((n) => n.type === 'input')
  const selects = flat.filter((n) => n.type === 'select')
  const buttons = flat.filter((n) => n.type === 'button' && n.props && n.props.role !== 'switch')
  if (process.env.DEBUG_UI) {
    console.log('  debug fetchCalls=', fetchCalls.map((c) => c.url).join('|'))
    console.log('  debug types=', flat.map((n) => String(n.type)).join(','))
  }
  return { switches, inputs, selects, buttons }
}

function describeNode(node) {
  if (!node || !node.props) return node && node.type
  if (node.props.role === 'switch') return `switch(${node.props['aria-label'] || '#'})`
  if (node.type === 'input') return `input(${node.props.type || 'text'}${node.props['aria-label'] ? ':' + node.props['aria-label'] : ''})`
  if (node.type === 'select') return 'select'
  if (node.type === 'button') return `button(${typeof node.props.children === 'string' ? node.props.children : '#'})`
  return node.type
}

function summarize(label, snap) {
  const state = (list) => list.map((n) => (n.props.disabled === true ? 'off' : 'on')).join(',')
  console.log(
    `  ${label}: switches=[${state(snap.switches)}] inputs=[${state(snap.inputs)}] select=[${state(snap.selects)}] buttons=[${state(snap.buttons)}]`,
  )
}

let failed = 0

console.log('\n[1] 总开关开启 → 子项可操作')
const on = await inspect(true)
summarize('on ', on)
const anyDisabledWhenOn =
  on.switches.some((n) => n.props.disabled === true) ||
  on.inputs.some((n) => n.props.disabled === true) ||
  on.selects.some((n) => n.props.disabled === true) ||
  on.buttons.some((n) => n.props.disabled === true)
if (anyDisabledWhenOn) {
  console.log('  FAIL: 总开关开启时不应有禁用控件')
  failed += 1
} else {
  console.log('  PASS: 全部可操作')
}
if (on.switches.length < 2) {
  console.log(`  FAIL: 期望至少 2 个开关（总开关 + 邮件推送），实际 ${on.switches.length}`)
  failed += 1
} else {
  console.log(`  PASS: ${on.switches.length} 个开关都在`)
}

console.log('\n[2] 总开关关闭 → 除总开关外全部禁用')
const off = await inspect(false)
summarize('off', off)
const masterSwitch = off.switches[0]
if (!masterSwitch || masterSwitch.props.disabled === true) {
  console.log('  FAIL: 总开关本身必须保持可操作')
  failed += 1
} else {
  console.log('  PASS: 总开关仍可点')
}
const subControls = [...off.switches.slice(1), ...off.inputs, ...off.selects, ...off.buttons]
const notDisabled = subControls.filter((n) => n.props.disabled !== true)
if (notDisabled.length > 0) {
  console.log(`  FAIL: 有 ${notDisabled.length} 个子控件未禁用 -> ${notDisabled.map(describeNode).join(', ')}`)
  failed += 1
} else {
  console.log(`  PASS: ${subControls.length} 个子控件全部 disabled -> ${subControls.map(describeNode).join(', ')}`)
}

console.log('\n[3] show() 在总开关关闭时不发任何推送')
storage.set('dsh-task-notify/settings', JSON.stringify({ enabled: false, volume: 80, sound: null }))
fetchCalls.length = 0
factory.__test.show('session-1', '某个任务', {}, null)
await Promise.resolve()
const mailedWhenOff = fetchCalls.filter((call) => call.url.includes('/dsh-task-notify/push'))
console.log(`  fetch 调用数=${fetchCalls.length}, 其中推送=${mailedWhenOff.length}`)
if (mailedWhenOff.length !== 0) {
  console.log('  FAIL: 总开关关闭时仍然发了推送')
  failed += 1
} else {
  console.log('  PASS: 没有推送')
}

console.log('\n[4] show() 在总开关开启时确实推送一次')
storage.set('dsh-task-notify/settings', JSON.stringify({ enabled: true, volume: 80, sound: null }))
fetchCalls.length = 0
factory.__test.show('session-1', '某个任务', {}, null)
await Promise.resolve()
const mailedWhenOn = fetchCalls.filter((call) => call.url.includes('/dsh-task-notify/push'))
console.log(`  fetch 调用数=${fetchCalls.length}, 其中推送=${mailedWhenOn.length}`)
if (mailedWhenOn.length !== 1) {
  console.log('  FAIL: 期望恰好 1 次推送')
  failed += 1
} else {
  console.log('  PASS: 推送 1 次')
}

async function tick() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
}

function countPlays() {
  return fetchCalls.filter((call) => call.url.includes('/dsh-task-notify/play'))
}

console.log('\n[5] 松滑块：还原的自动试听，恰好一次且用保存的音量')
storage.set('dsh-task-notify/settings', JSON.stringify({ enabled: true, volume: 45, sound: null }))
const sliderSnap = await inspect(true)
fetchCalls.length = 0
localPlays.length = 0
const slider = sliderSnap.inputs.find((n) => n.props && n.props.type === 'range')
if (!slider) {
  console.log('  FAIL: 没找到音量滑块')
  failed += 1
} else {
  slider.props.onPointerUp({ currentTarget: { value: '45' } })
  await tick()
  const plays = countPlays()
  const volumes = plays.map((call) => {
    try {
      return JSON.parse(call.body).volume
    } catch {
      return NaN
    }
  })
  console.log(`  播放请求=${plays.length}, volume=${volumes.join(',')}, 页面补播=${localPlays.length}`)
  if (plays.length !== 1 || volumes[0] !== 45 || localPlays.length !== 0) {
    console.log('  FAIL: 期望 1 次播放、volume=45、不补播')
    failed += 1
  } else {
    console.log('  PASS: 一次播放，音量正确，无补播')
  }
}

console.log('\n[6] 快速连点 3 次：每次都播（Host 会打断上一声）')
fetchCalls.length = 0
localPlays.length = 0
for (let i = 0; i < 3; i += 1) slider.props.onPointerUp({ currentTarget: { value: '45' } })
await tick()
const burst = countPlays().length
console.log(`  3 次操作 -> 播放请求=${burst}, 页面补播=${localPlays.length}`)
if (burst !== 3) {
  console.log('  FAIL: 期望 3 次操作产生 3 次播放请求')
  failed += 1
} else {
  console.log('  PASS: 三次点击都发出播放请求，且没有页面补播')
}

async function hostStatusCase(label, behavior, expectLocal) {
  fetchCalls.length = 0
  localPlays.length = 0
  playBehavior = behavior
  storage.set('dsh-task-notify/settings', JSON.stringify({ enabled: true, volume: 60, sound: null }))
  factory.__test.show('session-1', '任务', {}, null)
  await tick()
  const plays = countPlays().length
  playBehavior = 'ok'
  console.log(`  ${label}: Host 请求=${plays}, 页面补播=${localPlays.length}`)
  if (plays !== 1 || localPlays.length !== expectLocal) {
    console.log(`  FAIL: 期望 Host 请求 1 次、页面补播 ${expectLocal} 次`)
    failed += 1
  } else {
    console.log('  PASS')
  }
}

console.log('\n[7] Host 返回 503（正在播）：页面不补播')
await hostStatusCase('503', '503', 0)

console.log('\n[8] Host 返回 409（已在别处播）：页面不补播')
await hostStatusCase('409', '409', 0)

console.log('\n[9] Host 请求失败：页面补播 1 次')
await hostStatusCase('reject', 'reject', 1)

console.log(failed === 0 ? '\nRESULT: ALL OK' : `\nRESULT: ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
