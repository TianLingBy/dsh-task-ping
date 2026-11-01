/**
 * Host half of dsh-task-notify.
 *
 * The toast stays in the browser: only the renderer can raise one. Making Windows
 * duck other applications, however, needs WASAPI, which the page cannot touch — so
 * the client POSTs the notification sound here and this half hands it to
 * `play-comm.ps1`, which renders it on the *communications* render endpoint. Windows
 * then applies its own "communications activity" ducking; nothing in this plugin
 * writes another application's volume.
 *
 * Link: the page origin is `dsh-app://app`, and the Desktop shell forwards every
 * pathname of that origin to the Host with its authentication cookie
 * (`forwardWebRequest` in the app's lib/main.js), so a relative `fetch` from the
 * client lands on `webServer.register` below.
 *
 * Everything here is optional: any failure answers non-2xx, and the client then
 * plays the sound itself exactly as before (no ducking, but audible).
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { fileURLToPath } from 'node:url'

/**
 * Boot breadcrumbs. When the Host half stops registering its routes there is nothing
 * anywhere to point at, so every load step appends one line here; this file is the
 * first thing to read when the plugin "looks installed but nothing happens".
 */
const BOOT_DIR = join(homedir(), '.dsh')
const BOOT_LOG = join(BOOT_DIR, 'dsh-task-notify-boot.log')
function bootLog(step) {
  try {
    mkdirSync(BOOT_DIR, { recursive: true })
    appendFileSync(BOOT_LOG, `${new Date().toISOString()} ${step}\n`)
  } catch {}
}
bootLog(`module loaded pid=${process.pid}`)

const ROUTE = '/dsh-task-notify/play'
const DIR = join(tmpdir(), 'dsh-task-notify')
const CMD_FILE = join(DIR, 'cmd.json')
const ACK_FILE = join(DIR, 'ack.txt')
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'play-comm.ps1')
/** One notification is never longer than this; the helper truncates to it too. */
const MAX_MS = 4000
/** Longest wait for the helper's "stream is live" ack before the page plays instead. */
const ACK_TIMEOUT_MS = 1300
const MAX_BODY_BYTES = 8 * 1024 * 1024
/** Fresh per Host process: a command left by a previous run must never replay after a restart. */
const BOOT = Math.random().toString(36).slice(2, 10)
/** PowerShell 7 first, the built-in 5.1 after an ENOENT; see `spawnHidden`. */
let shell = 'pwsh'

function spawnHidden(args) {
  // `pwsh` (PowerShell 7) is not guaranteed on a fresh Windows install; fall back to
  // the built-in 5.1 once, after the first spawn reports ENOENT.
  const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', SCRIPT, ...args], {
    windowsHide: true,
    stdio: 'ignore',
  })
  child.on('error', (err) => {
    if (err && err.code === 'ENOENT' && shell === 'pwsh') shell = 'powershell'
  })
  return child
}

/** Read the POST body, refusing anything larger than one sound. */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Turn an `audio/*` data URL into WAV bytes. Only the RIFF/WAVE envelope is checked
 * here so an mp3 (or anything else) is rejected before the helper is bothered; the
 * helper validates PCM/16-bit and reports its own failure.
 */
function decodeWav(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length < 32) return null
  if (dataUrl.slice(0, 5).toLowerCase() !== 'data:') return null
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  if (!/;base64$/i.test(dataUrl.slice(5, comma))) return null
  const buf = Buffer.from(dataUrl.slice(comma + 1), 'base64')
  if (buf.length < 44) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  return buf
}

/** Keep the temp directory from growing one file per notification. */
function prune() {
  try {
    const now = Date.now()
    for (const name of readdirSync(DIR)) {
      if (!/^play-\d+-\d+\.wav$/.test(name)) continue
      const path = join(DIR, name)
      try {
        if (now - statSync(path).mtimeMs > 120000) unlinkSync(path)
      } catch {}
    }
  } catch {}
}

