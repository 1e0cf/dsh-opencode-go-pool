// src/adapter.ts
var QUOTA_CODES = new Set([
  "QUOTA_EXCEEDED",
  "INSUFFICIENT_QUOTA",
  "USAGE_LIMIT",
  "USAGE_LIMIT_REACHED"
]);
var AUTH_CODES = new Set([
  "AUTH",
  "INVALID_CREDENTIAL",
  "UNAUTHORIZED",
  "MISSING_CREDENTIAL"
]);

class PoolExhaustedError extends Error {
  code = "QUOTA_EXCEEDED";
  blocked;
  constructor(affinity, blocked) {
    const detail = blocked.map((entry) => `${entry.keyId} (${entry.reason})`).join(", ");
    super(`no OpenCode Go key can serve conversation "${affinity}"${detail === "" ? "" : `: ${detail}`}`);
    this.name = "PoolExhaustedError";
    this.blocked = blocked;
  }
}
function codeOf(error) {
  if (typeof error !== "object" || error === null)
    return;
  const own = Object.getOwnPropertyDescriptor(error, "code");
  if (own !== undefined && "value" in own && typeof own.value === "string")
    return own.value;
  const failure = Object.getOwnPropertyDescriptor(error, "failure");
  if (failure !== undefined && "value" in failure) {
    const nested = failure.value;
    if (typeof nested?.code === "string")
      return nested.code;
  }
  return;
}
function blockReasonOf(error) {
  const code = codeOf(error);
  if (code === undefined)
    return null;
  if (QUOTA_CODES.has(code))
    return "rate-limited";
  if (AUTH_CODES.has(code))
    return "unauthorized";
  return null;
}

class PoolAdapter {
  #options;
  #providers;
  constructor(options, providers) {
    if (providers.length === 0)
      throw new Error("pool adapter needs at least one route");
    this.#options = options;
    this.#providers = providers;
  }
  providers() {
    return this.#providers;
  }
  providerInfo(provider) {
    return this.#options.catalog.providerInfo?.(provider) ?? { provider, id: provider, name: provider };
  }
  providerRetryPolicy(provider) {
    return this.#options.catalog.providerRetryPolicy?.(provider);
  }
  imageRequestPricing(provider, model) {
    return this.#options.catalog.imageRequestPricing?.(provider, model);
  }
  imageRequestTarget(provider, model, image) {
    return this.#options.catalog.imageRequestTarget?.(provider, model, image);
  }
  listModels(provider) {
    return this.#options.catalog.listModels?.(provider) ?? Promise.resolve([]);
  }
  resolveModel(provider, model, signal) {
    return this.#options.catalog.resolveModel?.(provider, model, signal) ?? Promise.resolve({ provider, id: model, name: model });
  }
  async prepareCall(provider, model, signal) {
    const info = await this.resolveModel(provider, model, signal);
    return { model: info, stream: (options) => this.stream(options) };
  }
  stream(options) {
    return this.#dispatch(options);
  }
  async* #dispatch(options) {
    const conversation = this.#options.conversationOf(options);
    const selection = await this.#options.pool.resolve(conversation);
    if (selection === null)
      throw new PoolExhaustedError(conversation, this.#blocked());
    const inner = this.#options.adapters.get(selection.keyId);
    if (inner === undefined) {
      throw new Error(`no adapter for pooled key "${selection.keyId}" (session "${conversation}")`);
    }
    try {
      yield* inner.stream(options);
    } catch (error) {
      const reason = blockReasonOf(error);
      if (reason !== null)
        this.#options.pool.block(selection.keyId, reason);
      this.#options.onError?.({ keyId: selection.keyId, error });
      throw error;
    }
  }
  #blocked() {
    return this.#options.pool.report().filter((entry) => !entry.assessment.usable).map((entry) => ({ keyId: entry.id, reason: entry.assessment.reason ?? "exhausted" }));
  }
}

