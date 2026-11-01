// 设置页接口自测：伪造 Host 上下文，跑 /push/config 与 /push/test（含 env: 授权码）。
// 用临时 USERPROFILE 把写入重定向到工作区（真实运行时写的是 ~/.dsh）。
import { apply } from './index.js'

const routes = new Map()
const webServer = {
  register(opts) {
    routes.set(opts.path, opts.handler)
    return () => {}
  },
  registerUpgrade() {
    return () => {}
  },
}
const ctx = { get: (k) => (k === 'webServer' ? webServer : undefined), inject: (d, cb) => cb(ctx), on: () => {} }
apply(ctx)
console.log('routes:', [...routes.keys()])

function makeReq(method, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    async *[Symbol.asyncIterator]() {
      if (payload) yield Buffer.from(payload)
    },
  }
}
function makeRes() {
  const out = { status: 0, body: '' }
  return {
    out,
    writeHead(code) {
      out.status = code
    },
    end(text) {
      if (text) out.body = String(text)
    },
  }
}
async function call(path, method, body) {
  const handler = routes.get(path)
  if (!handler) throw new Error('missing route ' + path)
  const res = makeRes()
  await handler(makeReq(method, body), res)
  let parsed = null
  try {
    parsed = JSON.parse(res.out.body)
  } catch {}
  return { status: res.out.status, json: parsed }
}

const baseConfig = {
  enabled: true,
  host: 'smtp.qq.com',
  port: '465',
  user: '3280026525@qq.com',
  to: '3280026525@qq.com',
  fromName: 'DSH',
}

console.log('\n[1] GET /push/config')
const before = await call('/dsh-task-notify/push/config', 'GET')
console.log('  status', before.status, 'enabled=', before.json && before.json.config && before.json.config.enabled)

console.log('\n[2] POST invalid (empty fields)')
const invalid = await call('/dsh-task-notify/push/config', 'POST', { enabled: true })
console.log('  status', invalid.status, invalid.json)

console.log('\n[3] POST valid with a plain pass')
const saved = await call('/dsh-task-notify/push/config', 'POST', { ...baseConfig, pass: 'REMOVED-SECRET' })
console.log('  status', saved.status, saved.json)

console.log('\n[4] POST pass=env:DSH_PASS_TEST while the variable is unset -> warning')
delete process.env.DSH_PASS_TEST
const warned = await call('/dsh-task-notify/push/config', 'POST', { ...baseConfig, pass: 'env:DSH_PASS_TEST' })
console.log('  status', warned.status, warned.json)

console.log('\n[5] POST /push/test with the env var missing -> 400 with a reason')
const missing = await call('/dsh-task-notify/push/test', 'POST')
console.log('  status', missing.status, missing.json)

console.log('\n[6] set the env var, /push/test again (sends a real mail)')
process.env.DSH_PASS_TEST = 'REMOVED-SECRET'
const ok = await call('/dsh-task-notify/push/test', 'POST')
console.log('  status', ok.status, ok.json)

console.log('\n[7] GET config returns the env placeholder, not the secret')
const after = await call('/dsh-task-notify/push/config', 'GET')
console.log('  pass field =', after.json && after.json.config && after.json.config.pass)

console.log('\n[8] disallowed method')
const wrong = await call('/dsh-task-notify/push/config', 'PUT')
console.log('  status', wrong.status, wrong.json)

const allOk =
  ok.status === 200 &&
  ok.json &&
  ok.json.ok &&
  warned.status === 200 &&
  warned.json &&
  typeof warned.json.warning === 'string' &&
  after.json &&
  after.json.config.pass === 'env:DSH_PASS_TEST' &&
  missing.status === 400
console.log('\nRESULT:', allOk ? 'ALL OK' : 'SOMETHING FAILED')
process.exit(allOk ? 0 : 1)
