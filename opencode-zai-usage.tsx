/** @jsxImportSource @opentui/solid */

// z.ai usage: GET <api_url> (Bearer token).
// Config (user-level): ~/.config/opencode/zai-usage.json, override via ZAI_USAGE_CONFIG.
// Prompt plans (legacy): TOKENS_LIMIT rows carry only `percentage`, absolute counts
// are derived as round(pct * cap / 100). Credit/token plans: rows carry absolute
// `currentValue`/`usage`/`remaining` and are shown as-is.
// Shares cache (default /tmp/zai-quota.json, mtime TTL 90s) with
// ~/.claude/statusline-command.sh.

import type {
  TuiPlugin,
  TuiPluginApi,
  TuiSlotContext,
  TuiThemeCurrent,
} from "@opencode-ai/plugin/tui"
import { createSignal, Show } from "solid-js"
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

type Color = string | TuiThemeCurrent["error"]
type Unit = "prompts" | "credits" | "tokens"

interface PlanConfig {
  provider_match?: string[]
  model_regex?: string
}

interface PluginConfig {
  token?: string
  api_url?: string
  cache_path?: string
  cache_ttl_ms?: number
  refresh_ms?: number
  show_always?: boolean
  plan?: PlanConfig
  caps?: Record<string, { h5: number; week: number }>
}

const DEFAULT_CONFIG: PluginConfig = {
  api_url: "https://api.z.ai/api/monitor/usage/quota/limit",
  cache_path: "/tmp/zai-quota.json",
  cache_ttl_ms: 90_000,
  refresh_ms: 60_000,
  show_always: false,
  plan: {
    provider_match: ["zai", "z-ai", "bigmodel"],
    model_regex: "^glm-",
  },
  caps: {
    lite: { h5: 80, week: 400 },
    pro: { h5: 400, week: 2000 },
    max: { h5: 1600, week: 8000 },
  },
}
const DEFAULT_CAPS = DEFAULT_CONFIG.caps!.pro!

interface QuotaRow {
  type: string
  unit?: number
  number?: number
  percentage?: number
  nextResetTime?: number
  usage?: number
  currentValue?: number
  remaining?: number
}

interface QuotaPayload {
  code?: number
  data?: { limits?: QuotaRow[]; level?: string }
  success?: boolean
}

interface QuotaWindow {
  used: number
  cap: number
  pct: number
  reset?: number
  absolute: boolean
  unit: Unit
}

interface Snapshot {
  five: QuotaWindow
  week: QuotaWindow
  level: string
  kind: Unit
  fetchedAt: number
  source: "live" | "cache"
}

interface ModelRef {
  providerID: string
  modelID: string
}

/** Model-switch events on the bus; the SDK Event union is stale and omits them. */
interface ModelSwitchedEventLike {
  created?: number
  timestamp?: number
  sessionID?: string
  data?: { model?: ModelRefLike; timestamp?: number; sessionID?: string }
  properties?: { model?: ModelRefLike; sessionID?: string }
  model?: ModelRefLike
}

/** Narrow cast target: TuiEventBus only types SDK-known event names. */
interface EventBusLike {
  on(type: string, handler: (event: ModelSwitchedEventLike) => void): () => void
}

let configPath = join(homedir(), ".config", "opencode", "zai-usage.json")
let modelJsonPath = join(homedir(), ".local", "share", "opencode", "model.json")
let gApi: TuiPluginApi | undefined

let cfgCache: { cfg: PluginConfig; mtimeMs: number } | undefined

function loadConfig(): PluginConfig {
  try {
    const st = statSync(configPath)
    if (cfgCache && cfgCache.mtimeMs === st.mtimeMs) return cfgCache.cfg
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as PluginConfig
    const cfg: PluginConfig = {
      ...DEFAULT_CONFIG,
      ...raw,
      plan: { ...DEFAULT_CONFIG.plan, ...raw.plan },
      caps: { ...DEFAULT_CONFIG.caps, ...raw.caps },
    }
    cfgCache = { cfg, mtimeMs: st.mtimeMs }
    return cfg
  } catch {
    return {
      ...DEFAULT_CONFIG,
      plan: { ...DEFAULT_CONFIG.plan },
      caps: { ...DEFAULT_CONFIG.caps },
    }
  }
}

