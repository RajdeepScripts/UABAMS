/* operator-dashboard.js – Final version with detailed communication status */

const SERVER = window.location.origin;

// ── Test Run Recorder — uses TestRun from common.js (persists across pages) ──
function _testUISync() {
    const recording = TestRun.isRecording();
    document.getElementById('testStartBtn').style.display = recording ? 'none'         : 'inline-block';
    document.getElementById('testStopBtn').style.display  = recording ? 'inline-block' : 'none';
    if (recording) {
        const t = TestRun.startTime();
        document.getElementById('testStatusLabel').textContent =
            `● Recording — started ${t.toLocaleTimeString('en-IN')}`;
        clearInterval(window._localTestTimer);
        window._localTestTimer = setInterval(() => {
            const s  = Math.round((Date.now() - TestRun.startTime()) / 1000);
            const el = document.getElementById('testTimerLabel');
            if (el) el.textContent =
                `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')} elapsed`;
        }, 1000);
    } else {
        clearInterval(window._localTestTimer);
        const lbl = document.getElementById('testTimerLabel');
        if (lbl) lbl.textContent = '';
    }
}

function startTestRun() {
    TestRun.start();
    _testUISync();
}

async function stopTestRun() {
    if (!TestRun.isRecording()) return;
    const startTime = TestRun.startTime();
    const endTime   = new Date();
    TestRun.stop();
    _testUISync();

    document.getElementById('testStatusLabel').textContent = 'Generating report…';
    try {
        const from = encodeURIComponent(startTime.toISOString());
        const to   = encodeURIComponent(endTime.toISOString());
        const res  = await fetch(`${SERVER}/api/test-report/csv?from=${from}&to=${to}`);
        if (!res.ok) throw new Error(await res.text());

        const blob = await res.blob();
        const a    = document.createElement('a');
        a.href     = URL.createObjectURL(blob);
        a.download = `test_report_${startTime.toISOString().slice(0,10)}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);

        const dur = Math.round((endTime - startTime) / 1000);
        document.getElementById('testStatusLabel').textContent =
            `✓ Report downloaded — ${Math.floor(dur/60)}m ${dur%60}s recorded`;
    } catch (e) {
        document.getElementById('testStatusLabel').textContent = `✗ Export failed: ${e.message}`;
    }
}

document.addEventListener('DOMContentLoaded', _testUISync);

let isLiveStreaming  = true;
let debugMode        = false;
let sensorDataPoints = 50;
let currentDataIndex = 0;
let latestLeft       = { x: 0, y: 0, z: 0, gForce: 0 };
let latestRight      = { x: 0, y: 0, z: 0, gForce: 0 };

startClock('currentTime', 'currentDate');

// ── Helpers ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };
const fmtG  = v => v != null ? (+v).toFixed(2) + 'g' : '—';
const fmtG4 = v => v != null ? (+v).toFixed(4) : '—';
const fmtInt = v => v != null ? v.toString() : '—';

const P_CLASS_STYLE = {
    'P1': { bg: '#fef3c7', color: '#92400e' },
    'P2': { bg: '#fee2e2', color: '#b91c1c' },
    'P3': { bg: '#4c0519', color: '#fecdd3' },
    '—':  { bg: '#f1f5f9', color: '#64748b' }
};

function applyStats(stats) {
    if (!stats) return;
    const total = stats.total ?? 0;
    const high  = stats.highSeverity ?? 0;
    const maxP  = stats.maxPeak ?? 0;
    const lastP = stats.lastPeak ?? 0;
    const pCls  = stats.lastPeakClass || '—';
    const distM = stats.totalDistanceM ?? 0;

    setText('impactsToday', total);
    setText('highSeverity', high);
    setText('maxPeak', fmtG(maxP));
    setText('lastPeak', lastP > 0 ? fmtG(lastP) : '—');
    const badge = $('lastPeakClass');
    if (badge) {
        badge.textContent = pCls;
        const style = P_CLASS_STYLE[pCls] || P_CLASS_STYLE['—'];
        badge.style.background = style.bg;
        badge.style.color = style.color;
    }
    setText('totalDistance', (+distM).toFixed(1) + ' m');
    setText('distanceKm', (distM / 1000).toFixed(3) + ' km');
}

async function refreshStats() {
    try {
        const res = await fetch(`${SERVER}/api/impacts/stats`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        applyStats(await res.json());
    } catch (e) { console.warn('[operator] Stats fetch failed:', e.message); }
}

// Debug toggle
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

// Live / Pause
$('playPauseBtn')?.addEventListener('click', () => {
    isLiveStreaming = !isLiveStreaming;
    const li = $('liveIndicator');
    const dot = $('liveDot');
    const lt = $('liveText');
    const pi = $('pauseIcon');
    if (isLiveStreaming) {
        li?.classList.replace('paused','streaming');
        dot?.classList.add('pulsing');
        if (lt) lt.textContent = 'LIVE';
        if (pi) pi.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    } else {
        li?.classList.replace('streaming','paused');
        dot?.classList.remove('pulsing');
        if (lt) lt.textContent = 'PAUSED';
        if (pi) pi.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>';
    }
});

// Refresh button
$('refreshBtn')?.addEventListener('click', () => {
    currentDataIndex = 0;
    initializeSensorData();
    loadHistoricalChart();
});

// Reset button
$('resetSessionBtn')?.addEventListener('click', () => {
    if (!confirm('Reset all display counters to zero?\n\nThis only clears the screen — all database records are kept.\nThe counters will repopulate when the next impact arrives.')) return;
    ['impactsToday','highSeverity','maxPeak','lastPeak','totalDistance','distanceKm'].forEach(id => {
        const el = $(id);
        if (!el) return;
        if (id === 'totalDistance') { el.textContent = '0 m'; return; }
        if (id === 'distanceKm')    { el.textContent = '0.000 km'; return; }
        el.textContent = id.toLowerCase().includes('peak') ? '—' : '0';
    });
    const badge = $('lastPeakClass');
    if (badge) { badge.textContent = '—'; badge.style.background = '#f1f5f9'; badge.style.color = '#64748b'; }
    initializeSensorData();
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
                tooltip: {
                    backgroundColor: '#fff', titleColor: '#0f172a', bodyColor: '#0f172a',
                    borderColor: '#e2e8f0', borderWidth: 1, padding: 12,
                    callbacks: {
                        label: ctx => `${ctx.dataset.label} Peak: ${ctx.parsed.y.toFixed(3)}g`
                    }
                }
            },
            scales: {
                y: {
                    suggestedMin: -2,
                    suggestedMax: 2,
                    grid: { color: '#e2e8f0' },
                    ticks: { color: '#64748b', font: { size: 11 }, callback: v => v.toFixed(1) + 'g' }
                },
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
async function loadGValueHistory() {
    const fromEl = document.getElementById('gHistFrom');
    const toEl   = document.getElementById('gHistTo');
    if (!fromEl?.value || !toEl?.value) {
        alert('Please select both a From and To date/time.');
        return;
    }
    const fromISO = new Date(fromEl.value).toISOString();
    const toISO   = new Date(toEl.value).toISOString();
    if (fromISO >= toISO) { alert('"From" must be before "To".'); return; }

    try {
        const res  = await fetch(`${SERVER}/api/history/g-value?from=${encodeURIComponent(fromISO)}&to=${encodeURIComponent(toISO)}`);
        const rows = await res.json();
        if (!rows.length) { alert('No data found for the selected period.'); return; }

        const leftRows  = rows.filter(r => r.sensor === 'left');
        const rightRows = rows.filter(r => r.sensor === 'right');
        const n = Math.max(leftRows.length, rightRows.length);

        if (!chart) return;
        chart.data.labels = Array.from({ length: n }, (_, i) => i + 1);
        chart.data.datasets[0].data = leftRows.map(r => +(r.peak ?? 0));
        chart.data.datasets[1].data = rightRows.map(r => +(r.peak ?? 0));
        chart.options.plugins.title = { display: true, text: `G-Value History: ${fromEl._flatpickr?.altInput?.value || fromEl.value} → ${toEl._flatpickr?.altInput?.value || toEl.value}` };
        chart.update();

        isLiveStreaming = false;
        document.getElementById('gLiveBtn').style.display = 'inline-block';
    } catch (e) {
        alert('Failed to load history: ' + e.message);
    }
}

function switchGToLive() {
    isLiveStreaming = true;
    document.getElementById('gLiveBtn').style.display = 'none';
    if (chart) {
        chart.options.plugins.title = { display: false };
        currentDataIndex = 0;
        initializeSensorData();
        loadHistoricalChart();
    }
}

async function loadHistoricalChart() {
    try {
        const res = await fetch(`${SERVER}/api/historical/graph/24`);
        const data = await res.json();
        if (!data.length) return;
        currentDataIndex = 0;
        sensorData = generateSensorData();
        data.forEach((pt, i) => {
            if (i < sensorDataPoints) sensorData[i] = { time: i, accel1: pt.accel1 || 0, accel2: pt.accel2 || 0 };
        });
        if (!chart) return;
        chart.data.labels = sensorData.map(d => d.time);
        chart.data.datasets[0].data = sensorData.map(d => d.accel1);
        chart.data.datasets[1].data = sensorData.map(d => d.accel2);
        chart.update();
    } catch (e) { console.warn('[operator] Historical chart load failed:', e.message); }
}

function fillAccel(prefix, data) {
    setText(`${prefix}X`, fmtG4(data.x));
    setText(`${prefix}Y`, fmtG4(data.y));
    setText(`${prefix}Z`, fmtG4(data.z));
    setText(`${prefix}Peak`, fmtG4(data.peak ?? data.gForce));
    setText(`${prefix}RmsV`, fmtG4(data.rmsV));
    setText(`${prefix}RmsL`, fmtG4(data.rmsL));
    setText(`${prefix}SdV`, fmtG4(data.sdV));
    setText(`${prefix}SdL`, fmtG4(data.sdL));
    setText(`${prefix}P2pV`, fmtG4(data.p2pV));
    setText(`${prefix}P2pL`, fmtG4(data.p2pL));
    setText(`${prefix}Fs`, fmtInt(data.fs));
    setText(`${prefix}Window`, fmtInt(data.window));
}

// ── High-G alert ─────────────────────────────────────────────────────────
const alertState = { left: null, right: null };
let alertDismissTimers = { left: null, right: null };
function showHighGAlert(sensor, peakG) {
    alertState[sensor] = `${peakG.toFixed(2)}g on ${sensor.toUpperCase()} axle`;
    const banner = $('highGAlert');
    const msg = $('highGMsg');
    if (!banner || !msg) return;
    msg.textContent = [alertState.left, alertState.right].filter(Boolean).join('   |   ');
    banner.style.display = 'flex';
    clearTimeout(alertDismissTimers[sensor]);
    alertDismissTimers[sensor] = setTimeout(() => {
        alertState[sensor] = null;
        const remaining = [alertState.left, alertState.right].filter(Boolean);
        if (remaining.length) msg.textContent = remaining.join('   |   ');
        else banner.style.display = 'none';
    }, 1000);
}

// ── Session timer ─────────────────────────────────────────────────────────
const _sessionStart = Date.now();
setInterval(() => {
    const e = Date.now() - _sessionStart;
    const h = Math.floor(e / 3600000);
    const m = Math.floor((e % 3600000) / 60000);
    const s = Math.floor((e % 60000) / 1000);
    setText('sessionTimer',
        `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`);
}, 1000);

// ── MQTT badge helpers ────────────────────────────────────────────────────
function setMqttBadge(state) {
    const text  = $('statusMqtt');
    const badge = $('statusMqttBadge');
    if (text)  text.textContent  = state === 'live' ? 'Connected' : state === 'error' ? 'Error' : 'Disconnected';
    if (badge) { badge.textContent = state === 'live' ? 'LIVE' : 'OFFLINE'; badge.dataset.state = state; }
}

// ── Socket.IO ────────────────────────────────────────────────────────────
const socket = io(SERVER);
socket.on('connect', () => {
    console.log('[operator] Socket connected');
    setText('liveText', 'LIVE');
    const dot = $('liveDot'); if (dot) dot.style.background = '#22c55e';
    setMqttBadge('live');
    loadHistoricalChart();
    refreshStats();
});
socket.on('disconnect', () => {
    setText('liveText', 'NO SERVER');
    const dot = $('liveDot'); if (dot) dot.style.background = '#ef4444';
    setMqttBadge('offline');
});
socket.on('connect_error', () => {
    setText('liveText', 'ERROR');
    const dot = $('liveDot'); if (dot) dot.style.background = '#f59e0b';
    setMqttBadge('error');
});

// ── System Health Grid (separate card) ───────────────────────────────────
const HEALTH_COMPONENTS = [
    { key: 'adxl345_s1', id: 'healthAccel1', label: 'Accel-1 (S1)' },
    { key: 'adxl345_s2', id: 'healthAccel2', label: 'Accel-2 (S2)' },
    { key: 'w5500',       id: 'healthComm',  label: 'Comm (W5500)' },
    { key: 'phyLink',     id: 'healthPhy',   label: 'PHY Link' },
    { key: 'tcp',         id: 'healthTcp',   label: 'TCP' },
    { key: 'spi1',        id: 'healthSpi',   label: 'SPI1' },
    { key: 'usart2',      id: 'healthUsart', label: 'USART2' },
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
            <span class="health-status not-connected">NOT CONNECTED</span>
        </div>`).join('');
})();
let healthStatus = {};
socket.on('system-health', (health) => {
    healthStatus = health;
    HEALTH_COMPONENTS.forEach(c => {
        const row = $(c.id);
        if (!row) return;
        const raw = health[c.key];
        const isOk = raw === 'OK';
        const isFail = raw === 'FAIL';
        row.className = 'health-item ' + (isOk ? 'operational' : isFail ? 'error' : 'not-connected');
        row.querySelector('svg').innerHTML = isOk
            ? `<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>`
            : isFail
            ? `<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/>`
            : `<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>`;
        const statusEl = row.querySelector('.health-status');
        statusEl.textContent = isOk ? 'CONNECTED' : isFail ? 'FAIL' : 'NOT CONNECTED';
        statusEl.className = 'health-status ' + (isOk ? 'connected' : isFail ? 'fail' : 'not-connected');
    });
    updateHardwareStatus(); // refresh communication line
});

