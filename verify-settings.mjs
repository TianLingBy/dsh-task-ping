// 设置页接口自测：伪造 Host 上下文，跑 GET/POST /push/config 与 /push/test。
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

console.log('\n[1] GET /push/config')
const before = await call('/dsh-task-notify/push/config', 'GET')
console.log('status', before.status, 'enabled=', before.json && before.json.config && before.json.config.enabled, 'path=', before.json && before.json.path)

console.log('\n[2] POST /push/config (invalid: enabled but empty)')
const invalid = await call('/dsh-task-notify/push/config', 'POST', { enabled: true, host: '', user: '', pass: '', to: '' })
console.log('status', invalid.status, invalid.json)

console.log('\n[3] POST /push/config (valid)')
const valid = await call('/dsh-task-notify/push/config', 'POST', {
  enabled: true,
  host: 'smtp.qq.com',
  port: '465',
  user: '3280026525@qq.com',
  pass: 'REMOVED-SECRET',
  to: '3280026525@qq.com',
})
console.log('status', valid.status, valid.json)

console.log('\n[4] GET /push/config again')
const after = await call('/dsh-task-notify/push/config', 'GET')
console.log('status', after.status, 'user=', after.json && after.json.config && after.json.config.user, 'port=', after.json && after.json.config && after.json.config.port)

console.log('\n[5] GET on wrong method path is 405')
const wrong = await call('/dsh-task-notify/push/config', 'PUT')
console.log('status', wrong.status, wrong.json)

console.log('\n[6] POST /push/test (sends a real mail)')
const test = await call('/dsh-task-notify/push/test', 'POST')
console.log('status', test.status, test.json)

process.exit(test.status === 200 && test.json && test.json.ok ? 0 : 1)
