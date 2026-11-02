# qq-node

DSH（cordis）插件：长轮询云端 QQ bridge，把每个 QQ 会话跑成独立的 agent session，再把回复提交回 bridge。

- 硬依赖注入只有 `agents`；`tools` 与 attachment 服务按需取用。
- 一个 QQ 会话对应一个 agent session；同一会话的 turn 串行，跨会话受 `maxConcurrentTurns` 限制。
- 空闲超过 `idleRecycleMs` 的会话会被 dispose 并丢弃。
- 同一会话跑满 `sessionMaxTurns` 轮、或者静默超过 `sessionRotateAfterIdleMs` 后的下一条消息，会换成新会话：对话记录丢掉，身份与长期记忆（system prompt 里的 persona + MEMORY.md）留着。有 turn 在飞时不换。
- 私聊里可以在 `batchWindowMs` 窗口内把连着几条消息合成一轮；被并掉的 taskId 各自结一个空结果，正文随最后一条发出。群聊不攒批（发送人不同，合并会压平「谁说的」）。

## 挂载

本包自带 `cordis.patch.yml`，只把插件挂一次，不含任何部署值：

```yaml
- insert:
    - id: qq-node
      name: qq-node
```

`package.json` 的 `dsh.bundle.patch` 指向这个文件。手工挂载：

```powershell
node <dsh>/lib/bin.js --profile qq --patch qq-dsh/node-plugin/cordis.patch.yml
```

真实部署值（bridge URL、token、模型）写在 profile 自己的 `cordis.patch.yml` 里——它在 bundle 这一层之后应用。

## 配置项

