import {
  DUO_PROTOCOL,
  DUO_THRESHOLD,
  MAX_PAIRS_PER_TITLE,
  MAX_PLAYERS,
  buildErrorTitle,
  buildSuccessTitle,
  parseBridgeQuery,
} from "./duo_stats_title.js";

const API_ORIGIN = "https://api.deadlock-api.com";
const FETCH_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_CONCURRENT_REQUESTS = 3;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const ERROR_MESSAGES = Object.freeze({
  invalid_query: "Invalid duo bridge request.",
  network_error: "The duo service could not be reached.",
  upstream_error: "The duo service returned an error.",
  rate_limit: "The duo service is rate limited.",
  empty_roster: "No players were available.",
  invalid_payload: "The duo service returned invalid data.",
  internal_error: "The duo bridge failed.",
});

const inFlight = new Map();

function defaultLocation() {
  return typeof globalThis.location === "undefined" ? null : globalThis.location;
}

function defaultDocument() {
  return typeof globalThis.document === "undefined" ? null : globalThis.document;
}

function clockValue(now) {
  const value = typeof now === "function" ? now() : now;
  return Number.isFinite(value) ? value : Date.now();
}

function safeIsoNow(now) {
  try {
    return new Date(clockValue(now)).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function waitMs(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isAbortError(error, signal) {
  return signal?.aborted === true || error?.name === "AbortError";
}

function publishTitle(title, { documentRef = defaultDocument(), locationRef = defaultLocation() } = {}) {
  if (!documentRef || typeof title !== "string") {
    return false;
  }
  try {
    documentRef.title = title;
    if (locationRef) {
      locationRef.hash = encodeURIComponent(title);
    }
    return true;
  } catch {
    return false;
  }
}

function emitError(query, code, options, deps) {
  let title;
  try {
    title = buildErrorTitle({
      request: query?.request,
      protocol: query?.protocol ?? DUO_PROTOCOL,
      code,
      status: options?.status,
      message: ERROR_MESSAGES[code] ?? ERROR_MESSAGES.internal_error,
    });
  } catch {
    title = buildErrorTitle({
      request: "",
      protocol: DUO_PROTOCOL,
      code: "internal_error",
      message: ERROR_MESSAGES.internal_error,
    });
  }
  publishTitle(title, deps);
  return { ok: false, title, code };
}

class ApiError extends Error {
  constructor(message, { status = 0, retryAfter = null, url = "", cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ApiError";
    this.status = Number.isFinite(status) ? status : 0;
    this.retryAfter = retryAfter ?? null;
    this.url = String(url);
  }
}

function retryAfterSeconds(headers) {
  const raw = headers?.["retry-after"];
  if (raw === undefined || raw === null) {
    return null;
  }
  const seconds = Number(String(raw).split(",")[0].trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function normalizeHeaders(headers) {
  const normalized = {};
  if (!headers) {
    return normalized;
  }
  if (typeof headers.forEach === "function") {
    headers.forEach((value, key) => {
      normalized[String(key).toLowerCase()] = String(value);
    });
    return normalized;
  }
  if (typeof headers.entries === "function") {
    for (const [key, value] of headers.entries()) {
      normalized[String(key).toLowerCase()] = String(value);
    }
    return normalized;
  }
  if (typeof headers === "object") {
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined && value !== null) {
        normalized[String(key).toLowerCase()] = String(value);
      }
    }
  }
  return normalized;
}

async function readBoundedJson(response, headers, url) {
  const contentLength = Number(headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new ApiError("Duo API response exceeds the byte limit", { status: response?.status ?? 0, url, code: "payload_too_large" });
  }
  const text = typeof response?.text === "function" ? await response.text() : "";
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new ApiError("Duo API response exceeds the byte limit", { status: response?.status ?? 0, url });
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new ApiError("Duo API returned invalid JSON", { status: response?.status ?? 0, url, cause: error });
  }
}

async function fetchJson(url, { fetchImpl = globalThis.fetch, signal, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  if (signal?.aborted) {
    const error = new Error("The request was aborted");
    error.name = "AbortError";
    throw error;
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer = null;
  const onParentAbort = () => controller?.abort();
  if (typeof signal?.addEventListener === "function") {
    signal.addEventListener("abort", onParentAbort, { once: true });
  }
  try {
    timer = setTimeout(() => controller?.abort(), Math.max(1, timeoutMs));
    const response = await fetchImpl(url, controller?.signal ? { signal: controller.signal } : undefined);
    const status = Number.isFinite(response?.status) ? response.status : 0;
    const headers = normalizeHeaders(response?.headers);
    if (status === 429) {
      throw new ApiError("Duo API rate limited", { status, retryAfter: retryAfterSeconds(headers), url });
    }
    if (status === 400) {
      throw new ApiError("Duo API rejected the request", { status, url });
    }
    if (status < 200 || status >= 300) {
      throw new ApiError(`Duo API failed with status ${status}`, { status, url });
    }
    return { data: await readBoundedJson(response, headers, url), status, headers };
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError("Duo API request failed", { status: 0, url, cause: error });
  } finally {
    clearTimeout(timer);
    if (typeof signal?.removeEventListener === "function") {
      signal.removeEventListener("abort", onParentAbort);
    }
  }
}

export function buildMateStatsUrl(accountId, threshold) {
  const url = new URL(`/v1/players/${accountId}/mate-stats`, API_ORIGIN);
  url.searchParams.set("same_party", "true");
  if (Number.isSafeInteger(threshold) && threshold > 0) {
    url.searchParams.set("min_matches_played", String(threshold));
  }
  return url.toString();
}

export function buildSteamBatchUrl(accountIds) {
  const url = new URL("/v1/players/steam", API_ORIGIN);
  url.searchParams.set("account_ids", accountIds.join(","));
  return url.toString();
}

export function normalizeMateRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return null;
  }
  const mateId = Number(row.mate_id);
  const matchesPlayed = Number(row.matches_played);
  if (!Number.isSafeInteger(mateId) || mateId <= 0 || mateId > 4294967295) {
    return null;
  }
  if (!Number.isSafeInteger(matchesPlayed) || matchesPlayed < 0) {
    return null;
  }
  return { mateId, matchesPlayed };
}

export function normalizeSteamRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return null;
  }
  const accountId = Number(row.account_id);
  if (!Number.isSafeInteger(accountId) || accountId <= 0 || accountId > 4294967295) {
    return null;
  }
  const name = typeof row.personaname === "string" && row.personaname ? row.personaname : `#${accountId}`;
  return { accountId, name };
}

export function reconcilePairStrength(first, second) {
  if (first === null || first === undefined) {
    return second ?? 0;
  }
  if (second === null || second === undefined) {
    return first ?? 0;
  }
  return Math.min(first, second);
}

export function calculatePairKey(first, second) {
  return first < second ? `${first}:${second}` : `${second}:${first}`;
}

export function findDuoPairs(players, statsByPlayer, threshold) {
  const roster = new Set(players);
  const strengths = new Map();
  for (const player of players) {
    const stats = statsByPlayer.get(player) ?? [];
    for (const mate of stats) {
      if (!roster.has(mate.mateId) || mate.mateId === player) {
        continue;
      }
      if (mate.matchesPlayed < threshold) {
        continue;
      }
      const key = calculatePairKey(player, mate.mateId);
      const seen = strengths.get(key);
      if (seen === undefined) {
        strengths.set(key, { first: mate.matchesPlayed, second: null, a: Math.min(player, mate.mateId), b: Math.max(player, mate.mateId) });
      } else {
        seen.second = mate.matchesPlayed;
      }
    }
  }
  const pairs = [];
  for (const entry of strengths.values()) {
    const strength = reconcilePairStrength(entry.first, entry.second);
    if (strength >= threshold) {
      pairs.push({ a: entry.a, b: entry.b, coMatches: strength });
    }
  }
  pairs.sort((left, right) => right.coMatches - left.coMatches || left.a - right.a || left.b - right.b);
  return pairs.slice(0, MAX_PAIRS_PER_TITLE);
}

export function attachPairColors(pairs) {
  return pairs.map((pair, index) => ({ ...pair, color: index }));
}

async function fetchWithRetry(url, { fetchImpl, signal, attempts = 3 }) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) {
      const error = new Error("The request was aborted");
      error.name = "AbortError";
      throw error;
    }
    const key = url;
    let promise = inFlight.get(key);
    if (!promise) {
      promise = fetchJson(url, { fetchImpl, signal }).finally(() => inFlight.delete(key));
      inFlight.set(key, promise);
    }
    try {
      return await promise;
    } catch (error) {
      lastError = error;
      const status = error instanceof ApiError ? error.status : 0;
      const retryable = status === 0 || RETRYABLE_STATUS.has(status);
      if (!retryable || attempt >= attempts) {
        throw error;
      }
      await waitMs(250 * attempt);
    }
  }
  throw lastError ?? new ApiError("Duo API request failed", { status: 0, url });
}

