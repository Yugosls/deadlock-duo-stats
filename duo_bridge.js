// Deadlock Duo Stats bridge — host duo_bridge.html + this file on any static
// host (e.g. GitHub Pages) and paste the page URL into BRIDGE_URL /
// BRIDGE_ORIGIN_PATH at the top of panorama/scripts/profile_stats_duo.js.
//
// Query:  ?account_id=<steam3 id>&min_matches=<2|3|5|10>&request=<nonce>&protocol=1
// Answer: document.title = "DLDUO1:" + JSON.stringify(payload), which the
// in-game CitadelHTMLPanel surfaces via HTMLTitle / HTMLURLChanged. The page
// also mirrors the title into location.hash so the URL-changed handler fires.
//
// Success payload (must match validateSuccessPayload in profile_stats_duo.js):
//   { v:1, kind:"duo_stats", request, account, min_matches, sample,
//     generated, teammates:[{account, matches, wins, name, avatar}] }
// sorted by matches desc, max 8 rows.
//
// Error payload (must match validateErrorPayload):
//   { v:1, kind:"error", request, account, min_matches, code,
//     status?, retry_after?, message? }
// codes: invalid_query | network_error | upstream_error | rate_limit |
//        empty_sample | invalid_payload | payload_too_large | internal_error

var API_ORIGIN = "https://api.deadlock-api.com";
var TITLE_PREFIX = "DLDUO1:";
var TITLE_MAX_LENGTH = 2048;
var PROTOCOL = 1;
var ROW_LIMIT = 8;
var FETCH_TIMEOUT_MS = 20000;
var MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
var DEBUG_BRIDGE = true;

function bridgeLog(stage, detail) {
    var stamp;
    var line;
    if (!DEBUG_BRIDGE) {
        return;
    }
    try {
        stamp = new Date().toISOString();
    } catch (stampError) {
        stamp = "?";
    }
    line = "[DUOBRIDGE " + stamp + "] " + String(stage) +
        (detail === undefined ? "" : " " + String(detail).slice(0, 500));
    try {
        if (typeof console !== "undefined" && typeof console.log === "function") {
            console.log(line);
        }
    } catch (logError) {
    }
    try {
        if (typeof document !== "undefined" && document && document.body) {
            var pre = document.getElementById("duo-bridge-log");
            if (!pre) {
                pre = document.createElement("pre");
                pre.id = "duo-bridge-log";
                pre.setAttribute("style", "white-space:pre-wrap;word-break:break-word;font-size:12px;padding:12px;");
                document.body.appendChild(pre);
            }
            pre.textContent = (pre.textContent || "") + line + "\n";
        }
    } catch (domError) {
    }
}

var ERROR_MESSAGES = {
    invalid_query: "Invalid duo request.",
    network_error: "The duo service could not be reached.",
    upstream_error: "The duo service returned an error.",
    rate_limit: "The duo service is rate limited.",
    empty_sample: "No repeat teammates found.",
    invalid_payload: "The duo service returned invalid data.",
    payload_too_large: "The duo result was too large.",
    internal_error: "The duo bridge failed."
};

function printableAscii(value) {
    return typeof value === "string" && /^[\x20-\x7E]*$/.test(value);
}

function normalizeAccount(value) {
    var account;
    if (typeof value === "number") {
        return Number.isSafeInteger(value) && value > 0 && value <= 4294967295 ? value : null;
    }
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
        return null;
    }
    account = Number(value);
    return Number.isSafeInteger(account) && account > 0 && account <= 4294967295 ? account : null;
}

function normalizeMinMatches(value) {
    var n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    return n === 2 || n === 3 || n === 5 || n === 10 ? n : null;
}

function normalizeRequest(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 64 &&
        /^[A-Za-z0-9._~-]{1,64}$/.test(value) ? value : null;
}

function parseQuery(search) {
    bridgeLog("query.search", search);
    var rawAccount;
    var rawMin;
    var rawRequest;
    var rawProtocol;
    try {
        params = new URLSearchParams(typeof search === "string" && search.charAt(0) === "?" ? search.slice(1) : search);
    } catch (err) {
        return { ok: false };
    }
    if (params.getAll("account_id").length !== 1 || params.getAll("min_matches").length !== 1 ||
            params.getAll("request").length !== 1) {
        return { ok: false };
    }
    rawAccount = params.get("account_id");
    rawMin = params.get("min_matches");
    rawRequest = params.get("request");
    rawProtocol = params.has("protocol") ? params.get("protocol") : "1";
    return {
        ok: true,
        account: normalizeAccount(rawAccount),
        minMatches: normalizeMinMatches(rawMin),
        request: normalizeRequest(rawRequest),
        protocol: rawProtocol === "1" ? 1 : null
    };
}