写在挂载行的 `config` 下。`index.js` 的 `resolveOptions()` 是唯一校验与默认值来源。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `bridgeUrl` | `http://127.0.0.1:8787` | bridge 基址，必须是 http(s) URL |
| `nodeToken` | 空 | node 令牌；留空则读环境变量 `QQ_NODE_TOKEN` |
| `personaDir` | 空（= `../persona`） | 人格与记忆目录；留空按本包位置解析，不依赖 cwd |
| `pollWaitSeconds` | `25` | 单次长轮询等待秒数，协议上限 30 |
| `pollLimit` | `2` | 每次长轮询取几个任务，协议上限 5 |
| `maxConcurrentTurns` | `2` | 全局并发的 turn 上限 |
| `turnTimeoutMs` | `180000` | 单 turn 超时，超时上报 `turn timeout` |
| `toolCallBudget` | `20` | 一个回合里允许几次工具调用；到点先收尾（把已经说的话和一句交代送出去），剩下的留给下一轮，`0` 关闭。一步模型往返约 5 秒，41 次的回合正好撞满 240 秒，所以这条才是「太长」的真闸门 |
| `earlyReplyMs` | `75000` | 长回合里先把已经说出口的那句发给主人（0 关掉） |
| `idleRecycleMs` | `21600000` | 会话空闲多久后回收 |
| `sessionMaxTurns` | `60` | 同一会话跑满多少轮后换新会话，`0` 关闭 |
| `sessionRotateAfterIdleMs` | `600000` | 静默这么久后的下一条消息换新会话（话题自然断开），`0` 关闭 |
| `batchWindowMs` | `0` | 私聊里这么多毫秒内连到的消息合成一轮，`0` 关闭；群聊永不攒批 |
| `provider` / `model` / `reasoningEffort` | 空 | 留空继承 profile 默认 |
| `maxTokens` | `0` | 单 turn 输出上限，0 继承默认 |
| `cwd` | 空 | 交给 agent session 的工作目录，空则为 DSH 进程 cwd |
| `nonOwnerPreset` | `qq-chat-only` | 记在非 owner 会话上的可审计 preset 名；真正的工具封锁由 setup hook 执行 |
| `proactiveInterjection` | 见下 | 群聊插话开关与配额；`enabled: false` 时完全不触发 |
| `napcatUrl` | `ws://127.0.0.1:3001` | NapCat OneBot11 WS 口，`qzone_send` 每次调用短连一次；必须是 ws(s) URL |
| `auditDir` | 空（关闭） | 每月一个 `audit-YYYY-MM.jsonl`，记下她每一句对外发言。**留空即关闭**，因为派生默认值会让测试跑进生产审计日志；云端 profile 显式指到 `/opt/dsh-qq-agent/audit`，备份脚本已覆盖那棵树 |
| `effortTiering` | `false` | 逐条消息降思考档：短句、无任务动词、无图片走低档。**必须同时配好 `provider` 与 `model`**，否则自动关闭（tier 需要重写这两个字段） |
| `pcEnabled` | `false` | 主人电脑通道总开关。**不动就是关的**：关着时 `pc_exec`/`pc_read`/`pc_write` 一个都不注册，启动日志会写明原因。只在主人私聊里注册，群里一个都没有 |
| `pcBaseUrl` | `http://127.0.0.1:8787` | 三个 PC 工具投命令的 bridge 基址（`POST /node/pc/enqueue`）；判离线时还会主动查一次 `GET /node/pc/status` 区分「刚断开」与「没开机」。必须是 http(s) URL，通常与 `bridgeUrl` 相同 |
| `pcTimeoutMs` | `30000` | 一条命令在 bridge 上等多久，夹在协议允许的 `1000..120000`。超时按「电脑开着但没回话」上报，不按「没发出去」 |
| `lightReasoningEffort` | 空 | 低档用的 effort；**留空表示这一轮不带 effort 覆盖**，即走 provider 默认——这是它比 `max` 便宜的原因 |
| `lightMaxChars` | `40` | 超过这么多字符一律高档 |
| `nightlyEnabled` | `false` | 夜班总开关。**不动就是关的**。打开后每天 `nightlyHour:10` 读一次 digest、跑一轮复盘，唯一能写的是 `MEMORY.md` 与提案/意图文件——代码一个字都动不了（这一轮走非主人的无工具会话构造，见 `lib/nightly-runner.js`） |
| `nightlyHour` | `3` | 夜班那个整点（服务器本地时区 `Asia/Shanghai`）；分钟固定 03:10，由契约规定，挖矿器 03:00 才写完 digest。窗口开到整点结束：错过一次 tick 能补，但不会早于 03:10 跑 |
| `nightlyTimeoutMs` | `120000` | 夜班单轮预算；周日深度档会抬到至少 `180000`（契约 120s / 180s） |
| `nightlyMaxMemories` | `5` | 每晚最多接受几条记忆；契约上限 5，周日深度档 10 |
| `nightlyMaxProposals` | `3` | 每晚最多接受几条代码提案/意图；契约上限 3，周日深度档 5。`intent` 与旧 `proposal` 合并计数 |
| `nightlyDigestDir` | `/var/lib/dsh-qq-agent/nightly` | 挖矿器写 `digest-YYYY-MM-DD.md` 的目录。**文件不存在就跳过并记一行日志**，不报错、不重试 |
| `proposalsDir` | 空（= `<personaDir>/../proposals`） | 提案落盘目录，按 `YYYY-MM-DD/NN-slug.patch` + `.json`（旧通道）或 `NN-intent-M.json`（intent 通道）组织；文件已存在时报错而不是覆盖 |

`nodeToken` 为空时不轮询：只打一条 error，说明缺少令牌。

`qzone_send` 的 NapCat 令牌**不在配置里**：只读环境变量 `NAPCAT_ACCESS_TOKEN`，不落盘、不能写进 profile。它为空时不注册这个工具，只打一条 warn，插件照常启动。

### `proactiveInterjection`

```yaml
proactiveInterjection:
  enabled: false          # 默认关；关闭时任何群消息都不会额外起 turn
  minIntervalMs: 20000    # 同一群两次发言的最小间隔
  maxPerMinute: 6         # 全局每分钟最多几条插话
  maxPerGroupPerDay: 100  # 单个群 24 小时滑动窗口内最多几条插话
```