/* ---------------------------------------------------------------------------- *
 * Phone mirror — the same notice, mailed.
 *
 * A page cannot open a socket to a mail server, so the client posts the text it is
 * about to show and this half speaks SMTP. `push.config.json` next to this file
 * carries the account; missing or `enabled: false` means the route answers 204 and
 * nothing leaves the machine. No dependency is used: QQ / 163 / 126 all accept
 * AUTH LOGIN over implicit TLS on 465, and plain text + base64 body is enough for a
 * one-line notice.
 * ---------------------------------------------------------------------------- */
const PUSH_ROUTE = '/dsh-task-notify/push'
/**
 * Installed from npm the plugin lives inside node_modules, so the account file is
 * read from the profile directory first; the copy next to this file keeps a locally
 * linked checkout working without touching the user's home.
 */
const PUSH_CONFIG_USER = join(homedir(), '.dsh', 'dsh-task-notify-push.json')
const PUSH_CONFIG_LOCAL = join(dirname(fileURLToPath(import.meta.url)), 'push.config.json')
const PUSH_LOG = join(BOOT_DIR, 'dsh-task-notify-push.log')

function readPushConfig() {
  const raw = readRawPushConfig()
  if (!raw.cfg || raw.cfg.enabled === false) return null
  const cfg = raw.cfg
  if (!cfg.host || !cfg.user || !cfg.pass || !cfg.to) return null
  const pass = resolveSecret(cfg.pass)
  if (!pass) return null
  return {
    host: String(cfg.host),
    port: Number(cfg.port) || 465,
    secure: cfg.secure !== false,
    user: String(cfg.user),
    pass,
    from: String(cfg.from || cfg.user),
    fromName: typeof cfg.fromName === 'string' && cfg.fromName.trim() ? cfg.fromName.trim() : 'DSH',
    to: String(cfg.to),
  }
}

/**
 * `env:NAME` keeps the authorization code out of the config file: the value is read
 * from the Host process environment at send time, so the form can show a placeholder
 * instead of a secret and a leaked config file carries nothing usable.
 */
function resolveSecret(value) {
  const text = String(value == null ? '' : value).trim()
  const match = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(text)
  if (!match) return text
  const fromEnv = process.env[match[1]]
  return typeof fromEnv === 'string' ? fromEnv : ''
}

/** First readable account file, plus where it came from (the settings form shows it). */
function readRawPushConfig() {
  for (const path of [PUSH_CONFIG_USER, PUSH_CONFIG_LOCAL]) {
    try {
      const cfg = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
      if (cfg && typeof cfg === 'object') return { cfg, path }
    } catch {}
  }
  return { cfg: null, path: PUSH_CONFIG_USER }
}

/** The settings form always writes the user-level file, never into the package. */
function writePushConfig(cfg) {
  mkdirSync(BOOT_DIR, { recursive: true })
  writeFileSync(PUSH_CONFIG_USER, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
}

function pushLog(line) {
  try {
    mkdirSync(BOOT_DIR, { recursive: true })
    appendFileSync(PUSH_LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

/**
 * Open the transport and resolve once TLS is up. `timeout` is handled here because a
 * silent server would otherwise hang the request until the page gave up.
 */
function openSmtp(cfg) {
  return new Promise((resolve, reject) => {
    const socket = cfg.secure
      ? tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host })
      : netConnect({ host: cfg.host, port: cfg.port })
    const ready = cfg.secure ? 'secureConnect' : 'connect'
    const onError = (err) => {
      socket.destroy()
      reject(err)
    }
    const onReady = () => {
      socket.removeListener('error', onError)
      socket.setTimeout(25000, () => socket.destroy(new Error('smtp idle timeout')))
      socket.on('error', () => {})
      resolve(socket)
    }
    socket.once('error', onError)
    socket.once(ready, onReady)
    socket.setTimeout(12000, () => onError(new Error('smtp connect timeout')))
  })
}

/** Line-oriented reply reader: a reply ends on a line whose 4th character is a space. */
function smtpSession(socket) {
  const arrived = []
  const waiting = []
  let buffer = ''
  let parts = []
  const deliver = (reply) => {
    const next = waiting.shift()
    if (next) next(reply)
    else arrived.push(reply)
  }
  socket.on('data', (chunk) => {
    buffer += chunk.toString('latin1')
    let at
    while ((at = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 2)
      parts.push(line)
      const head = /^(\d{3})([ -])/.exec(line)
      if (head && head[2] === ' ') {
        const reply = { code: Number(head[1]), text: parts.join(' | ') }
        parts = []
        deliver(reply)
      }
    }
  })
  return {
    read() {
      if (arrived.length) return Promise.resolve(arrived.shift())
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('smtp reply timeout')), 25000)
        waiting.push((reply) => {
          clearTimeout(timer)
          resolve(reply)
        })
      })
    },
    write(line) {
      socket.write(`${line}\r\n`)
    },
  }
}

