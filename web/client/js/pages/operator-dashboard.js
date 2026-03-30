/* =============================================================================
   operator-dashboard.js
   Stats always loaded from CouchDB (/api/impacts/stats) — persists on refresh
   applyStats() updates ALL 7 stat elements by explicit ID — no positional hacks
   High-G alert: per-sensor, both shown simultaneously, auto-dismiss 1s
   Reset button: display-only reset, DB untouched
============================================================================= */

const SERVER = window.location.origin;

let isLiveStreaming  = true;
let debugMode        = false;
let sensorDataPoints = 50;
let currentDataIndex = 0;
let latestLeft       = { x: 0, y: 0, z: 0, gForce: 0 };
let latestRight      = { x: 0, y: 0, z: 0, gForce: 0 };

startClock('currentTime', 'currentDate');

// ── Helpers ───────────────────────────────────────────────────────────────
const $        = id  => document.getElementById(id);
const setText  = (id, v) => { const el = $(id); if (el) el.textContent = v; };
const fmtG     = v   => v != null ? (+v).toFixed(2) + 'g' : '—';
const fmtG4    = v   => v != null ? (+v).toFixed(4)       : '—';
const fmtInt   = v   => v != null ? v.toString()           : '—';

// ── P-class badge colours ─────────────────────────────────────────────────
const P_CLASS_STYLE = {
    'P1': { bg: '#fef3c7', color: '#92400e' },  // amber
    'P2': { bg: '#fee2e2', color: '#b91c1c' },  // red
    'P3': { bg: '#4c0519', color: '#fecdd3' },  // deep red
    '—':  { bg: '#f1f5f9', color: '#64748b' }   // grey
};

// ── applyStats — updates ALL stat display elements by explicit ID ─────────
function applyStats(stats) {
    if (!stats) return;

    const total = stats.total        ?? 0;
    const high  = stats.highSeverity ?? 0;
    const maxP  = stats.maxPeak      ?? 0;
    const lastP = stats.lastPeak     ?? 0;
    const pCls  = stats.lastPeakClass || '—';
    const distM = stats.totalDistanceM ?? 0;

    // Top metric cards
    setText('impactsToday', total);
    setText('highSeverity', high);
    setText('maxPeak',      fmtG(maxP));

    // Last Peak + P-class badge
    setText('lastPeak', lastP > 0 ? fmtG(lastP) : '—');
    const badge = $('lastPeakClass');
    if (badge) {
        badge.textContent = pCls;
        const style = P_CLASS_STYLE[pCls] || P_CLASS_STYLE['—'];
        badge.style.background = style.bg;
        badge.style.color      = style.color;
    }

    // Distance traveled
    setText('totalDistance', distM + ' m');
    setText('distanceKm',    (distM / 1000).toFixed(3) + ' km');

    console.log(`[operator] Stats applied — total:${total} high:${high} max:${fmtG(maxP)} last:${fmtG(lastP)} (${pCls}) dist:${distM}m`);
}

