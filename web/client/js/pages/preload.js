/* =============================================================================
   preload.js — Fetches last known state from CouchDB on page load
   Include this in every page AFTER common.js and BEFORE the page-specific JS
   Populates all UI elements with historical data so the page is never blank
============================================================================= */

const PRELOAD_SERVER = window.location.origin;

// ── Safe DOM setter ───────────────────────────────────────────────────────
function _set(id, val) {
    const el = document.getElementById(id);
    if (el && val != null) el.textContent = val;
}

function _fmt4(v) { return v != null ? (+v).toFixed(4) + ' g' : '—'; }
function _fmt2(v) { return v != null ? (+v).toFixed(2) + 'g'  : '—'; }
function _fmtInt(v) { return v != null ? String(v) : '—'; }

// ── 1. Pre-populate sensor readings (Northern Central + operator raw values)
async function preloadSensorReadings() {
    try {
        const res  = await fetch(`${PRELOAD_SERVER}/api/latest/sensor`);
        const data = await res.json(); // { left: {...}, right: {...} }

        const sides = { left: data.left, right: data.right };

        for (const [side, d] of Object.entries(sides)) {
            if (!d) continue;

            // Northern Central panel (index.html)
            if (side === 'left') {
                const vert = Math.abs(d.z ?? 0);
                const lat  = Math.sqrt((d.x??0)**2 + (d.y??0)**2);
                _set('ablVert', vert.toFixed(4) + ' g');
                _set('ablLat',  lat.toFixed(4)  + ' g');
            }
            if (side === 'right') {
                const vert = Math.abs(d.z ?? 0);
                const lat  = Math.sqrt((d.x??0)**2 + (d.y??0)**2);
                _set('abrVert', vert.toFixed(4) + ' g');
                _set('abrLat',  lat.toFixed(4)  + ' g');
            }

            // Operator dashboard raw values
            const pfx = side === 'left' ? 'accel1' : 'accel2';
            _set(pfx + 'X',      _fmt4(d.x));
            _set(pfx + 'Y',      _fmt4(d.y));
            _set(pfx + 'Z',      _fmt4(d.z));
            _set(pfx + 'Peak',   _fmt4(d.peak ?? d.gForce));
            _set(pfx + 'RmsV',   _fmt4(d.rmsV));
            _set(pfx + 'RmsL',   _fmt4(d.rmsL));
            _set(pfx + 'SdV',    _fmt4(d.sdV));
            _set(pfx + 'SdL',    _fmt4(d.sdL));
            _set(pfx + 'P2pV',   _fmt4(d.p2pV));
            _set(pfx + 'P2pL',   _fmt4(d.p2pL));
            _set(pfx + 'Fs',     _fmtInt(d.fs));
            _set(pfx + 'Window', _fmtInt(d.window));

            // Graphs page legend values
            const gpfx = side === 'left' ? 'raw1' : 'raw2';
            _set(gpfx + 'X', _fmt4(d.x));
            _set(gpfx + 'Y', _fmt4(d.y));
            _set(gpfx + 'Z', _fmt4(d.z));
        }

        console.log('[preload] Sensor readings populated from DB');
    } catch (e) {
        console.warn('[preload] Sensor readings fetch failed:', e.message);
    }
}

// ── 2. Pre-populate impact stats (operator dashboard metric cards) ─────────
async function preloadStats() {
    try {
        const res   = await fetch(`${PRELOAD_SERVER}/api/impacts/stats`);
        const stats = await res.json();

        _set('impactsToday', stats.total        ?? 0);
        _set('highSeverity', stats.highSeverity ?? 0);
        _set('maxPeak',      stats.maxPeak != null ? (+stats.maxPeak).toFixed(2) + 'g' : '—');

        // Last peak + p-class badge
        if (stats.lastPeak > 0) {
            _set('lastPeak', (+stats.lastPeak).toFixed(2) + 'g');
            const badge = document.getElementById('lastPeakClass');
            if (badge) {
                badge.textContent = stats.lastPeakClass || '—';
                const STYLE = {
                    'P1': { bg: '#fef3c7', color: '#92400e' },
                    'P2': { bg: '#fee2e2', color: '#b91c1c' },
                    'P3': { bg: '#4c0519', color: '#fecdd3' },
                    '—':  { bg: '#f1f5f9', color: '#64748b' }
                };
                const s = STYLE[stats.lastPeakClass] || STYLE['—'];
                badge.style.background = s.bg;
                badge.style.color      = s.color;
            }
        }

        // Distance
        const distM = stats.totalDistanceM ?? 0;
        _set('totalDistance', distM + ' m');
        _set('distanceKm',    (distM / 1000).toFixed(3) + ' km');

        console.log('[preload] Stats populated from DB:', stats);
    } catch (e) {
        console.warn('[preload] Stats fetch failed:', e.message);
    }
}

