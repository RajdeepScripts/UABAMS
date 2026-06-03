/* management-dashboard.js — Executive Management Dashboard */

const API = window.location.origin;

// Clock — uses startClock from common.js
startClock('currentTime', 'currentDate', 'long');

// ── Chart config ───────────────────────────────────────────────────────────
const CHART_POINTS = 120; // how many seconds to show

// ── Sensor Performance Chart ───────────────────────────────────────────────
const sensorCtx = document.getElementById('sensorChart').getContext('2d');
const sensorChart = new Chart(sensorCtx, {
    type: 'line',
    data: {
        labels: [],
        datasets: [
            {
                label: 'Left (S1)',
                data: [],
                borderColor: '#0891b2',
                backgroundColor: 'transparent',
                tension: 0.4,
                borderWidth: 2,
                pointRadius: 0,
                spanGaps: true
            },
            {
                label: 'Right (S2)',
                data: [],
                borderColor: '#7c3aed',
                backgroundColor: 'transparent',
                tension: 0.4,
                borderWidth: 2,
                pointRadius: 0,
                spanGaps: true
            }
        ]
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
            legend: { display: true, position: 'top', labels: { color: '#0f172a', font: { size: 11 } } },
            tooltip: {
                backgroundColor: '#ffffff',
                titleColor: '#0f172a',
                bodyColor: '#0f172a',
                borderColor: '#e2e8f0',
                borderWidth: 1,
                padding: 12,
                callbacks: {
                    label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y != null ? ctx.parsed.y.toFixed(3) + ' g' : 'No data'}`
                }
            }
        },
        scales: {
            y: { suggestedMin: -2, suggestedMax: 2, grid: { color: '#e2e8f0' }, ticks: { color: '#64748b', font: { size: 11 }, callback: v => v.toFixed(1) + 'g' } },
            x: { display: false }
        }
    }
});

// ── System Health Doughnut ─────────────────────────────────────────────────
const healthCtx = document.getElementById('healthChart').getContext('2d');
const healthChart = new Chart(healthCtx, {
    type: 'doughnut',
    data: {
        labels: ['Operational', 'Warning', 'Critical'],
        datasets: [{
            data: [0, 0, 0],
            backgroundColor: ['#22c55e', '#eab308', '#ef4444'],
            borderWidth: 0,
            spacing: 2
        }]
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: '#ffffff',
                titleColor: '#0f172a',
                bodyColor: '#0f172a',
                borderColor: '#e2e8f0',
                borderWidth: 1,
                padding: 12
            }
        },
        cutout: '60%'
    }
});

// ── KPI entrance animation ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.kpi-value').forEach(el => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(20px)';
        setTimeout(() => {
            el.style.transition = 'all 0.5s ease';
            el.style.opacity = '1';
            el.style.transform = 'translateY(0)';
        }, 100);
    });
});

// ── Helpers ────────────────────────────────────────────────────────────────
function timeAgo(isoStr) {
    const diffMs  = Date.now() - new Date(isoStr).getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1)   return 'just now';
    if (diffMin < 60)  return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24)    return `${diffH}h ago`;
    return `${Math.floor(diffH / 24)}d ago`;
}

// ── REST pollers (KPIs only — chart is now Socket.IO driven) ───────────────

async function fetchUptime() {
    try {
        const data = await fetch(`${API}/api/management/uptime`).then(r => r.json());
        document.getElementById('kpi-uptime').textContent = data.uptime_pct + '%';
        if (data.window_hours === 0) {
            document.getElementById('kpi-uptime-sub').textContent = 'No data yet';
        } else if (data.last_seen) {
            document.getElementById('kpi-uptime-sub').textContent =
                `${data.active_hours}/${data.window_hours} hrs · last seen ${timeAgo(data.last_seen)}`;
        } else {
            document.getElementById('kpi-uptime-sub').textContent =
                `${data.active_hours}/${data.window_hours} hrs active`;
        }
    } catch (e) { console.error('uptime fetch error:', e); }
}

async function fetchActiveSensors() {
    try {
        const data = await fetch(`${API}/api/management/active-sensors`).then(r => r.json());
        document.getElementById('kpi-sensors').textContent = data.count;
        if (data.online.length > 0) {
            const offline = data.last_known.length ? ` · ${data.last_known.join(',')} offline` : '';
            document.getElementById('kpi-sensors-sub').textContent = data.online.join(', ') + ' active' + offline;
        } else if (data.last_known.length > 0) {
            const latestTs = data.last_known.reduce((best, s) =>
                data.last_seen[s] > best ? data.last_seen[s] : best, '');
            document.getElementById('kpi-sensors-sub').textContent =
                `${data.last_known.join(', ')} · last seen ${timeAgo(latestTs)}`;
        } else {
            document.getElementById('kpi-sensors-sub').textContent = 'No sensor data';
        }
    } catch (e) { console.error('active-sensors fetch error:', e); }
}

async function fetchActiveAlerts() {
    try {
        const data = await fetch(`${API}/api/management/active-alerts`).then(r => r.json());
        document.getElementById('kpi-alerts').textContent     = data.total;
        document.getElementById('kpi-alerts-sub').textContent = `${data.require_attention} require attention`;
    } catch (e) { console.error('active-alerts fetch error:', e); }
}

async function fetchSystemHealth() {
    try {
        const data = await fetch(`${API}/api/management/system-health`).then(r => r.json());
        healthChart.data.datasets[0].data = [data.operational, data.warning, data.critical];
        healthChart.update();
        document.getElementById('health-operational').textContent = data.operational;
        document.getElementById('health-warning').textContent     = data.warning;
        document.getElementById('health-critical').textContent    = data.critical;
    } catch (e) { console.error('system-health fetch error:', e); }
}

// ── Fetch chart from DB and update rolling window ─────────────────────────
// Only shows data from the last 2 minutes. If the latest DB point is >15s
// old (sensor disconnected), the right-hand side of the chart goes null so
// the line visibly drops off instead of showing stale data.
const CHART_WINDOW_MS  = 2 * 60 * 1000;  // 2 minutes visible
const STALE_CUTOFF_MS  = 15 * 1000;      // sensor considered offline after 15s

async function fetchChartFromDB() {
    try {
        const data = await fetch(`${API}/api/management/sensor-chart-recent`).then(r => r.json());

        const now       = Date.now();
        const windowCut = new Date(now - CHART_WINDOW_MS).toISOString().slice(0, 19);

        // Only keep points within the 2-minute window
        const windowed = data.filter(pt => pt.ts >= windowCut);

        const newLabels = Array(CHART_POINTS).fill('');
        const newLeft   = Array(CHART_POINTS).fill(null);
        const newRight  = Array(CHART_POINTS).fill(null);

        if (windowed.length > 0) {
            // Check if sensors have gone stale
            const latestTs  = windowed[windowed.length - 1].ts;
            const staleMs   = now - new Date(latestTs).getTime();
            const isStale   = staleMs > STALE_CUTOFF_MS;

            const slice = windowed.slice(-CHART_POINTS);
            const start = CHART_POINTS - slice.length;
            slice.forEach((pt, i) => {
                newLabels[start + i] = pt.ts ? new Date(pt.ts).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) : '';
                // If stale, only fill up to the last real point — leave rest null
                if (!isStale) {
                    newLeft[start + i]  = pt.left;
                    newRight[start + i] = pt.right;
                } else {
                    // Show data up to last known, then null gap at the end
                    const ageMs = now - new Date(pt.ts).getTime();
                    if (ageMs > STALE_CUTOFF_MS) {
                        newLeft[start + i]  = pt.left;
                        newRight[start + i] = pt.right;
                    }
                    // points within the stale gap stay null → line drops off
                }
            });
        }

        sensorChart.data.labels           = newLabels;
        sensorChart.data.datasets[0].data = newLeft;
        sensorChart.data.datasets[1].data = newRight;
        sensorChart.update('none');
    } catch (e) { console.error('chart DB fetch error:', e); }
}

// ── GPS ────────────────────────────────────────────────────────────────────
async function fetchGPS() {
    try {
        const d = await fetch(`${API}/api/latest/gps`).then(r => r.json());
        if (!d) return;

        const lat = d.lat >= 0 ? `${d.lat.toFixed(6)}° N` : `${Math.abs(d.lat).toFixed(6)}° S`;
        const lng = d.lng >= 0 ? `${d.lng.toFixed(6)}° E` : `${Math.abs(d.lng).toFixed(6)}° W`;
        const ts  = new Date(d.timestamp.endsWith('Z') ? d.timestamp : d.timestamp + 'Z');
        const ageMs = Date.now() - ts.getTime();
        const isLive = ageMs < 10000;

        document.getElementById('gps-lat').textContent      = lat;
        document.getElementById('gps-lng').textContent      = lng;
        document.getElementById('gps-speed').textContent    = `${d.speedKmh} km/h`;
        document.getElementById('gps-distance').textContent = `${(d.totalDistanceM / 1000).toFixed(2)} km`;
        document.getElementById('gps-lastfix').textContent  = ts.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });

        const statusEl = document.getElementById('gps-status');
        const statusItem = document.getElementById('gps-status-item');
        statusEl.textContent = isLive ? 'Active' : 'Stale';
        statusEl.style.color = isLive ? '#22c55e' : '#ef4444';
        statusItem.style.borderLeft = `3px solid ${isLive ? '#22c55e' : '#ef4444'}`;
    } catch (e) { console.error('gps fetch error:', e); }
}

// ── Initial load ──────────────────────────────────────────────────────────
fetchChartFromDB();
fetchUptime();
fetchActiveSensors();
fetchActiveAlerts();
fetchSystemHealth();
fetchGPS();

function getChartPollMs() {
    if (typeof AccelConfig === 'undefined') return 3000;
    const avg = (AccelConfig.getOdr(1) + AccelConfig.getOdr(2)) / 2;
    if (avg >= 150) return 3000;
    if (avg >= 75)  return 6000;
    return 12000;
}
let _mgmtPollTimer = null;
function restartMgmtPoll() {
    if (_mgmtPollTimer) clearInterval(_mgmtPollTimer);
    _mgmtPollTimer = setInterval(() => { 
        fetchChartFromDB();
        fetchActiveSensors();
        fetchSystemHealth();
        fetchGPS();
    }, getChartPollMs());
}
if (typeof AccelConfig !== 'undefined') AccelConfig.onChange(restartMgmtPoll);
restartMgmtPoll();
setInterval(() => { 
    fetchUptime();
    fetchActiveAlerts(); 
    }, 15000);