async function runWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function genericError(error) {
  if (error instanceof ApiError || error?.name === "ApiError") {
    if (error.status === 429) {
      return { code: "rate_limit", status: error.status, retryAfter: error.retryAfter };
    }
    if (error.status === 400) {
      return { code: "invalid_query", status: error.status };
    }
    return { code: error.status === 0 ? "network_error" : "upstream_error", status: error.status };
  }
  return { code: "network_error", status: null };
}

function makeDeps(options) {
  return {
    location: options.location ?? defaultLocation(),
    documentRef: options.documentRef ?? defaultDocument(),
    signal: options.signal,
    now: options.now ?? Date.now,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    wait: options.wait ?? waitMs,
  };
}

export async function runBridge(options = {}) {
  const deps = makeDeps(options);
  const query = parseBridgeQuery(deps.location?.search ?? "");
  const titleOptions = { documentRef: deps.documentRef, locationRef: deps.location };
  if (deps.signal?.aborted) {
    return { ok: false, aborted: true };
  }
  if (!query.ok) {
    return emitError(query, "invalid_query", {}, titleOptions);
  }
  const accounts = [...new Set(query.accounts)].slice(0, MAX_PLAYERS);
  if (accounts.length === 0) {
    return emitError(query, "empty_roster", {}, titleOptions);
  }

  let mateRows;
  try {
    mateRows = await runWithLimit(accounts, MAX_CONCURRENT_REQUESTS, async (account) => {
      try {
        const envelope = await fetchWithRetry(buildMateStatsUrl(account, query.threshold), {
          fetchImpl: deps.fetchImpl,
          signal: deps.signal,
        });
        const rows = Array.isArray(envelope.data) ? envelope.data.map(normalizeMateRow).filter(Boolean) : [];
        return { account, rows };
      } catch (error) {
        return { account, rows: [], error };
      }
    });
  } catch (error) {
    const failure = genericError(error);
    return emitError(query, failure.code, failure, titleOptions);
  }
  if (deps.signal?.aborted) {
    return { ok: false, aborted: true };
  }

  const statsByPlayer = new Map(mateRows.map((entry) => [entry.account, entry.rows]));
  const pairs = attachPairColors(findDuoPairs(accounts, statsByPlayer, query.threshold));

  let names = new Map(accounts.map((account) => [account, `#${account}`]));
  try {
    const envelope = await fetchWithRetry(buildSteamBatchUrl(accounts), { fetchImpl: deps.fetchImpl, signal: deps.signal });
    if (Array.isArray(envelope.data)) {
      for (const row of envelope.data.map(normalizeSteamRow).filter(Boolean)) {
        names.set(row.accountId, row.name);
      }
    }
  } catch {
    // Usernames are cosmetic. One failed batch never fails the whole match.
  }
  if (deps.signal?.aborted) {
    return { ok: false, aborted: true };
  }

  const players = accounts.map((account) => ({ account, name: names.get(account) ?? `#${account}` }));
  let title;
  try {
    title = buildSuccessTitle({
      request: query.request,
      protocol: query.protocol,
      players,
      pairs,
      threshold: query.threshold,
      note: `Same-party queue history, threshold ${query.threshold}.`,
      generated: safeIsoNow(deps.now),
    });
  } catch {
    return emitError(query, "invalid_payload", {}, titleOptions);
  }
  publishTitle(title, titleOptions);
  void DUO_THRESHOLD;
  return { ok: true, title, pairs: pairs.length, players: players.length };
}

if (typeof globalThis.document !== "undefined" && typeof globalThis.location !== "undefined") {
  runBridge().catch(() => {
    try {
      emitError({ request: "", protocol: DUO_PROTOCOL }, "internal_error", {}, {});
    } catch {
      // Last-resort title write must never throw inside the game browser.
    }
  });
}