function buildError(query, code, options) {
    var payload = {
        v: PROTOCOL,
        kind: "error",
        request: query && typeof query.request === "string" ? query.request : "",
        account: query && typeof query.account === "number" ? query.account : 0,
        min_matches: query && typeof query.minMatches === "number" ? query.minMatches : 2,
        code: code,
        message: ERROR_MESSAGES[code] || ERROR_MESSAGES.internal_error
    };
    options = options || {};
    if (options.status) {
        payload.status = options.status;
    }
    if (options.retryAfter !== undefined && options.retryAfter !== null) {
        payload.retry_after = options.retryAfter;
    }
    return payload;
}

function publish(payload) {
    var title = TITLE_PREFIX + JSON.stringify(payload);
    if (title.length > TITLE_MAX_LENGTH) {
        bridgeLog("publish.too_large", "len=" + String(title.length));
        title = TITLE_PREFIX + JSON.stringify(buildError(
            { request: payload.request, account: payload.account, minMatches: payload.min_matches },
            "payload_too_large", {}));
    }
    bridgeLog("publish.title", "kind=" + String(payload.kind) + " len=" + String(title.length) + " head=" + title.slice(0, 120));
    try {
        document.title = title;
    } catch (err) {
        bridgeLog("publish.title_failed", String(err && err.message || err));
        return;
    }
    try {
        if (typeof location !== "undefined") {
            location.hash = encodeURIComponent(title);
        }
    } catch (err2) {
        bridgeLog("publish.hash_failed", String(err2 && err2.message || err2));
        return;
    }
}

function fetchJson(url, signal) {
    var controller;
    var timer;
    var work;
    bridgeLog("fetch.start", url);
    if (typeof fetch !== "function") {
        bridgeLog("fetch.unavailable", url);
        return Promise.reject(new Error("fetch unavailable"));
    }
    controller = typeof AbortController === "function" ? new AbortController() : null;
    if (controller && signal) {
        if (signal.aborted) {
            controller.abort();
        } else if (typeof signal.addEventListener === "function") {
            signal.addEventListener("abort", function () { controller.abort(); }, { once: true });
        }
    }
    work = fetch(url, controller && controller.signal ? { signal: controller.signal } : undefined)
        .then(function (response) {
            var status = response && typeof response.status === "number" ? response.status : 0;
            var headers = {};
            try {
                response.headers.forEach(function (value, key) {
                    headers[String(key).toLowerCase()] = String(value);
                });
            } catch (err) {
                headers = {};
            }
            if (status === 429) {
                bridgeLog("fetch.429", url + " status=429");
                return { rateLimited: true, status: status, headers: headers };
            }
            if (status < 200 || status >= 300) {
                bridgeLog("fetch.upstream", url + " status=" + String(status));
                throw { upstream: true, status: status };
            }
            return response.text().then(function (text) {
                bridgeLog("fetch.body", url + " bytes=" + String(text.length) + " status=" + String(status));
                if (text.length > MAX_RESPONSE_BYTES) {
                    bridgeLog("fetch.too_large", url + " bytes=" + String(text.length));
                    throw { tooLarge: true };
                }
                try {
                    return { data: text.trim() ? JSON.parse(text.trim()) : null, status: status, headers: headers };
                } catch (err2) {
                    bridgeLog("fetch.invalid_json", url + " head=" + String(text).slice(0, 120));
                    throw { invalid: true };
                }
            });
        });
    timer = new Promise(function (_, reject) {
        setTimeout(function () {
            try {
                if (controller) {
                    controller.abort();
                }
            } catch (err) {
                return;
            }
            reject({ timeout: true });
        }, FETCH_TIMEOUT_MS);
    });
    return Promise.race([work, timer]);
}

function retryAfterSeconds(headers) {
    var raw;
    var value;
    if (!headers) {
        return null;
    }
    raw = headers["retry-after"];
    if (raw === undefined || raw === null) {
        return null;
    }
    value = Number(raw);
    if (!isFinite(value) || value < 0 || value > 86400) {
        return null;
    }
    return value;
}