function readToken(cfg: PluginConfig): string {
  const candidates: Array<string | undefined> = []
  if (typeof cfg.token === "string") candidates.push(cfg.token)
  candidates.push(process.env.ZAI_TOKEN, process.env.Z_AI_API_KEY)
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".local", "share", "opencode", "auth.json"), "utf8"))
    candidates.push(auth?.["zai-coding-plan"]?.key, auth?.zai?.key)
  } catch {
    // missing/unreadable file — try the next source
  }
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"))
    candidates.push(settings?.env?.ANTHROPIC_AUTH_TOKEN)
  } catch {
    // no token in any source
  }
  for (const key of candidates) {
    if (typeof key === "string" && key.length > 10) return key
  }
  return ""
}

interface CacheRead {
  payload: QuotaPayload
  fresh: boolean
}

function readCache(cfg: PluginConfig): CacheRead | undefined {
  try {
    const path = cfg.cache_path!
    if (!existsSync(path)) return undefined
    const payload = JSON.parse(readFileSync(path, "utf8")) as QuotaPayload
    if (!Array.isArray(payload?.data?.limits)) return undefined
    const age = Date.now() - statSync(path).mtimeMs
    return { payload, fresh: age < cfg.cache_ttl_ms! }
  } catch {
    return undefined
  }
}

let inflight: Promise<QuotaPayload | undefined> | undefined

async function fetchRemote(cfg: PluginConfig): Promise<QuotaPayload | undefined> {
  const token = readToken(cfg)
  if (!token) return undefined
  try {
    const res = await fetch(cfg.api_url!, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return undefined
    const text = await res.text()
    const payload = JSON.parse(text) as QuotaPayload
    if (!Array.isArray(payload?.data?.limits)) return undefined
    try {
      const tmp = `${cfg.cache_path}.${process.pid}.tmp`
      writeFileSync(tmp, text)
      renameSync(tmp, cfg.cache_path!)
    } catch {
      // cache is best-effort; payload still usable
    }
    return payload
  } catch {
    return undefined
  }
}

/** Fresh cache wins unless force; network failure falls back to stale cache. */
async function loadQuota(force = false): Promise<{ payload: QuotaPayload; stale: boolean } | undefined> {
  const cfg = loadConfig()
  const cached = readCache(cfg)
  if (cached?.fresh && !force) return { payload: cached.payload, stale: false }
  if (!inflight) {
    inflight = fetchRemote(cfg).finally(() => {
      inflight = undefined
    })
  }
  const fresh = await inflight
  if (fresh) return { payload: fresh, stale: false }
  if (cached) return { payload: cached.payload, stale: true }
  return undefined
}

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function rowUnit(row: QuotaRow): Unit {
  return row.type.includes("CREDIT") ? "credits" : "tokens"
}

function toWindow(row: QuotaRow | undefined, cap: number, derivedUnit: Unit): QuotaWindow {
  if (!row) return { used: 0, cap, pct: 0, absolute: false, unit: derivedUnit }
  const pct = clampPct(Number(row.percentage ?? 0))
  const reset = typeof row.nextResetTime === "number" ? Math.floor(row.nextResetTime / 1000) : undefined
  const hasAbs = typeof row.currentValue === "number" || typeof row.remaining === "number"
  if (hasAbs) {
    const used =
      typeof row.currentValue === "number"
        ? Math.round(row.currentValue)
        : typeof row.remaining === "number" && typeof row.usage === "number" && row.usage > 0
          ? Math.round(row.usage - row.remaining)
          : Math.round((pct * cap) / 100)
    const limit =
      typeof row.usage === "number" && row.usage > 0
        ? Math.round(row.usage)
        : typeof row.remaining === "number"
          ? used + Math.round(row.remaining)
          : cap
    const usedPct = typeof row.percentage === "number" ? pct : clampPct((used / Math.max(1, limit)) * 100)
    return { used, cap: limit, pct: usedPct, reset, absolute: true, unit: rowUnit(row) }
  }
  const limit = typeof row.usage === "number" && row.usage > 0 ? Math.round(row.usage) : cap
  return { used: Math.round((pct * cap) / 100), cap: limit, pct, reset, absolute: false, unit: derivedUnit }
}

function toSnapshot(result: { payload: QuotaPayload; stale: boolean }): Snapshot {
  const cfg = loadConfig()
  const data = result.payload.data ?? {}
  const limits = data.limits ?? []
  const levelKey = (data.level ?? "pro").toLowerCase()
  const caps = cfg.caps?.[levelKey] ?? DEFAULT_CAPS
  // 5h window = unit 3 / number 5; week window = unit 6 / number 1.
  // TIME_LIMIT (unit 5 / number 1) is the monthly MCP budget — unused here.
  const windowRows = limits.filter((row) => row.type !== "TIME_LIMIT")
  const fiveRow = windowRows.find((row) => row.unit === 3 && row.number === 5) ?? windowRows[0]
  const weekRow = windowRows.find((row) => row.unit === 6 && row.number === 1) ?? windowRows[1]
  const five = toWindow(fiveRow, caps.h5, "prompts")
  const week = toWindow(weekRow, caps.week, "prompts")
  const kind: Unit = five.absolute ? five.unit : week.absolute ? week.unit : "prompts"
  return {
    five,
    week,
    level: cfg.caps?.[levelKey] ? levelKey : data.level ?? "pro",
    kind,
    fetchedAt: Date.now(),
    source: result.stale ? "cache" : "live",
  }
}

function parseModel(value: string | undefined): ModelRef | undefined {
  if (!value) return undefined
  const idx = value.indexOf("/")
  if (idx <= 0) return undefined
  return { providerID: value.slice(0, idx), modelID: value.slice(idx + 1) }
}

/** Lowercase + strip non-alphanumerics so "z.ai", "z-ai" and "zai" all match. */
function normId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "")
}

