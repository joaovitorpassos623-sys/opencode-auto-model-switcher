import { tool } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

type ModelRef = { providerID: string; modelID: string }
type OrderEntry = ModelRef & { enabled: boolean }
type SwitchRecord = { time: number; sessionID: string; from: string; to: string; reason: string }

const DEFAULT_ORDER: ModelRef[] = [
  { providerID: "opencode", modelID: "deepseek-v4.1-flash-free" },
  { providerID: "nvidia", modelID: "deepseek-ai/deepseek-v4.1-flash" },
  { providerID: "nvidia", modelID: "stepfun-ai/step-5-preview" },
  { providerID: "opencode", modelID: "glm-5.3-flash-free" },
  { providerID: "nvidia", modelID: "z-ai/glm-5.3-flash" },
  { providerID: "nvidia", modelID: "minimaxai/minimax-m3.1-flash" },
  { providerID: "nvidia", modelID: "nvidia/nemotron-3-ultra-550b-a55b" },
  { providerID: "nvidia", modelID: "nvidia/nemotron-3.5-super-vl-120b-a12b" },
  { providerID: "opencode", modelID: "nemotron-3.5-super-vl-free" },
  { providerID: "nvidia", modelID: "nvidia/nemotron-3.5-lightning-30b-a3b" },
  { providerID: "opencode", modelID: "nemotron-3.5-lightning-free" },
  { providerID: "opencode", modelID: "mimo-v2.6-flash-free" },
  { providerID: "nvidia", modelID: "openai/gpt-oss-20b" },
  { providerID: "nvidia", modelID: "google/gemma-4-31b-it" },
  { providerID: "nvidia", modelID: "poolside/laguna-xs-2.1" },
  { providerID: "nvidia", modelID: "meta/muse-glimmer-30b" },
  { providerID: "opencode", modelID: "flint-40b-free" },
  { providerID: "opencode", modelID: "big-pickle" },
  { providerID: "opencode", modelID: "pulse-alpha-free" },
  { providerID: "opencode", modelID: "crouton-alpha-free" },
]

const CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? join(process.env.XDG_CONFIG_HOME, "opencode")
  : join(homedir(), ".config", "opencode")
const STATE_PATH = join(CONFIG_DIR, "auto-model-switcher.json")
const LOG_SERVICE = "auto-model-switcher"
const PROVIDER_CACHE_MS = 30_000
const MODEL_COOLDOWN_MS = 60_000
const PROVIDER_COOLDOWN_MS = 120_000
const PROVIDER_DOWN_COOLDOWN_MS = 300_000

type Cooldowns = { models: Record<string, number>; providers: Record<string, number> }

type State = {
  version: number
  enabled: boolean
  thresholdPct: number
  autoRetry: boolean
  maxAutoRetries: number
  requireToolcall: boolean
  order: OrderEntry[]
  history: SwitchRecord[]
  cooldowns: Cooldowns
}

function defaultState(): State {
  return {
    version: 1,
    enabled: true,
    thresholdPct: 0.9,
    autoRetry: true,
    maxAutoRetries: 2,
    requireToolcall: true,
    order: DEFAULT_ORDER.map((m) => ({ ...m, enabled: true })),
    history: [],
    cooldowns: { models: {}, providers: {} },
  }
}

function sanitizeCooldowns(raw: any): Record<string, number> {
  const now = Date.now()
  const out: Record<string, number> = {}
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "number" && Number.isFinite(v) && v > now) out[k] = v
    }
  }
  return out
}