// Track previous warning states to avoid repeated popups
const previousWarningState = {
    left: true,      // assume initially online
    right: true,
    gps: true,
    usart2: true,
    spi1: true,
    w5500: true,
    tcp: true,
    phyLink: true,
    system: true
};

// ── Last active timestamps and detailed communication ─────────────────────
let lastLeftTime = null, lastRightTime = null, lastGpsTime = null;

function formatLogTime(isoString) {
    if (!isoString) return '--';
    const date = new Date(isoString);
    return date.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' ' +
           date.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

function getDetailedCommunicationStatus() {
    // Only called when hardware is online (any sensor active)
    const parts = [];
    if (healthStatus.usart2 !== undefined) parts.push(`USART: ${healthStatus.usart2 === 'OK' ? 'ok' : 'fail'}`);
    if (healthStatus.spi1 !== undefined)   parts.push(`SPI: ${healthStatus.spi1 === 'OK' ? 'ok' : 'fail'}`);
    if (healthStatus.w5500 !== undefined)  parts.push(`W5500: ${healthStatus.w5500 === 'OK' ? 'ok' : 'fail'}`);
    if (healthStatus.tcp !== undefined)    parts.push(`TCP: ${healthStatus.tcp === 'OK' ? 'ok' : 'fail'}`);
    if (healthStatus.phyLink !== undefined)parts.push(`PHY: ${healthStatus.phyLink === 'OK' ? 'ok' : 'fail'}`);
    return parts.length ? parts.join(', ') : 'No health data';
}

function updateHardwareStatus() {
    const container = document.querySelector('.log-container');
    if (!container) return;

    const now = Date.now();
    const leftOnline = lastLeftTime && (now - new Date(lastLeftTime).getTime() < 15000);
    const rightOnline = lastRightTime && (now - new Date(lastRightTime).getTime() < 15000);
    const gpsOnline = lastGpsTime && (now - new Date(lastGpsTime).getTime() < 30000);
    const anyOnline = leftOnline || rightOnline || gpsOnline;

    const currentTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    const leftFail = healthStatus.adxl345_s1 === 'FAIL';
    const rightFail = healthStatus.adxl345_s2 === 'FAIL';

    const leftMsg = leftFail ? 'Accel-1 connection failed'
                  : leftOnline ? 'ACTIVE NOW'
                  : `OFFLINE, last active ${formatLogTime(lastLeftTime)}`;
    const rightMsg = rightFail ? 'Accel-2 connection failed'
                   : rightOnline ? 'ACTIVE NOW'
                   : `OFFLINE, last active ${formatLogTime(lastRightTime)}`;
    const gpsMsg = gpsOnline ? 'ACTIVE NOW' : `OFFLINE, last active ${formatLogTime(lastGpsTime)}`;

    const logEntries = [];

    function addEntry(type, message, sensor, stateKey) {
        logEntries.push({ time: currentTime, type, message, sensor });

        // Trigger popup only for warnings and only on state change
        if (stateKey && type === 'warning') {
            const wasOk = previousWarningState[stateKey] === true;
            if (wasOk) {
                showToast(`${sensor}: ${message}`, 'warning');
            }
            previousWarningState[stateKey] = false;
        } else if (stateKey && type === 'info') {
            previousWarningState[stateKey] = true;
        }
    }

    addEntry(leftOnline ? 'info' : 'warning', leftMsg, '[Accel-1]', 'left');
    addEntry(rightOnline ? 'info' : 'warning', rightMsg, '[Accel-2]', 'right');
    addEntry(gpsOnline ? 'info' : 'warning', gpsMsg, '[GPS]', 'gps');

    if (anyOnline) {
        const healthMap = [
            { key: 'usart2', label: '[USART]', stateKey: 'usart2' },
            { key: 'spi1', label: '[SPI1]', stateKey: 'spi1' },
            { key: 'w5500', label: '[W5500]', stateKey: 'w5500' },
            { key: 'tcp', label: '[TCP]', stateKey: 'tcp' },
            { key: 'phyLink', label: '[PHY Link]', stateKey: 'phyLink' }
        ];
        for (const h of healthMap) {
            const status = healthStatus[h.key];
            if (status !== undefined) {
                const isOk = status === 'OK';
                const msg = `${h.key.toUpperCase()}: ${isOk ? 'OK' : 'FAIL'}`;
                addEntry(isOk ? 'info' : 'warning', msg, h.label, h.stateKey);
            }
        }
    } else {
        addEntry('warning', 'Communication: Not connected since the hardware is offline.', '[System]', 'system');
    }

    container.innerHTML = logEntries.map(entry => `
        <div class="log-entry">
            <span class="log-time">${entry.time}</span>
            <span class="log-type ${entry.type}">${entry.type === 'info' ? 'info' : 'warn'}</span>
            <span class="log-message">${entry.message}</span>
            <span class="log-sensor">${entry.sensor}</span>
        </div>
    `).join('');
}

async function fetchLatestTimestamps() {
    try {
        const [sensorRes, gpsRes] = await Promise.all([
            fetch(`${SERVER}/api/latest/sensor`),
            fetch(`${SERVER}/api/latest/gps`)
        ]);

        if (sensorRes.ok) {
            const data = await sensorRes.json();
            if (data.left?.timestamp)  lastLeftTime  = data.left.timestamp;
            if (data.right?.timestamp) lastRightTime = data.right.timestamp;
        }

        if (gpsRes.ok) {
            const gpsData = await gpsRes.json();
            if (gpsData?.timestamp) lastGpsTime = gpsData.timestamp;
        }

        updateHardwareStatus();
    } catch (e) {
        console.warn('Failed to fetch timestamps:', e);
        updateHardwareStatus();
    }
}

// Initialise log with loading message
const logContainer = document.querySelector('.log-container');
if (logContainer) {
    logContainer.innerHTML = `<div class="log-entry"><span class="log-time">--:--:--</span><span class="log-type info">info</span><span class="log-message">Loading hardware status...</span><span class="log-sensor">[System]</span></div>`;
}
fetchLatestTimestamps();

// Socket updates for accelerometer data (updates timestamps)
socket.on('accelerometer-data', (data) => {
    if (!isLiveStreaming) return;
    // ODR decimation gate
    const _sid = data.sensor === 'left' ? 1 : data.sensor === 'right' ? 2 : null;
    if (_sid && typeof AccelConfig !== 'undefined' && !AccelConfig.shouldAccept(_sid)) return;

    // Update Last Data timestamp
    const now = new Date();
    setText('statusLastData', now.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' }));

    if (data.sensor === 'left') {
        latestLeft = data;
        fillAccel('accel1', data);
        if (!lastLeftTime || data.timestamp > lastLeftTime) lastLeftTime = data.timestamp;
    } else if (data.sensor === 'right') {
        latestRight = data;
        fillAccel('accel2', data);
        if (!lastRightTime || data.timestamp > lastRightTime) lastRightTime = data.timestamp;
    }
    const peak = data.peak ?? data.gForce ?? 0;
    if (peak >= 8 && (data.sensor === 'left' || data.sensor === 'right')) showHighGAlert(data.sensor, peak);
    // Use PEAK (max G within window) so spikes are visible, fall back to gForce
    pushToChart(
        latestLeft.peak  || latestLeft.gForce  || 0,
        latestRight.peak || latestRight.gForce || 0
    );
    updateHardwareStatus();
});

// Periodic refresh of status (every 5 seconds)
setInterval(() => updateHardwareStatus(), 5000);
setInterval(fetchLatestTimestamps, 30000);

// ── Boot ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initializeSensorData();
    refreshStats();
    if (typeof window.preloadHealth === 'function') window.preloadHealth();
});

