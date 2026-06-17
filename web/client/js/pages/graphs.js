/* =============================================================================
   graphs.js — FINAL VERSION (Dynamic 24h tab, offline/online aware)
   - 24h tab: LIVE rolling when hardware online, else yesterday's average line
   - 7d / 30d tabs: always show average line from DB
   - Historical cards (yesterday, 7d, 30d) always populated
============================================================================= */

const SERVER_URL = window.location.origin;

// ── Hardware online detection ─────────────────────────────────────────────
let lastSensorDataTime = 0;
const DATA_TIMEOUT_MS = 10000;   // 10 seconds without data → offline
let isHardwareOnline = false;

function updateOnlineStatus() {
    const now = Date.now();
    const wasOnline = isHardwareOnline;
    isHardwareOnline = (now - lastSensorDataTime) < DATA_TIMEOUT_MS;

    // If we just went offline and the 24h tab is active, switch to yesterday timeseries
    if (wasOnline && !isHardwareOnline && currentPeriod === 1) {
        console.log('[RCI] Hardware offline → loading yesterday timeseries');
        activateRCITab(1);   // activateRCITab sees isHardwareOnline=false → calls fetchAndRenderRCITimeseries('24h')
    }
    // If we just came online and the 24h tab is active, clear to live rolling mode
    if (!wasOnline && isHardwareOnline && currentPeriod === 1) {
        console.log('[RCI] Hardware online → switching to LIVE rolling');
        rciChart.data.labels = emptyLabels(RCI_N);
        rciChart.data.datasets[0].data = new Array(RCI_N).fill(null);
        rciChart.options.scales.x.ticks.maxTicksLimit = 8;
        rciChart.update();
    }
}

// Check online status every 2 seconds
setInterval(updateOnlineStatus, 2000);

// ── Timestamp ticker ──────────────────────────────────────────────────────
(function tickTimestamp() {
    const el = document.getElementById('currentTimestamp');
    if (el) {
        const n = new Date();
        el.textContent = n.toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false
        });
    }
    setTimeout(tickTimestamp, 1000);
})();

// ── Channel derivation ────────────────────────────────────────────────────
function getVert(x, y, z) { return Math.abs(z); }
function getLat(x, y, z) { return Math.sqrt(x * x + y * y); }

// ── Distance tracking ─────────────────────────────────────────────────────
let distanceM = 0;
const LIVE_DIST_N = 300;   // rolling window in live mode (~5 min at 1 packet/s)
const MAX_DIST_POINTS = 10000;

let distMode = 'live';     // 'live' | 'history'
let distTimestamps = [];   // parallel to distanceChart.data.labels — ISO strings

function formatDistLabel(m) {
    const km = Math.floor(m / 1000);
    const rem = m % 1000;
    return km + '.' + String(rem).padStart(3, '0') + ' km';
}
function advanceDistance() { distanceM += 10; }

// ── Rolling buffers (for RCI and raw subplots only) ───────────────────────
const RAW_N = 80;
const RCI_N = 60;

function zeroBuf(n, v = null) { return new Array(n).fill(v); }
function emptyLabels(n) { return new Array(n).fill(''); }

function rollDataset(chart, datasetIndex, value, label) {
    const ds = chart.data.datasets[datasetIndex];
    ds.data.push(value);
    ds.data.shift();
    if (label !== undefined) {
        chart.data.labels.push(label);
        chart.data.labels.shift();
    }
}

// ── Distance Chart ────────────────────────────────────────────────────────
let _distAutoFollow = true;

