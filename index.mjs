// R4 Coder — a provider plugin for magpie.
//
// magpie's provider hook is OpenCode-compatible, but this plugin runs inside
// magpie's plugin host and needs no OpenCode installation.
//
// R4 Coder (https://r4.codes) is an OpenAI-compatible inference gateway.
// A coder_-prefixed API key is the only credential: requests go to
// https://api.r4.codes/v1, the live catalog comes from /v1/models and
// /v1/models/info, and the usage card reads /v1/cli/meta (package windows,
// wallet, expiry) and /v1/cli/key (this key's spend limit).
//
// Provider id: r4coder. The id matches what `r4 opencode` already writes
// into opencode.json, so existing r4coder/<model> references keep working.
//
// magpie calls every exported function as a plugin unless the module has a
// default { id, server } export. Keep helpers inside _internal.

const PROVIDER = "r4coder";
const DEFAULT_BASE = "https://api.r4.codes";
const NPM = "@ai-sdk/openai-compatible";
const CLIENT = "@r4coder/magpie-plugin/0.1.2";
const REQUEST_TIMEOUT_MS = 15_000;

// One stable model so a freshly added provider is not empty before its first
// live catalog fetch. The live /v1/models + /v1/models/info list replaces it.
// This is a fallback, not the catalog: the platform's list is authoritative.
const FALLBACK_MODELS = {
  "deepseek-v4.1-flash": {
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    reasoning: true,
    tool_call: true,
    attachment: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: 1_048_576, output: 393_216 },
    cost: { input: 0.15, output: 0.6, cache_read: 0.003, cache_write: 0 },
    variants: {
      minimal: { reasoningEffort: "minimal" },
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
      xhigh: { reasoningEffort: "xhigh" },
      max: { reasoningEffort: "max" },
    },
  },
};

class R4CoderError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "R4CoderError";
    this.status = status;
    if (status === 401) this.signIn = "expired";
  }
}

function envBase() {
  try {
    if (typeof process !== "undefined" && process.env?.R4_CODER_BASE_URL) {
      return String(process.env.R4_CODER_BASE_URL);
    }
  } catch {}
  return DEFAULT_BASE;
}

// baseURL is the service root with no trailing slash or /v1. The override
// exists for self-hosted R4 Coder instances and for tests.
function baseURL() {
  const raw = envBase().trim().replace(/\/+$/, "");
  return raw.endsWith("/v1") ? raw.slice(0, -3).replace(/\/+$/, "") : raw;
}

function apiBase() {
  return baseURL() + "/v1";
}