socket.on('stats-update', (stats) => {
    console.log('[operator] stats-update received');
    applyStats(stats);
});

// ── Reset modal (unchanged) ──────────────────────────────────────────────
(function injectResetModal() {
    const modal = document.createElement('div');
    modal.id = 'resetModal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <svg fill="none" stroke="#dc2626" stroke-width="2" viewBox="0 0 24 24">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                    <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
                <h2>Reset Impact Data</h2>
            </div>
            <div class="modal-body">
                <p>Choose how to reset. This action affects the impact counters and charts.</p>
                <label class="radio-option" id="optSave">
                    <input type="radio" name="resetOpt" value="save" checked>
                    <div>
                        <div class="option-title">Keep database records</div>
                        <div class="option-desc">Reset display counters to zero. All CouchDB records are preserved — you can still review historical data.</div>
                    </div>
                </label>
                <label class="radio-option wipe" id="optWipe">
                    <input type="radio" name="resetOpt" value="wipe">
                    <div>
                        <div class="option-title" style="color:#dc2626;">Wipe database & reset everything</div>
                        <div class="option-desc">Permanently deletes all records from CouchDB and resets all counters to zero. <strong>This cannot be undone.</strong></div>
                    </div>
                </label>
            </div>
            <div class="modal-footer">
                <button class="btn-cancel" id="resetCancelBtn">Cancel</button>
                <button class="btn-confirm" id="resetConfirmBtn">Reset</button>
            </div>
        </div>`;
    document.body.appendChild(modal);

    const optSave = document.getElementById('optSave');
    const optWipe = document.getElementById('optWipe');
    const confirmBtn = document.getElementById('resetConfirmBtn');
    const cancelBtn = document.getElementById('resetCancelBtn');

    modal.querySelectorAll('input[name="resetOpt"]').forEach(radio => {
        radio.addEventListener('change', () => {
            const isWipe = radio.value === 'wipe';
            optSave.classList.toggle('selected', !isWipe);
            optWipe.classList.toggle('selected', isWipe);
            confirmBtn.style.background = isWipe ? '#dc2626' : '#22c55e';
        });
    });

    // Set initial selected state
    optSave.classList.add('selected');

    cancelBtn.addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });

    confirmBtn.addEventListener('click', async () => {
        const selected = modal.querySelector('input[name="resetOpt"]:checked').value;
        const saveToDb = selected === 'save';
        confirmBtn.textContent = 'Resetting...';
        confirmBtn.disabled = true;
        try {
            const res = await fetch(`${SERVER}/api/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ saveToDb }) });
            const data = await res.json();
            if (data.success) {
                modal.style.display = 'none';
                applyStats({ total: 0, highSeverity: 0, medium: 0, low: 0, maxPeak: 0, avgPeak: 0 });
                initializeSensorData();
                console.log('[reset] Success:', data.message);
                showToast(saveToDb ? '✓ Display reset — database preserved' : 'Full reset — database wiped', saveToDb ? 'success' : 'warning');
            } else alert('Reset failed: ' + (data.error || 'Unknown error'));
        } catch (e) { alert('Reset request failed: ' + e.message); }
        finally { confirmBtn.textContent = 'Reset'; confirmBtn.disabled = false; }
    });

    const resetBtn = document.getElementById('resetSessionBtn');
    if (resetBtn) {
        const newBtn = resetBtn.cloneNode(true);
        resetBtn.parentNode.replaceChild(newBtn, resetBtn);
        newBtn.addEventListener('click', () => {
            modal.querySelector('input[value="save"]').checked = true;
            optSave.classList.add('selected');
            optWipe.classList.remove('selected');
            confirmBtn.style.background = '#22c55e';
            modal.style.display = 'flex';
        });
    }
})();