const distanceChart = new Chart(document.getElementById('distanceChart').getContext('2d'), {
    type: 'line',
    data: {
        labels: [],
        datasets: [
            { label: 'AB-L-VERT', data: [], borderColor: '#22c55e', borderWidth: 2, tension: 0.3, pointRadius: 0, spanGaps: false },
            { label: 'AB-L-LAT',  data: [], borderColor: '#eab308', borderWidth: 2, tension: 0.3, pointRadius: 0, spanGaps: false },
            { label: 'AB-R-VERT', data: [], borderColor: '#ef4444', borderWidth: 2, tension: 0.3, pointRadius: 0, spanGaps: false },
            { label: 'AB-R-LAT',  data: [], borderColor: '#8b5cf6', borderWidth: 2, tension: 0.3, pointRadius: 0, spanGaps: false }
        ]
    },
    options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: {
            legend: { display: false },
            tooltip: {
                callbacks: {
                    title(items) {
                        const i = items[0].dataIndex;
                        const dist = items[0].label;
                        const ts = distTimestamps[i];
                        if (!ts) return dist;
                        const d = new Date(ts);
                        const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                        const date = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
                        return `${dist}  ·  ${date} ${time}`;
                    }
                }
            },
            zoom: {
                pan: {
                    enabled: true, mode: 'x',
                    onPanStart: () => { _distAutoFollow = false; }
                },
                zoom: {
                    wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x',
                    onZoomStart: () => { _distAutoFollow = false; }
                }
            }
        },
        scales: {
            y: { suggestedMin: 0, suggestedMax: 2, title: { display: true, text: 'Acceleration (g)' }, grid: { color: '#f1f5f9' }, ticks: { callback: v => v.toFixed(2) + 'g' } },
            x: { title: { display: true, text: 'Distance' }, ticks: { maxRotation: 45, maxTicksLimit: 12 } }
        }
    }
});

function _clearDistChart() {
    distanceChart.data.labels = [];
    distanceChart.data.datasets.forEach(ds => ds.data = []);
    distTimestamps = [];
    distanceChart.resetZoom();
    distanceChart.update('none');
}

function _setDistBadge(mode) {
    const badge = document.getElementById('distModeBadge');
    const btnLive = document.getElementById('btnLiveMode');
    if (badge) {
        badge.textContent = mode === 'live' ? '● LIVE' : '◆ HISTORY';
        badge.style.background = mode === 'live' ? '#22c55e' : '#0891b2';
    }
    if (btnLive) btnLive.style.display = mode === 'history' ? '' : 'none';
}

function _setDistMsg(msg) {
    const el = document.getElementById('distChartMsg');
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? '' : 'none';
}

function jumpToLatest() {
    _distAutoFollow = true;
    distanceChart.resetZoom();
}

function resetDistZoom() {
    distanceChart.resetZoom();
}

function switchToLiveMode() {
    distMode = 'live';
    distanceM = 0;
    _distAutoFollow = true;
    _clearDistChart();
    _setDistBadge('live');
    _setDistMsg('');
}

async function loadHistoricalRange() {
    const fromEl = document.getElementById('histFrom');
    const toEl   = document.getElementById('histTo');
    if (!fromEl.value || !toEl.value) { _setDistMsg('Please select both a From and To date/time.'); return; }

    const fromISO = new Date(fromEl.value).toISOString();
    const toISO   = new Date(toEl.value).toISOString();
    if (fromISO >= toISO) { _setDistMsg('"From" must be before "To".'); return; }

    _setDistMsg('Loading…');
    try {
        const res  = await fetch(`${SERVER_URL}/api/history/distance-chart?from=${encodeURIComponent(fromISO)}&to=${encodeURIComponent(toISO)}&limit=5000`);
        const data = await res.json();
        const left  = data.left  || [];
        const right = data.right || [];

        if (!left.length && !right.length) {
            _setDistMsg('No data found for the selected period.');
            return;
        }

        const n = Math.max(left.length, right.length);
        const labels = [], lVert = [], lLat = [], rVert = [], rLat = [];
        distTimestamps = [];
        for (let i = 0; i < n; i++) {
            const distM = i * 10;
            const km = Math.floor(distM / 1000), rem = distM % 1000;
            labels.push(km + '.' + String(rem).padStart(3, '0') + ' km');
            distTimestamps.push((left[i] || right[i] || {}).timestamp || null);
            if (left[i])  { const {x=0,y=0,z=0} = left[i];  lVert.push(Math.abs(z)); lLat.push(Math.sqrt(x*x+y*y)); }
            else          { lVert.push(null); lLat.push(null); }
            if (right[i]) { const {x=0,y=0,z=0} = right[i]; rVert.push(Math.abs(z)); rLat.push(Math.sqrt(x*x+y*y)); }
            else          { rVert.push(null); rLat.push(null); }
        }

        distanceChart.data.labels           = labels;
        distanceChart.data.datasets[0].data = lVert;
        distanceChart.data.datasets[1].data = lLat;
        distanceChart.data.datasets[2].data = rVert;
        distanceChart.data.datasets[3].data = rLat;
        distanceChart.resetZoom();
        distanceChart.update('none');

        distMode = 'history';
        _distAutoFollow = false;
        _setDistBadge('history');
        _setDistMsg(`Showing ${n} points · ${fromEl.value.replace('T', ' ')} → ${toEl.value.replace('T', ' ')} · Drag to scroll, scroll wheel to zoom`);
    } catch (e) {
        _setDistMsg('Failed to load history: ' + e.message);
    }
}