// ── Fetch stats from DB and apply ─────────────────────────────────────────
async function refreshStats() {
    try {
        const res   = await fetch(`${SERVER}/api/impacts/stats`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const stats = await res.json();
        applyStats(stats);
    } catch (e) {
        console.warn('[operator] Stats fetch failed:', e.message);
    }
}

// ── Debug toggle ──────────────────────────────────────────────────────────
const debugToggle = $('debugToggle');
if (debugToggle) {
    debugToggle.addEventListener('click', () => {
        debugMode = !debugMode;
        debugToggle.classList.toggle('active');
        setText('debugStatus', debugMode ? 'Debug ON' : 'Debug OFF');
        ['debug1','debug2','debugLog'].forEach(id => {
            const el = $(id);
            if (el) el.style.display = debugMode ? 'block' : 'none';
        });
    });
}

// ── Live / Pause toggle ───────────────────────────────────────────────────
$('playPauseBtn')?.addEventListener('click', () => {
    isLiveStreaming = !isLiveStreaming;
    const pi = $('pauseIcon');
    if (isLiveStreaming) {
        if (pi) pi.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    } else {
        if (pi) pi.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>';
    }
});

// ── Refresh button — reload chart history ─────────────────────────────────
$('refreshBtn')?.addEventListener('click', () => {
    currentDataIndex = 0;
    initializeSensorData();
    loadHistoricalChart();
});

// ── Reset button — display only, DB untouched ─────────────────────────────
$('resetBtn')?.addEventListener('click', () => {
    if (!confirm('Reset all display counters to zero?\n\nThis only clears the screen — all database records are kept.\nThe counters will repopulate when the next impact arrives.')) return;
    ['impactsToday','highSeverity','maxPeak','lastPeak',
     'totalDistance','distanceKm'].forEach(id => {
        const el = $(id);
        if (!el) return;
        if (id === 'totalDistance') { el.textContent = '0 m'; return; }
        if (id === 'distanceKm')    { el.textContent = '0.000 km'; return; }
        el.textContent = id.toLowerCase().includes('peak') ? '—' : '0';
    });
    const badge = $('lastPeakClass');
    if (badge) { badge.textContent = '—'; badge.style.background = '#f1f5f9'; badge.style.color = '#64748b'; }
    initializeSensorData();
    console.log('[operator] Display reset to zero');
});

// ── Sensor chart ──────────────────────────────────────────────────────────
function generateSensorData() {
    return Array(sensorDataPoints).fill(0).map((_,i) => ({ time: i, accel1: 0, accel2: 0 }));
}
let sensorData = generateSensorData();
const ctx = $('sensorChart')?.getContext('2d');
let chart = null;

if (ctx) {
    chart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: sensorData.map(d => d.time),
            datasets: [
                { label: 'Left (S1)',  data: sensorData.map(d => d.accel1), borderColor: '#0891b2', backgroundColor: 'transparent', tension: 0.4, borderWidth: 2, pointRadius: 0 },
                { label: 'Right (S2)', data: sensorData.map(d => d.accel2), borderColor: '#7c3aed', backgroundColor: 'transparent', tension: 0.4, borderWidth: 2, pointRadius: 0 }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            plugins: {
                legend: { display: true, position: 'top', labels: { color: '#0f172a', font: { size: 11 } } },
                tooltip: { backgroundColor: '#fff', titleColor: '#0f172a', bodyColor: '#0f172a', borderColor: '#e2e8f0', borderWidth: 1, padding: 12 }
            },
            scales: {
                y: { min: 0, grid: { color: '#e2e8f0' }, ticks: { color: '#64748b', font: { size: 11 } } },
                x: { display: false }
            }
        }
    });
}

function initializeSensorData() {
    sensorData = generateSensorData();
    if (!chart) return;
    chart.data.labels = sensorData.map(d => d.time);
    chart.data.datasets[0].data = sensorData.map(d => d.accel1);
    chart.data.datasets[1].data = sensorData.map(d => d.accel2);
    chart.update();
}

function pushToChart(a1, a2) {
    currentDataIndex++;
    sensorData.shift();
    sensorData.push({ time: currentDataIndex, accel1: a1, accel2: a2 });
    if (!chart) return;
    chart.data.labels = sensorData.map(d => d.time);
    chart.data.datasets[0].data = sensorData.map(d => d.accel1);
    chart.data.datasets[1].data = sensorData.map(d => d.accel2);
    chart.update('none');
}

async function loadHistoricalChart() {
    try {
        const res  = await fetch(`${SERVER}/api/historical/graph/24`);
        const data = await res.json();
        if (!data.length) return;
        currentDataIndex = 0;
        sensorData = generateSensorData();
        data.forEach((pt, i) => {
            if (i < sensorDataPoints)
                sensorData[i] = { time: i, accel1: pt.accel1 || 0, accel2: pt.accel2 || 0 };
        });
        if (!chart) return;
        chart.data.labels = sensorData.map(d => d.time);
        chart.data.datasets[0].data = sensorData.map(d => d.accel1);
        chart.data.datasets[1].data = sensorData.map(d => d.accel2);
        chart.update();
    } catch (e) { console.warn('[operator] Historical chart load failed:', e.message); }
}

