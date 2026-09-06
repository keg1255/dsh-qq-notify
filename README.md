# dsh-qq-notify

DSH 插件：通过自建 QQ 推送中继站（`notice.inu1255.cn/qq/send`）推送通知。

## 通知时机

| 事件 | 行为 | 文案 |
| --- | --- | --- |
| `approval/asked`（session/event） | **立即推送** | 🔐 需要你批准：工具 + 原因 |
| `user-questions/request`（ask_user 瀑布） | **立即推送**，严格旁路观察（`return next()`，绝不吞掉问答流） | 💬 Agent 有问题要问你 |
| `turn/end` `completed` | **10 秒尾沿防抖**：同一 session 连续完成只推最后一条，附最后一条助手消息摘录（≤500 字符） | ✅ 任务完成 |
| `turn/end` 其他 kind（error/blocked/aborted/max-tokens/interrupted） | **立即推送**；未知 kind 静默忽略 | ❌ 任务出错 / ⛔ 任务受阻 / ⏹ 已中止 / 🔢 达到 token 上限 / ⏸ 已被打断 |
| `agent/error`（总线事件） | **立即推送** | 🔥 Agent 内部错误 |

助手摘录取法：`session.snapshotEvents()` 从尾倒序找最后一条 `assistant/message`，取 `data.message.content` 中 `type === 'text'` 块的 text 拼接（避开 reasoning/tool-call 块）。

## notify 工具（agent 可调用）

参数 `{ message, title? }`，走同一发送链路，滑动窗口限流（默认 10 次/分钟）。超限返回 `delivered: false, detail: "rate limited; retry in Ns"`，不会排队。

## 配置

在 `~/.dsh/profiles/web/cordis.patch.yml` 用同 id 覆盖（**字段整体替换，不是深合并**——覆盖 `events` 就要写全 `events`）：

```yaml
- id: dsh-qq-notify
  config:
    enabled: true
    url: 'http://notice.inu1255.cn/qq/send'
    openid: '<your openid>'
    debounceMs: 10000
    summaryMaxChars: 500
    events:
      turnEnd: true
      approval: true
      askUser: true
      agentError: true
    tool:
      enabled: true
      rateLimitPerMinute: 10
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 时插件完全不订阅、不注册工具 |
| `url` | `http://notice.inu1255.cn/qq/send` | 中继站地址 |
| `openid` | `''` | 为空时插件保持被动（不崩溃，只打 console.error） |
| `debounceMs` | `10000` | completed 尾沿防抖窗口 |
| `summaryMaxChars` | `500` | 摘录最大字符数 |
| `timeoutMs` | `10000` | 单次 POST 超时（5xx/网络错误自动重试 1 次） |
| `events.*` | 全 `true` | 分线开关 |
| `tool.enabled` | `true` | 是否注册 notify 工具 |
| `tool.rateLimitPerMinute` | `10` | notify 工具滑动窗口限流 |

## 账本

每次推送落一行 JSONL 到 `~/.dsh/dsh-qq-notify/ledger.jsonl`：

```json
{"at":"2025-09-06T05:17:16.563Z","kind":"approval","title":"approval","contentLength":40,"delivered":false,"failed":[{"channel":"qq-relay","error":"content is required"}],"elapsedMs":1}
```

`failed[].error` 保存失败原文。web profile 下 cordis logger 不落 stdout/stderr，所以推送结果与失败原因用 **JSONL 账本 + console.error** 双写。

## 可靠性设计（对应 dsh-notifier 的翻车点）

1. **宿主 API 以 0.1.2-rc.1 实测为准**：无 `Session.events`，只用 `snapshotEvents()`。
2. **订阅作用域**：root 上下文探测（`ctx.root.root === ctx.root`）+ 每个监听器都带 `{ global: true }`（cordis 对 global hook 免除 scope 过滤，与本 profile 内置的 dsh-rewind-plugin 同一手法）。
3. **事件载荷**：`session/event` 以 `(session, event)` 派发；`turn/end` data 为 `{ turn, reason: { kind } }`；未知 kind 静默忽略。
4. **绝不弄崩宿主**：配置缺失/渠道失败只 warn；订阅、发送、磁盘 IO 全部 try/catch；`user-questions/request` 严格 `return next()`。
5. **content 永不为空**：正文 → 标题 → 占位文本三级兜底，中继站对空 content 返回 500。
6. **日志可见性**：JSONL 账本 + console.error。

## 开发

```bash
node --test "test/*.test.mjs"   # 71 tests
```

零运行时第三方依赖（只用 `fetch` / `node:*` 内置能力 + 宿主 `@deepseek-ai/dsh-tools` 的动态可选导入，导入失败自动退化为等价的裸 JSON-Schema 工具定义）。纯 ESM，Node 22+。

## 安装（web profile）

```bash
dsh plugin --profile web add github:keg1255/dsh-qq-notify
```

或从 npm / 本地路径：

```bash
dsh plugin --profile web add dsh-qq-notify            # npm registry
dsh plugin --profile web add /path/to/dsh-qq-notify-0.1.0.tgz
```

安装命令会自动把插件注册进 `dsh.profile.bundles`，然后 `pm2 restart dsh` 生效。

### 配置 openid（必做）

`openid` 不随包分发。安装后在 `~/.dsh/profiles/web/cordis.patch.yml` 追加同 id 覆盖：

```yaml
- id: dsh-qq-notify
  config:
    openid: '<your openid>'
```

未配置 openid 时插件被动加载（console.error 警告、不发送、不影响宿主）。