function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast-notification ${type}`;
    
    if (type === 'warning') {
        toast.innerHTML = `<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
    }
    toast.appendChild(document.createTextNode(type === 'warning' ? ` ${message}` : message));
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), type === 'warning' ? 5000 : 3000);
}

socket.on('display-reset', () => {
    applyStats({ total: 0, highSeverity: 0, medium: 0, low: 0, maxPeak: 0, avgPeak: 0 });
    initializeSensorData();
});

// ── CSV Download modal (unchanged) ──────────────────────────────────────
(function initCsvModal() {
    const modal = document.getElementById('csvModal');
    const openBtn = document.getElementById('downloadCsvBtn');
    const cancelBtn = document.getElementById('csvCancelBtn');
    const downloadBtn = document.getElementById('csvDownloadBtn');
    if (!modal || !openBtn) return;
    openBtn.addEventListener('click', () => { modal.style.display = 'flex'; });
    cancelBtn.addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
    modal.querySelectorAll('input[name="csvRange"]').forEach(radio => {
        radio.addEventListener('change', () => {
            modal.querySelectorAll('label').forEach(l => l.style.borderColor = '#e2e8f0');
            radio.closest('label').style.borderColor = '#3b82f6';
        });
    });
    const first = modal.querySelector('input[name="csvRange"]:checked');
    if (first) first.closest('label').style.borderColor = '#3b82f6';
    downloadBtn.addEventListener('click', () => {
        const hours = modal.querySelector('input[name="csvRange"]:checked')?.value || '24';
        const url = `${SERVER}/api/impacts/export/csv?hours=${hours}`;
        const dateStr = new Date().toISOString().slice(0,10);
        const filename = `impact_report_${dateStr}.csv`;
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        modal.style.display = 'none';
        showToast(`✓ Downloading ${filename}`, '#3b82f6');
    });
})();

