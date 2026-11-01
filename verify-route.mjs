// 本地自测：伪造 Host 上下文，让生产代码里的 /push 路由真正跑一次（会真发一封邮件）。
// 验证的是「路由注册 + 请求解析 + SMTP」这一段，不含浏览器到 Host 的 HTTP 转发。
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
const ctx = {
  get: (key) => (key === 'webServer' ? webServer : undefined),
  inject: (deps, callback) => callback(ctx),
  on: () => {},
}

apply(ctx)
console.log('registered routes:', [...routes.keys()])

const handler = routes.get('/dsh-task-notify/push')
if (!handler) {
  console.error('FAIL: /dsh-task-notify/push 没有注册')
  process.exit(2)
}

const payload = JSON.stringify({
  title: '对话任务完成（路由自测）',
  body: '已完成：验证 /push 路由 → SMTP 全链路',
  sessionId: 'selftest',
})
const req = {
  method: 'POST',
  async *[Symbol.asyncIterator]() {
    yield Buffer.from(payload)
  },
}
let status = 0
let body = ''
const res = {
  writeHead(code) {
    status = code
  },
  end(text) {
    if (text) body = String(text)
  },
}

await handler(req, res)
console.log(`status=${status}${body ? ` body=${body}` : ''}`)
process.exit(status === 204 ? 0 : 1)
