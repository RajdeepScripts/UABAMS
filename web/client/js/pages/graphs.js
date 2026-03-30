/* =============================================================================
   graphs.js — RailMonitor real-time graphs
   Channel derivation from raw axes:
     VERT = |Z|              (vertical peak, Z axis carries gravity + vibration)
     LAT  = sqrt(X²+Y²)     (lateral peak, horizontal plane magnitude)
   Applied per sensor side → 4 channels: AB-L-VERT, AB-L-LAT, AB-R-VERT, AB-R-LAT
============================================================================= */

const SERVER_URL = window.location.origin;

// ── Historical mode detection ─────────────────────────────────────────────
const _gp        = new URLSearchParams(location.search);
const _histFrom  = _gp.get('from');
const _histTo    = _gp.get('to');
const IS_HISTORICAL = !!(_histFrom && _histTo);

// ── Channel derivation ────────────────────────────────────────────────────
function getVert(x, y, z) { return Math.abs(z); }
function getLat (x, y, z) { return Math.sqrt(x * x + y * y); }

// ── Distance tracking (10 m steps, advances on each left-sensor packet) ───
const BASE_DISTANCE_M = 1390 * 1000; // adjust to match your train's start coordinate
let distanceM = BASE_DISTANCE_M;

function formatDistLabel(m) {
    const km  = Math.floor(m / 1000);
    const rem = m % 1000;
    return km + '.' + String(rem).padStart(3, '0') + ' km';
    // e.g. 1390.000 km → 1390.010 km → 1390.020 km ...
}

function advanceDistance() { distanceM += 10; }

// ── Rolling buffer helpers ────────────────────────────────────────────────
const DIST_N = 100;  // 100 × 10 m = 1 km window
const RAW_N  = 80;
const RCI_N  = 60;

function zeroBuf(n, v = 0) { return new Array(n).fill(v); }
function emptyLabels(n)     { return new Array(n).fill(''); }

const initDistLabels = Array.from({ length: DIST_N },
    (_, i) => formatDistLabel(BASE_DISTANCE_M + i * 10));

function roll(chart, dsIdx, value, label) {
    chart.data.datasets[dsIdx].data.push(value);
    chart.data.datasets[dsIdx].data.shift();
    if (label !== undefined) {
        chart.data.labels.push(label);
        chart.data.labels.shift();
    }
}

// ── Chart 1: Acceleration vs Distance — 4 channels ───────────────────────
const distanceChart = new Chart(
    document.getElementById('distanceChart').getContext('2d'), {
    type: 'line',
    data: {
        labels: [...initDistLabels],
        datasets: [
            { label: 'AB-L-VERT', data: zeroBuf(DIST_N), borderColor: '#22c55e', backgroundColor: 'transparent', borderWidth: 2, tension: 0.3, pointRadius: 0 },
            { label: 'AB-L-LAT',  data: zeroBuf(DIST_N), borderColor: '#eab308', backgroundColor: 'transparent', borderWidth: 2, tension: 0.3, pointRadius: 0 },
            { label: 'AB-R-VERT', data: zeroBuf(DIST_N), borderColor: '#ef4444', backgroundColor: 'transparent', borderWidth: 2, tension: 0.3, pointRadius: 0 },
            { label: 'AB-R-LAT',  data: zeroBuf(DIST_N), borderColor: '#8b5cf6', backgroundColor: 'transparent', borderWidth: 2, tension: 0.3, pointRadius: 0 }
        ]
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: false } },
        scales: {
            y: {
                beginAtZero: true,
                title: { display: true, text: 'Acceleration (g)' },
                grid: { color: '#f1f5f9' },
                ticks: { callback: v => v.toFixed(3) }
            },
            x: {
                title: { display: true, text: 'Distance (km)' },
                ticks: { maxRotation: 45, maxTicksLimit: 10 }
            }
        }
    }
});