function updateThresholdDisplay(thresholds) {
  const chipP1 = $('threshChipP1');
  const chipP2 = $('threshChipP2');
  const chipP3 = $('threshChipP3');

  if (chipP1) {
    chipP1.textContent = (thresholds?.p1Min != null && thresholds?.p1Max != null)
      ? `P1: ${thresholds.p1Min.toFixed(2)}–${thresholds.p1Max.toFixed(2)} g`
      : 'P1: —';
  }
  if (chipP2) {
    chipP2.textContent = (thresholds?.p2Min != null && thresholds?.p2Max != null)
      ? `P2: ${thresholds.p2Min.toFixed(2)}–${thresholds.p2Max.toFixed(2)} g`
      : 'P2: —';
  }
  if (chipP3) {
    chipP3.textContent = (thresholds?.p3Min != null)
      ? `P3: > ${thresholds.p3Min.toFixed(2)} g`
      : 'P3: —';
  }
}

// Keep track of active warning popups to avoid spamming
const activeWarnings = new Set();
// function showWarningNotification(message, sensor) {
//     const toast = document.createElement('div');
//     toast.style.cssText = `position:fixed; bottom:1.5rem; left:1.5rem; z-index:99999; background:#f59e0b; color:#fff; padding:0.75rem 1.25rem; border-radius:10px; font-size:0.9rem; font-weight:600; box-shadow:0 4px 20px rgba(0,0,0,0.2); animation:fadeInUp 0.3s ease; display:flex; align-items:center; gap:0.5rem;`;
//     toast.innerHTML = `<svg style="width:18px;height:18px;" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> ${sensor}: ${message}`;
//     document.body.appendChild(toast);
//     setTimeout(() => toast.remove(), 5000);
// }