// ── fillAccel ─────────────────────────────────────────────────────────────
function fillAccel(prefix, data) {
    setText(`${prefix}X`,      fmtG4(data.x));
    setText(`${prefix}Y`,      fmtG4(data.y));
    setText(`${prefix}Z`,      fmtG4(data.z));
    setText(`${prefix}Peak`,   fmtG4(data.peak ?? data.gForce));
    setText(`${prefix}RmsV`,   fmtG4(data.rmsV));
    setText(`${prefix}RmsL`,   fmtG4(data.rmsL));
    setText(`${prefix}SdV`,    fmtG4(data.sdV));
    setText(`${prefix}SdL`,    fmtG4(data.sdL));
    setText(`${prefix}P2pV`,   fmtG4(data.p2pV));
    setText(`${prefix}P2pL`,   fmtG4(data.p2pL));
    setText(`${prefix}Fs`,     fmtInt(data.fs));
    setText(`${prefix}Window`, fmtInt(data.window));
}

// ── High-G alert — per sensor, both shown together, auto-dismiss 1s ───────
const alertState = { left: null, right: null };
let alertDismissTimers = { left: null, right: null };

function showHighGAlert(sensor, peakG) {
    alertState[sensor] = `${peakG.toFixed(2)}g on ${sensor.toUpperCase()} axle`;

    const banner = $('highGAlert');
    const msg    = $('highGMsg');
    if (!banner || !msg) return;

    // Show combined message for whichever sensors are currently active
    msg.textContent = [alertState.left, alertState.right].filter(Boolean).join('   |   ');
    banner.style.display = 'flex';

    // Clear previous timer for this sensor and set a fresh 1s one
    clearTimeout(alertDismissTimers[sensor]);
    alertDismissTimers[sensor] = setTimeout(() => {
        alertState[sensor] = null;
        const remaining = [alertState.left, alertState.right].filter(Boolean);
        if (remaining.length) {
            msg.textContent = remaining.join('   |   ');
        } else {
            banner.style.display = 'none';
        }
    }, 1000);
}

// ── Socket.IO ─────────────────────────────────────────────────────────────
const socket = io(SERVER);

socket.on('connect', () => {
    console.log('[operator] Socket connected:', socket.id);
    loadHistoricalChart();
    // Always re-fetch stats from DB on (re)connect
    refreshStats();
});

socket.on('disconnect', () => {
    console.warn('[operator] Socket disconnected');
});

socket.on('connect_error', () => {
    console.warn('[operator] Socket connection error');
});

socket.on('accelerometer-data', (data) => {
    if (!isLiveStreaming) return;

    if (data.sensor === 'left') {
        latestLeft = data;
        fillAccel('accel1', data);
    } else if (data.sensor === 'right') {
        latestRight = data;
        fillAccel('accel2', data);
    }

    // High-G check per sensor independently
    const peak = data.peak ?? data.gForce ?? 0;
    if (peak >= 8 && (data.sensor === 'left' || data.sensor === 'right')) {
        showHighGAlert(data.sensor, peak);
    }

    pushToChart(latestLeft.gForce || 0, latestRight.gForce || 0);
});

// On every new impact: re-fetch stats from CouchDB so counts are live + accurate
socket.on('new-impact', () => {
    refreshStats();
});

// ── System Health ─────────────────────────────────────────────────────────
const HEALTH_COMPONENTS = [
    { key: 'adxl345_s1', id: 'healthAccel1', label: 'Accel-1 (S1)' },
    { key: 'adxl345_s2', id: 'healthAccel2', label: 'Accel-2 (S2)' },
    { key: 'w5500',       id: 'healthComm',  label: 'Comm (W5500)' },
    { key: 'phyLink',     id: 'healthPhy',   label: 'PHY Link'     },
    { key: 'tcp',         id: 'healthTcp',   label: 'TCP'          },
    { key: 'spi1',        id: 'healthSpi',   label: 'SPI1'         },
    { key: 'usart2',      id: 'healthUsart', label: 'USART2'       },
];

(function buildHealthGrid() {
    const grid = document.querySelector('.health-grid');
    if (!grid) return;
    grid.innerHTML = HEALTH_COMPONENTS.map(c => `
        <div class="health-item" id="${c.id}">
            <div class="health-left">
                <svg class="icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/>
                </svg>
                <span>${c.label}</span>
            </div>
            <span class="health-status">Waiting...</span>
        </div>`).join('');
})();

