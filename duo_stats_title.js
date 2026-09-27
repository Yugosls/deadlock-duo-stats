const DUO_TITLE_PREFIX = "DUO1:";
const DUO_PROTOCOL = 1;
const DUO_THRESHOLD = 10;
const MAX_PLAYERS = 12;
const MAX_PAIRS_PER_TITLE = 8;
const DUO_TITLE_MAX_LENGTH = 2048;
const DUO_BUDGET_JSON_BYTES = 1900;
const DUO_NAME_MAX_LENGTH = 32;
const REQUEST_PATTERN = /^[A-Za-z0-9._~-]{1,64}$/;
const MAX_ACCOUNT_ID = 4294967295;

const ERROR_CODES = Object.freeze([
  "invalid_query",
  "network_error",
  "upstream_error",
  "rate_limit",
  "empty_roster",
  "empty_sample",
  "invalid_payload",
  "internal_error",
]);
const ERROR_CODE_SET = new Set(ERROR_CODES);

function normalizeSearch(search) {
  if (typeof search !== "string") {
    return "";
  }
  return search.startsWith("?") ? search.slice(1) : search;
}

function oneQueryValue(params, key) {
  const values = params.getAll(key);
  return values.length === 1 ? values[0] : null;
}

function normalizeAccount(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 && value <= MAX_ACCOUNT_ID ? value : null;
  }
  if (typeof value !== "string" || !/^\d{1,10}$/.test(value)) {
    return null;
  }
  const account = Number(value);
  return Number.isSafeInteger(account) && account > 0 && account <= MAX_ACCOUNT_ID ? account : null;
}

function normalizeThreshold(value) {
  if (value === null || value === undefined || value === "") {
    return DUO_THRESHOLD;
  }
  const threshold = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(threshold) && threshold >= 1 && threshold <= 999 ? threshold : null;
}

function normalizeRequest(value) {
  return typeof value === "string" && REQUEST_PATTERN.test(value) ? value : null;
}

export function parseBridgeQuery(search = "") {
  let params;
  try {
    params = new URLSearchParams(normalizeSearch(search));
  } catch {
    return { ok: false, code: "invalid_query", request: null, protocol: DUO_PROTOCOL, message: "Invalid duo bridge request." };
  }
  const rawAccounts = oneQueryValue(params, "accounts");
  const rawAccount = oneQueryValue(params, "account_id");
  const rawThreshold = params.has("threshold") ? oneQueryValue(params, "threshold") : null;
  const rawRequest = oneQueryValue(params, "request");
  const rawProtocol = params.has("protocol") ? oneQueryValue(params, "protocol") : "1";
  const protocol = rawProtocol !== null && /^\d+$/.test(String(rawProtocol)) ? Number(rawProtocol) : null;
  const request = normalizeRequest(rawRequest);
  const threshold = rawThreshold === null ? DUO_THRESHOLD : normalizeThreshold(rawThreshold);
  if (rawAccounts !== null && rawAccount !== null) {
    return { ok: false, code: "invalid_query", request, protocol: DUO_PROTOCOL, message: "Invalid duo bridge request." };
  }
  if (rawAccount !== null) {
    const account = normalizeAccount(rawAccount.trim());
    if (account === null || threshold === null || request === null || protocol !== DUO_PROTOCOL) {
      return { ok: false, code: "invalid_query", request, protocol: DUO_PROTOCOL, message: "Invalid duo bridge request." };
    }
    return { ok: true, mode: "mates", account, threshold, request, protocol };
  }
  const accounts =
    typeof rawAccounts === "string"
      ? [...new Set(rawAccounts.split(",").map((part) => normalizeAccount(part.trim())).filter((account) => account !== null))]
      : null;
  if (accounts === null || accounts.length < 1 || accounts.length > MAX_PLAYERS || threshold === null || request === null || protocol !== DUO_PROTOCOL) {
    return { ok: false, code: "invalid_query", request, protocol: DUO_PROTOCOL, message: "Invalid duo bridge request." };
  }
  return { ok: true, mode: "roster", accounts, threshold, request, protocol };
}

function truncateName(name, account) {
  if (typeof name !== "string" || !name) {
    return `#${account}`;
  }
  return name.length > DUO_NAME_MAX_LENGTH ? `${name.slice(0, DUO_NAME_MAX_LENGTH)}…` : name;
}

function normalizePair(pair) {
  if (!pair || typeof pair !== "object" || Array.isArray(pair)) {
    return null;
  }
  const a = Number(pair.a);
  const b = Number(pair.b);
  const coMatches = Number(pair.coMatches);
  const color = Number(pair.color);
  if (!Number.isSafeInteger(a) || a <= 0 || a > MAX_ACCOUNT_ID) {
    return null;
  }
  if (!Number.isSafeInteger(b) || b <= 0 || b > MAX_ACCOUNT_ID || b === a) {
    return null;
  }
  if (!Number.isSafeInteger(coMatches) || coMatches < 0) {
    return null;
  }
  if (!Number.isSafeInteger(color) || color < 0 || color >= 8) {
    return null;
  }
  const clean = { a, b, coMatches, color };
  if (pair.wins !== undefined || pair.coWins !== undefined) {
    const wins = normalizeWins(pair.wins ?? pair.coWins, coMatches);
    if (wins === null) {
      return null;
    }
    clean.wins = wins;
  }
  return clean;
}

function normalizeWins(value, coMatches) {
  const wins = Number(value);
  if (!Number.isSafeInteger(wins) || wins < 0 || wins > coMatches) {
    return null;
  }
  return wins;
}