开关打开后，群里一条**不要求回复**的消息在距她上次发言 ≥ `minIntervalMs`、且两类配额都没满时，会允许跑一次 turn——这是插话唯一的触发路径；必需回复的消息不受这些上限约束。插话 turn 的回复若是空字符串或正好 `[沉默]`，则一条 QQ 消息都不发（提交空 `text`），这也算一次发言并重置间隔计时。`maxPerMinute` 与 `maxPerGroupPerDay` 的计数只统计真正跑起来的插话。

## `qzone_send`：发 QQ 空间说说

需要环境变量 `NAPCAT_ACCESS_TOKEN`（NapCat 的 WS 令牌）；为空则该工具不注册。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `content` | string，必填 | 正文，1–1000 字符；首尾空白会被去掉，去完为空则报错 |
| `visibility` | `public` \| `self`，默认 `public` | 映射到 `ugc_right`：`public` → 1，`self` → 64 |

只有这两个参数：不接受任意 OneBot action、不接受 `ugc_right` 原始数字、不传图、不支持 `ugc_right` 16/128（那需要 `target_uins`，本工具不做）。

每次调用**新开一条 WS** 连 `napcatUrl`，`Authorization: Bearer <NAPCAT_ACCESS_TOKEN>` 走握手头，发一帧 `{"action":"send_qzone_msg","params":{"content":"…","ugc_right":1},"echo":"qzone-<uuid>"}`，按 `echo` 匹配回包，拿到就 `close()`。没有常驻连接、没有重连队列。整体预算 **10 秒**，超时明确报错并关连接。

错误文本（fail 时抛给模型的就是这些，不带堆栈）：

- `retcode !== 0`：`QQ 空间发送失败：<status> retcode=<n> wording=<wording> message=<message>`（哪项有就带哪项）
- 超时：`10000ms 内没有等到 NapCat（ws://…）的回包，已关闭连接`
- 连不上：`连不上 NapCat（ws://…）：<原因>`
- 回包前被断开：`NapCat（ws://…）在回包前关闭了连接：code=<n>`

成功返回一行文本：`已发出 QQ 空间说说：tid=<tid>，可见性=公开|仅自己可见`。

## `qq_send_file`（把她做好的文件交给主人）

```
参数：path（必填，绝对路径）  name（可选，QQ 里显示的名字）
成功：发出去了：汇报.pptx（2.0 MB）
```

她原本发不出任何文件：2026-11-01 那次 240 秒的回合里她做完了 PPT，说了句「我看看怎么把它发给你」，
然后什么都没有——插件里没有发文件的工具，桥也只有 `/node/send_image` 那条只认图片扩展名的路。
现在这条路是 `POST /node/send_file`，桥把文件读成 base64 交给 NapCat（它在另一台机器上，传路径过去
只会说「文件不存在」），收件人固定是主人。

- **只发给主人 + 只打开 `QQ_FILE_ROOTS` 里的路径**（默认 `/var/lib/dsh-qq-agent/workspace:/tmp`）。
  别的路径桥回 `not_in_allowed_roots`，工具把它翻成「只能发工作区或 /tmp 下的文件」。
- 工具本身仍然只在主人的私聊里可用（`isPrivateOwnerTurn()`），群里问她要文件一律 `scope` 错误。
- 发之前先确认文件在不在：`file not found` 会原样变成「那边没找到这个文件」，别让她空口承诺。
- 上限 20 MB；文件名里的路径分隔符会被抹成 `_`。

## 群聊与协议 v2

`/node/poll` 的 task 带两个可选字段：`mentioned`（群里是否 @ 了机器人）与 `needsReply`（是否需要回复；私聊恒为 true，群里等于 `mentioned`）。

**缺字段按 true 处理。** 旧 bridge 不发这两个字段时，消息照常跑 turn——绝不能因为字段缺失就沉默。

- `needsReply: false`：只进群聊缓冲，不跑 turn，立刻提交 `{ ok: true, text: '' }`（只报 `accepted`，不报 `running`）。
- `needsReply: true`：群聊时把缓冲格式化成「群聊前文」拼在本条消息之前，再跑 turn。
- 私聊不使用缓冲，行为与 v1 一致：即使 bridge 在私聊 task 上写了 `needsReply: false`，也照样跑 turn——上下文语义只对 `kind: "group"` 生效。
群聊缓冲（`lib/groups.js`）按会话键保留最近 **20** 条 `{ nickname, text, mentioned, at }`，超出丢最旧的；格式化形如 `[昵称] 内容`，被 @ 的条目前缀 `@`：