function loadState(): State {
  const base = defaultState()
  if (!existsSync(STATE_PATH)) return base
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8"))
    const order: OrderEntry[] = Array.isArray(raw.order)
      ? raw.order
          .filter((e: any) => e && typeof e.providerID === "string" && typeof e.modelID === "string")
          .map((e: any) => ({
            providerID: e.providerID,
            modelID: e.modelID,
            enabled: e.enabled !== false,
          }))
      : []
    for (const m of DEFAULT_ORDER) {
      if (!order.some((e) => e.providerID === m.providerID && e.modelID === m.modelID)) {
        order.push({ ...m, enabled: true })
      }
    }
    return {
      version: 1,
      enabled: raw.enabled !== false,
      thresholdPct:
        typeof raw.thresholdPct === "number" && raw.thresholdPct > 0 && raw.thresholdPct <= 1
          ? raw.thresholdPct
          : base.thresholdPct,
      autoRetry: raw.autoRetry !== false,
      maxAutoRetries: Number.isInteger(raw.maxAutoRetries) && raw.maxAutoRetries >= 0 ? raw.maxAutoRetries : 2,
      requireToolcall: raw.requireToolcall !== false,
      order,
      history: Array.isArray(raw.history) ? raw.history.slice(-100) : [],
      cooldowns: {
        models: sanitizeCooldowns(raw.cooldowns?.models),
        providers: sanitizeCooldowns(raw.cooldowns?.providers),
      },
    }
  } catch {
    return base
  }
}

function saveState(state: State) {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8")
  } catch {}
}

function keyOf(m: ModelRef) {
  return m.providerID + "/" + m.modelID
}

function classifyError(err: any): { retryable: boolean; providerDown: boolean; kind: string } {
  if (!err) return { retryable: false, providerDown: false, kind: "unknown" }
  const name = err.name ?? ""
  const data = err.data ?? {}
  const status = data.statusCode
  const hay = (
    JSON.stringify(data) + " " + String(data.message ?? "") + " " + String(data.responseBody ?? "")
  ).toLowerCase()

  if (name === "MessageAbortedError") return { retryable: false, providerDown: false, kind: "aborted" }
  if (name === "ProviderAuthError") return { retryable: true, providerDown: true, kind: "auth" }
  if (name === "MessageOutputLengthError") return { retryable: true, providerDown: false, kind: "output_length" }

  const rate =
    status === 429 ||
    /429|rate.?limit|too many requests|quota|resource[_ ]?exhausted|resourceexhausted/.test(hay)
  const overload =
    status === 503 ||
    status === 502 ||
    status === 529 ||
    /overloaded|overload|service unavailable|server error|temporarily unavailable/.test(hay)
  const tls = /certificate|self.signed|selfsigned|\bssl\b|\btls\b|x509|not yet valid/.test(hay)
  const network =
    /timeout|timed out|econnreset|econnrefused|enotfound|eai_again|socket hang up|fetch failed|network error|disconnected/.test(
      hay
    )
  const serverErr = typeof status === "number" && status >= 500 && status <= 599

  if (rate) return { retryable: true, providerDown: false, kind: "rate_limit" }
  if (tls) return { retryable: true, providerDown: true, kind: "tls" }
  if (overload || serverErr) return { retryable: true, providerDown: false, kind: "overloaded" }
  if (network) return { retryable: true, providerDown: false, kind: "network" }
  if (data.isRetryable === true) return { retryable: true, providerDown: false, kind: "retryable" }
  return { retryable: false, providerDown: false, kind: name || "unknown" }
}

