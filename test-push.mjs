// 一次性验证脚本：node test-push.mjs
// 读 push.config.json，发一封测试邮件；不经过 DSH，不依赖 Host。
import { readPushConfig, sendMail } from './index.js'

const cfg = readPushConfig()
if (!cfg) {
  console.error('未配置：push.config.json 不存在、enabled=false，或缺 host/user/pass/to')
  process.exit(2)
}
const stamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
try {
  await sendMail(
    cfg,
    'DSH 测试通知',
    `这是一封来自 dsh-task-notify 插件的测试邮件。\n\n收到即表示 SMTP 通道可用。\n\n时间：${stamp}`,
  )
  console.log(`SENT OK -> ${cfg.to} via ${cfg.host}:${cfg.port}`)
} catch (err) {
  console.error(`SEND FAIL: ${(err && err.message) || err}`)
  process.exit(1)
}