function asciiName(value, fallback) {
    var text = String(value === null || value === undefined ? "" : value)
        .replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
    if (!text || text.length > 64 || !printableAscii(text)) {
        return fallback;
    }
    return text;
}

function asciiAvatar(value) {
    var text = String(value === null || value === undefined ? "" : value).replace(/^\s+|\s+$/g, "");
    if (text.length > 512 || (text.length > 0 && !printableAscii(text))) {
        return "";
    }
    if (text && text.indexOf("http://") !== 0 && text.indexOf("https://") !== 0) {
        return "";
    }
    return text;
}

export function runDuoBridge(options) {
    var query = parseQuery(typeof location !== "undefined" ? location.search : "");
    bridgeLog("query.parsed", JSON.stringify({ ok: query.ok, account: query.account, minMatches: query.minMatches, request: query.request, protocol: query.protocol }));
    var accountLabel;
    var signal;
    var mateUrl;
    if (!query.ok || query.account === null || query.minMatches === null ||
            query.request === null || query.protocol === null) {
        bridgeLog("query.invalid", JSON.stringify({ ok: query.ok, account: query.account, minMatches: query.minMatches, request: query.request, protocol: query.protocol }));
        publish(buildError(query.ok ? query : null, "invalid_query", {}));
        return Promise.resolve({ ok: false, code: "invalid_query" });
    }
    accountLabel = String(query.account);
    signal = options && options.signal ? options.signal : undefined;
    mateUrl = API_ORIGIN + "/v1/players/" + encodeURIComponent(accountLabel) +
        "/mate-stats?min_matches_played=" + String(query.minMatches);
    bridgeLog("fetch.mate_stats.request", mateUrl);
    return fetchJson(mateUrl, signal).then(function (mateResult) {
        var mates;
        var top;
        var ids;
        if (mateResult && mateResult.rateLimited) {
            bridgeLog("fetch.mate_stats.rate_limited", "status=429");
            publish(buildError(query, "rate_limit",
                { status: 429, retryAfter: retryAfterSeconds(mateResult.headers) }));
            return { ok: false, code: "rate_limit" };
        }
        bridgeLog("fetch.mate_stats.response", "rows=" + String(Array.isArray(mateResult.data) ? mateResult.data.length : -1) + " status=" + String(mateResult.status));
        mates = Array.isArray(mateResult.data) ? mateResult.data : null;
        if (!mates) {
            bridgeLog("fetch.mate_stats.invalid_payload", "status=" + String(mateResult.status));
            publish(buildError(query, "invalid_payload", {}));
            return { ok: false, code: "invalid_payload" };
        }
        mates = mates.filter(function (entry) {
            return entry && typeof entry === "object" &&
                Number.isSafeInteger(entry.mate_id) && entry.mate_id > 0 &&
                Number.isSafeInteger(entry.matches_played) &&
                Number.isSafeInteger(entry.wins) &&
                entry.wins >= 0 && entry.wins <= entry.matches_played;
        }).sort(function (a, b) {
            return b.matches_played - a.matches_played;
        });
        bridgeLog("filter.top", "kept=" + String(mates.length));
        top = mates.slice(0, ROW_LIMIT);
        if (top.length === 0) {
            bridgeLog("filter.empty_sample", "account=" + accountLabel);
            publish(buildError(query, "empty_sample", {}));
            return { ok: false, code: "empty_sample" };
        }
        ids = top.map(function (entry) { return String(entry.mate_id); }).join(",");
        steamUrl = API_ORIGIN + "/v1/players/steam?account_ids=" + encodeURIComponent(ids);
        bridgeLog("fetch.steam.request", steamUrl);
        return fetchJson(steamUrl, signal).then(function (steamResult) {
            bridgeLog("fetch.steam.response", "profiles=" + String(Array.isArray(steamResult.data) ? steamResult.data.length : -1) + " status=" + String(steamResult.status));
            var profiles = {};
            var teammates;
            var payload;
            if (steamResult && steamResult.rateLimited) {
                bridgeLog("fetch.steam.rate_limited", "status=429");
                publish(buildError(query, "rate_limit",
                    { status: 429, retryAfter: retryAfterSeconds(steamResult.headers) }));
                return { ok: false, code: "rate_limit" };
            }
            if (Array.isArray(steamResult.data)) {
                steamResult.data.forEach(function (profile) {
                    if (profile && typeof profile === "object" && normalizeAccount(profile.account_id) !== null) {
                        profiles[String(profile.account_id)] = profile;
                    }
                });
            }
            bridgeLog("fetch.steam.profiles", "matched=" + String(Object.keys(profiles).length));
            teammates = top.map(function (entry) {
                var profile = profiles[String(entry.mate_id)] || {};
                return {
                    account: entry.mate_id,
                    matches: entry.matches_played,
                    wins: entry.wins,
                    name: asciiName(profile.personaname, "Player " + String(entry.mate_id)),
                    avatar: asciiAvatar(profile.avatarfull || profile.avatar)
                };
            });
            payload = {
                v: PROTOCOL,
                request: query.request,
                account: query.account,
                min_matches: query.minMatches,
                sample: teammates.length,
                generated: new Date().toISOString(),
                teammates: teammates
            };
            publish(payload);
            return { ok: true, payload: payload };
        }, function (error) {
            bridgeLog("fetch.steam.error", JSON.stringify({ timeout: !!(error && error.timeout), tooLarge: !!(error && error.tooLarge), upstream: !!(error && error.upstream), status: error && error.status }));
            if (error && error.rateLimited) {
                bridgeLog("fetch.steam.rate_limited", "status=429");
                publish(buildError(query, "rate_limit", { status: 429 }));
                return { ok: false, code: "rate_limit" };
            }
            if (error && (error.timeout || error.tooLarge)) {
                bridgeLog("fetch.steam.failed", error.tooLarge ? "payload_too_large" : "network_error");
                publish(buildError(query, error.tooLarge ? "payload_too_large" : "network_error", {}));
                return { ok: false, code: error.tooLarge ? "payload_too_large" : "network_error" };
            }
            if (error && error.upstream) {
                bridgeLog("fetch.steam.upstream", "status=" + String(error.status));
                publish(buildError(query, "upstream_error", { status: error.status }));
                return { ok: false, code: "upstream_error" };
            }
            // Steam lookup is best-effort: fall back to bare account names.
            bridgeLog("fetch.steam.fallback", "bare_names=" + String(top.length));
            var teammates = top.map(function (entry) {
                return {
                    account: entry.mate_id,
                    matches: entry.matches_played,
                    wins: entry.wins,
                    name: "Player " + String(entry.mate_id),
                    avatar: ""
                };
            });
            var payload = {
                v: PROTOCOL,
                kind: "duo_stats",
                request: query.request,
                account: query.account,
                min_matches: query.minMatches,
                sample: teammates.length,
                generated: new Date().toISOString(),
                teammates: teammates
            };
            publish(payload);
            return { ok: true, payload: payload };
        });
    }, function (error) {
        bridgeLog("fetch.mate_stats.error", "status=" + String(error && error.status) + " timeout=" + String(!!(error && error.timeout)) + " upstream=" + String(!!(error && error.upstream)));
        if (error && error.rateLimited) {
            bridgeLog("fetch.mate_stats.rate_limited", "status=429");
            publish(buildError(query, "rate_limit", { status: 429 }));
            return { ok: false, code: "rate_limit" };
        }
        if (error && error.timeout) {
            bridgeLog("fetch.mate_stats.timeout", "network_error");
            publish(buildError(query, "network_error", {}));
            return { ok: false, code: "network_error" };
        }
        if (error && error.tooLarge) {
            bridgeLog("fetch.mate_stats.too_large", "payload_too_large");
            publish(buildError(query, "payload_too_large", {}));
            return { ok: false, code: "payload_too_large" };
        }
        if (error && error.upstream) {
            bridgeLog("fetch.mate_stats.upstream", "status=" + String(error.status));
            publish(buildError(query, "upstream_error", { status: error.status }));
            return { ok: false, code: "upstream_error" };
        }
        bridgeLog("fetch.mate_stats.network_error", "no_detail");
        publish(buildError(query, "network_error", {}));
        return { ok: false, code: "network_error" };
    }).catch(function () {
        bridgeLog("bridge.internal_error", "catch_all");
        try {
            publish(buildError(query, "internal_error", {}));
        } catch (err) {
            return;
        }
        return { ok: false, code: "internal_error" };
    });
}

try {
    if (typeof document !== "undefined" && typeof location !== "undefined" &&
            location.search && location.search.indexOf("account_id=") !== -1) {
        runDuoBridge();
    }
} catch (err) {
    // Unit-test imports only; the bridge runs via runDuoBridge().
}
