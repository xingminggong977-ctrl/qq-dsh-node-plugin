# qq-dsh-node-plugin

**The agent half of qq-dsh: it runs the turn.**

A DSH plugin called `qq-node`. It polls the bridge for tasks, runs one agent turn per task,
posts the result back, and between those bookends it does the parts that make the thing feel
alive: assembles the persona under a byte budget, keeps long-term memory with decay, writes a
diary, sends a sentence early when a turn is slow, and runs a nightly review.

## In short

- **Layout** (this repository *is* the deployment layout, because the plugin finds its persona
  by "the directory above the package"):

  ```
  node-plugin/   the package — package.json and the test suite live here
  persona/       the example persona; runtime memory and diaries stay out of git
  ```

- **Try it:**
  ```bash
  cd node-plugin
  node --import ./test/dsh-resolve.js --test test/index.js    # 300 tests, no network needed
  ```
- **Install it:** link the package into a DSH profile —
  `"qq-node": "link:/path/to/repo/node-plugin"` — then write your own
  [`persona/PERSONA.md`](persona/PERSONA.md) (the one in this repo is a template).
  `MEMORY.md`, `CORRECTIONS.md` and `diary/` create themselves on first write.
- **Where to start reading:** `lib/session.js` (one turn: timeouts, tool budget, early reply,
  wrap-up), `lib/persona.js` (prompt assembly and its budgets), `lib/memory.js` (tiers and
  decay).

## What it gives the agent

| Tool | What it is for |
| --- | --- |
| `remember` / `recall` | write a long-term fact; fetch an old one when it matters |
| `qq_send_file` | hand a finished file to the owner |
| `remind` | "remind me at seven" becomes a row in the bridge's database, delivered even if the turn is long gone |
| `qzone_send` | post to QQ Zone |
| `pc_exec` / `pc_read` / `pc_write` | reach a small, allow-listed part of the owner's computer |

Everything else is not a tool on purpose: prompt assembly, memory decay, tool budgets, the
silence ladder and the nightly digest all live in the runtime, where they cannot be argued
away by a model that is in a hurry.

## Privacy

The owner's long-term memory, rules and diary are injected **only** into the owner's own
private chat. Anyone else who talks to it gets the persona and public notes — and no tools at
all, because non-owner sessions are assembled with an empty preset.

All configuration, budgets and the full test list are in
[`node-plugin/README.md`](node-plugin/README.md).

## 中文

这是一个 DSH 插件：它向桥接要来任务、跑一个回合并把结果交回去。中间那些让人以为「她在」
的东西都在这个仓库里——按字节预算装配人格、带衰减的长期记忆、日记、慢回合先说一句、
工具预算、夜班复盘。

装的时候把 `node-plugin/` 链进 profile（`"qq-node": "link:/路径/仓库/node-plugin"`），
然后照 `persona/PERSONA.md` 写你自己的人格；记忆、规矩、日记会在第一次写入时自己长出来，
而且不会进 git。别人的会话拿不到你的记忆，也拿不到工具。

## License

MIT.