// ── Raw subplots ──────────────────────────────────────────────────────────
function makeSubplot(id, color, initVal = 0) {
    const canvas = document.getElementById(id);
    if (!canvas) return null;
    const isZ = initVal > 1;   // Z axis initialised at 9.8g, X/Y at 0
    return new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: zeroBuf(RAW_N, ''),
            datasets: [{ data: zeroBuf(RAW_N, initVal), borderColor: color, backgroundColor: color + '18', borderWidth: 1.5, tension: 0.3, pointRadius: 0, fill: true }]
        },
        options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: {
                y: {
                    suggestedMin: isZ ? 0.0 : -2.0,
                    suggestedMax: isZ ? 2.0 :  2.0,
                    grid: { color: '#f1f5f9' },
                    ticks: { maxTicksLimit: 3, font: { size: 9 }, color: '#94a3b8', callback: v => v.toFixed(2) + 'g' }
                },
                x: { display: false }
            }
        }
    });
}

const subplots = {
    s1: { x: makeSubplot('raw1X_chart', '#ef4444', 0), y: makeSubplot('raw1Y_chart', '#22c55e', 0), z: makeSubplot('raw1Z_chart', '#3b82f6', 9.8) },
    s2: { x: makeSubplot('raw2X_chart', '#ef4444', 0), y: makeSubplot('raw2Y_chart', '#22c55e', 0), z: makeSubplot('raw2Z_chart', '#3b82f6', 9.8) }
};

function pushSubplot(chart, value) {
    if (!chart) return;
    chart.data.datasets[0].data.shift();
    chart.data.datasets[0].data.push(value);
    chart.update('none');
}

// ── Sperling Ride Index Wz ────────────────────────────────────────────────
// Input:  rms_g  — RMS acceleration in g-units (as stored in DB / sent by sensor)
// Step 1: Convert g → cm/s²   (1 g = 981 cm/s²)
// Step 2: Apply frequency weighting Bf at 100 Hz.
//         For vertical vibration (ISO 2631 simplified Sperling):
//           Bf ≈ 0.325 at f = 100 Hz  (weighting curve peak ~5–20 Hz, falls off above)
//         This brings typical train values (rms ~0.1–1.3 g) into the 2–5 Wz range.
// Step 3: Wz = 0.896 × (a_rms_cm × Bf)^0.3
//
// Why Bf = 0.325 and NOT 1.0?
//   Bf = 1.0 is only correct when a_rms is already the frequency-weighted RMS (e.g.
//   from a filtered signal).  Our sensor stores the raw RMS at 100 Hz, so we must
//   apply the weighting factor manually.  At 100 Hz vertical: Bf ≈ 0.325.
// ── Dynamic Sperling Bf — tracks configured ODR ───────────────────────────
// Bf (frequency weighting) varies with the ODR set by the user in settings:
//    50 Hz → Bf = 0.48   (closer to 5–20 Hz sensitivity band)
//   100 Hz → Bf = 0.325  (original calibrated value)
//   200 Hz → Bf = 0.18   (far above sensitivity band, attenuated)
let _configuredOdrHz = 100;   // updated from /api/odr-config on load + socket event