// ── Raw axis subplot factory ───────────────────────────────────────────────
// One chart per axis — single dataset, single Y-axis, no X labels
// Each subplot is 80px tall, stacked vertically inside the card
function makeSubplot(canvasId, color, initVal = 0) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    return new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: zeroBuf(RAW_N, ''),
            datasets: [{
                data:            zeroBuf(RAW_N, initVal),
                borderColor:     color,
                backgroundColor: color + '18',
                borderWidth:     1.5,
                tension:         0.3,
                pointRadius:     0,
                fill:            true
            }]
        },
        options: {
            responsive:          true,
            maintainAspectRatio: false,
            animation:           false,
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: {
                y: {
                    grid:  { color: '#f1f5f9' },
                    ticks: {
                        maxTicksLimit: 3,
                        font:  { size: 9 },
                        color: '#94a3b8',
                        callback: v => v.toFixed(2)
                    }
                },
                x: { display: false }
            }
        }
    });
}

// ── 6 subplot charts: X, Y, Z × 2 accelerometers ─────────────────────────
const subplots = {
    s1: {
        x: makeSubplot('raw1X_chart', '#ef4444', 0),
        y: makeSubplot('raw1Y_chart', '#22c55e', 0),
        z: makeSubplot('raw1Z_chart', '#3b82f6', 9.8)
    },
    s2: {
        x: makeSubplot('raw2X_chart', '#ef4444', 0),
        y: makeSubplot('raw2Y_chart', '#22c55e', 0),
        z: makeSubplot('raw2Z_chart', '#3b82f6', 9.8)
    }
};

// Push one value into a subplot rolling buffer and update
function pushSubplot(chart, value) {
    if (!chart) return;
    chart.data.datasets[0].data.shift();
    chart.data.datasets[0].data.push(value);
    chart.update('none');
}



// ── Chart 3: Ride Comfort Index ───────────────────────────────────────────
const rciChart = new Chart(
    document.getElementById('rciChart').getContext('2d'), {
    type: 'line',
    data: {
        labels: emptyLabels(RCI_N),
        datasets: [{
            label: 'RCI',
            data: zeroBuf(RCI_N, 50),
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59,130,246,0.1)',
            borderWidth: 2, tension: 0.4, fill: true, pointRadius: 2
        }]
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: false } },
        scales: {
            y: { min: 0, max: 100, title: { display: true, text: 'RCI Score' }, grid: { color: '#f1f5f9' } },
            x: { ticks: { maxRotation: 45, maxTicksLimit: 8 } }
        }
    }
});

// ── RCI: derived from VERT (Z peak) — ISO 2631 simplified ─────────────────
// 0 g = 100 (perfect), 2 g = 0 (very poor)
function vertToRCI(vert) {
    return Math.round(Math.max(0, Math.min(100, 100 - (vert / 2.0) * 100)));
}

function setRCIStatus(score) {
    const el = document.getElementById('rciStatus');
    if (!el) return;
    if      (score >= 80) { el.textContent = 'Excellent'; el.className = 'rci-status status-excellent'; }
    else if (score >= 60) { el.textContent = 'Good';      el.className = 'rci-status status-good'; }
    else if (score >= 40) { el.textContent = 'Fair';      el.className = 'rci-status status-fair'; }
    else                  { el.textContent = 'Poor';      el.className = 'rci-status status-poor'; }
}

// ── Sensor cache (holds latest derived values per side) ───────────────────
const cache = {
    left:  { x: 0, y: 0, z: 0, vert: 0, lat: 0 },
    right: { x: 0, y: 0, z: 0, vert: 0, lat: 0 }
};

// ── Batch render via rAF ──────────────────────────────────────────────────
let rafPending = false;
function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
        distanceChart.update('none');
        rciChart.update('none');
        // subplots update inline via pushSubplot — no batch needed
        rafPending = false;
    });
}

// ── Socket.IO ─────────────────────────────────────────────────────────────
if (typeof io === 'undefined') {
    console.error('[graphs] Socket.IO not loaded! Add this to graphs.html <head>:\n<script src="/socket.io/socket.io.js"><\/script>');
}