export function buildMatesTitle({ request, protocol = DUO_PROTOCOL, account, threshold = DUO_THRESHOLD, mates = [], note = "", generated = "" }) {
  if (!normalizeRequest(request) || protocol !== DUO_PROTOCOL) {
    throw new TypeError("request and protocol must be valid");
  }
  if (normalizeAccount(account) === null) {
    throw new TypeError("account must be valid");
  }
  if (normalizeThreshold(threshold) === null) {
    throw new TypeError("threshold must be valid");
  }
  const clean = [];
  for (const mate of mates) {
    if (!mate || typeof mate !== "object" || Array.isArray(mate)) {
      continue;
    }
    const mateId = normalizeAccount(mate.account);
    const matches = Number(mate.matches);
    const wins = Number(mate.wins);
    if (mateId === null || mateId === account) {
      continue;
    }
    if (!Number.isSafeInteger(matches) || matches < threshold) {
      continue;
    }
    if (!Number.isSafeInteger(wins) || wins < 0 || wins > matches) {
      continue;
    }
    clean.push({ account: mateId, name: truncateName(mate.name, mateId), matches, wins });
  }
  clean.sort((left, right) => right.matches - left.matches || left.account - right.account);
  let kept = clean.slice(0, MAX_PAIRS_PER_TITLE);
  let droppedMates = clean.length - kept.length;
  const payload = () => ({
    v: DUO_PROTOCOL,
    kind: "duo_mates",
    request,
    account,
    threshold,
    mates: kept,
    droppedMates,
    note: typeof note === "string" ? note.slice(0, 120) : "",
    generated: typeof generated === "string" ? generated.slice(0, 64) : "",
  });
  // Shrink weakest mates first so the title always fits the Panorama budget.
  while (kept.length > 0 && JSON.stringify(payload()).length > DUO_BUDGET_JSON_BYTES) {
    kept = kept.slice(0, -1);
    droppedMates += 1;
  }
  const title = `${DUO_TITLE_PREFIX}${JSON.stringify(payload())}`;
  if (title.length > DUO_TITLE_MAX_LENGTH) {
    throw new RangeError("duo payload exceeds the Panorama title budget");
  }
  return title;
}

export function buildSuccessTitle({ request, protocol = DUO_PROTOCOL, players = [], pairs = [], threshold = DUO_THRESHOLD, note = "", generated = "" }) {
  if (!normalizeRequest(request) || protocol !== DUO_PROTOCOL) {
    throw new TypeError("request and protocol must be valid");
  }
  const seen = new Set();
  const cleanPlayers = [];
  for (const player of players.slice(0, MAX_PLAYERS)) {
    const account = normalizeAccount(player?.account);
    if (account === null || seen.has(account)) {
      continue;
    }
    seen.add(account);
    cleanPlayers.push({ account, name: truncateName(player?.name, account) });
  }
  if (cleanPlayers.length === 0) {
    throw new TypeError("at least one player is required");
  }
  const roster = new Set(cleanPlayers.map((player) => player.account));
  const cleanPairs = [];
  for (const pair of pairs) {
    const clean = normalizePair(pair);
    if (clean && roster.has(clean.a) && roster.has(clean.b) && clean.coMatches >= threshold) {
      cleanPairs.push(clean);
    }
  }
  cleanPairs.sort((left, right) => right.coMatches - left.coMatches || left.a - right.a || left.b - right.b);
  let kept = cleanPairs.slice(0, MAX_PAIRS_PER_TITLE);
  let droppedPairs = cleanPairs.length - kept.length;
  const payload = () => ({
    v: DUO_PROTOCOL,
    kind: "duo_match",
    request,
    players: cleanPlayers,
    pairs: kept,
    threshold,
    droppedPairs,
    note: typeof note === "string" ? note.slice(0, 120) : "",
    generated: typeof generated === "string" ? generated.slice(0, 64) : "",
  });
  // Shrink weakest pairs first so the title always fits the Panorama budget.
  while (kept.length > 0 && JSON.stringify(payload()).length > DUO_BUDGET_JSON_BYTES) {
    kept = kept.slice(0, -1);
    droppedPairs += 1;
  }
  const title = `${DUO_TITLE_PREFIX}${JSON.stringify(payload())}`;
  if (title.length > DUO_TITLE_MAX_LENGTH) {
    throw new RangeError("duo payload exceeds the Panorama title budget");
  }
  return title;
}

export function buildErrorTitle({ request = "", protocol = DUO_PROTOCOL, code = "internal_error", status = null, message = "" }) {
  const safeCode = ERROR_CODE_SET.has(code) ? code : "internal_error";
  const safeStatus = Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null;
  const title = `${DUO_TITLE_PREFIX}${JSON.stringify({
    v: DUO_PROTOCOL,
    kind: "error",
    request: typeof request === "string" ? request.slice(0, 64) : "",
    protocol: protocol === DUO_PROTOCOL ? protocol : DUO_PROTOCOL,
    code: safeCode,
    status: safeStatus,
    message: typeof message === "string" ? message.slice(0, 160) : "",
  })}`;
  if (title.length > DUO_TITLE_MAX_LENGTH) {
    throw new RangeError("duo error payload exceeds the Panorama title budget");
  }
  return title;
}

export { DUO_PROTOCOL, DUO_THRESHOLD, MAX_PAIRS_PER_TITLE, MAX_PLAYERS, DUO_TITLE_PREFIX, DUO_TITLE_MAX_LENGTH };