function _getSperlingBf() {
    if (_configuredOdrHz >= 150) return 0.18;
    if (_configuredOdrHz >= 75) return 0.325;
    return 0.48;
}

function calculateSperlingWz(rmsG) {
    if (rmsG == null || isNaN(rmsG) || rmsG <= 0) return null;
    const a_rms_cms2 = rmsG * 981;                            // g  → cm/s²
    const a_weighted = a_rms_cms2 * _getSperlingBf();         // apply configured frequency weighting
    const wz = 0.896 * Math.pow(a_weighted, 0.3);             // Sperling formula
    return Math.round(wz * 100) / 100;                        // 2 d.p.
}

function setRCIStatus(wz) {
    const el = document.getElementById('rciStatus');
    if (!el) return;
    if (wz <= 2.0) { el.textContent = 'Excellent'; el.className = 'rci-status status-excellent'; }
    else if (wz <= 2.75) { el.textContent = 'Good'; el.className = 'rci-status status-good'; }
    else if (wz <= 3.25) { el.textContent = 'Fair'; el.className = 'rci-status status-fair'; }
    else if (wz <= 3.75) { el.textContent = 'Poor'; el.className = 'rci-status status-poor'; }
    else { el.textContent = 'Very Poor'; el.className = 'rci-status status-poor'; }
}

// ── RCI Chart ─────────────────────────────────────────────────────────────
// Y-axis is NOT hard-capped — it auto-scales to actual Wz values.
// Sperling comfort zones (reference lines drawn via annotation plugin or
// background segment colours via custom plugin below):
//   ≤ 2.0  Excellent  (green)
//   ≤ 2.75 Good       (blue)
//   ≤ 3.25 Fair       (yellow)
//   ≤ 3.75 Poor       (orange)
//   > 3.75 Very Poor  (red)

// Inline background-band plugin — draws horizontal coloured bands behind the line
const rciZoneBandPlugin = {
    id: 'rciZoneBands',
    beforeDraw(chart) {
        const { ctx, chartArea: { left, right, top, bottom }, scales: { y } } = chart;
        if (!y) return;
        const bands = [
            { from: 0, to: 2.0, color: 'rgba(34,197,94,0.08)' },   // Excellent
            { from: 2.0, to: 2.75, color: 'rgba(59,130,246,0.08)' },   // Good
            { from: 2.75, to: 3.25, color: 'rgba(234,179,8,0.10)' },   // Fair
            { from: 3.25, to: 3.75, color: 'rgba(249,115,22,0.12)' },   // Poor
            { from: 3.75, to: 99, color: 'rgba(239,68,68,0.12)' },   // Very Poor
        ];
        ctx.save();
        for (const b of bands) {
            const yTop = Math.max(y.getPixelForValue(b.to), top);
            const yBottom = Math.min(y.getPixelForValue(b.from), bottom);
            if (yTop >= yBottom) continue;
            ctx.fillStyle = b.color;
            ctx.fillRect(left, yTop, right - left, yBottom - yTop);
        }
        ctx.restore();
    }
};

const rciChart = new Chart(document.getElementById('rciChart').getContext('2d'), {
    type: 'line',
    plugins: [rciZoneBandPlugin],
    data: {
        labels: emptyLabels(RCI_N),
        datasets: [{
            label: 'Sperling Wz',
            data: new Array(RCI_N).fill(null),   // null = no line until real data arrives
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59,130,246,0.06)',
            borderWidth: 2.5,
            tension: 0.4,
            fill: false,
            pointRadius: 0,
            spanGaps: false                       // do not connect across nulls
        }]
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        plugins: {
            legend: { display: false },
            tooltip: {
                callbacks: {
                    label: ctx => {
                        const wz = ctx.parsed.y;
                        const grade = wz <= 2.0 ? 'Excellent'
                            : wz <= 2.75 ? 'Good'
                                : wz <= 3.25 ? 'Fair'
                                    : wz <= 3.75 ? 'Poor'
                                        : 'Very Poor';
                        return `Wz ${wz.toFixed(2)} — ${grade}`;
                    }
                }
            }
        },
        scales: {
            y: {
                // Dynamic — no hard min/max; Chart.js will fit to data
                suggestedMin: 1.0,
                suggestedMax: 5.0,
                title: { display: true, text: 'Sperling Ride Index Wz' },
                grid: { color: '#f1f5f9' },
                ticks: { stepSize: 0.25, callback: v => v.toFixed(2) }
            },
            x: {
                ticks: { maxRotation: 45, maxTicksLimit: 10 },
                grid: { display: false }
            }
        }
    }
});