// ── Threshold sync (unchanged) ──────────────────────────────────────────
let clientThresholds = { p1Min: null, p1Max: null, p2Min: null, p2Max: null, p3Min: null };
function getPClassClient(peakG) {
    if (peakG == null || clientThresholds.p1Min == null) return null;
    const g = +peakG;
    const t = clientThresholds;
    if (g >= t.p3Min) return 'P3';
    if (g >= t.p2Min) return 'P2';
    if (g >= t.p1Min) return 'P1';
    return null;
}
async function loadThresholdsFromServer() {
    try {
        const res = await fetch(`${SERVER}/api/thresholds`);
        const data = await res.json();
        clientThresholds = data;
        updateThresholdDisplay(data);
        if (typeof saveThresholds === 'function') saveThresholds(data);
    } catch (e) {
        if (typeof loadStoredThresholds === 'function') clientThresholds = loadStoredThresholds();
        updateThresholdDisplay(clientThresholds);
        console.warn('[operator] Using cached thresholds:', clientThresholds);
    }
}
socket.on('thresholds-updated', (thresholds) => {
    clientThresholds = thresholds;

    updateThresholdDisplay(thresholds);
    if (typeof saveThresholds === 'function') saveThresholds(thresholds);
    refreshStats();
    showToast(`✓ Thresholds updated: P1 ${thresholds.p1Min}–${thresholds.p1Max}g | P2 ${thresholds.p2Min}–${thresholds.p2Max}g | P3 >${thresholds.p3Min}g`, 'success');
});
const _origApplyStats = applyStats;
socket.on('stats-update', (stats) => {
    _origApplyStats(stats);
    if (stats.lastPeak > 0) {
        const pCls = getPClassClient(stats.lastPeak) || '—';
        const badge = document.getElementById('lastPeakClass');
        if (badge) {
            badge.textContent = pCls;
            const style = { 'P1': { bg: '#fef3c7', color: '#92400e' }, 'P2': { bg: '#fee2e2', color: '#b91c1c' }, 'P3': { bg: '#4c0519', color: '#fecdd3' }, '—': { bg: '#f1f5f9', color: '#64748b' } }[pCls] || { bg: '#f1f5f9', color: '#64748b' };
            badge.style.background = style.bg;
            badge.style.color = style.color;
        }
    }
});
loadThresholdsFromServer();