```
--- 群聊前文 ---
[李四] 今晚有人打游戏吗
@[张三] 算我一个
--- 以上是前文 ---
@bot 还有位置吗
```

当前这条消息**不在**自己的前文里——快照在入缓冲之前取。缓冲区按进程存活，重启后清空；它不落盘，也不进人格记忆。

## 测试

```powershell
npm test
```

等价于 `node --import ./test/dsh-resolve.js --test test/index.js`，一条命令跑完 27 个测试文件——persona、session、acceptance、groups、turn-timeout、early-reply、tool-budget、memory、recall、remind、send-file、nightly、pc-tools、audit、tier 等（当前 300 个用例）。`test/dsh-resolve.js` 负责把 `@deepseek-ai/*` 解析到本机 dsh 安装，装到别处时用 `DSH_INSTALL` 覆盖安装锚点。这台机器上 PowerShell 执行策略禁用 `npm.ps1`，所以用 `npm.cmd test`。

单跑某一套时也要带 `--import ./test/dsh-resolve.js`，否则 `lib/session.js` 解析不到 `@deepseek-ai/dsh-llm`（`ERR_MODULE_NOT_FOUND`）。`audit.test.js` 与 `tier.test.js` 是纯函数，不带也能跑。

`qzone.test.js` 覆盖 `qzone_send` 的线协议面：短连一次即关、`content`/`ugc_right` 的 payload 形状（在服务端收到的 WS 帧上断言）、`Authorization` 头确实发出、`retcode !== 0` 时把 wording 带进错误、服务端不回包时按超时预算报错并关连接、`echo` 不匹配的帧被跳过、NapCat 主动推来的事件帧不会被误当成回包、`NAPCAT_ACCESS_TOKEN` 为空时不注册。它连的是 `test/qzone-ws-stub.js`（手写 RFC 6455 握手的本地假 WS 服务端），**不碰真 NapCat**。

`protocol-v2.test.js` 覆盖群聊协议面：`needsReply: false` 不产生 turn 且上报空 `text`、缓冲只留最近 20 条、`needsReply: true` 的前文注入、旧 bridge 缺字段的兼容、私聊不受 `needsReply` 影响、`proactiveInterjection.enabled: false` 的零额外 turn，以及开启后的间隔拦截与 `[沉默]` 静默。`groups.test.js` 单独覆盖环形缓冲与插话配额。

加测试：import 进 `test/index.js` 即可。不要写成 `node --test test/`——Node 24 会把该位置参数当文件解析，直接以 `ERR_UNSUPPORTED_DIR_IMPORT` 失败。

## owner 与 guest 会话

| | owner 会话 | guest（非 owner）会话 |
| --- | --- | --- |
| 工具 | 继承 profile 默认组合 | 全部封锁，`tools.guard` 固定返回 `qq-node: this QQ conversation is chat-only and has no tools` |
| `agentPreset` | 不设置 | 记录 `nonOwnerPreset` |
| 人格 + 记忆 | 注入 | 注入 |
| 日记（`personaDir/diary/`） | 注入最近 3 天 | 不注入 |

`tools` 服务缺失时插件直接抛错，而不是默默放行——非 owner 会话必须能被证明确实没有工具。

## 人格与记忆文件

人格与长期记忆放在 `qq-dsh/persona/`，即本包的 `../persona/`：`PERSONA.md`、`MEMORY.md`，以及 `diary/YYYY-MM-DD.md`。

**这些文件归项目方维护，插件只读不写。** 插件只在装配 prompt 时按需读取：人格（不限，吃剩下的）、规矩 `CORRECTIONS.md`、记忆 8 KiB、`knowledge/*.md` 合计 4 KiB、单日日记 4 KiB、日记 7 天、总计 32 KiB（留出几千字节余量：线上曾经 `total 28671/28672` 一分不剩，再多写一条记忆就要从她日记尾部悄悄切掉一天）；日记先占住 6 KiB 的预留额度，剩下的才给记忆和笔记。文件缺失只 warn 一次（按 key 去重），不中断 turn。更新人格或写日记是项目方的职责。