socket.on('system-health', (health) => {
    const ts = new Date(health.timestamp || Date.now()).toLocaleTimeString();

    HEALTH_COMPONENTS.forEach(c => {
        const row  = $(c.id);
        if (!row) return;
        const status = health[c.key] || 'UNKNOWN';
        const isOk   = status === 'OK';
        row.className = 'health-item ' + (isOk ? 'operational' : 'error');
        row.querySelector('svg').innerHTML = isOk
            ? `<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>`
            : `<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/>`;
        row.querySelector('.health-status').textContent = isOk ? 'Operational' : status;
    });

    const container = document.querySelector('.log-container');
    if (container) {
        const failed  = HEALTH_COMPONENTS.filter(c => health[c.key] && health[c.key] !== 'OK').map(c => c.label);
        const type    = failed.length ? 'warning' : 'info';
        const message = failed.length ? `Health check FAIL: ${failed.join(', ')}` : 'Health check passed — all systems OK';
        const entry   = document.createElement('div');
        entry.className = 'log-entry';
        entry.innerHTML = `<span class="log-time">${ts}</span>
            <span class="log-type ${type}">${type}</span>
            <span class="log-message">${message}</span>
            <span class="log-sensor">[System]</span>`;
        container.insertBefore(entry, container.firstChild);
        while (container.children.length > 20) container.removeChild(container.lastChild);
    }
});

// ── Boot ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initializeSensorData();
    // Load persisted stats from CouchDB immediately — before any socket event
    refreshStats();
    // Pre-fill health grid from last known health status
    if (typeof window.preloadHealth === 'function') {
        window.preloadHealth();
    }
});

// ── Listen for server-pushed stats (fired on connect + every new impact) ──
// This replaces the REST polling approach — server pushes directly
socket.on('stats-update', (stats) => {
    console.log('[operator] stats-update received:', stats);
    applyStats(stats);
});

