# dsh-task-ping

DSH 任务提醒插件：**对话一结束就提醒你**，三种手段合在一个插件里。

| 手段 | 说明 | 平台 |
|---|---|---|
| 桌面弹窗 | 系统通知，点一下跳回对应会话 | Windows / macOS / Linux（走浏览器通知） |
| 提示音 + 自动压低音乐 | 声音在 **通信端点** 播放，Windows 按「通信活动」把其他媒体自动压到 50%，播完自动恢复；不改任何人音量 | Windows |
| 邮件推送 | 同一份内容再发一封邮件到手机，人不在电脑前也能收到 | 全平台 |

触发时机：**每轮对话结束**、**需要你审批**、**需要你回答**、**需要你确认计划**。二级会话（子代理）不打扰。

## 安装

DSH 插件市场里搜 `dsh-task-ping` 一键装；或命令行：

```sh
dsh plugin --profile desktop add dsh-task-ping
```

装完**完全退出并重开 DSH**（客户端模块不热更），再到 **设置 → 通用** 里确认「任务完成提醒」是开的。

## 桌面提醒

设置页里可开关、调音量、换提示音（支持上传自定义音效）。

- 提示音走 Windows 的 *通信* 播放端点，系统会按「声音 → 通信」里的档位自动压低其他媒体（默认 50%）。插件**不修改**任何应用的音量。
- 副作用：为了让声音落在你正在用的设备上，插件会把「默认通信设备」同步成当前播放设备。微信 / 游戏语音这类通信类应用也会跟着切设备；不想要就把 `index.js` 里 `'-SyncComm', '1'` 改成 `'0'`。

## 邮件推送（可选）

1. 准备一个支持 SMTP 的邮箱（QQ / 163 / 126 都可以），拿到 **授权码**（不是登录密码）。QQ 邮箱：设置 → 账号 → 开启「IMAP/SMTP 服务」→ 短信验证 → 16 位授权码。
2. 把 `push.config.example.json` 复制成 `%USERPROFILE%\.dsh\dsh-task-notify-push.json`（Windows）或 `~/.dsh/dsh-task-notify-push.json`，填好账号：

```json
{
  "enabled": true,
  "host": "smtp.qq.com",
  "port": 465,
  "secure": true,
  "user": "you@qq.com",
  "pass": "授权码",
  "fromName": "DSH",
  "to": "you@qq.com"
}
```

3. 改完即时生效，不用重启。关掉推送把 `"enabled"` 改成 `false`。

- `secure: true` → 465 端口，隐式 TLS。
- `secure: false` → 587/25 端口，自动升级 STARTTLS；服务器不支持 STARTTLS 时**拒绝发信**，不会把授权码明文发出去。

## 排查

| 现象 | 看哪里 |
|---|---|
| 装了但完全没反应 | `~/.dsh/dsh-task-notify-boot.log` — 每次启动的注册过程 |
| 邮件没收到 | `~/.dsh/dsh-task-notify-push.log` — 每封的 `sent` / `failed` 与 SMTP 错误码 |
| 声音没响 | `%TEMP%\dsh-task-notify\play-comm.log` — 助手进程的播放日志 |

常见错误码：`AUTH pass: 535` 是授权码错（不是登录密码）；`connect timeout` 是本机到 `smtp.qq.com:465` 不通。

## 要求

- Windows（桌面弹窗与提示音）；macOS / Linux 上只有邮件推送生效。
- 提示音需要 PowerShell 7（`pwsh`），没有时自动回退到系统自带 5.1。

## 许可

MIT