记忆条目自带两个标签：`- [w:N][k:kind] 正文`。`w` 是权重 1–5，`w5` 直接钉住；`k` 是档位，决定走哪条遗忘曲线——`identity` / `rule` 永不淡出，`event` / `note` 稳定期半年、`ops` 四个月，没打标的按旧行为 1 天（保守）。真正的阈值是 `retention = exp(-天数 / 稳定期)`，所以没被钉住的条目最早也要 `0.51 × 稳定期` 之后才可能掉出提示词（半年档 ≈ 92 天），这期间只要她提到一次就往后再推。淡出的条目追加进 `memory/archive.md`（带 `<!-- key: … -->` 便于去重与 `recall` 找回），**从不删除**；日记落到窗口之外时同样追加进 `memory/archive/YYYY-MM.md`，日记文件本身不动。

**被注入进提示词不算复习。** 装配一次只记 `injections`（可观测），不改 `reviews` / `lastTouchedAt`——2026-11-01 之前这里把「装了几次 prompt」当成「复习了几次」，`reviews` 涨到几千，`2 ** reviews` 的稳定期让任何条目都等于永不衰减，`forgetBelow` 一次都没命中过。只有她重新确认（`remember`）或夜班改写才算确认。

`qq:pace`（order 120，主人专属，约 370 B）是每回合的工具预算：一个回合内工具调用控制在 8 次以内、能一条命令看完的别拆开、互不依赖的几件事写在同一条消息里一起发出去、60 秒没结论就先说卡在哪，**以及要动手做的事先撂一句「我去弄，稍等」再开始**（最后这条是给 `earlyReplyMinMs` 递话的：25 秒时她会把已经说出口的那句先发出去，先撂一句才有人可以先发）。加它是因为 2026-11-01 18:31 那次 240 秒超时的会话日志里是 `steps=41 tools=41`——两个字的提问跑了 41 次工具调用，一句话都没说出来；而相邻两步的平均间隔是 4.78 秒，所以**步数就是秒数**（详见 `docs/latency-profile-2026-11-01.md`）。

**超时不等于没说话。** 回合撞上 `turnTimeoutMs` 时，`TurnTimeoutError` 会带上她已经说出口的那几段（`partialText`）；`runner` 见到非空的 `partialText` 就以 `ok: true` 把这段话发出去，末尾补一句「这事儿还没完，你回一句「继续」我就接着弄。」。只有整个回合一句话都没说时才按 `turn timeout` 失败上报，交给 bridge 说那句「我先停在这儿了」。样本：那次 240 秒的回合里她已经做完了 PPT 并说「我看看怎么把它发给你」，这句话以前被一起丢掉。

**撞墙之后先要一句交代。** 超时不是直接收摊：同一个会话里再追一句 `WRAP_UP_TEXT`（「时间到了，先停一下。不要再调用工具，用一两句话告诉我：现在做到哪一步、结果放在哪里、还差什么。」），预算 `wrapUpMs`（默认 `min(60s, max(15s, turnTimeoutMs / 4))`，240 秒的配置下就是 60 秒）。收尾轮给出内容就以那句为准发出去；收尾轮也挂住，才退回「她已经说过的那句」；两样都没有，才按失败上报。收尾轮关得掉（`wrapUpOnTimeout: false`），acceptance 3 就是这么跑的。桥这边等着不会误判：`RUNNING_LEASE_MS = 600000`，任务 running 之后最多能等十分钟。