// ── Historical data loader ────────────────────────────────────────────────
async function loadHistoricalGraphData() {
    try {
        const url = new URL(`${SERVER_URL}/api/historical/graph/24`);
        url.searchParams.set('from', _histFrom);
        url.searchParams.set('to',   _histTo);
        const data = await fetch(url).then(r => r.json());
        if (!data.length) return;
        // Fill distance chart with historical points (up to DIST_N)
        const slice = data.slice(-DIST_N);
        slice.forEach((pt, i) => {
            distanceChart.data.labels[i]           = pt.timestamp ? new Date(pt.timestamp).toLocaleTimeString() : '';
            distanceChart.data.datasets[0].data[i] = pt.accel1 || 0;
            distanceChart.data.datasets[1].data[i] = 0; // lateral not in this endpoint
            distanceChart.data.datasets[2].data[i] = pt.accel2 || 0;
            distanceChart.data.datasets[3].data[i] = pt.magnitude || 0;
        });
        distanceChart.update('none');
        console.log(`[graphs] Historical: ${data.length} points loaded`);
    } catch (e) {
        console.error('[graphs] Historical load failed:', e.message);
    }
}

const socket = (IS_HISTORICAL || typeof io === 'undefined') ? { on: () => {} }
    : io(SERVER_URL, {
        transports: ['websocket', 'polling'],
        reconnectionDelay: 1000,
        reconnectionAttempts: Infinity
    });

if (!IS_HISTORICAL) {
    socket.on('connect',       () => console.log('[graphs] Socket connected ✓'));
    socket.on('disconnect',    r  => console.warn('[graphs] Disconnected:', r));
    socket.on('connect_error', e  => console.error('[graphs] Error:', e.message));
}

// ── Pre-fill all charts from DB on load ───────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    if (IS_HISTORICAL) {
        loadHistoricalGraphData();
    } else if (typeof window.preloadGraphHistory === 'function') {
        window.preloadGraphHistory(distanceChart, subplots);
    }
});

// Respond to mode changes from shell
window.addEventListener('message', (e) => {
    if (!e.data) return;
    if (e.data.mode === 'historical' || e.data.mode === 'live') {
        location.href = e.data.mode === 'historical'
            ? `${location.pathname}?from=${e.data.from}&to=${e.data.to}`
            : location.pathname;
    }
});

socket.on('accelerometer-data', data => {
    if (IS_HISTORICAL) return;
    const side = data.sensor;
    if (side !== 'left' && side !== 'right') return;

    const x = data.x ?? 0;
    const y = data.y ?? 0;
    const z = data.z ?? 0;

    // Derive channels from raw axes
    const vert = getVert(x, y, z);   // |Z|
    const lat  = getLat(x, y, z);    // sqrt(X²+Y²)

    // Update cache
    cache[side].x    = x;
    cache[side].y    = y;
    cache[side].z    = z;
    cache[side].vert = vert;
    cache[side].lat  = lat;

    // ── Raw subplots: push X, Y, Z into their individual charts ──────────
    const sp  = side === 'left' ? subplots.s1 : subplots.s2;
    const pfx = side === 'left' ? 'raw1'       : 'raw2';

    pushSubplot(sp.x, x);
    pushSubplot(sp.y, y);
    pushSubplot(sp.z, z);

    document.getElementById(pfx + 'X').textContent = x.toFixed(4) + ' g';
    document.getElementById(pfx + 'Y').textContent = y.toFixed(4) + ' g';
    document.getElementById(pfx + 'Z').textContent = z.toFixed(4) + ' g';
    const now = new Date();
    document.getElementById(pfx + 'RefreshTime').textContent = '🕐 ' + now.toLocaleTimeString('en-GB', {hour12:false}) + '  ' + now.toLocaleDateString('en-GB');

    // ── Distance chart: left sensor drives label + distance advance ───────
    if (side === 'left') {
        advanceDistance();
        const distLabel = formatDistLabel(distanceM);

        roll(distanceChart, 0, vert,              distLabel); // AB-L-VERT
        roll(distanceChart, 1, lat);                          // AB-L-LAT
        roll(distanceChart, 2, cache.right.vert);             // AB-R-VERT (latest cached)
        roll(distanceChart, 3, cache.right.lat);              // AB-R-LAT  (latest cached)

        // ── RCI from left VERT ────────────────────────────────────────────
        const rci = vertToRCI(vert);
        roll(rciChart, 0, rci, distLabel);

        document.getElementById('rciCurrent').textContent = rci;
        setRCIStatus(rci);

        const d = rciChart.data.datasets[0].data;
        document.getElementById('rciAvg').textContent   = Math.round(d.reduce((a, b) => a + b, 0) / d.length);
        document.getElementById('rciBest').textContent  = Math.round(Math.max(...d));
        document.getElementById('rciWorst').textContent = Math.round(Math.min(...d));
    }

    // ── Legend: live derived values ───────────────────────────────────────
    document.getElementById('distVal1').textContent = cache.left.vert.toFixed(4)  + ' g';
    document.getElementById('distVal2').textContent = cache.left.lat.toFixed(4)   + ' g';
    document.getElementById('distVal3').textContent = cache.right.vert.toFixed(4) + ' g';
    document.getElementById('distVal4').textContent = cache.right.lat.toFixed(4)  + ' g';

    scheduleRender();
});