// ── Tab state ─────────────────────────────────────────────────────────────
let currentPeriod = 1;   // 1=24h, 7=7d, 30=30d


// ── Fetch average Wz (for historical summary cards only) ──────────────────
async function fetchAverageWz(days) {
    try {
        const res = await fetch(`${SERVER_URL}/api/rci/average?days=${days}`);
        const data = await res.json();
        if (data.avgRms != null) return calculateSperlingWz(data.avgRms);
        return null;
    } catch (e) {
        console.error(`[RCI] Failed to fetch ${days}d average:`, e);
        return null;
    }
}

// ── Fetch RCI timeseries from DB and render on chart ──────────────────────
// period: '24h' | '7d' | '30d'
// API returns raw rms_v_g (g-units).  ALL Sperling computation is done here.

async function fetchAndRenderRCITimeseries(period) {
    try {
        const res = await fetch(`${SERVER_URL}/api/rci/timeseries?period=${period}`);
        const data = await res.json();

        if (!data.points || !data.points.length) {
            console.warn(`[RCI] No timeseries data for period=${period}`);
            return null;
        }

        // Server returns DESC (latest first) — reverse to chronological for chart
        const ordered = [...data.points].reverse();

        // ── Sperling Wz computation — ALL unit conversion done here ──────
        // rms_v_g is in g-units  →  convert to cm/s²  →  apply Bf  →  Wz
        // Formula: Wz = 0.896 × (rms_g × 981 × Bf)^0.3
        //   where Bf = 0.325 for vertical vibration at FREQ_HZ = 100 Hz
        const wzValues = ordered.map(p => {
            const wz = calculateSperlingWz(p.rms_v_g);
            return wz !== null ? wz : null;
        });

        // Filter nulls for stats only
        const validWz = wzValues.filter(v => v !== null);
        if (!validWz.length) {
            console.warn(`[RCI] All Wz values null for period=${period}`);
            return null;
        }

        // ── Build timestamp labels ────────────────────────────────────────
        const labels = ordered.map(p => {
            const d = new Date(p.timestamp);
            if (period === '24h') {
                return d.toLocaleTimeString('en-IN', {
                    timeZone: 'Asia/Kolkata',
                    hour: '2-digit', minute: '2-digit', hour12: false
                });
            } else if (period === '7d') {
                return d.toLocaleDateString('en-IN', {
                    timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit'
                }) + ' ' + d.toLocaleTimeString('en-IN', {
                    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false
                });
            } else {
                return d.toLocaleDateString('en-IN', {
                    timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit'
                });
            }
        });

        // ── Push to chart — Y-axis will auto-scale to actual Wz range ────
        rciChart.data.labels = labels;
        rciChart.data.datasets[0].data = wzValues;
        rciChart.options.scales.x.ticks.maxTicksLimit = period === '24h' ? 12 : (period === '7d' ? 14 : 15);
        rciChart.update();

        // ── Stats ────────────────────────────────────────────────────────
        const sumWz = validWz.reduce((a, b) => a + b, 0);
        const avgWz = sumWz / validWz.length;
        const bestWz = Math.min(...validWz);    // lower Wz = smoother ride
        const worstWz = Math.max(...validWz);
        const latestWz = wzValues[wzValues.length - 1] ?? wzValues.find(v => v !== null);

        document.getElementById('rciCurrent').textContent = latestWz.toFixed(1);
        setRCIStatus(latestWz);
        document.getElementById('rciAvg').textContent = avgWz.toFixed(1);
        document.getElementById('rciBest').textContent = bestWz.toFixed(1);
        document.getElementById('rciWorst').textContent = worstWz.toFixed(1);

        // Debug log with full unit chain
        const sampleRmsG = ordered[ordered.length - 1]?.rms_v_g ?? 0;
        const _bf = _getSperlingBf();
        console.log(
            `[RCI] period=${period} | ODR=${_configuredOdrHz}Hz Bf=${_bf} | ${validWz.length} pts | ` +
            `latest rms=${sampleRmsG}g → ` +
            `a=${(sampleRmsG * 981).toFixed(1)} cm/s² → ` +
            `a_weighted=${(sampleRmsG * 981 * _bf).toFixed(1)} cm/s² → ` +
            `Wz=${latestWz.toFixed(2)} | avg=${avgWz.toFixed(2)} best=${bestWz.toFixed(2)} worst=${worstWz.toFixed(2)}`
        );

        return { points: ordered, wzValues, avgWz, bestWz, worstWz };

    } catch (e) {
        console.error(`[RCI] fetchAndRenderRCITimeseries(${period}) failed:`, e);
        return null;
    }
}