function isPlanModel(model: ModelRef | undefined, cfg: PluginConfig): boolean {
  if (!model) return true
  const providerMatch = cfg.plan?.provider_match ?? DEFAULT_CONFIG.plan!.provider_match!
  const modelRegex = cfg.plan?.model_regex ?? DEFAULT_CONFIG.plan!.model_regex!
  const providerID = normId(model.providerID)
  if (providerMatch.some((needle) => needle && providerID.includes(normId(needle)))) return true
  try {
    return new RegExp(modelRegex, "i").test(model.modelID)
  } catch {
    return false
  }
}

/** Model.Ref in messages/events is `{id, providerID, variant}`; model.json uses `{modelID}`. */
interface ModelRefLike {
  id?: string
  modelID?: string
  providerID?: string
}

function modelFromRefLike(raw: ModelRefLike | undefined): ModelRef | undefined {
  if (!raw || typeof raw.providerID !== "string") return undefined
  const id = typeof raw.id === "string" ? raw.id : typeof raw.modelID === "string" ? raw.modelID : undefined
  if (!id) return undefined
  return { providerID: raw.providerID, modelID: id }
}

/** Epoch seconds or milliseconds → milliseconds (0 when absent). */
function toMs(at: number | undefined): number {
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return 0
  return at < 1e12 ? at * 1000 : at
}

function modelOfMessage(message: unknown): { model?: ModelRef; at: number } {
  const msg = message as { model?: ModelRefLike; time?: { created?: number } }
  // Newest-first scan: an absent timestamp must not lose to model.json noise.
  const at = toMs(msg?.time?.created) || Number.MAX_SAFE_INTEGER
  return { model: modelFromRefLike(msg?.model), at }
}

const [picker, setPicker] = createSignal<{ model?: ModelRef; mtimeMs: number } | undefined>(undefined)
const [now, setNow] = createSignal(Date.now())
const [selected, setSelected] = createSignal<{ model: ModelRef; at: number; sessionID?: string } | undefined>(
  undefined,
)

function readPickerModel(): { model?: ModelRef; mtimeMs: number } | undefined {
  try {
    const st = statSync(modelJsonPath)
    const parsed = JSON.parse(readFileSync(modelJsonPath, "utf8")) as {
      recent?: Array<{ providerID?: string; modelID?: string }>
    }
    const head = parsed?.recent?.[0]
    const model =
      head && typeof head.providerID === "string" && typeof head.modelID === "string"
        ? { providerID: head.providerID, modelID: head.modelID }
        : undefined
    return { model, mtimeMs: st.mtimeMs }
  } catch {
    return undefined
  }
}

/**
 * Freshest of: model-switch event, session transcript model, model picker
 * (model.json recent[0]), config default. Ties prefer event > message > picker.
 */
function currentModel(sessionID?: string): ModelRef | undefined {
  const candidates: Array<{ model: ModelRef; at: number; rank: number }> = []
  const sel = selected()
  if (sel && (!sel.sessionID || sel.sessionID === sessionID)) {
    candidates.push({ model: sel.model, at: sel.at, rank: 0 })
  }
  if (sessionID && gApi) {
    const messages = gApi.state.session.messages(sessionID) as ReadonlyArray<unknown>
    for (let i = messages.length - 1; i >= 0; i--) {
      const { model, at } = modelOfMessage(messages[i])
      if (model) {
        candidates.push({ model, at, rank: 1 })
        break
      }
    }
  }
  const picked = picker()
  if (picked?.model) candidates.push({ model: picked.model, at: picked.mtimeMs, rank: 2 })
  if (candidates.length === 0) return parseModel(gApi?.state.config?.model)
  candidates.sort((a, b) => b.at - a.at || a.rank - b.rank)
  return candidates[0].model
}

