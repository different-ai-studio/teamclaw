// Tauri MCP addEventListener monkey-patch (vanilla JS, no TypeScript)
// Tracks which elements have interactive event listeners attached via addEventListener.
// Uses callback identity (type + listener + capture) so removeEventListener with a
// non-matching handler doesn't incorrectly decrement counts.
// Idempotent: guarded by __TAURI_MCP_LISTENER_PATCH__ flag.
(function() {
    if (typeof window === 'undefined' || window.__TAURI_MCP_LISTENER_PATCH__) return;

    var INTERACTIVE_TYPES = {
        click: true, dblclick: true, mousedown: true, mouseup: true,
        pointerdown: true, pointerup: true, touchstart: true, touchend: true,
        keydown: true, keyup: true, keypress: true
    };

    var elementsWithListeners = new WeakSet();
    // WeakMap<Element, Set<string>> where key is "type|capture" + listener ref tracking
    // We use a WeakMap<Element, Map<string, Set<listener>>> to track by identity
    var listenerSets = new WeakMap();

    function captureFlag(options) {
        if (typeof options === 'boolean') return options;
        if (options && typeof options === 'object') return !!options.capture;
        return false;
    }

    function listenerKey(type, capture) {
        return type + '|' + (capture ? '1' : '0');
    }

    var origAdd = EventTarget.prototype.addEventListener;
    var origRemove = EventTarget.prototype.removeEventListener;

    EventTarget.prototype.addEventListener = function(type, listener, options) {
        if (INTERACTIVE_TYPES[type] && this instanceof Element && listener) {
            var cap = captureFlag(options);
            var key = listenerKey(type, cap);
            var map = listenerSets.get(this);
            if (!map) { map = {}; listenerSets.set(this, map); }
            if (!map[key]) map[key] = new Set();
            map[key].add(listener);
            elementsWithListeners.add(this);
        }
        return origAdd.call(this, type, listener, options);
    };

    EventTarget.prototype.removeEventListener = function(type, listener, options) {
        if (INTERACTIVE_TYPES[type] && this instanceof Element && listener) {
            var map = listenerSets.get(this);
            if (map) {
                var cap = captureFlag(options);
                var key = listenerKey(type, cap);
                var set = map[key];
                if (set) {
                    set.delete(listener);
                    if (set.size === 0) delete map[key];
                }
                // Check if any listener sets remain
                var hasAny = false;
                for (var k in map) { if (map.hasOwnProperty(k)) { hasAny = true; break; } }
                if (!hasAny) {
                    elementsWithListeners.delete(this);
                    listenerSets.delete(this);
                }
            }
        }
        return origRemove.call(this, type, listener, options);
    };

    window.__TAURI_MCP_LISTENER_PATCH__ = true;
    window.__TAURI_MCP_ELEMENTS_WITH_LISTENERS__ = elementsWithListeners;
    window.__TAURI_MCP_LOG_STATS__ = { tried: 0, ok: 0, err: 0, threw: 0, lastErr: null };

    // ---- console.* forwarder ----
    // Mirrors console output (and uncaught errors / rejections) into the
    // Rust ring buffer so the MCP `query_logs` tool can serve it back to
    // the LLM. Tolerates Tauri internals being unavailable during early
    // page load by queuing entries and flushing once invoke is reachable.
    var TARGET = (function() {
        try { return location.host + location.pathname; } catch (e) { return undefined; }
    })();
    var PENDING = [];
    var MAX_PENDING = 500;
    var flushTimer = null;

    function safeStringify(arg) {
        if (typeof arg === 'string') return arg;
        if (arg instanceof Error) return (arg.stack || (arg.name + ': ' + arg.message));
        try {
            var seen = new WeakSet();
            return JSON.stringify(arg, function(_k, v) {
                if (typeof v === 'object' && v !== null) {
                    if (seen.has(v)) return '[Circular]';
                    seen.add(v);
                }
                if (typeof v === 'bigint') return v.toString() + 'n';
                if (typeof v === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
                return v;
            });
        } catch (e) {
            try { return String(arg); } catch (_) { return '[unserializable]'; }
        }
    }

    // Matches ANSI CSI escape sequences (color codes etc). Libraries like
    // HeroUI ship colored console messages — strip them so the LLM sees
    // clean text rather than `[33m...[0m`.
    var ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
    function stripAnsi(s) { return typeof s === 'string' ? s.replace(ANSI_RE, '') : s; }

    function formatArgs(args) {
        var out = [];
        for (var i = 0; i < args.length; i++) out.push(safeStringify(args[i]));
        return stripAnsi(out.join(' '));
    }

    function getInvoke() {
        var t = window.__TAURI_INTERNALS__;
        if (t && typeof t.invoke === 'function') return t.invoke;
        var legacy = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
        return typeof legacy === 'function' ? legacy : null;
    }

    function send(level, message) {
        var invoke = getInvoke();
        var payload = { level: level, message: message, target: TARGET };
        if (!invoke) {
            if (PENDING.length < MAX_PENDING) PENDING.push(payload);
            scheduleFlush();
            return;
        }
        try {
            window.__TAURI_MCP_LOG_STATS__.tried++;
            var p = invoke('plugin:mcp|push_log', payload);
            // Attach a rejection handler so a failed invoke can't become an
            // unhandledrejection that re-triggers `send('error', ...)` and
            // recurses forever.
            if (p && typeof p.then === 'function') {
                p.then(function() { window.__TAURI_MCP_LOG_STATS__.ok++; },
                       function(e) {
                           window.__TAURI_MCP_LOG_STATS__.err++;
                           window.__TAURI_MCP_LOG_STATS__.lastErr = String(e);
                       });
            }
        } catch (e) {
            window.__TAURI_MCP_LOG_STATS__.threw++;
            window.__TAURI_MCP_LOG_STATS__.lastErr = String(e);
        }
    }

    function scheduleFlush() {
        if (flushTimer) return;
        flushTimer = setInterval(function() {
            var invoke = getInvoke();
            if (!invoke) return;
            clearInterval(flushTimer);
            flushTimer = null;
            var batch = PENDING.splice(0, PENDING.length);
            for (var i = 0; i < batch.length; i++) {
                try { invoke('plugin:mcp|push_log', batch[i]); } catch (_) {}
            }
        }, 250);
    }

    // NOTE: Passive capture of frontend invoke() traffic is NOT possible in
    // Tauri v2 — `window.__TAURI_INTERNALS__.invoke` is defined non-writable
    // and non-configurable (a deliberate security lock), so it cannot be
    // wrapped from an injected script. The manage_ipc tool therefore records
    // only the IPC it mediates itself (agent-issued invokes and emitted /
    // received events), done Rust-side in tools/manage_ipc.rs.

    // ---- dialog stubs ----
    // window.alert/confirm/prompt are synchronous and block the webview's JS
    // thread, which deadlocks every MCP tool that round-trips through JS
    // (execute_js, query_page, type_text, ...). Replace them with stubs that
    // auto-answer and record the dialog into the log buffer (target "dialog",
    // queryable via query_logs). Opt out with PluginConfig::stub_dialogs(false),
    // which sets window.__TAURI_MCP_DIALOG_STUB__ = false before this runs.
    // Per-call overrides: set window.__TAURI_MCP_DIALOG_RESPONSES__ =
    // { confirm: false, prompt: "custom" } (e.g. via execute_js) to change
    // the answers for subsequent dialogs.
    if (window.__TAURI_MCP_DIALOG_STUB__ !== false) {
        function dialogResponses() {
            var o = window.__TAURI_MCP_DIALOG_RESPONSES__;
            return (o && typeof o === 'object') ? o : {};
        }
        function recordDialog(kind, message, answer) {
            try {
                var invoke = getInvoke();
                var payload = {
                    level: 'warn',
                    message: kind + '(' + safeStringify(String(message == null ? '' : message)) + ') intercepted, auto-answered: ' + answer,
                    target: 'dialog'
                };
                if (invoke) { invoke('plugin:mcp|push_log', payload); }
                else if (PENDING.length < MAX_PENDING) { PENDING.push(payload); scheduleFlush(); }
            } catch (_) {}
        }
        window.alert = function(message) {
            recordDialog('alert', message, 'dismissed');
        };
        window.confirm = function(message) {
            var r = dialogResponses().confirm;
            // Default to false: confirm() is a consent gate, so the safe
            // unattended answer is "deny". Opt into true per-session via
            // __TAURI_MCP_DIALOG_RESPONSES__ = { confirm: true }.
            var answer = (typeof r === 'boolean') ? r : false;
            recordDialog('confirm', message, String(answer));
            return answer;
        };
        window.prompt = function(message, defaultValue) {
            var r = dialogResponses().prompt;
            var answer = (typeof r === 'string') ? r : (defaultValue == null ? '' : String(defaultValue));
            recordDialog('prompt', message, JSON.stringify(answer));
            return answer;
        };
    }

    var LEVELS = { log: 'trace', debug: 'debug', info: 'info', warn: 'warn', error: 'error' };
    Object.keys(LEVELS).forEach(function(fn) {
        if (typeof console[fn] !== 'function') return;
        var orig = console[fn].bind(console);
        console[fn] = function() {
            try { orig.apply(null, arguments); } catch (_) {}
            try { send(LEVELS[fn], formatArgs(arguments)); } catch (_) {}
        };
    });

    window.addEventListener('error', function(ev) {
        try {
            var msg = 'Uncaught: ' + (ev.error && ev.error.stack ? ev.error.stack : (ev.message || 'unknown'));
            if (ev.filename) msg += ' (' + ev.filename + ':' + ev.lineno + ':' + ev.colno + ')';
            send('error', msg);
        } catch (_) {}
    });
    window.addEventListener('unhandledrejection', function(ev) {
        try {
            var r = ev.reason;
            var msg = 'UnhandledRejection: ' + (r && r.stack ? r.stack : safeStringify(r));
            send('error', msg);
        } catch (_) {}
    });
})();