// ── Reset modal ───────────────────────────────────────────────────────────
(function injectResetModal() {
    // Modal HTML injected into body
    const modal = document.createElement('div');
    modal.id = 'resetModal';
    modal.style.cssText = `
        display:none; position:fixed; inset:0; z-index:9999;
        background:rgba(0,0,0,0.55); align-items:center; justify-content:center;`;
    modal.innerHTML = `
        <div style="background:#fff; border-radius:16px; padding:2rem; max-width:440px; width:90%;
                    box-shadow:0 20px 60px rgba(0,0,0,0.3); font-family:inherit;">
            <div style="display:flex; align-items:center; gap:0.75rem; margin-bottom:1rem;">
                <svg style="width:28px;height:28px;color:#dc2626;flex-shrink:0;"
                     fill="none" stroke="#dc2626" stroke-width="2" viewBox="0 0 24 24">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                    <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
                <h2 style="margin:0;font-size:1.2rem;color:#1e293b;">Reset Impact Data</h2>
            </div>

            <p style="color:#475569;margin-bottom:1.5rem;line-height:1.6;">
                Choose how to reset. This action affects the impact counters and charts.
            </p>

            <!-- Option A: Save to DB -->
            <label id="optSave" style="display:flex;align-items:flex-start;gap:0.75rem;padding:1rem;
                   border:2px solid #e2e8f0;border-radius:10px;cursor:pointer;margin-bottom:0.75rem;
                   transition:border-color 0.2s;">
                <input type="radio" name="resetOpt" value="save" checked
                       style="margin-top:3px;accent-color:#22c55e;">
                <div>
                    <div style="font-weight:600;color:#1e293b;">Keep database records</div>
                    <div style="font-size:0.85rem;color:#64748b;margin-top:2px;">
                        Reset display counters to zero. All CouchDB records are preserved —
                        you can still review historical data.
                    </div>
                </div>
            </label>

            <!-- Option B: Wipe DB -->
            <label id="optWipe" style="display:flex;align-items:flex-start;gap:0.75rem;padding:1rem;
                   border:2px solid #e2e8f0;border-radius:10px;cursor:pointer;margin-bottom:1.5rem;
                   transition:border-color 0.2s;">
                <input type="radio" name="resetOpt" value="wipe"
                       style="margin-top:3px;accent-color:#dc2626;">
                <div>
                    <div style="font-weight:600;color:#dc2626;">Wipe database &amp; reset everything</div>
                    <div style="font-size:0.85rem;color:#64748b;margin-top:2px;">
                        Permanently deletes all records from CouchDB and resets all counters to zero.
                        <strong>This cannot be undone.</strong>
                    </div>
                </div>
            </label>

            <div style="display:flex;gap:0.75rem;justify-content:flex-end;">
                <button id="resetCancelBtn"
                        style="padding:0.6rem 1.25rem;border:1px solid #e2e8f0;border-radius:8px;
                               background:#f8fafc;cursor:pointer;font-size:0.9rem;color:#64748b;">
                    Cancel
                </button>
                <button id="resetConfirmBtn"
                        style="padding:0.6rem 1.25rem;border:none;border-radius:8px;
                               background:#dc2626;color:#fff;cursor:pointer;
                               font-size:0.9rem;font-weight:600;">
                    Reset
                </button>
            </div>
        </div>`;
    document.body.appendChild(modal);

    // Highlight selected option border
    modal.querySelectorAll('input[name="resetOpt"]').forEach(radio => {
        radio.addEventListener('change', () => {
            document.getElementById('optSave').style.borderColor =
                radio.value === 'save' ? '#22c55e' : '#e2e8f0';
            document.getElementById('optWipe').style.borderColor =
                radio.value === 'wipe' ? '#dc2626' : '#e2e8f0';
            document.getElementById('resetConfirmBtn').style.background =
                radio.value === 'wipe' ? '#dc2626' : '#22c55e';
        });
    });
    // Init border
    document.getElementById('optSave').style.borderColor = '#22c55e';

    // Cancel
    document.getElementById('resetCancelBtn').addEventListener('click', () => {
        modal.style.display = 'none';
    });
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });

    // Confirm
    document.getElementById('resetConfirmBtn').addEventListener('click', async () => {
        const selected = modal.querySelector('input[name="resetOpt"]:checked').value;
        const saveToDb = selected === 'save';
        const btn      = document.getElementById('resetConfirmBtn');

        btn.textContent = 'Resetting...';
        btn.disabled    = true;

        try {
            const res  = await fetch(`${SERVER}/api/reset`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ saveToDb })
            });
            const data = await res.json();

            if (data.success) {
                modal.style.display = 'none';
                // Zero out all display fields immediately
                applyStats({ total: 0, highSeverity: 0, medium: 0, low: 0, maxPeak: 0, avgPeak: 0 });
                initializeSensorData();
                console.log('[reset] Success:', data.message);

                // Show brief confirmation toast
                showToast(saveToDb
                    ? '✓ Display reset — database preserved'
                    : '✓ Full reset — database wiped', saveToDb ? '#22c55e' : '#dc2626');
            } else {
                alert('Reset failed: ' + (data.error || 'Unknown error'));
            }
        } catch (e) {
            alert('Reset request failed: ' + e.message);
        } finally {
            btn.textContent = 'Reset';
            btn.disabled    = false;
        }
    });

    // Wire the reset button in the card header to open this modal
    const resetBtn = document.getElementById('resetBtn');
    if (resetBtn) {
        // Remove old inline listener if any
        const newBtn = resetBtn.cloneNode(true);
        resetBtn.parentNode.replaceChild(newBtn, resetBtn);
        newBtn.addEventListener('click', () => {
            // Reset radio to default
            modal.querySelector('input[value="save"]').checked = true;
            document.getElementById('optSave').style.borderColor = '#22c55e';
            document.getElementById('optWipe').style.borderColor = '#e2e8f0';
            document.getElementById('resetConfirmBtn').style.background = '#22c55e';
            modal.style.display = 'flex';
        });
    }
})();