**同一句话只进一次提示词（论文 §2.5/§2.7 的量化版）。** 三处判重都走同一个纯函数 `isNearDuplicate`（`memory.js`）：字二元组 + 拉丁整词的 Jaccard ≥ 0.60 **且** 包含度 ≥ 0.78。写入端 `remember` 命中就不再写文件，只回一句「这件事我本来就记着（这次是换个说法又提了一遍）」；装配端 `#diverseItems` 把和已选条目同话的条目留在 `MEMORY.md` 里但不重复注入（日志 `memory:similar`）；`recall` 命中集里相似度 ≥ 0.8 的只留一条。钉住的条目（`w5` 与 `identity` / `rule`）永不因此被丢。检索打分也从「数命中次数」换成 idf 加权（`log(1 + 总行数 / (1 + 含有该词的行数))`），外加整句原样命中 `+ 2`——常见词不再靠重复刷分。

**运维笔记不许挤掉她自己的生活（论文 §2.1 分区预算的量化版）。** 记忆按档位切池子：`ops`（这台机器怎么跑）和 `note`（索引/wiki 类）各 3 KiB，池满之后的新条目这一次不注入，`identity` / `rule` / `event` 不受池子限制，钉住的条目永不因为容量被丢。日志 `memory:pool` 会说省了几条。依据是线上 35 条里 `ops` 有 11 条约 1.8 KiB、`note` 3 条，而这两档长得最快、对她的生活最没用——她的塔、麦田、小尾巴属于 `event`。文件一律不动，`recall` 照样翻得到。

**全新的事多活一阵，但钉住永远是她自己说的（论文 §2.2 的有界版）。** `remember` 写入时算惊讶度 `s = 1 − max Jaccard`（与现有条目最像的那条有多像）；`s ≥ 0.8` 且她给的是 3 分时抬到 4 分。**只抬这一档**：5 分是「永远不忘」，那是她和主人的决定，不该被一次自动计算给出去——否则一句「他今天买了杯咖啡」也会被钉住；也不往下调，她刚说的话不该因为我们觉得不新鲜就更快淡掉。返回值多了 `weight` 与 `surprise`，`onWrite` 记的是抬过之后的真实权重。

**工具用太多就先收尾（`toolCallBudget` 默认 20）。** 实测一步模型往返约 5 秒，所以「这一轮长不长」几乎等于「她调了几次工具」：线上 41 次工具调用的回合正好跑满 240 秒，而 0 次工具的回合均 3.8 秒、9–20 次的均 60 秒。回合里每来一次 `tool/call` 记一笔，到预算就让这一轮收口（`TurnBudgetError`，与超时共用「先要一句交代」那条路），而不是等墙。她已经说过的话照旧保留；`wrapUpOnTimeout` 关掉时退回她自己那句话加「回一句「继续」」。这条只承诺「别让一句话等四分钟」，不阻止她用工具——真要做长活，下一轮继续即可。

**说到一半就先开口（`earlyReplyMs` 默认 75 秒，`earlyReplyMinMs` 默认 25 秒）。** 长回合里最难受的不是慢，是静音：桥那边的 22/90/180 秒垫话是罐头句子，而她可能早就说了一句真话。回合开始 75 秒时把「已经冒出来的那段」通过 `POST /node/send` 先发给主人，只认主人私聊、只在真的在问事的回合（群聊、主动搭话、上下文消息都不走这条）；回合结束时 `withoutEarly` 把那部分扣掉，只发剩下的——她已经说过的不会被重复，剩下没有新内容就干脆不发。超时那条路也共用同一个扣减：`TurnTimeoutError` 带 `earlyText`，`runner` 见到它就不再补一遍同一句。从第 25 秒起，只要她已经说出一句完整的话（有句末标点且够 12 字，或长到 40 字）就先发出去，不必等到 75 秒那个硬窗口——20 到 40 秒的回合正是最常见的静音段。半句话不发：没有句末标点又不够长，就继续等。关掉用 `earlyReplyMs: 0`。先发那句会带上 `taskId`，桥那边收到就停掉这一轮剩下的罐头垫话（`dispatch.markSpoke`）——她已经自己开口了，再补一句「还在弄」只会显得吵。

**记忆窗口满了先丢普通的。** 8 KiB 装不下时不再按文件位置硬切（那样会把她是谁、主人立过的规矩一起切掉），而是先保 identity / rule，再按「新的优先」挑普通条目；丢下的仍在 MEMORY.md 里、recall 翻得到，日志里会写一句 `memory: overflow`。