// src/policy.ts
var METERS = ["rolling", "weekly", "monthly"];
function percentOf(reading) {
  if (!reading)
    return null;
  const value = typeof reading.percent === "number" ? reading.percent : Number(reading.percent);
  if (!Number.isFinite(value))
    return null;
  return Math.min(100, Math.max(0, value));
}
function assessKey(state) {
  const observed = state.usage !== null;
  if (!state.usage) {
    return {
      id: state.id,
      usable: true,
      reason: null,
      consumed: null,
      worstMeter: null,
      resetsAt: null,
      observed
    };
  }
  let consumed = null;
  let worstMeter = null;
  let blockedMeter = null;
  for (const meter of METERS) {
    const reading = state.usage[meter];
    if (!reading)
      continue;
    if (reading.status === "rate-limited" && blockedMeter === null)
      blockedMeter = meter;
    const percent = percentOf(reading);
    if (percent === null)
      continue;
    if (consumed === null || percent > consumed) {
      consumed = percent;
      worstMeter = meter;
    }
  }
  const blocking = blockedMeter ?? (consumed !== null && consumed >= 100 ? worstMeter : null);
  if (blocking !== null) {
    return {
      id: state.id,
      usable: false,
      reason: blockedMeter !== null ? "rate-limited" : "exhausted",
      consumed,
      worstMeter: blocking,
      resetsAt: state.usage[blocking]?.resetsAt ?? null,
      observed
    };
  }
  return {
    id: state.id,
    usable: true,
    reason: null,
    consumed,
    worstMeter,
    resetsAt: worstMeter === null ? null : state.usage[worstMeter]?.resetsAt ?? null,
    observed
  };
}
var DEFAULT_THRESHOLD_PERCENT = 90;
function affinityHash(affinity) {
  let hash = 2166136261;
  for (let index = 0;index < affinity.length; index += 1) {
    hash ^= affinity.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}
function consumedOf(assessment) {
  return assessment.consumed ?? 0;
}
function selectKey(policy, context) {
  const pinned = context.pin === undefined ? undefined : context.keys.find((key) => key.id === context.pin);
  if (pinned && pinned.usable) {
    return { keyId: pinned.id, pinned: true, avoided: [] };
  }
  const usable = context.keys.filter((key) => key.usable);
  if (usable.length === 0)
    return null;
  const observed = usable.filter((key) => key.observed);
  const preferred = observed.length > 0 ? observed : usable;
  const belowThreshold = preferred.filter((key) => consumedOf(key) < context.thresholdPercent);
  const candidates = belowThreshold.length > 0 ? belowThreshold : preferred;
  const avoided = usable.filter((key) => !candidates.includes(key)).map((key) => key.id);
  return {
    keyId: pick(policy, candidates, context.affinity),
    pinned: false,
    avoided
  };
}
function pick(policy, candidates, affinity) {
  if (policy === "round-robin") {
    return candidates[affinityHash(affinity) % candidates.length].id;
  }
  if (policy === "threshold") {
    let best = candidates[0];
    for (const candidate of candidates) {
      if (consumedOf(candidate) < consumedOf(best))
        best = candidate;
    }
    return best.id;
  }
  return candidates[0].id;
}

// src/usage.ts
var DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1";
var DEFAULT_TIMEOUT_MS = 1e4;

class UsageError extends Error {
  code;
  status;
  constructor(code, message, status) {
    super(message);
    this.name = "UsageError";
    this.code = code;
    this.status = status;
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function numberOf(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function parseMeter(value) {
  if (!isRecord(value))
    return null;
  return {
    status: typeof value.status === "string" ? value.status : null,
    percent: numberOf(value.percent),
    resetsAt: typeof value.resetsAt === "string" ? value.resetsAt : null
  };
}
function parseUsage(payload) {
  if (!isRecord(payload) || !isRecord(payload.usage)) {
    throw new UsageError("shape", "usage payload has no usage object");
  }
  const usage = payload.usage;
  const meters = ["rolling", "weekly", "monthly"];
  const reading = {
    rolling: null,
    weekly: null,
    monthly: null
  };
  for (const meter of meters)
    reading[meter] = parseMeter(usage[meter]);
  return reading;
}
function trimBase(baseUrl) {
  return baseUrl.replace(/\/+$/, "");
}
async function fetchUsage(request) {
  const url = `${trimBase(request.baseUrl ?? DEFAULT_BASE_URL)}/usage`;
  const doFetch = request.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  const headers = {
    authorization: `Bearer ${request.apiKey}`,
    accept: "application/json"
  };
  if (request.orgId !== undefined && request.orgId !== "") {
    headers["x-opencode-org-id"] = request.orgId;
  }
  let response;
  try {
    response = await doFetch(url, { method: "GET", headers, signal });
  } catch (cause) {
    throw new UsageError("unreachable", `usage request failed: ${String(cause)}`);
  }
  if (!response.ok) {
    const status = response.status;
    const code = status === 401 || status === 403 ? "unauthorized" : "http";
    throw new UsageError(code, `usage request returned ${status}`, status);
  }
  let payload;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new UsageError("shape", `usage response is not JSON: ${String(cause)}`);
  }
  return parseUsage(payload);
}

// src/poller.ts
var DEFAULT_INTERVAL_MS = 60000;
async function pollUsage(targets, deps = {}) {
  const at = (deps.now ?? Date.now)();
  return Promise.all(targets.map(async (target) => {
    try {
      const usage = await fetchUsage({
        apiKey: target.apiKey,
        ...target.orgId === undefined ? {} : { orgId: target.orgId },
        ...deps.baseUrl === undefined ? {} : { baseUrl: deps.baseUrl },
        ...deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl },
        ...deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }
      });
      return { keyId: target.keyId, ok: true, usage, at };
    } catch (cause) {
      const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : "unreachable";
      return {
        keyId: target.keyId,
        ok: false,
        code,
        message: cause instanceof Error ? cause.message : String(cause)
      };
    }
  }));
}

class UsagePoller {
  #options;
  #timer;
  #stopped = true;
  #first;
  constructor(options) {
    this.#options = options;
  }
  async once() {
    const targets = await this.#options.targets();
    if (targets.length === 0)
      return [];
    const outcomes = await pollUsage(targets, this.#options);
    for (const outcome of outcomes)
      this.#options.onOutcome(outcome);
    return outcomes;
  }
  start() {
    if (!this.#stopped)
      return;
    this.#stopped = false;
    this.#first = this.#sweep();
    this.#first;
  }
  whenSettled() {
    return this.#first ?? Promise.resolve();
  }
  stop() {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
  async#sweep() {
    try {
      await this.once();
    } catch (error) {
      this.#options.onError?.(error);
    }
    if (this.#stopped)
      return;
    const interval = this.#options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#timer = setTimeout(() => void this.#sweep(), interval);
    this.#timer.unref?.();
  }
}

// src/config.ts
var ROUTE = "opencode-go";

class ConfigError extends Error {
  path;
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = "ConfigError";
    this.path = path;
  }
}
var POLICIES = ["sticky", "threshold", "round-robin"];
var KEY_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireRecord(value, path) {
  if (!isRecord2(value))
    throw new ConfigError(path, "must be an object");
  return value;
}
function optionalString(record, field, path) {
  const value = record[field];
  if (value === undefined)
    return;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${path}.${field}`, "must be a non-empty string");
  }
  return value;
}
function parseKey(value, index) {
  const path = `keys[${index}]`;
  const record = requireRecord(value, path);
  const id = optionalString(record, "id", path);
  if (id === undefined)
    throw new ConfigError(`${path}.id`, "is required");
  if (!KEY_ID.test(id)) {
    throw new ConfigError(`${path}.id`, "must match [a-z0-9][a-z0-9-]* and be at most 32 characters");
  }
  const apiKeyEnv = optionalString(record, "apiKeyEnv", path);
  if (apiKeyEnv === undefined)
    throw new ConfigError(`${path}.apiKeyEnv`, "is required");
  const orgId = optionalString(record, "orgId", path);
  return { id, apiKeyEnv, ...orgId === undefined ? {} : { orgId } };
}
function percentage(record, fallback) {
  const value = record.thresholdPercent;
  if (value === undefined)
    return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100) {
    throw new ConfigError("thresholdPercent", "must be a number greater than 0 and at most 100");
  }
  return value;
}
function interval(record) {
  const value = record.pollIntervalMs;
  if (value === undefined)
    return DEFAULT_INTERVAL_MS;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 5000) {
    throw new ConfigError("pollIntervalMs", "must be an integer of at least 5000");
  }
  return value;
}
function resolveConfig(raw) {
  const record = requireRecord(raw, "config");
  const rawKeys = record.keys;
  if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
    throw new ConfigError("keys", "must be a non-empty list of accounts");
  }
  const keys = rawKeys.map((entry, index) => parseKey(entry, index));
  const seen = new Set;
  for (const key of keys) {
    if (seen.has(key.id))
      throw new ConfigError("keys", `duplicate account id "${key.id}"`);
    seen.add(key.id);
  }
  const policy = record.policy ?? "sticky";
  if (typeof policy !== "string" || !POLICIES.includes(policy)) {
    throw new ConfigError("policy", `must be one of ${POLICIES.join(", ")}`);
  }
  const baseUrl = record.baseUrl ?? DEFAULT_BASE_URL;
  if (typeof baseUrl !== "string")
    throw new ConfigError("baseUrl", "must be a string");
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new Error("protocol");
  } catch {
    throw new ConfigError("baseUrl", "must be an http(s) URL");
  }
  const repinOnCompaction = record.repinOnCompaction ?? true;
  if (typeof repinOnCompaction !== "boolean") {
    throw new ConfigError("repinOnCompaction", "must be a boolean");
  }
  return {
    keys,
    policy,
    thresholdPercent: percentage(record, DEFAULT_THRESHOLD_PERCENT),
    baseUrl,
    pollIntervalMs: interval(record),
    repinOnCompaction
  };
}

// src/pins.ts
var PIN_RECORD_TYPE = "plugin:opencode-go-pool/pin";
var COMPACTION_EVENT = "compaction/summary";
var EMPTY_FACTS = { pinKey: undefined, stale: false, end: 0 };
function pinOf(payload) {
  if (typeof payload !== "object" || payload === null)
    return;
  const candidate = payload.keyId;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}
function foldPinFacts(facts, events, repinOnCompaction = true) {
  let pinKey = facts.pinKey;
  let stale = facts.stale;
  let end = facts.end;
  for (const event of events) {
    if (event.type === PIN_RECORD_TYPE) {
      const keyId = pinOf(event.data);
      if (keyId !== undefined) {
        pinKey = keyId;
        stale = false;
      }
    } else if (repinOnCompaction && event.type === COMPACTION_EVENT) {
      stale = true;
    }
    if (event.seq >= end)
      end = event.seq + 1;
  }
  return { pinKey, stale, end };
}

class SessionPinStore {
  #port;
  #options;
  #facts = new Map;
  constructor(port, options = {}) {
    this.#port = port;
    this.#options = options;
  }
  async get(sessionId) {
    try {
      const facts = this.#factsOf(sessionId);
      return facts.stale ? undefined : facts.pinKey;
    } catch (error) {
      this.#options.onError?.({ operation: "read", sessionId, error });
      return;
    }
  }
  async set(sessionId, keyId) {
    try {
      const seq = this.#port.append(sessionId, { keyId });
      const facts = this.#facts.get(sessionId) ?? EMPTY_FACTS;
      this.#facts.set(sessionId, { pinKey: keyId, stale: false, end: Math.max(facts.end, seq + 1) });
    } catch (error) {
      this.#options.onError?.({ operation: "write", sessionId, error });
    }
  }
  #factsOf(sessionId) {
    const end = this.#port.endSeq(sessionId);
    if (end === undefined)
      return this.#facts.get(sessionId) ?? EMPTY_FACTS;
    const known = this.#facts.get(sessionId);
    if (known === undefined) {
      const facts = this.#scanBackwards(sessionId, end);
      this.#facts.set(sessionId, facts);
      return facts;
    }
    if (end <= known.end)
      return known;
    const events = this.#port.read(sessionId, known.end, end);
    const facts = foldPinFacts(known, events, this.#repin());
    this.#facts.set(sessionId, facts);
    return facts;
  }
  #scanBackwards(sessionId, end) {
    const repin = this.#repin();
    const events = this.#port.read(sessionId, this.#port.floorSeq(sessionId), end);
    for (let index = events.length - 1;index >= 0; index -= 1) {
      const event = events[index];
      if (event.type === PIN_RECORD_TYPE) {
        const keyId = pinOf(event.data);
        if (keyId !== undefined)
          return { pinKey: keyId, stale: false, end };
      } else if (repin && event.type === COMPACTION_EVENT) {
        return { pinKey: undefined, stale: true, end };
      }
    }
    return { pinKey: undefined, stale: false, end };
  }
  #repin() {
    return this.#options.repinOnCompaction ?? true;
  }
}

// src/pool.ts
class KeyPool {
  #entries;
  #order;
  #policy;
  #thresholdPercent;
  #pins;
  #lineageOf;
  #ready;
  #known = new Map;
  #readings;
  constructor(options) {
    const entries = new Map;
    for (const key of options.keys) {
      if (entries.has(key.id))
        throw new Error(`duplicate pool key id: ${key.id}`);
      entries.set(key.id, { key, usage: null, observedAt: null, blocked: null });
    }
    if (entries.size === 0)
      throw new Error("pool needs at least one key");
    this.#entries = entries;
    this.#order = options.keys.map((key) => key.id);
    this.#policy = options.policy;
    this.#thresholdPercent = options.thresholdPercent ?? DEFAULT_THRESHOLD_PERCENT;
    this.#pins = options.pins;
    this.#lineageOf = options.lineageOf;
    this.#ready = options.ready;
  }
  keys() {
    return this.#order.map((id) => this.#entries.get(id).key);
  }
  key(keyId) {
    return this.#entries.get(keyId)?.key;
  }
  observe(keyId, usage, at) {
    const entry = this.#entries.get(keyId);
    if (!entry)
      return;
    entry.usage = usage;
    entry.observedAt = at;
    entry.blocked = null;
  }
  block(keyId, reason) {
    const entry = this.#entries.get(keyId);
    if (!entry)
      return;
    entry.blocked = reason;
  }
  report() {
    return this.#order.map((id) => {
      const entry = this.#entries.get(id);
      const basis = {
        id,
        usage: entry.usage,
        observedAt: entry.observedAt
      };
      const base = assessKey(basis);
      const assessment = entry.blocked === null ? base : {
        ...base,
        usable: false,
        reason: entry.blocked
      };
      return {
        id,
        assessment,
        blocked: entry.blocked,
        observedAt: entry.observedAt
      };
    });
  }
  status() {
    return { keys: this.report(), pinCount: this.#known.size };
  }
  async resolve(conversation) {
    const pin = await this.#pinOf(conversation);
    if (pin === undefined)
      await this.#firstReading();
    const selection = selectKey(this.#policy, {
      affinity: conversation,
      keys: this.report().map((report) => report.assessment),
      pin,
      thresholdPercent: this.#thresholdPercent
    });
    if (selection === null)
      return null;
    if (!selection.pinned)
      await this.#pin(conversation, selection.keyId);
    return selection;
  }
  async pinned(conversation) {
    return this.#pinOf(conversation);
  }
  async#firstReading() {
    if (this.#ready === undefined)
      return;
    if (this.#order.some((id) => this.#entries.get(id).usage !== null))
      return;
    this.#readings ??= this.#ready().catch(() => {});
    await this.#readings;
  }
  async#pinOf(conversation) {
    if (this.#pins === undefined)
      return this.#known.get(conversation);
    const own = await this.#pins.get(conversation);
    if (own !== undefined) {
      this.#known.set(conversation, own);
      return own;
    }
    const lineage = await this.#lineageOf?.(conversation) ?? [conversation];
    for (const ancestor of lineage.slice(1)) {
      const inherited = await this.#pins?.get(ancestor);
      if (inherited === undefined)
        continue;
      await this.#pin(conversation, inherited);
      return inherited;
    }
    return;
  }
  async#pin(conversation, keyId) {
    this.#known.set(conversation, keyId);
    await this.#pins?.set(conversation, keyId);
  }
}

// src/index.ts
var name = "opencode-go-pool";
var inject = ["llm"];
var SESSION_MODULE = "@deepseek-ai/dsh-session";
var LLM_MODULE = "@deepseek-ai/dsh-llm";
var PI_AI_PLUGIN = "@deepseek-ai/dsh-llm-pi-ai";
var PI_AI_PROVIDER = "@earendil-works/pi-ai/providers/opencode-go";
var QUOTA_CODE = "QUOTA_EXCEEDED";
var RETRY_POLICY = Object.freeze({
  mode: "normal",
  maxRetries: 5,
  retryableCodes: Object.freeze([
    "EMPTY_RESPONSE",
    "RATE_LIMIT",
    "SERVER",
    "TIMEOUT",
    "TRANSPORT",
    QUOTA_CODE
  ]),
  initialDelayMs: 500,
  maxDelayMs: 1e4,
  jitterRatio: 0.1
});
var PROFILE_DEFAULTS = {
  streamIdleTimeoutMs: 300000,
  maxRequestImageBytes: 20 * 1024 * 1024,
  requestImagePixelBudget: 2048 * 2048,
  requestImageMaxBytes: 1024 * 1024
};
function loggerOf(ctx) {
  return ctx.logger ?? {
    info: () => {},
    warn: () => {},
    error: () => {}
  };
}
function errorCode(error) {
  if (typeof error !== "object" || error === null)
    return;
  const own = Object.getOwnPropertyDescriptor(error, "code");
  return own !== undefined && "value" in own && typeof own.value === "string" ? own.value : undefined;
}
async function resolveSecret(ctx, reference) {
  const credentials = ctx.get("credentials");
  if (credentials !== undefined) {
    try {
      const hit = await credentials.resolve(reference);
      if (hit?.value !== undefined && hit.value !== "")
        return hit.value;
    } catch (error) {
      loggerOf(ctx).warn(`opencode-go-pool: credential "${reference}" could not be resolved: %o`, error);
    }
  }
  const ambient = process.env[reference];
  if (ambient !== undefined && ambient !== "")
    return ambient;
  throw new Error(`opencode-go-pool: credential "${reference}" is not stored and not in the environment`);
}
async function scanPort(ctx) {
  const sessions = ctx.get("sessions");
  const sessionModule = await import(SESSION_MODULE);
  const live = (sessionId) => sessions?.get(sessionId);
  return {
    read(sessionId, fromSeq, toSeqExclusive) {
      const session = live(sessionId);
      if (session === undefined)
        return [];
      const start = Math.max(fromSeq, session.inheritedEventCount ?? 0);
      if (start >= toSeqExclusive)
        return [];
      const events = [];
      for (const event of session.snapshotEvents(start, toSeqExclusive)) {
        const record = sessionModule.pluginRecordOf(event);
        if (record?.type === PIN_RECORD_TYPE) {
          events.push({ type: PIN_RECORD_TYPE, seq: Number(record.seq), data: record.data });
        } else if (event.type === COMPACTION_EVENT) {
          events.push({ type: COMPACTION_EVENT, seq: Number(event.seq), data: event.data });
        }
      }
      return events;
    },
    endSeq(sessionId) {
      return live(sessionId)?.seq;
    },
    floorSeq(sessionId) {
      return live(sessionId)?.inheritedEventCount ?? 0;
    },
    append(sessionId, data) {
      const session = live(sessionId);
      if (session === undefined)
        throw new Error(`conversation "${sessionId}" has no live session`);
      return Number(sessionModule.appendPluginRecord(session, PIN_RECORD_TYPE, data));
    }
  };
}
function lineageOf(ctx) {
  const sessions = ctx.get("sessions");
  return async (sessionId) => {
    const chain = [sessionId];
    if (sessions === undefined)
      return chain;
    let current = sessions.get(sessionId);
    const seen = new Set([sessionId]);
    while (current !== undefined) {
      const parent = current.header?.parentSession;
      if (parent === undefined || seen.has(parent))
        break;
      const live = sessions.get(parent);
      if (live === undefined)
        break;
      seen.add(parent);
      chain.push(parent);
      current = live;
    }
    return chain;
  };
}
function buildAdapters(keys, PiAiAdapter, provider, llm, ctx) {
  const profile = {
    provider: ROUTE,
    displayName: provider.name ?? "OpenCode Go",
    ...PROFILE_DEFAULTS,
    retryPolicy: RETRY_POLICY,
    configuredMaxTokens: new Map,
    modelErrors: new Map,
    piProvider: provider
  };
  const adapters = new Map;
  for (const key of keys) {
    const profiles = new Map([[ROUTE, profile]]);
    adapters.set(key.id, new PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: () => resolveSecret(ctx, key.apiKeyEnv),
      resolveAttachments: () => ctx.get("attachments"),
      resolveImageAccess: (attachments, ref) => llm.resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get("fs")?.processPathFromHostPath(hostPath), ref),
      auth: {
        credentials: {
          read: async () => {
            return;
          },
          list: async () => [],
          modify: async () => {
            return;
          },
          delete: async () => {}
        },
        authContext: { env: async () => {
          return;
        }, fileExists: async () => false }
      }
    }));
  }
  return adapters;
}
function conversationOf(options) {
  if (typeof options.sessionId === "string")
    return options.sessionId;
  if (typeof options.sessionAffinity === "string")
    return options.sessionAffinity;
  return "unattributed";
}
function registerRoute(ctx, adapter) {
  const logger = loggerOf(ctx);
  const attempt = () => {
    try {
      ctx.llm.registerAdapter([ROUTE], adapter);
      logger.info('opencode-go-pool: route "%s" is served by the pool', ROUTE);
      return true;
    } catch (error) {
      if (errorCode(error) !== "DUPLICATE_ADAPTER")
        throw error;
      return false;
    }
  };
  if (attempt())
    return;
  logger.warn('opencode-go-pool: route "%s" is still owned by llm-pi-ai; remove it from that provider list and the pool takes over', ROUTE);
  const off = ctx.on("llm/adapters-updated", () => {
    try {
      if (attempt())
        off();
    } catch (error) {
      logger.error("opencode-go-pool: route registration failed: %o", error);
    }
  });
  return off;
}
function apply(ctx, raw) {
  const config = resolveConfig(raw);
  const logger = loggerOf(ctx);
  (async () => {
    const [{ PiAiAdapter }, { opencodeGoProvider }, llm] = await Promise.all([
      import(PI_AI_PLUGIN),
      import(PI_AI_PROVIDER),
      import(LLM_MODULE)
    ]);
    let poller;
    const pool = new KeyPool({
      keys: config.keys,
      policy: config.policy,
      thresholdPercent: config.thresholdPercent,
      pins: new SessionPinStore(await scanPort(ctx), {
        repinOnCompaction: config.repinOnCompaction,
        onError: (detail) => logger.warn("opencode-go-pool: pin %s failed: %o", detail.operation, detail.error)
      }),
      lineageOf: lineageOf(ctx),
      ready: () => poller?.whenSettled() ?? Promise.resolve()
    });
    const provider = opencodeGoProvider();
    const adapters = buildAdapters(config.keys, PiAiAdapter, provider, llm, ctx);
    const catalog = adapters.get(config.keys[0].id);
    const adapter = new PoolAdapter({
      pool,
      adapters,
      catalog,
      conversationOf,
      onError: ({ keyId, error }) => logger.warn('opencode-go-pool: key "%s" refused a request: %o', keyId, error)
    }, [ROUTE]);
    const unpollable = new Set;
    poller = new UsagePoller({
      baseUrl: config.baseUrl,
      intervalMs: config.pollIntervalMs,
      targets: async () => {
        const targets = [];
        for (const key of config.keys) {
          try {
            const apiKey = await resolveSecret(ctx, key.apiKeyEnv);
            targets.push({
              keyId: key.id,
              apiKey,
              ...key.orgId === undefined ? {} : { orgId: key.orgId }
            });
            unpollable.delete(key.id);
          } catch (error) {
            if (!unpollable.has(key.id)) {
              unpollable.add(key.id);
              logger.warn('opencode-go-pool: key "%s" has no usable credential (%s); polling serves the other accounts', key.id, error instanceof Error ? error.message : String(error));
            }
          }
        }
        return targets;
      },
      onError: (error) => logger.warn("opencode-go-pool: usage sweep failed: %o", error),
      onOutcome: (outcome) => {
        if (outcome.ok) {
          pool.observe(outcome.keyId, outcome.usage, outcome.at);
          return;
        }
        if (outcome.code === "unauthorized")
          pool.block(outcome.keyId, "unauthorized");
        logger.warn('opencode-go-pool: usage poll for key "%s" failed (%s): %s', outcome.keyId, outcome.code, outcome.message);
      }
    });
    const offRegistration = registerRoute(ctx, adapter);
    poller.start();
    ctx.on("dispose", () => {
      poller?.stop();
      offRegistration?.();
    });
  })().catch((error) => {
    logger.error("opencode-go-pool: failed to start: %o", error);
  });
}
export {
  apply,
  inject,
  name
};