function expectCode(reply, codes, step) {
  if (!codes.includes(reply.code)) throw new Error(`${step}: ${reply.code} ${reply.text}`)
  return reply
}

/** RFC 2047 word; a Chinese subject must not go out as raw bytes. */
const encodeWord = (text) => `=?UTF-8?B?${Buffer.from(String(text), 'utf8').toString('base64')}?=`

function bodyBase64(text) {
  const encoded = Buffer.from(text, 'utf8').toString('base64')
  return (encoded.match(/.{1,76}/g) || ['']).join('\r\n')
}

/** Upgrade a plain socket to TLS (RFC 3207); the plain reader is detached first. */
function startTls(socket, host) {
  socket.removeAllListeners('data')
  return new Promise((resolve, reject) => {
    const secure = tlsConnect({ socket, servername: host }, () => {
      secure.setTimeout(25000, () => secure.destroy(new Error('smtp idle timeout')))
      secure.on('error', () => {})
      resolve(secure)
    })
    secure.once('error', reject)
  })
}

async function sendMail(cfg, subject, text) {
  let socket = await openSmtp(cfg)
  let session = smtpSession(socket)
  try {
    expectCode(await session.read(), [220], 'greeting')
    session.write(`EHLO ${cfg.host}`)
    const ehlo = expectCode(await session.read(), [250], 'EHLO')
    if (!cfg.secure) {
      // On a plaintext port the password must not travel before TLS is up; a server
      // that offers no STARTTLS is refused rather than downgraded.
      if (!/STARTTLS/i.test(ehlo.text)) throw new Error('server offers no STARTTLS; refusing to send credentials in clear text')
      session.write('STARTTLS')
      expectCode(await session.read(), [220], 'STARTTLS')
      socket = await startTls(socket, cfg.host)
      session = smtpSession(socket)
      session.write(`EHLO ${cfg.host}`)
      expectCode(await session.read(), [250], 'EHLO')
    }
    session.write('AUTH LOGIN')
    expectCode(await session.read(), [334], 'AUTH LOGIN')
    session.write(Buffer.from(cfg.user, 'utf8').toString('base64'))
    expectCode(await session.read(), [334], 'AUTH user')
    session.write(Buffer.from(cfg.pass, 'utf8').toString('base64'))
    expectCode(await session.read(), [235], 'AUTH pass')
    session.write(`MAIL FROM:<${cfg.from}>`)
    expectCode(await session.read(), [250], 'MAIL FROM')
    session.write(`RCPT TO:<${cfg.to}>`)
    expectCode(await session.read(), [250, 251], 'RCPT TO')
    session.write('DATA')
    expectCode(await session.read(), [354], 'DATA')
    const message = [
      `From: ${encodeWord(cfg.fromName)} <${cfg.from}>`,
      `To: <${cfg.to}>`,
      `Subject: ${encodeWord(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      `Message-ID: <${randomUUID()}@dsh-task-notify>`,
      '',
      bodyBase64(text),
    ].join('\r\n')
    socket.write(`${message}\r\n.\r\n`)
    expectCode(await session.read(), [250], 'message body')
    session.write('QUIT')
    return true
  } finally {
    try {
      socket.end()
    } catch {}
  }
}

function register(ctx) {
  bootLog('register() entered')
  // `webServer` is a *service*, not a value guaranteed on the load-time context:
  // `ctx.get('webServer')` legitimately answers undefined this early (measured
  // 2026-11-01). `inject` is the supported form — the same one `api-gateway` uses in
  // the Host — and it runs when the service becomes available.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => guarded('inject callback', () => registerRoutes(webCtx)))
  } else {
    registerRoutes(ctx)
  }
}

function guarded(step, fn) {
  bootLog(step)
  try {
    fn()
  } catch (err) {
    bootLog(`${step} threw: ${(err && err.stack) || err}`)
  }
}

function registerRoutes(ctx) {
  // `inject` guarantees availability, so `webCtx.webServer` is the direct form the
  // Host's own api-gateway uses; `get` stays as the fallback for the non-inject path.
  const webServer = ctx.webServer || (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined)
  bootLog(`webServer=${webServer ? 'present' : 'missing'}`)
  if (!webServer || typeof webServer.register !== 'function') return
  mkdirSync(DIR, { recursive: true })

  let seq = 0
  let files = 0
  let helper = null
  /** Start the warm helper; a dead one is restarted. */
  const ensureHelper = () => {
    if (helper && helper.exitCode === null && helper.signalCode === null) return
    try {
      helper = spawnHidden(['-Action', 'Serve', '-ParentPid', String(process.pid), '-BootId', BOOT, '-MaxMs', String(MAX_MS), '-SyncComm', '1'])
      helper.on('error', () => { helper = null })
    } catch {
      helper = null
    }
  }
  /** The helper polls this file (~40 ms) and acts on a new sequence number. */
  const send = (command) => {
    const mine = ++seq
    try {
      const tmp = CMD_FILE + '.tmp'
      writeFileSync(tmp, JSON.stringify({ bootId: BOOT, seq: mine, ...command }))
      renameSync(tmp, CMD_FILE)
    } catch {}
    return mine
  }
  /** Resolve once the helper confirms this sequence's stream started, or on timeout. */
  const waitAck = async (wanted) => {
    const end = Date.now() + ACK_TIMEOUT_MS
    while (Date.now() < end) {
      try {
        const raw = readFileSync(ACK_FILE, 'utf8').replace(/^\uFEFF/, '')
        const fields = new Map(
          raw.split('\t').map((part) => {
            const at = part.indexOf('=')
            return at < 0 ? [part, ''] : [part.slice(0, at), part.slice(at + 1)]
          }),
        )
        if (Number(fields.get('seq')) === wanted) return { ok: fields.get('ok') === '1', raw }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 12))
    }
    return { ok: false, raw: '' }
  }

  /**
   * The helper plays one sound at a time and a command left unread can be replaced,
   * so a second notification arriving during playback is answered non-2xx at once:
   * the page rings it locally instead of risking a duplicate a few hundred ms later.
   */
  let busyUntil = 0

  const dispose = webServer.register({
    kind: 'exact',
    path: ROUTE,
    async handler(req, res) {
      try {
        if ((req.method || 'GET').toUpperCase() !== 'POST') {
          res.writeHead(405, { allow: 'POST' })
          return
        }
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const wav = decodeWav(body && body.dataUrl)
        if (!wav) {
          res.writeHead(415, { 'cache-control': 'no-store' })
          return
        }
        let volume = Number(body.volume)
        if (!Number.isFinite(volume)) volume = 1
        if (volume > 1) volume = volume / 100
        volume = Math.max(0, Math.min(1, volume))
        if (Date.now() < busyUntil) {
          res.writeHead(503, { 'cache-control': 'no-store', 'retry-after': '1' })
          return
        }
        // Claim the helper before the (async) ack wait so a second request cannot slip in.
        busyUntil = Date.now() + MAX_MS + 500

        mkdirSync(DIR, { recursive: true })
        const file = join(DIR, `play-${Date.now()}-${++files}.wav`)
        writeFileSync(file, wav)
        prune()
        ensureHelper()
        const mine = send({ op: 'play', wav: file, volume: Number(volume.toFixed(3)) })
        const ack = await waitAck(mine)
        if (ack.ok) {
          // Hold the helper for the sound's own length (frames / sample rate) so a
          // follow-up notification never queues behind it and doubles the sound.
          const rate = /format=(\d+)Hz/.exec(ack.raw)
          const frames = / frames=(\d+)/.exec(ack.raw)
          const soundMs = rate && frames ? (Number(frames[1]) * 1000) / Number(rate[1]) : MAX_MS
          busyUntil = Date.now() + Math.min(MAX_MS, Math.max(100, soundMs)) + 250
          // The helper renders on the *communications* endpoint, and with -SyncComm it
          // first moves that default onto the current playback default, so the sound is
          // heard where the user listens and Windows ducks the same endpoint. A failed
          // move (sameDevice=0) still means the sound went somewhere else, so the page
          // rings it locally: answer 409 instead of 204.
          const heard = /sameDevice=1/.test(ack.raw)
          if (heard) {
            res.writeHead(204, { 'cache-control': 'no-store' })
          } else {
            res.writeHead(409, { 'cache-control': 'no-store' })
          }
        } else {
          // Tell a late helper to drop a command the page already covered itself.
          send({ op: 'drop' })
          busyUntil = Date.now() + 400
          res.writeHead(503, { 'cache-control': 'no-store' })
        }
      } catch {
        busyUntil = Date.now() + 400
        try {
          res.writeHead(503, { 'cache-control': 'no-store' })
        } catch {}
      } finally {
        try {
          res.end()
        } catch {}
      }
    },
  })
  bootLog('play route registered')

  /**
   * One mail at a time: QQ throttles parallel sessions from the same account, and a
   * burst of notifications is rare enough that queueing costs nothing visible.
   */
  let mailChain = Promise.resolve()
  const enqueueMail = (job) => {
    const run = mailChain.then(job, job)
    mailChain = run.catch(() => {})
    return run
  }
  /** Last notice mailed, for the duplicate guard below. */
  let lastMail = { key: '', at: 0 }

  const disposePush = webServer.register({
    kind: 'exact',
    path: PUSH_ROUTE,
    async handler(req, res) {
      bootLog(`push request ${req.method} arrived`)
      const done = (status, text) => {
        try {
          if (text === undefined) res.writeHead(status, { 'cache-control': 'no-store' })
          else res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
          res.end(text)
        } catch {}
      }
      try {
        if ((req.method || 'GET').toUpperCase() !== 'POST') {
          done(405)
          return
        }
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const cfg = readPushConfig()
        if (!cfg) {
          done(204)
          return
        }
        const rawTitle = body && typeof body.title === 'string' ? body.title.trim() : ''
        const rawBody = body && typeof body.body === 'string' ? body.body.trim() : ''
        const title = (rawTitle || 'DSH 通知').slice(0, 120)
        // The dock component can be mounted twice while a page settles; the same
        // notice twice in a few seconds is a double mount, not a second task.
        const key = `${title}\u0000${rawBody}`
        if (key === lastMail.key && Date.now() - lastMail.at < 5000) {
          bootLog('push skipped: duplicate within 5s')
          done(204)
          return
        }
        lastMail = { key, at: Date.now() }
        const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId : ''
        const stamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        const lines = [rawBody || '（无正文）', '', `时间：${stamp}`]
        if (sessionId) lines.push(`会话：${sessionId}`)
        await enqueueMail(() => sendMail(cfg, title, lines.join('\n')))
        pushLog(`sent | ${title}`)
        done(204)
      } catch (err) {
        const message = String((err && err.message) || err)
        pushLog(`failed | ${message}`)
        done(500, message)
      }
    },
  })

  bootLog('push route registered')

  /* -------------------------------------------------------------------------- *
   * Settings form: the account is read, written and test-fired from the page.
   * Writing always targets the user-level file so a package install stays clean.
   * -------------------------------------------------------------------------- */
  const CONFIG_ROUTE = '/dsh-task-notify/push/config'
  const TEST_ROUTE = '/dsh-task-notify/push/test'
  const replyJson = (res, status, payload) => {
    try {
      res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(payload))
    } catch {}
  }

  const disposeConfig = webServer.register({
    kind: 'exact',
    path: CONFIG_ROUTE,
    async handler(req, res) {
      try {
        const method = (req.method || 'GET').toUpperCase()
        if (method === 'GET') {
          const { cfg, path } = readRawPushConfig()
          replyJson(res, 200, {
            ok: true,
            path,
            config:
              cfg ||
              { enabled: false, host: 'smtp.qq.com', port: 465, secure: true, user: '', pass: '', fromName: 'DSH', to: '' },
          })
          return
        }
        if (method !== 'POST') {
          replyJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const body = JSON.parse((await readBody(req)).toString('utf8')) || {}
        const next = {
          enabled: body.enabled !== false,
          host: String(body.host || '').trim(),
          port: Number(body.port) || 465,
          secure: body.secure !== false,
          user: String(body.user || '').trim(),
          pass: String(body.pass || ''),
          fromName: String(body.fromName || 'DSH').trim() || 'DSH',
          to: String(body.to || body.user || '').trim(),
        }
        if (next.enabled) {
          const missing = !next.host
            ? 'SMTP 服务器不能为空'
            : !next.user
              ? '发件邮箱不能为空'
              : !next.pass
                ? '授权码不能为空'
                : !next.to
                  ? '收件邮箱不能为空'
                  : ''
          if (missing) {
            replyJson(res, 400, { ok: false, error: missing })
            return
          }
        }
        writePushConfig(next)
        pushLog(`config saved from settings (enabled=${next.enabled})`)
        // An `env:` placeholder is only useful if the variable is actually set; say so
        // now instead of letting the next notification fail silently.
        let warning = ''
        const envName = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(next.pass.trim())
        if (next.enabled && envName && !process.env[envName[1]]) {
          warning = `环境变量 ${envName[1]} 当前没有值，发信会失败`
        }
        replyJson(res, 200, warning ? { ok: true, warning } : { ok: true })
      } catch (err) {
        replyJson(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
    },
  })

  const disposeTest = webServer.register({
    kind: 'exact',
    path: TEST_ROUTE,
    async handler(req, res) {
      try {
        if ((req.method || '').toUpperCase() !== 'POST') {
          replyJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const cfg = readPushConfig()
        if (!cfg) {
          const raw = readRawPushConfig()
          const envName = raw.cfg && /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(String(raw.cfg.pass || '').trim())
          const why = envName
            ? `环境变量 ${envName[1]} 没有值，授权码取不到`
            : raw.cfg && raw.cfg.enabled === false
              ? '邮件推送是关着的'
              : '还没有可用的邮件配置'
          replyJson(res, 400, { ok: false, error: why })
          return
        }
        const stamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        await enqueueMail(() => sendMail(cfg, 'DSH 测试邮件', `从设置页发起的测试。\n\n时间：${stamp}`))
        pushLog('test mail sent from settings')
        replyJson(res, 200, { ok: true, to: cfg.to })
      } catch (err) {
        const message = String((err && err.message) || err)
        pushLog(`test failed | ${message}`)
        replyJson(res, 500, { ok: false, error: message })
      }
    },
  })

  ensureHelper()
  bootLog(`helper spawned pid=${helper && helper.pid}`)
  ctx.on('dispose', () => {
    try {
      send({ op: 'exit' })
    } catch {}
    for (const dispose of [dispose, disposePush, disposeConfig, disposeTest]) {
      try {
        dispose()
      } catch {}
    }
  })
}

export function apply(ctx) {
  bootLog('apply() called')
  try {
    register(ctx)
    bootLog('apply() finished')
  } catch (err) {
    bootLog(`apply() threw: ${(err && err.stack) || err}`)
  }
}

// Test hook: a one-off script can exercise the mailer without a running Host.
export { readPushConfig, sendMail }
