(function () {
    "use strict";
    var viewedProfileIdentityPolicy = (function () {
        var STEAM_ID_BASE = "76561197960265728";
        var MAX_ACCOUNT_ID = "4294967295";

        function trim(value) {
            return String(value === null || value === undefined ? "" : value).replace(/^\s+|\s+$/g, "");
        }

        function stripLeadingZeroes(value) {
            var result = String(value).replace(/^0+/, "");
            return result || "0";
        }

        function normalizeAccount(value) {
            var normalized;
            if (typeof value !== "string") {
                return "";
            }
            normalized = trim(value);
            if (!/^\d{1,20}$/.test(normalized)) {
                return "";
            }
            normalized = stripLeadingZeroes(normalized);
            if (normalized === "0" || normalized.length > MAX_ACCOUNT_ID.length ||
                (normalized.length === MAX_ACCOUNT_ID.length && normalized > MAX_ACCOUNT_ID)) {
                return "";
            }
            return normalized;
        }

        function canonicalAccount(value) {
            var normalized = normalizeAccount(value);
            return normalized && normalized === value ? normalized : "";
        }

        function subtractSteamIdBase(value) {
            var index;
            var baseIndex;
            var digit;
            var baseDigit;
            var difference;
            var borrow = 0;
            var output = "";
            if (!/^\d{17}$/.test(value) || value < STEAM_ID_BASE) {
                return "";
            }
            index = value.length - 1;
            baseIndex = STEAM_ID_BASE.length - 1;
            while (index >= 0) {
                digit = parseInt(value.charAt(index), 10) - borrow;
                baseDigit = baseIndex >= 0 ? parseInt(STEAM_ID_BASE.charAt(baseIndex), 10) : 0;
                difference = digit - baseDigit;
                if (difference < 0) {
                    difference += 10;
                    borrow = 1;
                } else {
                    borrow = 0;
                }
                output = String(difference) + output;
                index -= 1;
                baseIndex -= 1;
            }
            return normalizeAccount(stripLeadingZeroes(output));
        }

        function normalizeSteamId(value) {
            var normalized;
            if (typeof value !== "string") {
                return "";
            }
            normalized = stripLeadingZeroes(trim(value));
            return normalizeAccount(normalized) || subtractSteamIdBase(normalized);
        }

        function normalizeIdentity(value) {
            var normalized;
            var steam3;
            if (typeof value !== "string") {
                return "";
            }
            normalized = trim(value);
            steam3 = /^\[U:1:([1-9][0-9]*)\]$/.exec(normalized) || /^U:1:([1-9][0-9]*)$/.exec(normalized);
            if (steam3) {
                return normalizeAccount(steam3[1]);
            }
            return normalizeAccount(normalized) || normalizeSteamId(normalized);
        }

        function normalize(value, format) {
            if (format === "account") {
                return normalizeAccount(value);
            }
            if (format === "steamid") {
                return normalizeSteamId(value);
            }
            if (format === "identity") {
                return normalizeIdentity(value);
            }
            return "";
        }

        function result(state, account) {
            return {
                state: state,
                account: account || ""
            };
        }

        function resolve(primary, corroborators) {
            var account;
            var index;
            var witness;
            var raw;
            var normalized;
            if (!primary) {
                return result("missing", "");
            }
            raw = typeof primary.value === "string" ? primary.value : "";
            account = normalize(raw, primary.format);
            if (!account) {
                return result("missing", "");
            }
            corroborators = corroborators || [];
            for (index = 0; index < corroborators.length; index += 1) {
                witness = corroborators[index];
                if (!witness || typeof witness.value !== "string") {
                    return result("mismatch", account);
                }
                raw = witness.value;
                if (trim(raw) === "") {
                    continue;
                }
                normalized = normalize(raw, witness.format);
                if (!normalized || normalized !== account) {
                    return result("mismatch", account);
                }
            }
            return result("valid", account);
        }

        function same(left, right) {
            return !!left && !!right && left.state === right.state && left.account === right.account;
        }

        function payloadMatches(value, account) {
            return typeof value === "number" && isFinite(value) && Math.floor(value) === value &&
                value > 0 && value <= 4294967295 && String(value) === account;
        }

        function accountNumber(account) {
            var normalized = normalizeAccount(account);
            return normalized ? Number(normalized) : null;
        }

        return {
            normalizeAccount: normalizeAccount,
            normalizeIdentity: normalizeIdentity,
            resolve: resolve,
            canonicalAccount: canonicalAccount,
            same: same,
            payloadMatches: payloadMatches,
            accountNumber: accountNumber
        };
    }());
    // DUO BRIDGE CONFIG: the hosted bridge page answering
    // ?accounts=<id>&threshold=<2|3|5|10>&request=<nonce>&protocol=1 with a
    // "DUO1:" + JSON title, surfaced through HTMLTitle / HTMLURLChanged.
    // Live endpoint: https://yugosls.github.io/deadlock-duo-stats/duo_stats_bridge.html
    var BRIDGE_URL = "https://yugosls.github.io/deadlock-duo-stats/duo_stats_bridge.html";
    var BRIDGE_ORIGIN_PATH = "https://yugosls.github.io/deadlock-duo-stats/duo_stats_bridge.html";
    var SUPPORTER_TICKER_URL = "https://hantu-raya.github.io/hp-colors-preset-builder/supporters-strip/";
    var STATLOCKER_PROFILE_URL_PREFIX = "https://statlocker.gg/profile/";
    var STATLOCKER_PROFILE_URL_SUFFIX = "/matches";
    var BRIDGE_TITLE_PREFIX = "DUO1:";
    var BRIDGE_TITLE_MAX_LENGTH = 2048;
    var BRIDGE_URL_MAX_LENGTH = 4096;
    var BRIDGE_PROTOCOL = 1;
    var DEFAULT_MIN_MATCHES = 2;
    var MIN_MATCHES_OPTIONS = {
        "2": true,
        "3": true,
        "5": true,
        "10": true
    };
    var AUTHORITY_NAMES = ["accountid", "steamid"];
    var ROW_COUNT = 8;
    var CACHE_TTL_MS = 10 * 60 * 1000;
    var CACHE_SCHEMA = "profile_stats_duo_v1";
    var CONTEXT_CHECK_SECONDS = 0.5;
    var BRIDGE_ASSIGN_DELAY_SECONDS = 0.25;
    var REQUEST_TIMEOUT_SECONDS = 25;
    var MAX_HERO_ROWS = 64;
    var MAX_GENERATED_LENGTH = 64;
    var MAX_NAME_LENGTH = 32;
    var MAX_PLAYER_NAME_LENGTH = 64;
    var STATE_STOCK = "stock";
    var STATE_LOADING = "loading";
    var STATE_READY = "ready";
    var STATE_ERROR = "error";
    var STATE_DISABLED = "disabled";

    var WIN_RATE_TOP_CLASS = "ProfileStatsDuoWinRateTop";
    var WIN_RATE_BOTTOM_CLASS = "ProfileStatsDuoWinRateBottom";
    var WIN_RATE_UNAVAILABLE_CLASS = "ProfileStatsDuoWinRateUnavailable";

    var ERROR_CODES = {
        "invalid_query": true,
        "network_error": true,
        "upstream_error": true,
        "rate_limit": true,
        "empty_sample": true,
        "invalid_payload": true,
        "internal_error": true
    };

    var ERROR_TEXT = {
        "invalid_query": "The duo request was rejected.",
        "network_error": "The duo service could not be reached.",
        "upstream_error": "The duo service is unavailable.",
        "rate_limit": "The duo service is rate-limited. Try again later.",
        "empty_sample": "No repeat teammates found for this profile yet.",
        "invalid_payload": "The duo response was invalid.",
        "internal_error": "The duo service returned an internal error."
    };

    var root = null;
    var heroList = null;
    var statsBlock = null;
    var stockTitle = null;
    var stockLeft = null;
    var stockRight = null;
    var stockSectionName = null;
    var duoButton = null;
    var customPanel = null;
    var selfNamePanel = null;
    var titleLabel = null;
    var statLockerButton = null;
    var accountWitness = null;
    var statusLabel = null;
    var rowsPanel = null;
    var metadataPanel = null;
    var sampleLabel = null;
    var generatedLabel = null;
    var retryButton = null;
    var bridgePanel = null;
    var supporterTicker = null;
    var minMatchesDropdown = null;
    var stockSectionSignature = "";
    var stockRowSignature = "";

    var rowRefs = [];
    var currentIdentity = null;
    var currentDisplayName = "";
    var lifecycleState = STATE_STOCK;
    var requestGeneration = 0;
    var watcherGeneration = 0;
    var watcherHandle = null;
    var watcherPending = false;
    var watcherCallback = null;
    var bridgeAssignmentHandle = null;
    var nonceSerial = 0;
    var requestState = null;
    var memoryCache = null;
    var rateLimitUntil = 0;
    var rateLimitBlocked = false;
    var initialized = false;
    var selectedMinMatches = DEFAULT_MIN_MATCHES;

    function isCallable(value) {
        return typeof value === "function";
    }

    function isCustomActive() {
        return lifecycleState === STATE_LOADING || lifecycleState === STATE_READY || lifecycleState === STATE_ERROR;
    }

    function enterState(nextState) {
        if (lifecycleState !== nextState) {
            lifecycleState = nextState;
        }
    }

    function isValidPanel(panel) {
        if (!panel) {
            return false;
        }
        try {
            if (isCallable(panel.IsValid)) {
                return !!panel.IsValid();
            }
        } catch (error) {
            return false;
        }
        return true;
    }

    function findPanel(id) {
        if (!isValidPanel(root) || !id) {
            return null;
        }
        try {
            return root.FindChildTraverse(id);
        } catch (error) {
            return null;
        }
    }

    function findDirectChildByClass(panel, className) {
        var count;
        var index;
        var child;
        if (!isValidPanel(panel) || !className) {
            return null;
        }
        try {
            count = Math.min(panel.GetChildCount(), 8);
        } catch (error) {
            return null;
        }
        for (index = 0; index < count; index += 1) {
            try {
                child = panel.GetChild(index);
            } catch (error2) {
                return null;
            }
            if (!isValidPanel(child)) {
                continue;
            }
            try {
                if (isCallable(child.BHasClass) && child.BHasClass(className)) {
                    return child;
                }
            } catch (error3) {
                continue;
            }
        }
        return null;
    }

    function setPanelEvent(panel, eventName, handler) {
        if (!isValidPanel(panel) || !isCallable(handler)) {
            return false;
        }
        try {
            panel.SetPanelEvent(eventName, handler);
            return true;
        } catch (error) {
            return false;
        }
    }

    function registerPanelEvent(panel, eventName, handler) {
        if (!isValidPanel(panel) || !isCallable(handler) || !isCallable($.RegisterEventHandler)) {
            return false;
        }
        try {
            $.RegisterEventHandler(eventName, panel, handler);
            return true;
        } catch (error) {
            return false;
        }
    }

    function setStyle(panel, propertyName, value) {
        if (!isValidPanel(panel)) {
            return;
        }
        try {
            if (panel.style) {
                panel.style[propertyName] = value;
            }
        } catch (error) {
            return;
        }
    }

    function setVisibility(panel, visible) {
        setStyle(panel, "visibility", visible ? "visible" : "collapse");
    }

    function setVisibleProperty(panel, visible) {
        if (!isValidPanel(panel)) {
            return;
        }
        try {
            panel.visible = !!visible;
        } catch (error) {
            return;
        }
    }

    function setText(panel, value) {
        if (!isValidPanel(panel)) {
            return;
        }
        try {
            panel.text = value === null || value === undefined ? "" : String(value);
        } catch (error) {
            return;
        }
    }

    function setClass(panel, className, enabled) {
        if (!isValidPanel(panel) || !className) {
            return;
        }
        try {
            if (enabled && isCallable(panel.AddClass)) {
                panel.AddClass(className);
            } else if (!enabled && isCallable(panel.RemoveClass)) {
                panel.RemoveClass(className);
            }
        } catch (error) {
            return;
        }
    }

    function trim(value) {
        return String(value).replace(/^\s+|\s+$/g, "");
    }

    function textOf(panel) {
        var value;
        if (!isValidPanel(panel)) {
            return "";
        }
        try {
            value = panel.text;
            return value === null || value === undefined ? "" : String(value);
        } catch (error) {
            return "";
        }
    }

    function normalizeDisplayName(value) {
        var normalized = trim(String(value || "").replace(/[ -]/g, " ").replace(/\s+/g, " "));
        if (normalized.length > MAX_PLAYER_NAME_LENGTH) {
            normalized = normalized.substring(0, MAX_PLAYER_NAME_LENGTH);
        }
        return normalized;
    }

    function readDisplayName() {
        var displayName;
        var count;
        var index;
        var child;
        if (!isValidPanel(selfNamePanel)) {
            selfNamePanel = findPanel("SelfName");
        }
        displayName = normalizeDisplayName(textOf(selfNamePanel));
        if (displayName) {
            return displayName;
        }
        try {
            count = Math.min(selfNamePanel.GetChildCount(), 8);
        } catch (error) {
            return "";
        }
        for (index = 0; index < count; index += 1) {
            try {
                child = selfNamePanel.GetChild(index);
            } catch (error2) {
                return "";
            }
            displayName = normalizeDisplayName(textOf(child));
            if (displayName) {
                return displayName;
            }
        }
        return "";
    }

    function renderViewedName() {
        var displayName = readDisplayName() || "PLAYER";
        if (displayName === currentDisplayName) {
            return;
        }
        currentDisplayName = displayName;
        setText(titleLabel, displayName + " DUO STATS");
    }

    function openStatLockerProfile() {
        var identity;
        var url;
        if (!isCustomActive()) {
            return;
        }
        identity = readIdentity();
        if (identity.state !== "valid" || !identity.account) {
            return;
        }
        url = STATLOCKER_PROFILE_URL_PREFIX + encodeURIComponent(identity.account) + STATLOCKER_PROFILE_URL_SUFFIX;
        try {
            if (isCallable($.DispatchEvent)) {
                $.DispatchEvent("ExternalBrowserGoToURL", url);
            }
        } catch (error) {
            return;
        }
    }

    function readRootAuthority(name) {
        var value;
        if (!isValidPanel(root)) {
            return "";
        }
        try {
            if (isCallable(root.GetAttributeString)) {
                value = root.GetAttributeString(name, "");
                return value === null || value === undefined ? "" : String(value);
            }
        } catch (error) {
            return "";
        }
        try {
            if (root[name] !== undefined && root[name] !== null) {
                return String(root[name]);
            }
        } catch (error2) {
            return "";
        }
        return "";
    }

    function readIdentity() {
        var witness;
        var authorityNames = AUTHORITY_NAMES;
        var corroborators = [];
        var index;
        var identity;
        if (!isValidPanel(accountWitness)) {
            accountWitness = findPanel("ProfileStatsDuoAccount");
        }
        witness = accountWitness;
        for (index = 0; index < authorityNames.length; index += 1) {
            corroborators.push({
                value: readRootAuthority(authorityNames[index]),
                format: authorityNames[index] === "steamid" ? "identity" : "account"
            });
        }
        identity = viewedProfileIdentityPolicy.resolve({
            value: textOf(witness),
            format: "account"
        }, corroborators);
        if (identity.state === "missing") {
            return {
                state: "missing",
                account: "",
                message: "The viewed profile account is unavailable."
            };
        }
        if (identity.state !== "valid") {
            return {
                state: "mismatch",
                account: identity.account,
                message: "The viewed profile account witness does not match the profile root."
            };
        }
        return {
            state: "valid",
            account: identity.account,
            message: ""
        };
    }

    function payloadAccountMatches(value, accountText) {
        return viewedProfileIdentityPolicy.payloadMatches(value, accountText);
    }

    function sameIdentity(left, right) {
        return viewedProfileIdentityPolicy.same(left, right);
    }

    function openSupporterTicker() {
        if (!isCustomActive() || !isValidPanel(supporterTicker) || !isCallable(supporterTicker.SetURL)) {
            return;
        }
        try {
            supporterTicker.SetURL(SUPPORTER_TICKER_URL);
        } catch (error) {
            return;
        }
        setVisibleProperty(supporterTicker, true);
        setVisibility(supporterTicker, true);
    }

    function closeSupporterTicker() {
        if (!isValidPanel(supporterTicker)) {
            return;
        }
        try {
            if (isCallable(supporterTicker.SetURL)) {
                supporterTicker.SetURL("about:blank");
            }
        } catch (error) {
            setVisibleProperty(supporterTicker, false);
            setVisibility(supporterTicker, false);
            return;
        }
        setVisibleProperty(supporterTicker, false);
        setVisibility(supporterTicker, false);
    }

    function isAscii(value) {
        var index;
        var code;
        for (index = 0; index < value.length; index += 1) {
            code = value.charCodeAt(index);
            if (code < 32 || code > 126) {
                return false;
            }
        }
        return true;
    }

    function finiteNumber(value) {
        return typeof value === "number" && isFinite(value);
    }

    function isArray(value) {
        return Object.prototype.toString.call(value) === "[object Array]";
    }

    function hasOwn(object, key) {
        return Object.prototype.hasOwnProperty.call(object, key);
    }

    function exactKeys(object, required, optional) {
        var allowed = {};
        var keys;
        var index;
        var key;
        if (!object || typeof object !== "object" || isArray(object)) {
            return false;
        }
        optional = optional || [];
        for (index = 0; index < required.length; index += 1) {
            allowed[required[index]] = true;
        }
        for (index = 0; index < optional.length; index += 1) {
            allowed[optional[index]] = true;
        }
        keys = Object.keys(object);
        for (index = 0; index < keys.length; index += 1) {
            key = keys[index];
            if (!hasOwn(allowed, key)) {
                return false;
            }
        }
        for (index = 0; index < required.length; index += 1) {
            if (!hasOwn(object, required[index])) {
                return false;
            }
        }
        return true;
    }

    function validThreshold(value) {
        return finiteNumber(value) && Math.floor(value) === value && hasOwn(MIN_MATCHES_OPTIONS, String(value));
    }

    function validAccountId(value) {
        return finiteNumber(value) && Math.floor(value) === value && value > 0 && value <= 4294967295;
    }

    function validPlayerName(value) {
        return typeof value === "string" && value.length > 0 && value.length <= MAX_NAME_LENGTH && isAscii(value);
    }

    function validMates(mates, account, threshold) {
        var index;
        var seen = {};
        var previous = Infinity;
        if (!isArray(mates) || mates.length === 0 || mates.length > ROW_COUNT) {
            return false;
        }
        for (index = 0; index < mates.length; index += 1) {
            if (!exactKeys(mates[index], ["account", "name", "matches", "wins"])) {
                return false;
            }
            if (!validAccountId(mates[index].account) || mates[index].account === account) {
                return false;
            }
            if (seen[mates[index].account]) {
                return false;
            }
            seen[mates[index].account] = true;
            if (!validPlayerName(mates[index].name)) {
                return false;
            }
            if (!finiteNumber(mates[index].matches) || Math.floor(mates[index].matches) !== mates[index].matches || mates[index].matches < threshold) {
                return false;
            }
            if (!finiteNumber(mates[index].wins) || Math.floor(mates[index].wins) !== mates[index].wins || mates[index].wins < 0 || mates[index].wins > mates[index].matches) {
                return false;
            }
            if (mates[index].matches > previous) {
                return false;
            }
            previous = mates[index].matches;
        }
        return true;
    }

    function validateIdentityFields(payload, request) {
        if (!payload || typeof payload !== "object") {
            return "invalid";
        }
        if (payload.request !== request.nonce) {
            return "stale";
        }
        if (!payloadAccountMatches(payload.account, request.account) || payload.threshold !== request.minMatches) {
            return "invalid";
        }
        return "ok";
    }

    function validateSuccessPayload(payload, request) {
        var identityResult = validateIdentityFields(payload, request);
        if (identityResult !== "ok") {
            return identityResult;
        }
        if (!exactKeys(payload, ["v", "kind", "request", "account", "threshold", "mates", "droppedMates", "note", "generated"])) {
            return "invalid";
        }
        if (payload.v !== BRIDGE_PROTOCOL || payload.kind !== "duo_mates" || typeof payload.request !== "string" || !validAccountId(payload.account)) {
            return "invalid";
        }
        if (!validThreshold(payload.threshold) || !finiteNumber(payload.droppedMates) || Math.floor(payload.droppedMates) !== payload.droppedMates || payload.droppedMates < 0) {
            return "invalid";
        }
        if (typeof payload.note !== "string" || payload.note.length > 120 || (payload.note.length > 0 && !isAscii(payload.note))) {
            return "invalid";
        }
        if (typeof payload.generated !== "string" || payload.generated.length === 0 || payload.generated.length > MAX_GENERATED_LENGTH || !isAscii(payload.generated)) {
            return "invalid";
        }
        return validMates(payload.mates, payload.account, payload.threshold) ? "ok" : "invalid";
    }

    function validErrorEnvelope(payload) {
        if (!exactKeys(payload, ["v", "kind", "request", "protocol", "code", "status", "message"], [])) {
            return false;
        }
        return payload.v === BRIDGE_PROTOCOL &&
            payload.kind === "error" &&
            typeof payload.request === "string" &&
            payload.protocol === BRIDGE_PROTOCOL &&
            !!ERROR_CODES[payload.code];
    }

    function validateErrorPayload(payload, request) {
        if (!payload || typeof payload !== "object") {
            return "invalid";
        }
        if (payload.request !== request.nonce) {
            return "stale";
        }
        if (!validErrorEnvelope(payload)) {
            return "invalid";
        }
        if (payload.status !== null || typeof payload.message !== "string" || payload.message.length > 160) {
            return "invalid";
        }
        return "ok";
    }

    function parseTitle(title) {
        var body;
        if (typeof title !== "string" || title.length > BRIDGE_TITLE_MAX_LENGTH || !isAscii(title)) {
            return { kind: "invalid_title" };
        }
        if (title.indexOf(BRIDGE_TITLE_PREFIX) !== 0) {
            return null;
        }
        if (title.length === BRIDGE_TITLE_PREFIX.length) {
            return { kind: "invalid_title" };
        }
        body = title.substring(BRIDGE_TITLE_PREFIX.length);
        try {
            return { kind: "payload", value: JSON.parse(body) };
        } catch (error) {
            return { kind: "invalid_title" };
        }
    }

    function createNonce() {
        nonceSerial += 1;
        return "p" + Date.now().toString(36) + nonceSerial.toString(36);
    }

    function now() {
        return Date.now();
    }

    function freshCache(account, minMatches) {
        var age;
        if (!memoryCache ||
                memoryCache.schema !== CACHE_SCHEMA ||
                memoryCache.account !== account ||
                memoryCache.minMatches !== minMatches ||
                !memoryCache.payload ||
                memoryCache.payload.v !== BRIDGE_PROTOCOL) {
            return null;
        }
        if (!validMates(memoryCache.payload.mates, memoryCache.payload.account, memoryCache.payload.threshold)) {
            return null;
        }
        age = now() - memoryCache.receivedAt;
        if (age < 0 || age >= CACHE_TTL_MS || generatedIsStale(memoryCache.payload.generated)) {
            memoryCache = null;
            return null;
        }
        return memoryCache.payload;
    }

    function formatWinRate(wins, matches) {
        if (!finiteNumber(wins) || !finiteNumber(matches) || matches <= 0) {
            return "—";
        }
        return String(Math.round((wins / matches) * 100)) + "%";
    }

    function setWinRateState(panel, wins, matches) {
        var rate = matches > 0 ? (wins / matches) * 100 : null;
        var available = rate !== null && finiteNumber(rate);
        setClass(panel, WIN_RATE_TOP_CLASS, available && rate >= 50);
        setClass(panel, WIN_RATE_BOTTOM_CLASS, available && rate < 50);
        setClass(panel, WIN_RATE_UNAVAILABLE_CLASS, !available);
    }

    function setRowVisible(refs, visible) {
        if (refs && isValidPanel(refs.row)) {
            setVisibility(refs.row, visible);
        }
    }

    function renderMatesRows(mates) {
        var index;
        var mate;
        var refs;
        for (index = 0; index < ROW_COUNT; index += 1) {
            refs = rowRefs[index];
            if (!refs) {
                continue;
            }
            if (index >= mates.length) {
                setRowVisible(refs, false);
                continue;
            }
            mate = mates[index];
            setRowVisible(refs, true);
            setText(refs.name, mate.name);
            setText(refs.games, String(mate.matches));
            setText(refs.wins, String(mate.wins));
            setText(refs.winRate, formatWinRate(mate.wins, mate.matches));
            setWinRateState(refs.winRate, mate.wins, mate.matches);
        }
    }

    function setBridgeVisible(visible) {
        setVisibleProperty(bridgePanel, visible);
        if (!visible) {
            setStyle(bridgePanel, "visibility", "collapse");
        } else {
            setStyle(bridgePanel, "visibility", "visible");
        }
    }

    function unloadBridge() {
        if (!isValidPanel(bridgePanel)) {
            return;
        }
        try {
            if (isCallable(bridgePanel.SetURL)) {
                bridgePanel.SetURL("about:blank");
            }
        } catch (error) {
            /* A racing HTML panel is already on the unload path. */
        }
        setBridgeVisible(false);
    }

    function setRetryVisible(visible) {
        if (isValidPanel(retryButton)) {
            setVisibility(retryButton, visible);
        }
    }

    function setRowsVisible(visible) {
        setVisibility(rowsPanel, visible);
        setVisibility(metadataPanel, visible);
    }

    function renderLoading() {
        setText(statusLabel, "Loading duo stats for teammates with " + String(selectedMinMatches) + "+ shared games...");
        setRowsVisible(false);
        setRetryVisible(false);
    }

    function renderIdentityError(identity) {
        setRowsVisible(false);
        setRetryVisible(true);
        setText(statusLabel, identity && identity.message ? identity.message : "The viewed profile account is unavailable.");
    }

    function renderLocalError(code, status, retryVisible, retryAfter) {
        var message = ERROR_TEXT[code] || ERROR_TEXT.invalid_payload;
        if (status) {
            message += " (HTTP " + String(status) + ").";
        }
        if (finiteNumber(retryAfter) && retryAfter > 0) {
            message += " Retry after " + String(Math.ceil(retryAfter)) + " seconds.";
        }
        setRowsVisible(false);
        setRetryVisible(retryVisible !== false);
        setText(statusLabel, message);
    }

    function generatedIsStale(value) {
        var timestamp;
        try {
            timestamp = Date.parse(value);
        } catch (error) {
            return false;
        }
        return finiteNumber(timestamp) && now() - timestamp >= CACHE_TTL_MS;
    }

    function renderSuccess(payload) {
        var shown = payload.mates.length;
        var extra = payload.droppedMates > 0 ? " (+" + String(payload.droppedMates) + " more)" : "";
        var sampleText = "Repeat teammates (" + String(payload.threshold) + "+ games): " + String(shown) + " shown" + extra;
        var stale = generatedIsStale(payload.generated);
        var generatedText = "Generated: " + String(payload.generated) + (stale ? " (stale)" : "");
        renderMatesRows(payload.mates);
        setText(sampleLabel, sampleText);
        setText(generatedLabel, generatedText);
        setRowsVisible(true);
        setRetryVisible(stale);
        setText(statusLabel, stale ? "Showing cached duo data. Retry for current values." : "Duo stats loaded.");
    }

    function cancelBridgeAssignment() {
        var handle = bridgeAssignmentHandle;
        bridgeAssignmentHandle = null;
        if (handle !== null && handle !== undefined && isCallable($.CancelScheduled)) {
            try {
                $.CancelScheduled(handle);
            } catch (error) {
                return;
            }
        }
    }

    function invalidateRequest(unload) {
        cancelBridgeAssignment();
        requestState = null;
        requestGeneration += 1;
        if (unload !== false) {
            unloadBridge();
        }
    }

    function renderBridgeError(payload) {
        enterState(STATE_ERROR);
        rateLimitBlocked = false;
        renderLocalError(payload.code, payload.status, true, 0);
    }

    function finishError(code, status) {
        invalidateRequest(true);
        rateLimitBlocked = false;
        enterState(STATE_ERROR);
        renderLocalError(code, status, true, 0);
    }

    function finishSuccess(payload, request) {
        if (generatedIsStale(payload.generated)) {
            memoryCache = null;
        } else {
            memoryCache = {
                schema: CACHE_SCHEMA,
                account: request.account,
                minMatches: request.minMatches,
                receivedAt: now(),
                payload: payload
            };
        }
        invalidateRequest(true);
        rateLimitBlocked = false;
        enterState(STATE_READY);
        renderSuccess(payload);
    }

    function bridgeUrl(request) {
        return BRIDGE_URL + "?account_id=" + encodeURIComponent(request.account) + "&threshold=" + String(request.minMatches) + "&request=" + encodeURIComponent(request.nonce) + "&protocol=" + String(BRIDGE_PROTOCOL);
    }

    function expectedBridgeUrl(url, request) {
        var boundary;
        if (typeof url !== "string" || !request) {
            return false;
        }
        if (url.indexOf(BRIDGE_ORIGIN_PATH) !== 0) {
            return false;
        }
        boundary = url.charAt(BRIDGE_ORIGIN_PATH.length);
        return boundary === "" || boundary === "?" || boundary === "#";
    }

    function bridgeFragment(url) {
        var hashIndex;
        var fragment;
        if (typeof url !== "string" || url.length > BRIDGE_URL_MAX_LENGTH) {
            return null;
        }
        hashIndex = url.indexOf("#");
        if (hashIndex < 0) {
            return "";
        }
        fragment = url.substring(hashIndex + 1);
        if (fragment.length === 0 || fragment.length > BRIDGE_FRAGMENT_MAX_LENGTH || fragment.indexOf("#") !== -1) {
            return null;
        }
        return fragment;
    }

    function eventString(value) {
        if (typeof value === "string") {
            return value;
        }
        if (value && typeof value.url === "string") {
            return value.url;
        }
        if (value && typeof value.title === "string") {
            return value.title;
        }
        return "";
    }

    function onBridgeUrlChanged(panelOrValue, eventValue) {
        var url = eventString(arguments.length > 1 ? eventValue : panelOrValue);
        var fragment;
        var decodedTitle;
        if (lifecycleState !== STATE_LOADING || !requestState || requestState.generation !== requestGeneration) {
            return;
        }
        if (url === "about:blank") {
            return;
        }
        if (!expectedBridgeUrl(url, requestState)) {
            finishError("network_error", null);
            return;
        }
        fragment = bridgeFragment(url);
        if (fragment === "") {
            return;
        }
        if (fragment === null) {
            return;
        }
        try {
            decodedTitle = decodeURIComponent(fragment);
        } catch (error) {
            return;
        }
        if (typeof decodedTitle !== "string" || decodedTitle.length > BRIDGE_TITLE_MAX_LENGTH) {
            return;
        }
        if (decodedTitle.indexOf(BRIDGE_TITLE_PREFIX) !== 0) {
            return;
        }
        onBridgeTitle(decodedTitle);
    }

    function onBridgeTitle(panelOrValue, eventValue) {
        var parsed;
        var successResult;
        var errorResult;
        var request;
        var value = arguments.length > 1 ? eventValue : panelOrValue;
        if (lifecycleState !== STATE_LOADING || !requestState || requestState.generation !== requestGeneration) {
            return;
        }
        request = requestState;
        if (typeof value !== "string") {
            return;
        }
        if (request.lastTitle === value) {
            return;
        }
        request.lastTitle = value;
        parsed = parseTitle(value);
        if (!parsed) {
            return;
        }
        if (parsed.kind === "invalid_title") {
            finishError("invalid_payload", null);
            return;
        }
        if (!parsed.value || typeof parsed.value !== "object") {
            finishError("invalid_payload", null);
            return;
        }
        if (parsed.value.kind === "duo_mates") {
            successResult = validateSuccessPayload(parsed.value, request);
            if (successResult === "stale") {
                return;
            }
            if (successResult !== "ok") {
                finishError("invalid_payload", null);
                return;
            }
            finishSuccess(parsed.value, request);
            return;
        }
        if (parsed.value.kind === "error") {
            errorResult = validateErrorPayload(parsed.value, request);
            if (errorResult === "stale") {
                return;
            }
            if (errorResult !== "ok") {
                finishError("invalid_payload", null);
                return;
            }
            renderBridgeError(parsed.value);
            invalidateRequest(true);
            return;
        }
        finishError("invalid_payload", null);
    }

    function registerBridgeEvents() {
        registerPanelEvent(bridgePanel, "HTMLTitle", onBridgeTitle);
        registerPanelEvent(bridgePanel, "HTMLURLChanged", onBridgeUrlChanged);
    }

    function assignBridgeUrl(request) {
        if (requestState !== request || request.generation !== requestGeneration || !isCustomActive()) {
            return;
        }
        if (!runtimePanelsValid()) {
            disableRuntime("panel_invalid");
            return;
        }
        try {
            if (isCallable(bridgePanel.SetIgnoreCursor)) {
                bridgePanel.SetIgnoreCursor(true);
            }
            if (!isCallable(bridgePanel.SetURL)) {
                throw new Error("SetURL unavailable");
            }
            bridgePanel.SetURL(bridgeUrl(request));
        } catch (error) {
            finishError("network_error", null);
        }
    }

    function scheduleBridgeAssignment(request) {
        var generation = request.generation;
        cancelBridgeAssignment();
        try {
            bridgeAssignmentHandle = $.Schedule(BRIDGE_ASSIGN_DELAY_SECONDS, function () {
                if (requestState !== request || generation !== requestGeneration) {
                    return;
                }
                bridgeAssignmentHandle = null;
                inspectNativeHeroSignature();
                if (!isCustomActive()) {
                    return;
                }
                inspectStockSelection();
                if (!isCustomActive()) {
                    return;
                }
                assignBridgeUrl(request);
            });
        } catch (error) {
            bridgeAssignmentHandle = null;
            finishError("network_error", null);
        }
    }

    function beginRequest(deferBridgeAssignment) {
        var identity = readIdentity();
        var request;
        var cached;
        var remaining;
        if (!isCustomActive()) {
            return;
        }
        currentIdentity = identity;
        if (identity.state !== "valid") {
            invalidateRequest(true);
            rateLimitBlocked = false;
            enterState(STATE_ERROR);
            renderIdentityError(identity);
            return;
        }
        cached = freshCache(identity.account, selectedMinMatches);
        if (cached) {
            invalidateRequest(true);
            rateLimitBlocked = false;
            enterState(STATE_READY);
            renderSuccess(cached);
            return;
        }
        remaining = rateLimitUntil - now();
        if (remaining > 0) {
            invalidateRequest(true);
            rateLimitBlocked = true;
            enterState(STATE_ERROR);
            renderLocalError("rate_limit", 429, false, remaining / 1000);
            return;
        }
        rateLimitUntil = 0;
        rateLimitBlocked = false;
        invalidateRequest(true);
        request = {
            generation: requestGeneration,
            nonce: createNonce(),
            account: identity.account,
            minMatches: selectedMinMatches,
            startedAt: now(),
            lastTitle: ""
        };
        requestState = request;
        enterState(STATE_LOADING);
        setBridgeVisible(true);
        if (deferBridgeAssignment) {
            scheduleBridgeAssignment(request);
        } else {
            assignBridgeUrl(request);
        }
    }

    function hasSelectionEvidence(panel) {
        try {
            if (isCallable(panel.BHasKeyFocus) && panel.BHasKeyFocus()) {
                return true;
            }
        } catch (error) {
            /* Try descendant focus and native selection signals. */
        }
        try {
            if (isCallable(panel.BHasDescendantKeyFocus) && panel.BHasDescendantKeyFocus()) {
                return true;
            }
        } catch (error2) {
            /* Try native selection signals. */
        }
        try {
            if (isCallable(panel.IsSelected) && panel.IsSelected()) {
                return true;
            }
        } catch (error3) {
            /* Try the direct class signal. */
        }
        try {
            if (isCallable(panel.BHasClass) && (panel.BHasClass("selected") || panel.BHasClass("Selected"))) {
                return true;
            }
        } catch (error4) {
            /* A replaced row has no usable selection signal. */
        }
        return false;
    }

    function readSelectedHeroSignature() {
        var childCount;
        var index;
        var row;
        var isHeroRow;
        var rowId;
        if (!isValidPanel(heroList)) {
            return "";
        }
        try {
            childCount = Math.min(heroList.GetChildCount(), MAX_HERO_ROWS);
        } catch (error) {
            return "";
        }
        for (index = 0; index < childCount; index += 1) {
            try {
                row = heroList.GetChild(index);
            } catch (error2) {
                return "";
            }
            if (!isValidPanel(row)) {
                continue;
            }
            isHeroRow = false;
            try {
                isHeroRow = isCallable(row.BHasClass) && row.BHasClass("heroRow");
            } catch (error3) {
                isHeroRow = false;
            }
            if (isHeroRow && hasSelectionEvidence(row)) {
                rowId = "";
                try {
                    if (row.id !== undefined && row.id !== null) {
                        rowId = String(row.id);
                    }
                } catch (error4) {
                    rowId = "";
                }
                return String(index) + ":" + rowId;
            }
        }
        return "";
    }

    function inspectStockSelection() {
        var signature;
        if (!isCustomActive()) {
            return;
        }
        signature = readSelectedHeroSignature();
        if (signature !== stockRowSignature) {
            restoreStock("stock_selection");
        }
    }

    function inspectNativeHeroSignature() {
        var signature;
        if (!isValidPanel(stockSectionName)) {
            stockSectionName = findDirectChildByClass(stockTitle, "statSectionName");
        }
        if (!isValidPanel(stockSectionName)) {
            return;
        }
        signature = textOf(stockSectionName);
        if (signature !== stockSectionSignature) {
            restoreStock("native_selection");
        }
    }

    function checkIdentity() {
        var nextIdentity = readIdentity();
        if (sameIdentity(currentIdentity, nextIdentity)) {
            return;
        }
        currentIdentity = nextIdentity;
        if (isCustomActive()) {
            restoreStock("profile_change");
        }
    }

    function runtimePanelsValid() {
        return isValidPanel(root) &&
            isValidPanel(heroList) &&
            isValidPanel(stockTitle) &&
            isValidPanel(customPanel) &&
            isValidPanel(selfNamePanel) &&
            isValidPanel(titleLabel) &&
            isValidPanel(statLockerButton) &&
            isValidPanel(bridgePanel);
    }

    function stopWatcher() {
        var handle = watcherHandle;
        watcherGeneration += 1;
        watcherHandle = null;
        watcherPending = false;
        watcherCallback = null;
        if (handle !== null && handle !== undefined && isCallable($.CancelScheduled)) {
            try {
                $.CancelScheduled(handle);
            } catch (error) {
                return;
            }
        }
    }

    function disableRuntime(reason) {
        enterState(STATE_DISABLED);
        stopWatcher();
        invalidateRequest(true);
        closeSupporterTicker();
        setVisibility(customPanel, false);
        setRetryVisible(false);
    }

    function updateRateLimit() {
        if (!rateLimitBlocked || now() < rateLimitUntil) {
            return;
        }
        rateLimitBlocked = false;
        rateLimitUntil = 0;
        if (lifecycleState === STATE_ERROR) {
            setRetryVisible(true);
            setText(statusLabel, "The duo service is ready for another request.");
        }
    }

    function scheduledCheck() {
        var elapsed;
        if (!isCustomActive()) {
            return;
        }
        if (!runtimePanelsValid()) {
            disableRuntime("panel_invalid");
            return;
        }
        checkIdentity();
        if (!isCustomActive()) {
            return;
        }
        renderViewedName();
        inspectNativeHeroSignature();
        if (!isCustomActive()) {
            return;
        }
        inspectStockSelection();
        if (!isCustomActive()) {
            return;
        }
        updateRateLimit();
        if (requestState && requestState.generation === requestGeneration) {
            elapsed = (now() - requestState.startedAt) / 1000;
            if (elapsed >= REQUEST_TIMEOUT_SECONDS) {
                finishError("network_error", null);
            }
        }
    }

    function startWatcher() {
        var token;
        function armWatcher() {
            if (token !== watcherGeneration || !isCustomActive() || watcherPending) {
                return;
            }
            watcherPending = true;
            try {
                watcherHandle = $.Schedule(CONTEXT_CHECK_SECONDS, watcherCallback);
            } catch (error) {
                watcherPending = false;
                watcherHandle = null;
                watcherCallback = null;
                disableRuntime("schedule_failed");
            }
        }
        if (!isCustomActive() || watcherPending || watcherCallback) {
            return;
        }
        watcherGeneration += 1;
        token = watcherGeneration;
        watcherCallback = function () {
            if (token !== watcherGeneration) {
                return;
            }
            watcherPending = false;
            watcherHandle = null;
            if (!isCustomActive()) {
                return;
            }
            scheduledCheck();
            armWatcher();
        };
        armWatcher();
    }

    function restoreStock(reason) {
        if (lifecycleState === STATE_DISABLED) {
            return;
        }
        enterState(STATE_STOCK);
        stockRowSignature = "";
        stopWatcher();
        invalidateRequest(true);
        closeSupporterTicker();
        setVisibility(customPanel, false);
        setRetryVisible(false);
        if (reason === "profile_change" || reason === "stock_selection" || reason === "page_leave" || reason === "native_selection") {
            setText(statusLabel, "");
        }
    }

    function showCustomMode() {
        if (lifecycleState === STATE_DISABLED || isCustomActive()) {
            return;
        }
        currentIdentity = readIdentity();
        enterState(STATE_LOADING);
        stockSectionSignature = textOf(stockSectionName);
        stockRowSignature = readSelectedHeroSignature();
        setVisibility(customPanel, true);
        openSupporterTicker();
        currentDisplayName = "";
        renderViewedName();
        beginRequest();
        startWatcher();
    }

    function readMinMatchesSelection() {
        var option;
        var value = "";
        if (!isValidPanel(minMatchesDropdown) || !isCallable(minMatchesDropdown.GetSelected)) {
            return selectedMinMatches;
        }
        try {
            option = minMatchesDropdown.GetSelected();
        } catch (error) {
            return selectedMinMatches;
        }
        if (!isValidPanel(option)) {
            return selectedMinMatches;
        }
        if (option.id === "ProfileStatsDuoMinMatches2") {
            return 2;
        }
        if (option.id === "ProfileStatsDuoMinMatches3") {
            return 3;
        }
        if (option.id === "ProfileStatsDuoMinMatches5") {
            return 5;
        }
        if (option.id === "ProfileStatsDuoMinMatches10") {
            return 10;
        }
        try {
            if (isCallable(option.GetAttributeString)) {
                value = option.GetAttributeString("value", "");
            }
        } catch (error2) {
            value = "";
        }
        return hasOwn(MIN_MATCHES_OPTIONS, value) ? Number(value) : selectedMinMatches;
    }

    function onMinMatchesChanged() {
        var nextMinMatches = readMinMatchesSelection();
        if (nextMinMatches === selectedMinMatches) {
            return;
        }
        selectedMinMatches = nextMinMatches;
        beginRequest(true);
    }

    function onRetry() {
        if (!isCustomActive() || rateLimitBlocked) {
            return;
        }
        beginRequest();
    }

    function collectRowRefs() {
        var index;
        rowRefs = [];
        for (index = 0; index < ROW_COUNT; index += 1) {
            rowRefs.push({
                row: findPanel("ProfileStatsDuoRow" + String(index)),
                name: findPanel("ProfileStatsDuoName" + String(index)),
                games: findPanel("ProfileStatsDuoGames" + String(index)),
                wins: findPanel("ProfileStatsDuoWins" + String(index)),
                winRate: findPanel("ProfileStatsDuoWinRate" + String(index))
            });
        }
    }

    function collectPanels() {
        root = $.GetContextPanel();
        if (!isValidPanel(root)) {
            return false;
        }
        heroList = findPanel("HeroList");
        statsBlock = findPanel("StatsBlock");
        stockTitle = findPanel("StatsTitle");
        stockLeft = findPanel("StatsLeft");
        stockRight = findPanel("StatsRight");
        stockSectionName = findDirectChildByClass(stockTitle, "statSectionName");
        duoButton = findPanel("ProfileStatsDuoButton");
        customPanel = findPanel("ProfileStatsDuoPanel");
        selfNamePanel = findPanel("SelfName");
        titleLabel = findPanel("ProfileStatsDuoTitle");
        statLockerButton = findPanel("ProfileStatsDuoStatLocker");
        accountWitness = findPanel("ProfileStatsDuoAccount");
        minMatchesDropdown = findPanel("ProfileStatsDuoMinMatches");
        statusLabel = findPanel("ProfileStatsDuoStatus");
        rowsPanel = findPanel("ProfileStatsDuoRows");
        metadataPanel = findPanel("ProfileStatsDuoMetadata");
        sampleLabel = findPanel("ProfileStatsDuoSample");
        generatedLabel = findPanel("ProfileStatsDuoGenerated");
        retryButton = findPanel("ProfileStatsDuoRetry");
        bridgePanel = findPanel("ProfileStatsDuoBridge");
        supporterTicker = findPanel("ProfileStatsDuoSupporterTicker");
        stockSectionSignature = textOf(stockSectionName);
        collectRowRefs();
        return !!(heroList && statsBlock && stockTitle && stockLeft && stockRight && duoButton && customPanel && selfNamePanel && titleLabel && statLockerButton && bridgePanel && supporterTicker && minMatchesDropdown);
    }

    function bindEvents() {
        setPanelEvent(duoButton, "onactivate", showCustomMode);
        setPanelEvent(statLockerButton, "onactivate", openStatLockerProfile);
        setPanelEvent(minMatchesDropdown, "oninputsubmit", onMinMatchesChanged);
        setPanelEvent(retryButton, "onactivate", onRetry);
        registerBridgeEvents();
    }

    function boot() {
        if (initialized) {
            return;
        }
        if (!collectPanels()) {
            return;
        }
        initialized = true;
        currentIdentity = readIdentity();
        renderViewedName();
        unloadBridge();
        closeSupporterTicker();
        setVisibility(customPanel, false);
        bindEvents();
    }

    try {
        $.Schedule(0.01, boot);
    } catch (error) {
        boot();
    }
})();