// ── Toast notification ────────────────────────────────────────────────────
function showToast(message, color = '#22c55e') {
    const toast = document.createElement('div');
    toast.style.cssText = `
        position:fixed; bottom:1.5rem; right:1.5rem; z-index:99999;
        background:${color}; color:#fff; padding:0.75rem 1.25rem;
        border-radius:10px; font-size:0.9rem; font-weight:600;
        box-shadow:0 4px 20px rgba(0,0,0,0.2);
        animation:fadeInUp 0.3s ease;`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// Listen for server-pushed display-reset (handles multi-tab sync)
socket.on('display-reset', () => {
    applyStats({ total: 0, highSeverity: 0, medium: 0, low: 0, maxPeak: 0, avgPeak: 0 });
    initializeSensorData();
});

// ── CSV Download modal ────────────────────────────────────────────────────
(function initCsvModal() {
    const modal       = document.getElementById('csvModal');
    const openBtn     = document.getElementById('downloadCsvBtn');
    const cancelBtn   = document.getElementById('csvCancelBtn');
    const downloadBtn = document.getElementById('csvDownloadBtn');
    if (!modal || !openBtn) return;

    // Open modal
    openBtn.addEventListener('click', () => {
        modal.style.display = 'flex';
    });

    // Close modal
    cancelBtn.addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });

    // Highlight selected radio border
    modal.querySelectorAll('input[name="csvRange"]').forEach(radio => {
        radio.addEventListener('change', () => {
            modal.querySelectorAll('label').forEach(l => l.style.borderColor = '#e2e8f0');
            radio.closest('label').style.borderColor = '#3b82f6';
        });
    });
    // Init first option highlighted
    const first = modal.querySelector('input[name="csvRange"]:checked');
    if (first) first.closest('label').style.borderColor = '#3b82f6';

    // Download
    downloadBtn.addEventListener('click', () => {
        const hours    = modal.querySelector('input[name="csvRange"]:checked')?.value || '24';
        const url      = `${SERVER}/api/impacts/export/csv?hours=${hours}`;
        const dateStr  = new Date().toISOString().slice(0, 10);
        const filename = `impact_report_${dateStr}.csv`;

        // Trigger download via hidden anchor
        const a  = document.createElement('a');
        a.href   = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        modal.style.display = 'none';
        showToast(`✓ Downloading ${filename}`, '#3b82f6');
    });
})();

// ── Threshold sync ────────────────────────────────────────────────────────
// Fetch current thresholds from server on load so P-class badge is correct
// Also listen for live updates when config page saves new values
let clientThresholds = { p1Min: 5, p1Max: 10, p2Min: 10, p2Max: 20, p3Min: 20 };

function getPClassClient(peakG) {
    if (peakG == null) return null;
    const g = +peakG;
    const t = clientThresholds;
    if (g >= t.p3Min)                    return 'P3';
    if (g >= t.p2Min && g < t.p2Max)     return 'P2';
    if (g >= t.p1Min && g < t.p1Max)     return 'P1';
    return null;
}

async function loadThresholdsFromServer() {
    try {
        const res  = await fetch(`${SERVER}/api/thresholds`);
        const data = await res.json();
        clientThresholds = data;
        console.log('[operator] Thresholds loaded:', clientThresholds);
        // Save to localStorage as offline cache
        if (typeof saveThresholds === 'function') saveThresholds(data);
    } catch (e) {
        // Fall back to localStorage cache
        if (typeof loadStoredThresholds === 'function') {
            clientThresholds = loadStoredThresholds();
        }
        console.warn('[operator] Using cached thresholds:', clientThresholds);
    }
}

// Live update: when config page saves, server broadcasts this event
socket.on('thresholds-updated', (thresholds) => {
    clientThresholds = thresholds;
    if (typeof saveThresholds === 'function') saveThresholds(thresholds);
    console.log('[operator] Thresholds updated live:', thresholds);
    // Re-fetch stats so Last Peak badge re-classifies with new thresholds
    refreshStats();
    showToast(`✓ Thresholds updated: P1 ${thresholds.p1Min}–${thresholds.p1Max}g | P2 ${thresholds.p2Min}–${thresholds.p2Max}g | P3 >${thresholds.p3Min}g`, '#8b5cf6');
});

// Override applyStats badge to use client-side thresholds
// (server also classifies, but this ensures instant UI response)
const _origApplyStats = applyStats;
// Patch: after applyStats runs, re-classify lastPeak with current client thresholds
socket.on('stats-update', (stats) => {
    _origApplyStats(stats);
    // Re-apply badge using client thresholds in case they differ
    if (stats.lastPeak > 0) {
        const pCls  = getPClassClient(stats.lastPeak) || '—';
        const badge = document.getElementById('lastPeakClass');
        if (badge) {
            badge.textContent = pCls;
            const STYLE = {
                'P1': { bg: '#fef3c7', color: '#92400e' },
                'P2': { bg: '#fee2e2', color: '#b91c1c' },
                'P3': { bg: '#4c0519', color: '#fecdd3' },
                '—':  { bg: '#f1f5f9', color: '#64748b' }
            };
            const s = STYLE[pCls] || STYLE['—'];
            badge.style.background = s.bg;
            badge.style.color      = s.color;
        }
    }
});

// Load thresholds on boot
loadThresholdsFromServer();