// ── Update historical summary cards ──────────────────────────────────────
async function updateHistoricalCards() {
    const yesterdayWz = await fetchAverageWz(1);
    const weekWz = await fetchAverageWz(7);
    const monthWz = await fetchAverageWz(30);
    if (yesterdayWz !== null) document.getElementById('rciYesterday').textContent = yesterdayWz.toFixed(1);
    if (weekWz !== null) document.getElementById('rciWeekAvg').textContent = weekWz.toFixed(1);
    if (monthWz !== null) document.getElementById('rciMonthAvg').textContent = monthWz.toFixed(1);
}

// ── Activate tab (called on tab click or programmatically) ─────────────────
async function activateRCITab(days) {
    currentPeriod = days;
    document.querySelectorAll('.rci-tab').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.days) === days);
    });

    if (days === 1) {
        if (isHardwareOnline) {
            // Hardware ONLINE: live rolling mode — reset chart to empty, socket data will fill it
            console.log('[RCI] 24h tab: hardware ONLINE → LIVE rolling');
            rciChart.data.labels = emptyLabels(RCI_N);
            rciChart.data.datasets[0].data = new Array(RCI_N).fill(null);
            rciChart.options.scales.x.ticks.maxTicksLimit = 8;
            rciChart.update();
        } else {
            // Hardware OFFLINE: show yesterday's timeseries from DB
            console.log('[RCI] 24h tab: hardware OFFLINE → showing yesterday timeseries');
            const result = await fetchAndRenderRCITimeseries('24h');
            if (!result) {
                // No data at all — show empty chart
                rciChart.data.labels = emptyLabels(RCI_N);
                rciChart.data.datasets[0].data = new Array(RCI_N).fill(null);
                rciChart.update();
                document.getElementById('rciAvg').textContent = '—';
                document.getElementById('rciBest').textContent = '—';
                document.getElementById('rciWorst').textContent = '—';
            }
        }
    } else {
        // 7d or 30d: always fetch and render full timeseries from DB
        const periodStr = days === 7 ? '7d' : '30d';
        console.log(`[RCI] ${periodStr} tab → fetching timeseries`);
        const result = await fetchAndRenderRCITimeseries(periodStr);
        if (!result) {
            rciChart.data.labels = emptyLabels(RCI_N);
            rciChart.data.datasets[0].data = new Array(RCI_N).fill(null);
            rciChart.update();
            document.getElementById('rciAvg').textContent = '—';
            document.getElementById('rciBest').textContent = '—';
            document.getElementById('rciWorst').textContent = '—';
        }
    }
}

// ── Sensor cache ──────────────────────────────────────────────────────────
const cache = {
    left: { x: 0, y: 0, z: 0, vert: 0, lat: 0, rms: null },
    right: { x: 0, y: 0, z: 0, vert: 0, lat: 0, rms: null }
};