function number(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function integer(value) {
  return Math.trunc(number(value));
}

function timeoutSignal(ms) {
  try {
    return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(ms)
      : undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(body) {
  const e = body?.error;
  if (typeof e === "string" && e.trim()) return e.trim();
  if (e && typeof e.message === "string" && e.message.trim()) return e.message.trim();
  if (typeof body?.message === "string" && body.message.trim()) return body.message.trim();
  return "";
}

// requestJSON asks one R4 endpoint with the account's key. The key is sent
// as Authorization: Bearer; R4 accepts x-api-key too, but Bearer is what
// the host's OpenAI-compatible client already sends.
async function requestJSON(path, key, options = {}) {
  const url = /^https?:\/\//i.test(path) ? path : baseURL() + path;
  const init = {
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/json",
      "x-r4-client": CLIENT,
    },
    cache: "no-store",
  };
  const signal = options.signal ?? timeoutSignal(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  if (signal) init.signal = signal;

  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {}
  }
  if (!res.ok) {
    const message =
      errorMessage(body) || text.trim().slice(0, 300) || `${res.status} ${res.statusText}`.trim();
    throw new R4CoderError(res.status, message);
  }
  return body;
}

// modelEntry maps one R4 catalog row to the OpenCode model shape the magpie
// host consumes. /v1/models carries effort tiers; /v1/models/info carries
// the curated output cap and input modalities. Either may be missing.
function modelEntry(slug, listed, info) {
  const a = listed && typeof listed === "object" ? listed : {};
  const b = info && typeof info === "object" ? info : {};
  const price = b.pricing_effective ?? b.pricing ?? a.pricing ?? {};
  const tiers = Array.isArray(a.effort?.tiers)
    ? a.effort.tiers.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim())
    : [];
  const modalities = Array.isArray(b.input_modalities)
    ? b.input_modalities.filter((m) => typeof m === "string")
    : null;
  const image = modalities ? modalities.includes("image") : undefined;
  const context = integer(a.context_window ?? b.context_window);
  const output = integer(b.max_output_tokens ?? a.max_output_tokens);

  const input = { text: true };
  if (image !== undefined) input.image = image;
  const capabilities = {
    temperature: true,
    reasoning: tiers.length > 0,
    toolcall: true,
    input,
    output: { text: true },
    interleaved: false,
  };
  // imageSaid in magpie is "capabilities.input.image is a boolean": leave it
  // out when R4 has not curated the model's modalities.
  if (image !== undefined) capabilities.attachment = image;

  return {
    id: slug,
    name: String(a.display_name || b.display_name || slug),
    api: { id: slug, url: apiBase(), npm: NPM },
    status: "active",
    cost: {
      input: number(price.input_per_m_tokens),
      output: number(price.output_per_m_tokens),
      cache: {
        read: number(price.cache_read_per_m_tokens),
        write: number(price.cache_creation_per_m_tokens),
      },
    },
    limit: { context: context > 0 ? context : 0, output: output > 0 ? output : 0 },
    options: {},
    headers: {},
    capabilities,
    release_date: "",
    variants: Object.fromEntries(tiers.map((tier) => [tier, { reasoningEffort: tier }])),
  };
}

async function modelsOf(auth) {
  const [listed, info] = await Promise.allSettled([
    requestJSON("/v1/models", auth.key),
    requestJSON("/v1/models/info", auth.key),
  ]);
  const listedOK = listed.status === "fulfilled";
  const infoOK = info.status === "fulfilled";
  if (!listedOK && !infoOK) {
    const failures = [listed.reason, info.reason];
    // A 404 on /v1/models/info is expected on an older server; only throw
    // it when nothing else answered.
    throw failures.find((e) => !(e instanceof R4CoderError && e.status === 404)) ?? failures[0];
  }

  const byID = new Map();
  if (listedOK) {
    for (const m of listed.value?.data ?? []) {
      if (m && typeof m.id === "string" && m.id) byID.set(m.id, { listed: m });
    }
  }
  if (infoOK) {
    for (const m of info.value?.models ?? []) {
      if (m && typeof m.slug === "string" && m.slug) {
        const cur = byID.get(m.slug) ?? {};
        cur.info = m;
        byID.set(m.slug, cur);
      }
    }
  }

  const out = {};
  for (const [id, pair] of byID) out[id] = modelEntry(id, pair.listed, pair.info);
  return out;
}

const WINDOW_NAMES = new Map([
  [3600, "1 hour"],
  [18000, "5 hours"],
  [21600, "6 hours"],
  [43200, "12 hours"],
  [86400, "1 day"],
  [604800, "7 days"],
  [1209600, "14 days"],
  [2592000, "30 days"],
]);

function windowName(seconds) {
  const known = WINDOW_NAMES.get(seconds);
  if (known) return known;
  if (seconds % 86400 === 0) return `${seconds / 86400} days`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

function usd(value) {
  const n = number(value);
  const digits = Math.abs(n) > 0 && Math.abs(n) < 1 ? 4 : 2;
  const text = Math.abs(n).toFixed(digits);
  return n < 0 ? `-$${text}` : `$${text}`;
}

function keyLabel(key) {
  const name = typeof key?.name === "string" ? key.name.trim() : "";
  const start = typeof key?.start === "string" ? key.start.trim() : "";
  if (name && start) return `${name} (${start})`;
  return name || start || "R4 Coder key";
}

function localTimeZone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" && tz ? tz : "UTC";
  } catch {
    return "UTC";
  }
}

