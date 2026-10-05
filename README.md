# opencode-zai-usage

A TUI status plugin for [OpenCode](https://opencode.ai) that shows your
**Z.AI / GLM Coding Plan** usage (GLM models: `glm-4.7`, `glm-5`, `glm-5.1`,
`glm-5.2`, `glm-5.3`, …) right in the interface. It automatically detects
the subscription type: legacy plans are counted in **prompts**, newer ones in
**credits/tokens**.

```
5h:  187 / 400 prompts          # legacy subscription (prompts)
5h:  1.2M / 5M credits          # new subscription (credits/tokens)
```

## What it shows and where

| Location | Format |
|---|---|
| Home screen (line under the input, slot `home_bottom`) | `5h: 0/400 · Wk: 1240/2000` |
| Session input (right side, slot `session_prompt_right`) | `5h: 0/400 · Wk: 1240/2000` |
| Sidebar (slot `sidebar_content`) | panel with header `Z.ai usage · pro · credits`, limit rows and a footer (see below) |
| `/zai` command | toast with counters, units, percentages and the reset time |

Value color by percentage: ≤20% muted, ≤50% green, ≤75% yellow,
≤90% orange, >90% red.

**Sidebar footer**: `↻ 11:20:09 AM` — last refresh time
(+` (cached)` if served from cache). When a limit is exhausted, the footer
switches to a countdown until reset: `↻ 5h in 2h 13m · Wk in 3d 4h`.

## Installation

**Prerequisites**: a working [OpenCode](https://opencode.ai) install and a
Z.AI Coding Plan account (the plugin reads the API token from OpenCode's
`auth.json` automatically; see [How it works](#how-it-works) for the
fallback chain).

1. Clone the repository (any location works — the plugin is a single file):

   ```bash
   git clone https://github.com/yoshkin-kod/opencode-zai-usage.git
   cd opencode-zai-usage
   ```

2. Link (or copy) the plugin into your OpenCode plugins directory:

   ```bash
   ln -s "$PWD/opencode-zai-usage.tsx" ~/.config/opencode/plugins/opencode-zai-usage.tsx
   ```

   Equivalent with `cp`:

   ```bash
   cp opencode-zai-usage.tsx ~/.config/opencode/plugins/
   ```

3. Register the plugin in `~/.config/opencode/tui.json`. TUI plugins are
   read from `tui.json`, not from `opencode.json`, and the built-in
   `plugins/*.{ts,js}` glob does not pick up `.tsx` files — so the path
   must be listed explicitly:

   ```json
   {
     "plugin": [
       "…other plugins…",
       "./plugins/opencode-zai-usage.tsx"
     ]
   }
   ```

4. Restart OpenCode. The status line appears on the home screen when a
   Z.AI plan model is selected; run `/zai` to force a refresh and see the
   full quota summary.

5. (Optional) create `~/.config/opencode/zai-usage.json` if you need to
   override the token, endpoint, visibility, or caps — see
   [Configuration](#configuration-user-level).

If you later move or delete the cloned repository, re-run step 2 (or copy
the file instead of symlinking).

## Configuration (user-level)

Config file: `~/.config/opencode/zai-usage.json` (override the path with the
`ZAI_USAGE_CONFIG` environment variable). All fields are optional:

```json
{
  "token": "…",
  "api_url": "https://api.z.ai/api/monitor/usage/quota/limit",
  "cache_path": "/tmp/zai-quota.json",
  "cache_ttl_ms": 90000,
  "refresh_ms": 60000,
  "show_always": false,
  "plan": {
    "provider_match": ["zai", "z-ai", "bigmodel"],
    "model_regex": "^glm-"
  },
  "caps": {
    "lite": { "h5": 80, "week": 400 },
    "pro":  { "h5": 400, "week": 2000 },
    "max":  { "h5": 1600, "week": 8000 }
  }
}
```

| Field | Purpose |
|---|---|
| `token` | Explicit API token (otherwise discovered via auth.json / env, see below) |
| `api_url` | Quota endpoint |
| `cache_path` / `cache_ttl_ms` | Shared cache file and its TTL |
| `refresh_ms` | Auto-refresh interval |
| `show_always` | `false` (default) — show the status only when a plan model is selected; `true` — always show (for debugging) |
| `plan.provider_match` | Substrings that mark a provider as Z.AI |
| `plan.model_regex` | Regex matched against the model ID; dynamic — future models (`glm-5.3`, `glm-5.3-flash`, …) match automatically |
| `caps` | Fallback caps (prompts per 5h / per week) keyed by `data.level` for legacy subscriptions |

### Visibility

By default the status is shown **only when a Z.AI plan model is selected**
(the current session model is checked against `plan.provider_match` /
`plan.model_regex`). If the model cannot be determined, the status is shown
(fail-open). Set `"show_always": true` to disable the check and always show
the status — useful for debugging.

### Subscription type: prompts vs credits

Detected automatically from the API response:

- **Legacy (prompts)**: the response contains only percentages → the count
  is derived as `round(pct × cap / 100)` from the `caps` table, labeled
  ` prompts`.
- **New (credits/tokens)**: the response contains `usage` / `currentValue` /
  `remaining` → numbers are taken as-is; the unit comes from the limit type
  (`CREDIT…` → ` credits`, otherwise ` tokens`) and is added to the header
  as ` · credits` / ` · tokens`. For rows with absolute values the limit is
  computed as `used + remaining` instead of using the `caps` table.

## Development

```bash
bun install        # or npm install
npm run typecheck  # tsc --noEmit, jsxImportSource @opentui/solid
```

Runtime dependencies (solid-js, @opentui/*) are provided by OpenCode's own
bundle — you don't need to add them to your config `package.json`.

## How it works

- **Token** (first match wins): `token` from config → env `ZAI_TOKEN` →
  env `Z_AI_API_KEY` → `~/.local/share/opencode/auth.json`, key
  `zai-coding-plan.key` (or `zai.key`).
- **Endpoint**: `GET https://api.z.ai/api/monitor/usage/quota/limit` with
  `Authorization: Bearer <token>`.
- **Windows**: the 5-hour window is the `TOKENS_LIMIT unit=3 number=5` row,
  the weekly window is `unit=6 number=1`. The `TIME_LIMIT` row is the
  monthly MCP budget and is not used by the plugin.
- **Cache**: shared with Claude Code statusline scripts —
  `/tmp/zai-quota.json`, 90s TTL, atomic writes, force refresh via `/zai`,
  auto-refresh every 60 seconds; on network errors the stale cache is served.

## License

[MIT](LICENSE)
