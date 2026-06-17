/* ============================================================
   common.js — Shared utilities for all datalogger  html_pages
   ============================================================ */

// localStorage key constants
const RM_THRESHOLDS_KEY  = 'railmonitor_thresholds';
const RM_LIMITS_KEY      = 'railmonitor_peak_limits';
const TEST_RUN_START_KEY = 'uabams_test_run_start';

// ── Global Test Run state (persists across page navigation) ───────────────
const TestRun = {
    isRecording() { return !!localStorage.getItem(TEST_RUN_START_KEY); },
    startTime()   { const v = localStorage.getItem(TEST_RUN_START_KEY); return v ? new Date(v) : null; },

    start() {
        localStorage.setItem(TEST_RUN_START_KEY, new Date().toISOString());
        TestRun._syncUI();
    },

    stop() {
        const t = TestRun.startTime();
        localStorage.removeItem(TEST_RUN_START_KEY);
        TestRun._syncUI();
        return t;   // caller uses this as the "from" time
    },

    _timerRef: null,

    _syncUI() {
        const bar   = document.getElementById('globalTestBar');
        if (!bar) return;
        if (TestRun.isRecording()) {
            bar.style.display = 'flex';
            clearInterval(TestRun._timerRef);
            TestRun._timerRef = setInterval(() => {
                const el = document.getElementById('globalTestTimer');
                if (!el) return;
                const s = Math.round((Date.now() - TestRun.startTime()) / 1000);
                el.textContent = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
            }, 1000);
        } else {
            bar.style.display = 'none';
            clearInterval(TestRun._timerRef);
        }
    },

    init() { TestRun._syncUI(); }
};

// Auto-init on every page load
document.addEventListener('DOMContentLoaded', () => TestRun.init());

// Default values (mirror what configuration.html saves)
const DEFAULT_THRESHOLDS = {
    p1Min: 5, p1Max: 10,
    p2Min: 10, p2Max: 20,
    p3Min: 20
};

const DEFAULT_LIMITS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50];

/** Load thresholds from localStorage, falling back to defaults on error. */
function loadStoredThresholds() {
    try {
        const saved = localStorage.getItem(RM_THRESHOLDS_KEY);
        return saved ? JSON.parse(saved) : { ...DEFAULT_THRESHOLDS };
    } catch (e) {
        console.error('Error loading thresholds:', e);
        return { ...DEFAULT_THRESHOLDS };
    }
}

/** Load peak limits from localStorage, falling back to defaults on error. */
function loadStoredLimits() {
    try {
        const saved = localStorage.getItem(RM_LIMITS_KEY);
        return saved ? JSON.parse(saved) : [...DEFAULT_LIMITS];
    } catch (e) {
        console.error('Error loading peak limits:', e);
        return [...DEFAULT_LIMITS];
    }
}

/** Persist thresholds to localStorage. */
function saveThresholds(thresholds) {
    localStorage.setItem(RM_THRESHOLDS_KEY, JSON.stringify(thresholds));
}

/** Persist peak limits to localStorage. */
function saveLimits(limits) {
    localStorage.setItem(RM_LIMITS_KEY, JSON.stringify(limits));
}

/**
 * Start a running clock that updates DOM elements every second.
 * @param {string} timeId  - element id to receive the time string
 * @param {string} [dateId] - element id to receive the date string (optional)
 * @param {'long'|'short'} [dateFormat='short']
 *   'short' → "Mar 17, 2026"
 *   'long'  → "Tuesday, March 17"
 */
function startClock(timeId, dateId, dateFormat) {
    function tick() {
        const now = new Date();
        const timeEl = document.getElementById(timeId);
        if (timeEl) timeEl.textContent = now.toLocaleTimeString('en-US', { hour12: false });

        if (dateId) {
            const dateEl = document.getElementById(dateId);
            if (dateEl) {
                const fmt = dateFormat === 'long'
                    ? { weekday: 'long', month: 'long', day: 'numeric' }
                    : { month: 'short', day: 'numeric', year: 'numeric' };
                dateEl.textContent = now.toLocaleDateString('en-US', fmt);
            }
        }
    }
    tick();
    setInterval(tick, 1000);
}
