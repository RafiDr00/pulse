# pulse▸

**Real-time session health monitor for Claude Code.**

Claude Code has been silently degrading your sessions for months. Thinking depth down 73%. 20,000 invisible tokens added per request. Context collapsing at 40% usage. Nobody told you.

`pulse` watches it all — and when quota runs low, it automatically switches to budget mode so you keep working instead of hitting a wall.

```
npm install -g @rafidr00/pulse
pulse
```

---

## What it monitors

```
● pulse  healthy  thinking: deep  context: 18%  quota: 71%  burn: 9%/hr
```

| Metric | What it catches |
|--------|----------------|
| **Thinking depth** | Detects when Anthropic silently reduces Claude's reasoning (the Feb regression that AMD's director proved with 234,760 tool calls) |
| **Context health** | Warns you before quality degrades — real degradation starts at ~20-40%, not the advertised 100% |
| **Loop detection** | Catches runaway sessions before they burn hundreds of API calls (the autocompact bug wasted 250K calls/day) |
| **Quota burn rate** | Live %/hr burn with estimated time remaining |
| **Budget mode** | Automatically switches to Sonnet + low effort when quota drops below 25% |

---

## Terminal UI

```
  pulse▸  ● HEALTHY  claude-code

  THINKING          CONTEXT           QUOTA             BURN RATE
  DEEP              WARMING           71%               9%/hr
  ████████████████  ████░░░░░░░░░░░░  ██████████░░░░░░  ▸ 7.8h left

┌─ ◈ THINKING DEPTH ──┐  ┌─ ◈ CONTEXT WINDOW ──┐
│                      │  │                      │
│  depth    ~2100 chars│  │  window   18% used   │
│  level    DEEP       │  │  tokens   36K / 200K │
│  score    ████████░░ │  │  ████░░░░░░░░░░░░░░  │
│  trend    → stable   │  │  health   warming    │
│                      │  │                      │
└──────────────────────┘  └──────────────────────┘
```

## Why this exists

In February 2026, Anthropic silently reduced Claude's default thinking depth by 73%. A senior AMD director had to analyze 6,852 session files and 234,760 tool calls to prove it. Developers were losing hours of productive work with no explanation.

Separately, a bug in Claude Code's autocompact feature caused up to 3,272 consecutive failures in a single session — burning $200/month quotas in 19 minutes. The fix was 3 lines of code. It ran for weeks.

`pulse` is the monitoring layer that should have existed from day one.

---

## Install

```bash
npm install -g @rafidr00/pulse
```

## Usage

```bash
pulse
```

## Budget mode

When quota drops below 25%, pulse automatically activates budget mode:

```
⚡ BUDGET MODE ACTIVE — quota at 23%
suggested: /model claude-sonnet-4-6  ·  /effort low  ·  /compact
```

Toggle manually with `[b]` in the terminal dashboard.

---

## How it works

Pulse hooks into Claude Code's session JSONL files at `~/.claude/projects/` and reads them in real time. No proxy. No API key. No data leaves your machine.

**Thinking depth** is estimated using the same signature correlation method from the AMD director's analysis (0.971 Pearson r) — even when Anthropic redacts the thinking content.

**Context health** uses the real degradation thresholds discovered from user reports: quality issues start at ~20% usage, not the 100% Anthropic advertises.

---

## Stack

Node.js · blessed · chalk · chokidar

---

Built by [@RafiDr00](https://github.com/RafiDr00) · MIT License