let rafPending = false;
function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
        distanceChart.update('none');
        rciChart.update('none');
        rafPending = false;
    });
}

// ── Socket.IO ─────────────────────────────────────────────────────────────
const socket = io(SERVER_URL, { transports: ['websocket', 'polling'], reconnectionDelay: 1000 });

socket.on('connect', () => console.log('[graphs] Socket connected ✓'));
socket.on('disconnect', () => console.warn('[graphs] Disconnected'));

// ── Sync Sperling Bf when ODR changes from settings page ──────────────────
socket.on('odr-config-changed', (cfg) => {
    const avgOdr = (cfg.accel1 + cfg.accel2) / 2;
    _configuredOdrHz = avgOdr;
    console.log(`[graphs] ODR changed → ${avgOdr}Hz  Bf=${_getSperlingBf()} — refreshing RCI`);
    const periodStr = currentPeriod === 1 ? '24h' : currentPeriod === 7 ? '7d' : '30d';
    if (currentPeriod !== 1 || !isHardwareOnline) fetchAndRenderRCITimeseries(periodStr);
});

// ── Initial load ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    // Default the range pickers: today 00:00 → now
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const localNow  = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const localStart = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T00:00`;
    const fromEl = document.getElementById('histFrom');
    const toEl2  = document.getElementById('histTo');
    if (fromEl) fromEl.value = localStart;
    if (toEl2)  toEl2.value  = localNow;

    // Pre-fill raw subplots only (fast — doesn't touch the distance chart)
    if (typeof window.preloadGraphHistory === 'function') {
        await window.preloadGraphHistory(null, subplots);
    }

    // Attach tab listeners
    document.querySelectorAll('.rci-tab').forEach(btn => {
        btn.addEventListener('click', () => activateRCITab(parseInt(btn.dataset.days)));
    });

    // Load historical cards
    updateHistoricalCards();
    // Refresh cards every hour
    setInterval(updateHistoricalCards, 60 * 60 * 1000);

    // Activate default tab (24h) – will decide live vs historical based on current online status
    activateRCITab(1);

    // Fetch configured ODR so Sperling Bf is correct from the first frame
    fetch(`${SERVER_URL}/api/odr-config`)
        .then(r => r.json())
        .then(cfg => {
            _configuredOdrHz = (cfg.accel1 + cfg.accel2) / 2;
            console.log(`[graphs] ODR loaded → ${_configuredOdrHz}Hz  Bf=${_getSperlingBf()}`);
        })
        .catch(() => { });
});

// ── Live data handler ─────────────────────────────────────────────────────
socket.on('accelerometer-data', data => {
    const side = data.sensor;
    if (side !== 'left' && side !== 'right') return;

    lastSensorDataTime = Date.now();
    updateOnlineStatus();

    const x = data.x ?? 0;
    const y = data.y ?? 0;
    const z = data.z ?? 0;
    const rmsV = (data.rmsV != null && data.rmsV > 0) ? data.rmsV : null;

    const vert = getVert(x, y, z);
    const lat = getLat(x, y, z);

    // Update cache with raw values
    cache[side].x = x;
    cache[side].y = y;
    cache[side].z = z;
    cache[side].vert = vert;
    cache[side].lat = lat;
    cache[side].rms = rmsV;   // store RMS (g)

    // Raw subplots
    const sp = side === 'left' ? subplots.s1 : subplots.s2;
    const pfx = side === 'left' ? 'raw1' : 'raw2';
    pushSubplot(sp.x, x);
    pushSubplot(sp.y, y);
    pushSubplot(sp.z, z);

    document.getElementById(pfx + 'X').textContent = x.toFixed(4) + ' g';
    document.getElementById(pfx + 'Y').textContent = y.toFixed(4) + ' g';
    document.getElementById(pfx + 'Z').textContent = z.toFixed(4) + ' g';

    const now = new Date();
    document.getElementById(pfx + 'RefreshTime').textContent = '🕐 ' + now.toLocaleTimeString('en-IN', { hour12: false }) + ' ' + now.toLocaleDateString('en-IN');

    // ── Distance chart (left sensor drives distance, live mode only) ─────
    if (side === 'left' && distMode === 'live') {
        advanceDistance();
        const distLabel = formatDistLabel(distanceM);

        distanceChart.data.labels.push(distLabel);
        distTimestamps.push(new Date().toISOString());
        distanceChart.data.datasets[0].data.push(vert);
        distanceChart.data.datasets[1].data.push(lat);
        distanceChart.data.datasets[2].data.push(cache.right.vert);
        distanceChart.data.datasets[3].data.push(cache.right.lat);

        // Roll off oldest once we exceed the live window
        if (distanceChart.data.labels.length > LIVE_DIST_N) {
            distanceChart.data.labels.shift();
            distTimestamps.shift();
            distanceChart.data.datasets.forEach(ds => ds.data.shift());
        }
    }

    // ── RCI: Use average RMS from both accelerometers ─────────────────────
    const leftRms = cache.left.rms;
    const rightRms = cache.right.rms;
    let avgRms = null;

    if (leftRms !== null && rightRms !== null) {
        avgRms = (leftRms + rightRms) / 2;
    } else if (leftRms !== null) {
        avgRms = leftRms;
    } else if (rightRms !== null) {
        avgRms = rightRms;
    } else {
        // fallback to vertical g if RMS not available (should rarely happen)
        avgRms = (cache.left.vert + cache.right.vert) / 2;
    }

    const wz = calculateSperlingWz(avgRms);

    if (wz !== null) {
        if (currentPeriod === 1 && isHardwareOnline) {
            // Live rolling update (only on left packet to keep consistent time step)
            if (side === 'left') {
                const distLabel = formatDistLabel(distanceM);
                rollDataset(rciChart, 0, wz, distLabel);
                const rciData = rciChart.data.datasets[0].data.filter(v => v !== null);
                if (rciData.length) {
                    const avgRCI = rciData.reduce((a, b) => a + b, 0) / rciData.length;
                    const bestWz = Math.min(...rciData);
                    const worstWz = Math.max(...rciData);
                    document.getElementById('rciCurrent').textContent = wz.toFixed(1);
                    document.getElementById('rciAvg').textContent = avgRCI.toFixed(1);
                    document.getElementById('rciBest').textContent = bestWz.toFixed(1);
                    document.getElementById('rciWorst').textContent = worstWz.toFixed(1);
                }
            } else {
                // Right sensor only updates current reading, chart waits for left
                document.getElementById('rciCurrent').textContent = wz.toFixed(1);
            }
            setRCIStatus(wz);
        } else {
            // Not in live mode – just update the current reading
            document.getElementById('rciCurrent').textContent = wz.toFixed(1);
            setRCIStatus(wz);
        }
    }

    // Update legend values (always)
    document.getElementById('distVal1').textContent = cache.left.vert.toFixed(4) + ' g';
    document.getElementById('distVal2').textContent = cache.left.lat.toFixed(4) + ' g';
    document.getElementById('distVal3').textContent = cache.right.vert.toFixed(4) + ' g';
    document.getElementById('distVal4').textContent = cache.right.lat.toFixed(4) + ' g';

    scheduleRender();
});


// ── Raw DB polling (fallback) ─────────────────────────────────────────────
async function fetchRawFromDB() {
    try {
        const data = await fetch(`${SERVER_URL}/api/acceleration/channels?minutes=60`).then(r => r.json());
        if (!data.length) return;
        const slice = data.slice(-60);
        slice.forEach(pt => {
            if (pt.lv != null) pushSubplot(subplots.s1.z, pt.lv);
            if (pt.ll != null) pushSubplot(subplots.s1.x, pt.ll);
            if (pt.rv != null) pushSubplot(subplots.s2.z, pt.rv);
            if (pt.rl != null) pushSubplot(subplots.s2.x, pt.rl);
        });
    } catch (e) { console.error('[raw-db]', e); }
}
fetchRawFromDB();
setInterval(fetchRawFromDB, 3000);