export const AutoModelSwitcher = async ({ client }: any) => {
  const state = loadState()
  const sessionIndex = new Map<string, number>()
  const sessionHistory = new Map<string, string[]>()
  const pendingRetry = new Map<string, number>()
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const noFitWarned = new Set<string>()
  const providerCache = { at: 0, providers: [] as any[] }
  const modelCooldown = new Map<string, number>(Object.entries(state.cooldowns.models))
  const providerCooldown = new Map<string, number>(Object.entries(state.cooldowns.providers))

  function persist() {
    const now = Date.now()
    state.cooldowns = {
      models: Object.fromEntries([...modelCooldown].filter(([, t]) => t > now)),
      providers: Object.fromEntries([...providerCooldown].filter(([, t]) => t > now)),
    }
    saveState(state)
  }

  async function log(level: "debug" | "info" | "warn" | "error", message: string, extra?: any) {
    try {
      await client.app.log({ body: { service: LOG_SERVICE, level, message, extra } })
    } catch {}
  }

  async function toast(message: string, variant: "info" | "success" | "warning" | "error" = "info") {
    try {
      await client.tui.showToast({ body: { title: LOG_SERVICE, message, variant, duration: 5000 } })
    } catch {}
  }

  async function getProviders(force = false): Promise<any[]> {
    const now = Date.now()
    if (!force && providerCache.providers.length && now - providerCache.at < PROVIDER_CACHE_MS) {
      return providerCache.providers
    }
    try {
      const res = await client.config.providers()
      const providers = res?.data?.providers ?? res?.providers ?? []
      providerCache.providers = Array.isArray(providers) ? providers : []
      providerCache.at = now
    } catch (e) {
      await log("warn", "failed to list providers", { error: String(e) })
    }
    return providerCache.providers
  }

  function providerMap(providers: any[]) {
    const map = new Map<string, any>()
    for (const p of providers) map.set(p.id, p)
    return map
  }

  function modelMeta(providers: any[], ref: ModelRef) {
    const p = providers.find((x) => x.id === ref.providerID)
    return p?.models?.[ref.modelID]
  }

  function contextLimit(providers: any[], ref: ModelRef): number | undefined {
    const limit = modelMeta(providers, ref)?.limit?.context
    return typeof limit === "number" ? limit : undefined
  }

  function indexOfModel(providerID?: string, modelID?: string) {
    if (!providerID || !modelID) return -1
    return state.order.findIndex((m) => m.providerID === providerID && m.modelID === modelID)
  }

  function isUsable(providers: any[], entry: OrderEntry) {
    if (!entry.enabled) return false
    const meta = modelMeta(providers, entry)
    if (!meta) return false
    if (state.requireToolcall && meta.capabilities && meta.capabilities.toolcall === false) return false
    const now = Date.now()
    if ((modelCooldown.get(keyOf(entry)) ?? 0) > now) return false
    if ((providerCooldown.get(entry.providerID) ?? 0) > now) return false
    return true
  }

  function pickAvailable(providers: any[], from: number) {
    const n = state.order.length
    if (!n) return -1
    const start = ((from % n) + n) % n
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n
      if (isUsable(providers, state.order[i])) return i
    }
    return -1
  }

  function betterContextModel(providers: any[], from: number, used: number, currentLimit: number) {
    const n = state.order.length
    if (!n) return -1
    const start = ((from % n) + n) % n
    const candidates: { i: number; limit: number }[] = []
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n
      if (!isUsable(providers, state.order[i])) continue
      const limit = contextLimit(providers, state.order[i])
      if (limit === undefined || limit <= currentLimit) continue
      candidates.push({ i, limit })
    }
    if (!candidates.length) return -1
    const comfy = candidates.find((c) => c.limit >= used / state.thresholdPct)
    if (comfy) return comfy.i
    const fits = candidates.find((c) => c.limit >= used)
    if (fits) return fits.i
    return candidates.reduce((a, b) => (b.limit > a.limit ? b : a)).i
  }

  async function lastAssistant(sessionID: string): Promise<any | undefined> {
    try {
      const res = await client.session.messages({ path: { id: sessionID } })
      const list = res?.data ?? res ?? []
      if (!Array.isArray(list)) return undefined
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i]?.info?.role === "assistant") return list[i].info
      }
    } catch (e) {
      await log("warn", "failed to read session messages", { sessionID, error: String(e) })
    }
    return undefined
  }

  function contextUsage(info: any, providers: any[]) {
    const t = info?.tokens ?? {}
    const used =
      typeof t.total === "number"
        ? t.total
        : (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
    const meta = modelMeta(providers, { providerID: info?.providerID, modelID: info?.modelID })
    const limit = meta?.limit?.context
    return { used, limit: typeof limit === "number" ? limit : undefined, pct: limit ? used / limit : 0 }
  }

  function record(sessionID: string, from: string, to: string, reason: string) {
    const entry: SwitchRecord = { time: Date.now(), sessionID, from, to, reason }
    state.history.push(entry)
    if (state.history.length > 100) state.history = state.history.slice(-100)
    const log = sessionHistory.get(sessionID) ?? []
    log.push(`${new Date(entry.time).toISOString()} ${from} -> ${to} (${reason})`)
    sessionHistory.set(sessionID, log.slice(-50))
    persist()
  }

  function chooseForSession(providers: any[], sessionID: string, last: any) {
    const lastPos = last ? indexOfModel(last.providerID, last.modelID) : -1
    let intended = sessionIndex.get(sessionID)
    if (intended === undefined) intended = lastPos >= 0 ? lastPos : 0

    let reason = ""
    let noBetter = false
    if (last && lastPos >= 0 && intended <= lastPos) {
      const { pct, limit, used } = contextUsage(last, providers)
      if (limit && pct >= state.thresholdPct) {
        const fit = betterContextModel(providers, lastPos + 1, used, limit)
        if (fit >= 0) {
          intended = fit
          const newLimit = contextLimit(providers, state.order[fit])
          reason = `contexto ${(pct * 100).toFixed(1)}% (${used}/${limit}) >= ${(state.thresholdPct * 100).toFixed(0)}%; janela ${limit} -> ${newLimit ?? "?"}`
        } else {
          intended = lastPos
          noBetter = true
          reason = `contexto ${(pct * 100).toFixed(1)}% (${used}/${limit}) >= ${(state.thresholdPct * 100).toFixed(0)}%; sem modelo com janela maior`
        }
      }
    }
    const chosen = pickAvailable(providers, intended)
    return { chosen, intended, reason, noBetter }
  }

  async function applyModel(output: any, providers: any[], sessionID: string, last: any) {
    const { chosen, reason, noBetter } = chooseForSession(providers, sessionID, last)
    if (chosen === -1) {
      await toast(
        "Nenhum modelo disponivel. Use o tool model_switcher_toggle para reativar modelos.",
        "error"
      )
      await log("error", "no model available", { sessionID })
      return
    }
    const entry = state.order[chosen]
    const previous = last ? keyOf({ providerID: last.providerID, modelID: last.modelID }) : sessionHistory.get(sessionID)?.slice(-1)[0]
    const before = sessionIndex.get(sessionID)

    output.message.model = { providerID: entry.providerID, modelID: entry.modelID }
    sessionIndex.set(sessionID, chosen)

    if (before !== chosen) {
      noFitWarned.delete(sessionID)
      record(sessionID, previous ?? "(novo)", keyOf(entry), reason || "selecao")
      await toast(`Modelo: ${keyOf(entry)}`, "info")
      await log("info", "model selected", { sessionID, model: keyOf(entry), reason: reason || "select" })
    } else if (noBetter && !noFitWarned.has(sessionID)) {
      noFitWarned.add(sessionID)
      await toast("Contexto alto, mas nenhum modelo com janela maior disponivel. Permanecendo no modelo atual.", "warning")
      await log("warn", "context threshold reached with no larger window", { sessionID, reason })
    }
  }

  function scheduleRetry(sessionID: string) {
    if (retryTimers.has(sessionID)) return
    const timer = setTimeout(async () => {
      retryTimers.delete(sessionID)
      try {
        const attempts = pendingRetry.get(sessionID) ?? 0
        if (attempts >= state.maxAutoRetries) {
          pendingRetry.delete(sessionID)
          await toast("Limite de tentativas automaticas atingido.", "warning")
          return
        }
        const last = await lastAssistant(sessionID)
        if (!last?.error || !classifyError(last.error).retryable) {
          pendingRetry.delete(sessionID)
          return
        }
        pendingRetry.set(sessionID, attempts + 1)
        await log("info", "auto-retry", { sessionID, attempt: attempts + 1 })
        await client.session.prompt({
          path: { id: sessionID },
          body: {
            parts: [
              {
                type: "text",
                text: "Continue exatamente de onde parou. Nao repita trabalho ja concluido. Apenas finalize a tarefa pendente.",
                synthetic: true,
              },
            ],
          },
        })
      } catch (e) {
        await log("warn", "auto-retry failed", { sessionID, error: String(e) })
      }
    }, 1200)
    retryTimers.set(sessionID, timer)
  }

  async function buildStatus(sessionID?: string) {
    const providers = await getProviders()
    let current: ModelRef | undefined
    let used: number | undefined
    let limit: number | undefined
    let pct = 0
    if (sessionID) {
      const last = await lastAssistant(sessionID)
      if (last) {
        current = { providerID: last.providerID, modelID: last.modelID }
        const u = contextUsage(last, providers)
        used = u.used
        limit = u.limit
        pct = u.pct
      }
      if (!current) {
        const idx = sessionIndex.get(sessionID) ?? 0
        const e = state.order[idx]
        if (e) current = { providerID: e.providerID, modelID: e.modelID }
      }
    }
    const idx = sessionID ? sessionIndex.get(sessionID) ?? 0 : 0
    const nextIdx =
      limit && pct >= state.thresholdPct
        ? betterContextModel(providers, idx + 1, used ?? 0, limit)
        : pickAvailable(providers, idx + 1)
    const next = nextIdx >= 0 ? state.order[nextIdx] : undefined
    return {
      enabled: state.enabled,
      thresholdPct: state.thresholdPct,
      autoRetry: state.autoRetry,
      maxAutoRetries: state.maxAutoRetries,
      current,
      provider: current?.providerID,
      context: { used, limit, pct },
      next: next ? { providerID: next.providerID, modelID: next.modelID } : undefined,
      available: state.order.filter((e) => isUsable(providers, e)).length,
      total: state.order.length,
    }
  }

  async function humanStatus(sessionID?: string) {
    const s = await buildStatus(sessionID)
    const cur = s.current ? keyOf(s.current) : "(desconhecido)"
    const nxt = s.next ? keyOf(s.next) : "(nenhum)"
    const ctx = s.context.limit
      ? `${(s.context.pct * 100).toFixed(1)}% (${s.context.used}/${s.context.limit})`
      : "n/d"
    return [
      `Plugin: ${s.enabled ? "ATIVO" : "INATIVO"}`,
      `Modelo atual: ${cur}`,
      `Provedor: ${s.provider ?? "n/d"}`,
      `Contexto: ${ctx} (limite ${(s.thresholdPct * 100).toFixed(0)}%)`,
      `Proximo: ${nxt}`,
      `Disponiveis: ${s.available}/${s.total}`,
      `Auto-retry: ${s.autoRetry ? "on" : "off"} (max ${s.maxAutoRetries})`,
    ].join("\n")
  }

  return {
    config: async (cfg: any) => {
      if (!state.enabled) return
      const cmds = cfg.command ?? (cfg.command = {})
      const target = "build"
      const add = (name: string, description: string, prompt: string) => {
        if (!cmds[name]) cmds[name] = { description, agent: target, template: prompt }
      }
      add(
        "models-status",
        "Mostra o status do OpenCode Auto Model Switcher",
        "Chame a ferramenta model_switcher_status e mostre o resultado ao usuario, sem adicionar comentarios extras."
      )
      add(
        "models-list",
        "Lista a fila de 20 modelos com prioridade e estado",
        "Chame a ferramenta model_switcher_list e mostre ao usuario a lista retornada, sem comentarios extras."
      )
      add(
        "models-next",
        "Troca para o proximo modelo da fila",
        "Chame a ferramenta model_switcher_switch com mode=next e informe o novo modelo."
      )
      add(
        "models-reset",
        "Restaura a ordem inicial de prioridade",
        "Chame a ferramenta model_switcher_reset com scope=order e confirme ao usuario."
      )
      await log("info", "commands registered")
    },

    event: async ({ event }: any) => {
      if (!state.enabled) return
      try {
        if (event?.type === "session.error") {
          const sessionID: string | undefined = event.properties?.sessionID
          const err = event.properties?.error
          const c = classifyError(err)
          if (!c.retryable) return

          const providers = await getProviders()
          const last = sessionID ? await lastAssistant(sessionID) : undefined
          const lastPos = last ? indexOfModel(last.providerID, last.modelID) : -1
          const failRef = last
            ? { providerID: last.providerID, modelID: last.modelID }
            : sessionID !== undefined
              ? state.order[sessionIndex.get(sessionID) ?? 0]
              : undefined

          if (failRef) {
            modelCooldown.set(keyOf(failRef), Date.now() + MODEL_COOLDOWN_MS)
            providerCooldown.set(
              failRef.providerID,
              Date.now() + (c.providerDown ? PROVIDER_DOWN_COOLDOWN_MS : PROVIDER_COOLDOWN_MS)
            )
            persist()
          }

          const base = lastPos >= 0 ? lastPos + 1 : (sessionID ? (sessionIndex.get(sessionID) ?? 0) + 1 : 0)
          let nextIdx = -1
          if (last) {
            const used = contextUsage(last, providers).used
            if (used > 0) nextIdx = betterContextModel(providers, base, used, -1)
          }
          if (nextIdx < 0) nextIdx = pickAvailable(providers, base)
          if (sessionID) sessionIndex.set(sessionID, nextIdx >= 0 ? nextIdx : state.order.length)

          const nextLabel = nextIdx >= 0 ? keyOf(state.order[nextIdx]) : "(nenhum)"
          await log("warn", "provider error, switching", {
            sessionID,
            kind: c.kind,
            failed: failRef ? keyOf(failRef) : undefined,
            next: nextLabel,
          })
          await toast(`Erro (${c.kind}). Proximo modelo: ${nextLabel}`, "warning")

          if (state.autoRetry && sessionID && nextIdx >= 0) {
            scheduleRetry(sessionID)
          }
        } else if (event?.type === "session.idle") {
          const sessionID: string | undefined = event.properties?.sessionID
          if (!sessionID) return
          const last = await lastAssistant(sessionID)
          if (last && !last.error) pendingRetry.delete(sessionID)
        }
      } catch (e) {
        await log("error", "event handler error", { error: String(e) })
      }
    },

    "chat.message": async (input: any, output: any) => {
      if (!state.enabled) return
      try {
        const sessionID: string = input.sessionID
        if (!sessionID) return
        const providers = await getProviders()
        if (!providers.length) {
          await log("warn", "no providers returned from API")
          return
        }
        const last = await lastAssistant(sessionID)
        await applyModel(output, providers, sessionID, last)
      } catch (e) {
        await log("error", "chat.message handler error", { error: String(e) })
      }
    },

    tool: {
      model_switcher_status: tool({
        description:
          "Mostra o status do OpenCode Auto Model Switcher: modelo atual, provedor, uso de contexto, proximo modelo e quantos estao disponiveis.",
        args: {},
        async execute(_args, context) {
          return await humanStatus(context.sessionID)
        },
      }),

      model_switcher_list: tool({
        description:
          "Lista os 20 modelos na ordem de prioridade, com marcador de habilitado/desabilitado e quais estao realmente disponiveis na API.",
        args: {},
        async execute() {
          const providers = await getProviders()
          const avail = new Set(
            providers.flatMap((p: any) => Object.keys(p.models ?? {}).map((m: string) => p.id + "/" + m))
          )
          const lines = state.order.map((e, i) => {
            const ok = avail.has(keyOf(e)) ? "ok" : "ausente"
            return `${String(i + 1).padStart(2, " ")}. [${e.enabled ? "on " : "off"}] [${ok}] ${keyOf(e)}`
          })
          return lines.join("\n")
        },
      }),

      model_switcher_switch: tool({
        description:
          "Troca o modelo ativo desta sessao. mode=next|prev indice, ou informe index (1-20) ou model no formato provider/model.",
        args: {
          mode: tool.schema.string().optional().describe("next, prev ou index"),
          index: tool.schema.number().optional().describe("Posicao 1-20 na fila"),
          model: tool.schema.string().optional().describe("provider/model"),
        },
        async execute(args, context) {
          const providers = await getProviders()
          const sessionID = context.sessionID
          const cur = sessionIndex.get(sessionID) ?? 0
          let target = -1
          if (typeof args.index === "number") target = args.index - 1
          else if (args.model) {
            const [pid, ...rest] = String(args.model).split("/")
            target = state.order.findIndex((e) => e.providerID === pid && e.modelID === rest.join("/"))
          } else {
            const n = state.order.length
            target = n ? (args.mode === "prev" ? (cur - 1 + n) % n : (cur + 1) % n) : -1
          }
          if (target < 0 || target >= state.order.length) {
            return `Indice invalido. Use 1-${state.order.length}.`
          }
          if (!isUsable(providers, state.order[target])) {
            return `Modelo ${keyOf(state.order[target])} indisponivel/desabilitado.`
          }
          const from = state.order[cur] ? keyOf(state.order[cur]) : "(desconhecido)"
          sessionIndex.set(sessionID, target)
          record(sessionID, from, keyOf(state.order[target]), "troca manual")
          return `Trocado para ${keyOf(state.order[target])} (posicao ${target + 1}). A proxima mensagem usara este modelo.`
        },
      }),

      model_switcher_reorder: tool({
        description: "Move um modelo da fila. Informe from (1-20) e to (1-20).",
        args: {
          from: tool.schema.number().describe("Posicao atual (1-20)"),
          to: tool.schema.number().describe("Nova posicao (1-20)"),
        },
        async execute(args) {
          const from = args.from - 1
          const to = args.to - 1
          if (from < 0 || from >= state.order.length || to < 0 || to >= state.order.length) {
            return `Posicoes invalidas. Use 1-${state.order.length}.`
          }
          const [moved] = state.order.splice(from, 1)
          state.order.splice(to, 0, moved)
          persist()
          return `Movido ${keyOf(moved)} para posicao ${to + 1}.`
        },
      }),

      model_switcher_toggle: tool({
        description:
          "Ativa/desativa o plugin inteiro ou um modelo especifico. scope=plugin|model. Para modelo, informe index (1-20) e enabled (true/false).",
        args: {
          scope: tool.schema.string().describe("plugin ou model"),
          index: tool.schema.number().optional().describe("Posicao 1-20"),
          enabled: tool.schema.boolean().optional().describe("true=ativar, false=desativar"),
        },
        async execute(args) {
          if (args.scope === "plugin") {
            state.enabled = args.enabled !== false
            persist()
            return `Plugin ${state.enabled ? "ativado" : "desativado"}.`
          }
          const idx = (args.index ?? 0) - 1
          if (idx < 0 || idx >= state.order.length) return `Indice invalido. Use 1-${state.order.length}.`
          state.order[idx].enabled = args.enabled !== false
          persist()
          return `${keyOf(state.order[idx])} ${state.order[idx].enabled ? "ativado" : "desativado"}.`
        },
      }),

      model_switcher_threshold: tool({
        description: "Define o limite de contexto (0-100) que dispara a troca automatica de modelo.",
        args: { percent: tool.schema.number().describe("Percentual de 1 a 100") },
        async execute(args) {
          const pct = Math.min(100, Math.max(1, args.percent)) / 100
          state.thresholdPct = pct
          persist()
          return `Limite de contexto definido para ${(pct * 100).toFixed(0)}%.`
        },
      }),

      model_switcher_history: tool({
        description: "Mostra o historico de trocas de modelo (mais recentes primeiro).",
        args: { limit: tool.schema.number().optional().describe("Quantidade (padrao 10)") },
        async execute(args) {
          const n = args.limit && args.limit > 0 ? args.limit : 10
          const items = [...state.history].reverse().slice(0, n)
          if (!items.length) return "Sem trocas registradas."
          return items
            .map((h) => `${new Date(h.time).toISOString()} [${h.sessionID}] ${h.from} -> ${h.to} (${h.reason})`)
            .join("\n")
        },
      }),

      model_switcher_reset: tool({
        description: "Restaura a ordem inicial de prioridade e/ou limpa o historico. scope=order|history|all.",
        args: { scope: tool.schema.string().optional().describe("order, history ou all") },
        async execute(args) {
          const scope = args.scope ?? "order"
          if (scope === "order" || scope === "all") {
            state.order = DEFAULT_ORDER.map((m) => ({ ...m, enabled: true }))
            sessionIndex.clear()
            modelCooldown.clear()
            providerCooldown.clear()
            noFitWarned.clear()
          }
          if (scope === "history" || scope === "all") state.history = []
          if (scope === "all") {
            state.thresholdPct = 0.9
            state.enabled = true
            state.autoRetry = true
          }
          persist()
          return `Reset aplicado (${scope}). Ordem inicial de prioridade restaurada.`
        },
      }),
    },

    dispose: async () => {
      persist()
    },
  }
}

export default AutoModelSwitcher
