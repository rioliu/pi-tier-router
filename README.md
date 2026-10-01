# pi-tier-router

[![npm](https://img.shields.io/npm/v/pi-tier-router.svg)](https://www.npmjs.com/package/pi-tier-router)
[![npm downloads](https://img.shields.io/npm/dm/pi-tier-router.svg)](https://www.npmjs.com/package/pi-tier-router)
[![License: MIT](https://img.shields.io/github/license/rioliu/pi-tier-router)](LICENSE)
[![Pi extension](https://img.shields.io/badge/Pi-extension-6c5ce7)](https://github.com/earendil-works/pi)

> **Pay for difficulty, not for every message.** Routine work runs on the cheap model; only genuinely hard issues escalate to the strong one.

Route a Pi coding session between a **cheap flash model** and a **strong pro model**, based on how hard the issue actually is.

This is the same tiering idea as Claude Code's haiku/sonnet/opus model levels — most work belongs on the fast, inexpensive model, and a minority of hard issues deserves the strong one. Unlike a fixed tier list, the two roles are configuration: point it at any model family (MiMo, DeepSeek, an OpenAI-compatible endpoint, or a mix of providers).

## What it does

Pi exposes the router as a virtual model, `router/auto`. While it is selected, the first user message of each session is rated once and the result is stored for the rest of that session branch:

```
first user message
  1. flash model rates the issue itself (rating + confidence)
       confidence >= 0.8  -> decision is final, nothing else is consulted
  2. unsure  -> ask Jev, but only if JEVMODEL_API_KEY is configured
  3. no Jev  -> keep the flash model's lean
  4. neither -> keep the current model (flash for a new session); routing stops
```

- **Rated once per session branch**, so later turns keep their prompt cache and cost nothing extra.
- **Jev is optional**, never a dependency. In normal operation it is called zero times.
- **Compaction summaries** always run on the flash model.
- The deciding call is bounded at 10s and uses minimal reasoning, so it never holds up a turn.

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

The extension owns its config, next to the extension itself:

```
~/.pi/agent/extensions/auto-router.json      # plain file install
~/.pi/agent/extensions/auto-router.json      # npm install (config survives `pi update`)
```

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
[auto-router] self rated=pro conf=0.92
[auto-router] decided self/pro in 1432ms
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

The suite covers the decision chain, config persistence and refresh, change warnings, and the `provider/model-id` parser. It runs against a temporary copy of the extension, so it never writes into your real Pi directory.

## License

MIT
