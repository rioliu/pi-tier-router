<p align="center">
  <img src="https://rioliu.github.io/pi-tier-router/logo.svg" width="96" height="96" alt="pi-tier-router logo">
</p>

# pi-tier-router

[![npm](https://img.shields.io/npm/v/pi-tier-router.svg)](https://www.npmjs.com/package/pi-tier-router)
[![repo size](https://img.shields.io/github/repo-size/rioliu/pi-tier-router.svg)](https://github.com/rioliu/pi-tier-router)
[![License: MIT](https://img.shields.io/github/license/rioliu/pi-tier-router)](LICENSE)
[![Pi extension](https://img.shields.io/badge/Pi-extension-6c5ce7)](https://github.com/earendil-works/pi)

> **Pay for difficulty, not for every message.** Routine work runs on the cheap model; only genuinely hard issues escalate to the strong one.

**Project page:** [rioliu.github.io/pi-tier-router](https://rioliu.github.io/pi-tier-router/)

Route a Pi coding session between a **cheap flash model** and a **strong pro model**, based on how hard the issue actually is.

This is the same tiering idea as Claude Code's haiku/sonnet/opus model levels — most work belongs on the fast, inexpensive model, and a minority of hard issues deserves the strong one. Unlike a fixed tier list, the two roles are configuration: point it at any model family (MiMo, DeepSeek, an OpenAI-compatible endpoint, or a mix of providers).

## What it does

Pi exposes the router as a virtual model, `router/auto`. While it is selected, **every prompt is
decided on its own** the moment it arrives, and that decision serves the whole agent run (tool loop
included):

```
prompt arrives (before_agent_start)
  0. local router reads the prompt: 0 ms, no tokens, deterministic
       clear signals  -> decided right away (flash or pro)
       mixed/missing  -> abstain
  1. on abstain: the decision store is consulted first
       a similar past verdict is reused (signal-profile overlap or trigram
       match, k-NN vote) -> no model call at all
  2. otherwise: flash model rates the issue itself (rating + confidence)
       confidence >= 0.8  -> decision is final, nothing else is consulted
       and the verdict is stored for future prompts
  3. unsure  -> ask Jev, but only if JEVMODEL_API_KEY is configured
  4. no Jev  -> keep the flash model's lean
  5. neither -> keep the current model (flash for a new session); routing stops
```

- **One prompt, one decision** — the next prompt re-decides, so a hard task can escalate without
  locking the whole session to pro.
- **Local first**: routine and obviously hard prompts never reach a model. `/auto-router status`
  reports how often the local layer decided on its own. Signals cover **English and Chinese**
  (stack traces are language-neutral), and the scan looks at the first 32 KB only — a 1 MB paste
  still decides in ~0.3 ms, and past the window the layer abstains rather than guess.
- **It remembers**: chain verdicts from the abstain zone are stored next to the extension — a
  JSONL journal on disk and a fixed typed-array ring in memory (2 000 entries, ~285 KB, never
  grows with age). Similar prompts reuse them instead of paying for a rating call; neighbours
  that disagree keep abstaining. The file is removed together with the extension, and deleting
  it by hand is always safe — the store rebuilds itself.
- **Jev is optional**, never a dependency — consulted only when the local layer abstains *and* the
  flash model is unsure.
- **Compaction summaries** always run on the flash model.
- The model-based decision is bounded at 10s and uses minimal reasoning, so it never holds up a turn.

## Install

```bash
pi install npm:pi-tier-router
```

Or straight from GitHub while the npm package is pending:

```bash
pi install git:github.com/rioliu/pi-tier-router
```

Install **one or the other**. Loading both silently breaks the wizard: `/auto-router` stops dispatching and the literal text is sent to the model instead.

Then select it: `/model` → `router/auto`, and press `Ctrl+S` to make it the default for new sessions. Or set it directly in `settings.json`:

```json
{ "defaultProvider": "router", "defaultModel": "auto" }
```

Routing only runs while `router/auto` is selected. With any other model — including a physical pro model as your default — the extension does nothing.

## Configure

The extension owns its config, **next to the extension file** — so uninstalling the
extension takes its config with it:

```
<install-dir>/extensions/auto-router.json
```

| install method | config path |
|---|---|
| plain file | `~/.pi/agent/extensions/auto-router.json` |
| `pi install npm:` | `~/.pi/agent/npm/node_modules/pi-tier-router/extensions/auto-router.json` |
| `pi install git:` | `~/.pi/agent/git/github.com/rioliu/pi-tier-router/extensions/auto-router.json` |

`pi update` preserves the file — verified for both npm and git sources. If an older copy is
sitting in `~/.pi/agent/extensions/`, it is read and **moved next to the extension the first time
it loads**, so uninstalling leaves nothing behind.

```json
{
  "flash-model": "deepseek/deepseek-v4-flash",
  "pro-model":   "deepseek/deepseek-v4-pro"
}
```

Values are `provider/model-id` (split on the **first** slash, so ids containing slashes work, e.g. `openrouter/typesafe/jev-1.13`). The two roles may live on different providers. Omitted or malformed keys fall back to a MiMo pair.

Create or change it with the built-in wizard:

| command | effect |
|---|---|
| `/auto-router` | interactive: pick both roles from the models Pi can reach |
| `/auto-router status` | show config path, both roles, whether the pair resolves, current default |
| `/auto-router memory` | show the decision store: path, size, ring fill, session reuse, recent verdicts |
| `/auto-router memory reset` | wipe the store — it rebuilds itself from new verdicts |
| `/auto-router set flash=<provider/id> pro=<provider/id>` | write the config and reload |

The wizard writes only its own file. **`models.json` is never touched** — availability is read from Pi's live model registry — and the only value read from `settings.json` is your default model id, used to warn you when it changes.

## Behaviour when configuration changes

The extension re-checks at session start and before every prompt, so it follows your model settings instead of going silently dead:

| condition | result |
|---|---|
| default model is `router/auto` but the pair is missing | **error** notification + degraded (never a crash) |
| configured pair missing (provider rewritten, pro model removed) | **warning** + router disabled |
| default model changed during the run | **info** notification (pick it in `/model` to route) |
| no config yet, or no matching pair | inactive; Pi behaves exactly as if it were not installed |

Issues are announced when they appear, not on every prompt.

## Watching a decision

```
AUTO_ROUTER_DEBUG=1 pi
[auto-router] roles flash=... pro=...
[auto-router] local pro conf=0.93 via concurrency
```

Local decisions print a single line and cost nothing. Only an abstain reaches the store or the
model chain:

```
[auto-router] local abstain; flash rating chain decides
[auto-router] self rated=pro conf=0.92
[auto-router] decided self/pro in 1432ms
[auto-router] stored pro by self (4 entries)

[auto-router] local abstain; flash rating chain decides
[auto-router] memory flash (3 neighbours, 100% agree)      <- no rating call at all
```

The interactive footer shows the routed model (`auto • medium → deepseek-v4-pro`) and `/session` lists cost per physical model.

## Disable it

Pick any physical model in `/model`, or set your default to the pro model — routing then never engages. Removing the config file deactivates the router entirely.

## Requirements

Both role models must be registered in `models.json` with working credentials.

## Development

```bash
npm test        # node >= 23 (native TypeScript stripping)
```

The suite covers the local router's signal table, the decision chain, the hook → route() wiring,
the decision store (round-trip through the journal, torn lines, ring and journal caps, the
agreement gate), config persistence and refresh, change warnings, and the `provider/model-id`
parser. It runs against a temporary copy of the extension, so it never writes into your real Pi
directory.

## License

MIT