// usageOf combines the account-level card (/v1/cli/meta: package windows,
// wallet, expiry) with the key-level card (/v1/cli/key: this key's spend
// limit). Either endpoint may be missing on an older server.
async function usageOf(key) {
  const [metaResult, keyResult] = await Promise.allSettled([
    requestJSON("/v1/cli/meta", key),
    requestJSON("/v1/cli/key?tz=" + encodeURIComponent(localTimeZone()), key),
  ]);
  const meta = metaResult.status === "fulfilled" ? metaResult.value : null;
  const own = keyResult.status === "fulfilled" ? keyResult.value : null;

  if (!meta && !own) {
    const failures = [metaResult, keyResult]
      .filter((r) => r.status === "rejected")
      .map((r) => r.reason);
    const first =
      failures.find((e) => e instanceof R4CoderError && e.status !== 404) ?? failures[0];
    if (first instanceof R4CoderError && first.status === 401) {
      return {
        error: `R4 Coder rejected this API key: ${first.message}`,
        signIn: "expired",
      };
    }
    if (first instanceof R4CoderError && first.status === 403) {
      return {
        error: `R4 Coder can't show this key's usage: ${first.message}`,
        signIn: "kept",
      };
    }
    return {
      error: `R4 Coder usage is unavailable: ${first?.message ?? "no answer"}`,
      signIn: "kept",
    };
  }

  const plan = meta?.plan && typeof meta.plan === "object" ? meta.plan : null;
  const wallet = meta?.wallet && typeof meta.wallet === "object" ? meta.wallet : null;
  const keyInfo = own?.key ?? meta?.key ?? null;

  // Package windows can be spread over several grants (renewals). Sum the
  // same-duration windows and keep the soonest reset.
  const bySpan = new Map();
  const addLimits = (list) => {
    for (const w of Array.isArray(list) ? list : []) {
      const span = integer(w?.duration_seconds);
      const ceiling = optionalNumber(w?.ceiling_usd);
      if (!(span > 0) || ceiling === null || ceiling <= 0) continue;
      const cur = bySpan.get(span) ?? { consumed: 0, ceiling: 0, resetsAt: "" };
      cur.consumed += number(w?.consumed_usd);
      cur.ceiling += ceiling;
      const reset = typeof w?.resets_at === "string" ? w.resets_at : "";
      if (reset && (!cur.resetsAt || reset < cur.resetsAt)) cur.resetsAt = reset;
      bySpan.set(span, cur);
    }
  };
  const grants =
    Array.isArray(plan?.grants) && plan.grants.length > 0 ? plan.grants : plan ? [plan] : [];
  for (const grant of grants) addLimits(grant?.limit_windows);
  // A server that gives grants but not their windows still carries the head
  // grant's limit_windows.
  if (bySpan.size === 0) addLimits(plan?.limit_windows);

  const windows = [];
  for (const [span, w] of bySpan) {
    windows.push({
      name: windowName(span),
      used: w.ceiling > 0 ? (w.consumed / w.ceiling) * 100 : 0,
      ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}),
      amount: w.consumed,
      limit: w.ceiling,
      unit: "USD",
      span,
    });
  }

  const limit = optionalNumber(own?.limit_usd);
  const spent = number(own?.spent_usd) + number(own?.held_usd);
  if (limit !== null && limit > 0) {
    windows.push({
      name: "Key limit",
      used: (spent / limit) * 100,
      amount: spent,
      limit,
      unit: "USD",
      span: 0,
    });
  }

  let balance = "";
  if (wallet && optionalNumber(wallet.balance_usd) !== null) {
    balance = usd(wallet.balance_usd);
  } else if (windows.length === 0 && plan && optionalNumber(plan.remaining_usd) !== null) {
    balance = usd(plan.remaining_usd);
  }

  const planName =
    typeof plan?.package_name === "string" && plan.package_name.trim()
      ? plan.package_name.trim()
      : wallet
        ? "Pay as you go"
        : "R4 Coder";
  const until = typeof plan?.expires_at === "string" ? plan.expires_at : "";

  return {
    plan: planName,
    user: keyLabel(keyInfo),
    ...(until ? { until } : {}),
    ...(balance ? { balance } : {}),
    windows,
    signIn: "kept",
  };
}

export async function R4CoderPlugin() {
  return {
    config: async (cfg) => {
      if (!cfg || typeof cfg !== "object") return;
      cfg.provider ??= {};
      const was =
        cfg.provider[PROVIDER] && typeof cfg.provider[PROVIDER] === "object"
          ? cfg.provider[PROVIDER]
          : {};
      const userModels =
        was.models && typeof was.models === "object" && Object.keys(was.models).length > 0
          ? was.models
          : FALLBACK_MODELS;
      cfg.provider[PROVIDER] = {
        name: "R4 Coder",
        npm: NPM,
        api: apiBase(),
        ...was,
        models: userModels,
      };
    },

    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "api",
          label: "R4 Coder API key",
          placeholder: "coder_…",
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== "api" || typeof auth.key !== "string" || !auth.key) return {};
        return {
          baseURL: apiBase(),
          apiKey: auth.key,
          headers: { "x-r4-client": CLIENT },
        };
      },
      async usage(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== "api" || typeof auth.key !== "string" || !auth.key) {
          return { error: "Sign in with an R4 Coder API key", signIn: "kept" };
        }
        try {
          return await usageOf(auth.key);
        } catch (e) {
          return {
            error: `R4 Coder usage is unavailable: ${e?.message ?? String(e)}`,
            signIn: "kept",
          };
        }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (auth?.type !== "api" || typeof auth.key !== "string" || !auth.key) {
          return provider.models;
        }
        return (await modelsOf(auth)) ?? provider.models;
      },
    },
  };
}

export const _internal = {
  PROVIDER,
  DEFAULT_BASE,
  NPM,
  CLIENT,
  FALLBACK_MODELS,
  R4CoderError,
  baseURL,
  apiBase,
  modelEntry,
  modelsOf,
  usageOf,
  requestJSON,
  windowName,
  usd,
  keyLabel,
  localTimeZone,
};

export default { id: PROVIDER, server: R4CoderPlugin };