// ── Control buttons ───────────────────────────────────────────────────────
function setDistanceRange(range) {
    document.querySelectorAll('.graph-controls .graph-btn').forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');
}
function setRCIRange(range) {
    document.querySelectorAll('.graph-controls .graph-btn').forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');
}
window.setDistanceRange = setDistanceRange;
window.setRCIRange      = setRCIRange;

// ── Threshold sync — fetch from server, update live on config change ───────
let graphThresholds = { p1Min: 5, p1Max: 10, p2Min: 10, p2Max: 20, p3Min: 20 };

(async function loadGraphThresholds() {
    try {
        const res = await fetch(`${SERVER_URL}/api/thresholds`);
        graphThresholds = await res.json();
        console.log('[graphs] Thresholds loaded:', graphThresholds);
    } catch (e) {
        console.warn('[graphs] Using default thresholds');
    }
})();

socket.on('thresholds-updated', (t) => {
    graphThresholds = t;
    console.log('[graphs] Thresholds updated live:', t);
});

// ── Raw charts DB poll (every 3s, no Socket.IO) ───────────────────────────
// lv = left-vertical (Z), ll = left-lateral (X), rv = right-vertical (Z), rl = right-lateral (X)
async function fetchRawFromDB() {
    try {
        const data = await fetch(`${SERVER_URL}/api/acceleration/channels?minutes=60`).then(r => r.json());
        if (!data.length) return;

        // Use last 60 points to fill the rolling subplot charts
        const slice = data.slice(-60);
        slice.forEach(pt => {
            if (pt.lv != null) { pushSubplot(subplots.s1.z, pt.lv); }
            if (pt.ll != null) { pushSubplot(subplots.s1.x, pt.ll); }
            if (pt.rv != null) { pushSubplot(subplots.s2.z, pt.rv); }
            if (pt.rl != null) { pushSubplot(subplots.s2.x, pt.rl); }
        });

        // Latest values for the readout labels
        const latest = data[data.length - 1];
        const now    = new Date();
        const ts     = '🕐 ' + now.toLocaleTimeString('en-GB', {hour12:false}) + '  ' + now.toLocaleDateString('en-GB');

        if (latest.lv != null || latest.ll != null) {
            document.getElementById('raw1X').textContent = (latest.ll ?? 0).toFixed(4) + ' g';
            document.getElementById('raw1Y').textContent = '0.0000 g';
            document.getElementById('raw1Z').textContent = (latest.lv ?? 0).toFixed(4) + ' g';
            document.getElementById('raw1RefreshTime').textContent = ts;
        }
        if (latest.rv != null || latest.rl != null) {
            document.getElementById('raw2X').textContent = (latest.rl ?? 0).toFixed(4) + ' g';
            document.getElementById('raw2Y').textContent = '0.0000 g';
            document.getElementById('raw2Z').textContent = (latest.rv ?? 0).toFixed(4) + ' g';
            document.getElementById('raw2RefreshTime').textContent = ts;
        }
    } catch (e) { console.error('[raw-db]', e); }
}

fetchRawFromDB();
setInterval(fetchRawFromDB, 3000);