// ── 3. Pre-populate recent alerts ─────────────────────────────────────────
async function preloadAlerts() {
    try {
        const res     = await fetch(`${PRELOAD_SERVER}/api/impacts`);
        const impacts = await res.json();
        if (!impacts.length) return;

        const container = document.querySelector('.alerts-mini-list');
        if (!container) return;

        container.innerHTML = impacts.slice(0, 5).map(impact => {
            const cls  = (impact.severity || 'low').toLowerCase();
            const g    = impact.peak_g != null ? (+impact.peak_g).toFixed(1) + 'g' : '?g';
            const dist = impact.distance_m != null ? ` at ${impact.distance_m}m` : '';
            const side = impact.sensor ? ` (${impact.sensor})` : '';
            return `<div class="alert-mini-item ${cls}">
                        <span class="alert-dot"></span>
                        <span class="alert-text">${g}${dist}${side}</span>
                    </div>`;
        }).join('');

        console.log('[preload] Alerts populated from DB');
    } catch (e) {
        console.warn('[preload] Alerts fetch failed:', e.message);
    }
}

// ── 4. Pre-populate graphs (distance chart + raw subplots) ─────────────────
// This function is called by graphs.js after charts are initialized
// Exposed as window.preloadGraphHistory so graphs.js can call it
window.preloadGraphHistory = async function(distChart, subplotsObj, rollFn, pushSubFn, advFn, fmtLabelFn) {
    try {
        const res  = await fetch(`${PRELOAD_SERVER}/api/history/sensor?limit=200`);
        const data = await res.json();
        if (!data.length) return;

        console.log('[preload] Graph history: ' + data.length + ' points');

        // Separate left and right
        const left  = data.filter(d => d.sensor === 'left');
        const right = data.filter(d => d.sensor === 'right');

        // Pre-fill distance chart (left drives labels, right fills ds 2&3)
        // Use last DIST_N points from left
        const slice = left.slice(-100);
        slice.forEach((pt, i) => {
            const x    = pt.x ?? 0;
            const y    = pt.y ?? 0;
            const z    = pt.z ?? 0;
            const vert = Math.abs(z);
            const lat  = Math.sqrt(x*x + y*y);
            const lbl  = new Date(pt.timestamp).toLocaleTimeString();

            distChart.data.labels[i]                = lbl;
            distChart.data.datasets[0].data[i]      = vert;  // AB-L-VERT
            distChart.data.datasets[1].data[i]      = lat;   // AB-L-LAT
        });

        // Fill right channels from right history
        const rslice = right.slice(-100);
        rslice.forEach((pt, i) => {
            const x    = pt.x ?? 0;
            const y    = pt.y ?? 0;
            const z    = pt.z ?? 0;
            distChart.data.datasets[2].data[i] = Math.abs(z);          // AB-R-VERT
            distChart.data.datasets[3].data[i] = Math.sqrt(x*x + y*y); // AB-R-LAT
        });

        distChart.update('none');

        // Pre-fill raw subplots — last RAW_N points per side
        const fillSubplot = (chart, arr, extractFn) => {
            if (!chart) return;
            const pts = arr.slice(-80);
            chart.data.datasets[0].data = Array(80 - pts.length).fill(
                extractFn(pts[0] || {})
            ).concat(pts.map(extractFn));
            chart.update('none');
        };

        if (subplotsObj) {
            fillSubplot(subplotsObj.s1.x, left,  d => d.x ?? 0);
            fillSubplot(subplotsObj.s1.y, left,  d => d.y ?? 0);
            fillSubplot(subplotsObj.s1.z, left,  d => d.z ?? 9.8);
            fillSubplot(subplotsObj.s2.x, right, d => d.x ?? 0);
            fillSubplot(subplotsObj.s2.y, right, d => d.y ?? 0);
            fillSubplot(subplotsObj.s2.z, right, d => d.z ?? 9.8);
        }

        console.log('[preload] Charts pre-filled from DB history');
    } catch (e) {
        console.warn('[preload] Graph history fetch failed:', e.message);
    }
};

// ── 5. Pre-populate health grid ───────────────────────────────────────────
window.preloadHealth = async function() {
    try {
        const res    = await fetch(`${PRELOAD_SERVER}/api/latest/health`);
        const health = await res.json();
        if (!health) return;

        // Trigger the same applyHealthUpdate function used by socket events
        if (typeof applyHealthUpdate === 'function') {
            applyHealthUpdate(health);
            console.log('[preload] Health grid populated from DB');
        }
    } catch (e) {
        console.warn('[preload] Health fetch failed:', e.message);
    }
};

// ── Run all preloads on DOM ready ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    preloadSensorReadings();
    preloadStats();
    preloadAlerts();
    // preloadHealth and preloadGraphHistory are called by their respective
    // page JS files after charts/health grid are initialized
});