function visibleFor(sessionID?: string): () => boolean {
  return () => {
    const cfg = loadConfig()
    if (cfg.show_always) return true
    return isPlanModel(currentModel(sessionID), cfg)
  }
}

function fmtCount(value: number, unit: Unit): string {
  if (unit === "prompts") return String(Math.round(value))
  const abs = Math.abs(value)
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  return String(Math.round(value))
}

function fmtRemaining(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function isExhausted(window: QuotaWindow): boolean {
  return window.pct >= 100 || (window.cap > 0 && window.used >= window.cap)
}

function resetIn(window: QuotaWindow, at: number): string | undefined {
  if (!window.reset) return undefined
  return fmtRemaining(window.reset * 1000 - at)
}

// Gray <= 20, green <= 50, yellow <= 75, orange <= 90, red above.
function pctColor(theme: TuiThemeCurrent, pct: number): Color {
  if (pct > 90) return theme.error
  if (pct > 75) return "#f0883e"
  if (pct > 50) return theme.warning
  if (pct > 20) return theme.success
  return theme.textMuted
}

function CompactStatus(props: {
  context: TuiSlotContext
  snap: () => Snapshot | undefined
  visible: () => boolean
}) {
  const theme = () => props.context.theme.current
  return (
    <Show when={props.visible()}>
      <Show
        when={props.snap()}
        fallback={<text fg={theme().textMuted}>z.ai: —</text>}
      >
        {(snap) => (
          <box flexDirection="row" gap={1}>
            <text fg={theme().textMuted}>5h:</text>
            <text fg={pctColor(theme(), snap().five.pct)}>
              {fmtCount(snap().five.used, snap().five.unit)}/{fmtCount(snap().five.cap, snap().five.unit)}
            </text>
            <text fg={theme().textMuted}>·</text>
            <text fg={theme().textMuted}>Wk:</text>
            <text fg={pctColor(theme(), snap().week.pct)}>
              {fmtCount(snap().week.used, snap().week.unit)}/{fmtCount(snap().week.cap, snap().week.unit)}
            </text>
          </box>
        )}
      </Show>
    </Show>
  )
}

function SidebarPanel(props: {
  context: TuiSlotContext
  snap: () => Snapshot | undefined
  visible: () => boolean
}) {
  const theme = () => props.context.theme.current
  const title = () => {
    const snap = props.snap()
    if (!snap) return "Z.ai usage"
    const kind = snap.kind === "prompts" ? "" : ` · ${snap.kind}`
    return `Z.ai usage · ${snap.level}${kind}`
  }
  const footer = () => {
    const snap = props.snap()
    if (!snap) return "↻ —"
    const at = now()
    const parts: string[] = []
    if (isExhausted(snap.five)) {
      const left = resetIn(snap.five, at)
      if (left) parts.push(`5h in ${left}`)
    }
    if (isExhausted(snap.week)) {
      const left = resetIn(snap.week, at)
      if (left) parts.push(`Wk in ${left}`)
    }
    if (parts.length > 0) return `↻ ${parts.join(" · ")}`
    const updated = new Date(snap.fetchedAt).toLocaleTimeString()
    return `↻ ${updated}${snap.source === "cache" ? " (cached)" : ""}`
  }
  const row = (label: string, window: () => QuotaWindow) => {
    const unitLabel = () => (window().unit === "prompts" ? " prompts" : ` ${window().unit}`)
    return (
      <box flexDirection="row">
        <text fg={theme().textMuted}>{label}</text>
        <text fg={pctColor(theme(), window().pct)}>
          {fmtCount(window().used, window().unit)} / {fmtCount(window().cap, window().unit)}
        </text>
        <text fg={theme().textMuted}>{unitLabel()}</text>
      </box>
    )
  }
  return (
    <Show when={props.visible()}>
      <box
        flexDirection="column"
        width="100%"
        borderStyle="rounded"
        borderColor={theme().border}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={theme().primary}>
          <b>{title()}</b>
        </text>
        <Show
          when={props.snap()}
          fallback={<text fg={theme().textMuted}>z.ai: —</text>}
        >
          {(snap) => (
            <box flexDirection="column" width="100%">
              {row("5h:  ", () => snap().five)}
              {row("Week: ", () => snap().week)}
              <box width="100%">
                <text fg={theme().textMuted} selectable={false}>
                  {footer()}
                </text>
              </box>
            </box>
          )}
        </Show>
      </box>
    </Show>
  )
}

function resolveConfigPath(path: { config?: string } | undefined): string {
  const base = path?.config && path.config.trim() !== "" ? path.config : join(homedir(), ".config", "opencode")
  const dir = base.endsWith(".json") ? dirname(base) : base
  return join(dir, "zai-usage.json")
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  gApi = api
  configPath = process.env.ZAI_USAGE_CONFIG || resolveConfigPath(api.state.path)
  if (api.state.path?.state) modelJsonPath = join(api.state.path.state, "model.json")

  const [snap, setSnap] = createSignal<Snapshot | undefined>(undefined)
  let disposed = false

  const bus = api.event as unknown as EventBusLike
  const unsubscribers: Array<() => void> = []
  const trackSelection = (type: string): void => {
    try {
      unsubscribers.push(
        bus.on(type, (event) => {
          const model = modelFromRefLike(event?.data?.model ?? event?.properties?.model ?? event?.model)
          if (!model) return
          const at = toMs(event?.data?.timestamp ?? event?.created ?? event?.timestamp) || Date.now()
          const sessionID = event?.data?.sessionID ?? event?.sessionID
          setSelected({ model, at, sessionID: typeof sessionID === "string" ? sessionID : undefined })
        }),
      )
    } catch {
      // this TUI build does not emit the event — skip
    }
  }
  trackSelection("session.model.selected")
  trackSelection("session.next.model.switched")

  const refresh = async (force = false): Promise<void> => {
    try {
      const result = await loadQuota(force)
      if (disposed) return
      setSnap(result ? toSnapshot(result) : undefined)
    } catch {
      if (!disposed) setSnap(undefined)
    }
  }

  const interval = setInterval(() => {
    void refresh(false)
  }, loadConfig().refresh_ms!)
  const poller = setInterval(() => {
    if (disposed) return
    setPicker(readPickerModel())
  }, 1000)
  const ticker = setInterval(() => {
    if (disposed) return
    setNow(Date.now())
  }, 1000)
  api.lifecycle.onDispose(() => {
    disposed = true
    clearInterval(interval)
    clearInterval(poller)
    clearInterval(ticker)
    for (const off of unsubscribers) {
      try {
        off()
      } catch {
        // already unsubscribed
      }
    }
  })
  setPicker(readPickerModel())
  void refresh(false)

  const showDetail = () => {
    const current = snap()
    if (!current) {
      api.ui.toast({
        variant: "warning",
        title: "z.ai usage",
        message: "No quota data — check token or network",
      })
      return
    }
    const describe = (window: QuotaWindow): string => {
      const reset = window.reset ? `, resets ${new Date(window.reset * 1000).toLocaleString()}` : ""
      const unit = window.unit === "prompts" ? "prompts" : window.unit
      return `${fmtCount(window.used, window.unit)} / ${fmtCount(window.cap, window.unit)} ${unit} (${Math.round(window.pct)}%)${reset}`
    }
    const exhausted = isExhausted(current.five) || isExhausted(current.week)
    api.ui.toast({
      variant: exhausted ? "warning" : "info",
      title: `z.ai usage · ${current.level}${current.kind !== "prompts" ? ` · ${current.kind}` : ""}${
        current.source === "cache" ? " (cached)" : ""
      }`,
      message: [
        `5h:   ${describe(current.five)}`,
        `Week: ${describe(current.week)}`,
        `Updated ${new Date(current.fetchedAt).toLocaleTimeString()}${
          current.kind === "prompts" ? " · counts derived from percentage" : ""
        }`,
      ].join("\n"),
    })
  }

  api.command.register(() => [
    {
      title: "z.ai usage",
      value: "zai-usage",
      description: "Show z.ai coding plan quota: 5h and week windows",
      slash: { name: "zai" },
      onSelect: () => {
        void refresh(true).then(showDetail)
      },
    },
  ])

  api.slots.register({
    order: 50,
    slots: {
      session_prompt_right(context, props) {
        return <CompactStatus context={context} snap={snap} visible={visibleFor(props.session_id)} />
      },
      // home_footer is single_winner (owned by the built-in status line) and
      // home_prompt_right squeezes the composer row into a wrap — own line wins.
      home_bottom(context) {
        return <CompactStatus context={context} snap={snap} visible={visibleFor()} />
      },
      sidebar_content(context, props) {
        return <SidebarPanel context={context} snap={snap} visible={visibleFor(props.session_id)} />
      },
    },
  })
}

export default { id: "zai-usage", tui }
