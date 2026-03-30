/* =============================================================================
   index.js — RailMonitor shell: left panel, accel status, clock, iframe loader
   All sensor values driven by real Socket.IO data from hardware
============================================================================= */

const SERVER_URL = window.location.origin;
const ACCEL_STATES = ['not-connected', 'initialized', 'connected'];

// ── Sensor state cache (left panel uses this) ─────────────────────────────
const sensorCache = {
    left:  { vert: null, lat: null },
    right: { vert: null, lat: null }
};

// ── Distance tracking (meter-wise, increments per data packet) ────────────
// Server sends data at ~500ms intervals; we track distance using coordinate
// field from GPS if available, otherwise we just count packets × ~5m
let currentDistanceM = 0; // meters, updated from GPS or estimated

// ── Clock ─────────────────────────────────────────────────────────────────
function updateTime() {
    const now = new Date();
    const t   = now.toLocaleTimeString('en-US', { hour12: false });
    const el1 = document.getElementById('currentTime');
    const el2 = document.getElementById('northernTime');
    if (el1) el1.textContent = t;
    if (el2) el2.textContent = t;
}
setInterval(updateTime, 1000);
updateTime();

// ── Accel status pills ────────────────────────────────────────────────────
function setAccelStatus(accelId, status) {
    ACCEL_STATES.forEach(state => {
        const pill = document.getElementById('accel' + accelId + '-' + state);
        if (!pill) return;
        pill.classList.toggle('active', state === status);
    });
}

// ── Northern Central panel updater ───────────────────────────────────────
// Called on every accelerometer-data socket event
// Mapping (matches graphs.js exactly):
//   AB-L-VERT = rmsV from left sensor
//   AB-L-LAT  = rmsL from left sensor
//   AB-R-VERT = rmsV from right sensor
//   AB-R-LAT  = rmsL from right sensor
function updateNorthernPanel() {
    const L = sensorCache.left;
    const R = sensorCache.right;

    const ablVert = document.getElementById('ablVert');
    const ablLat  = document.getElementById('ablLat');
    const abrVert = document.getElementById('abrVert');
    const abrLat  = document.getElementById('abrLat');

    if (ablVert && L.vert !== null) ablVert.textContent = L.vert.toFixed(4) + ' g';
    if (ablLat  && L.lat !== null) ablLat.textContent  = L.lat.toFixed(4) + ' g';
    if (abrVert && R.vert !== null) abrVert.textContent = R.vert.toFixed(4) + ' g';
    if (abrLat  && R.lat !== null) abrLat.textContent  = R.lat.toFixed(4) + ' g';

    // Increment counter on each packet
    const counter = document.getElementById('counter');
    if (counter) {
        const cur = parseInt(counter.textContent.replace(/,/g, '')) || 0;
        counter.textContent = (cur + 1).toLocaleString();
    }
}

// ── Recent alerts ─────────────────────────────────────────────────────────
function updateRecentAlerts(impacts) {
    const container = document.querySelector('.alerts-mini-list');
    if (!container || !impacts || !impacts.length) return;

    container.innerHTML = impacts.slice(0, 3).map(impact => {
        const cls  = (impact.severity || 'low').toLowerCase();
        const loc  = impact.peak_g ? impact.peak_g.toFixed(1) + 'g' : '?g';
        const dist = impact.sensor ? ' (' + impact.sensor + ')' : '';
        return `<div class="alert-mini-item ${cls}">
                    <span class="alert-dot"></span>
                    <span class="alert-text">${loc} at ${currentDistanceM}m${dist}</span>
                </div>`;
    }).join('');
}

function addImpactAlert(impact) {
    const container = document.querySelector('.alerts-mini-list');
    if (!container) return;

    const cls  = (impact.severity || 'low').toLowerCase();
    const loc  = impact.peak_g ? impact.peak_g.toFixed(1) + 'g' : '?g';

    const el = document.createElement('div');
    el.className = 'alert-mini-item ' + cls;
    el.innerHTML = `<span class="alert-dot"></span>
                    <span class="alert-text">${loc} at ${currentDistanceM}m</span>`;

    container.insertBefore(el, container.firstChild);
    while (container.children.length > 5) container.removeChild(container.lastChild);

    if (impact.severity === 'HIGH') showHighSeverityPopup(impact);
}

function showHighSeverityPopup(impact) {
    const popup = document.createElement('div');
    popup.className = 'high-severity-popup';
    popup.innerHTML = `<strong>HIGH SEVERITY IMPACT</strong><br>
                       ${impact.peak_g.toFixed(2)}g detected<br>
                       ${new Date(impact.timestamp).toLocaleTimeString()}`;
    document.body.appendChild(popup);
    setTimeout(() => popup.remove(), 5000);
}

// ── GPS display ───────────────────────────────────────────────────────────
function updateGPSDisplay(location) {
    const coordEl = document.getElementById('coordinate');
    const speedEl = document.getElementById('speed');

    if (location.coordinate_km !== undefined && coordEl) {
        // e.g. "1393 km 79 m"
        const km  = Math.floor(location.coordinate_km);
        const m   = Math.round((location.coordinate_km - km) * 1000);
        coordEl.textContent = km + ' km ' + m + ' m';
        currentDistanceM = Math.round(location.coordinate_km * 1000);
    } else if (location.latitude && coordEl) {
        coordEl.textContent = location.latitude.toFixed(4) + '°, ' + location.longitude.toFixed(4) + '°';
    }

    if (location.speed !== undefined && speedEl) {
        speedEl.textContent = location.speed.toFixed(2) + ' km/h';
    }
}

// ── Socket.IO connection ──────────────────────────────────────────────────
let socket = null;

function connectToBackend() {
    socket = io(SERVER_URL, {
        transports: ['websocket', 'polling'],
        reconnectionDelay: 1000,
        reconnectionAttempts: Infinity
    });

    socket.on('connect', () => {
        console.log('[index.js] Socket connected');
        setAccelStatus(1, 'connected');
        setAccelStatus(2, 'connected');
        loadInitialAlerts();
    });

    socket.on('disconnect', reason => {
        console.warn('[index.js] Socket disconnected:', reason);
        setAccelStatus(1, 'not-connected');
        setAccelStatus(2, 'not-connected');
    });

    socket.on('connect_error', err => {
        console.error('[index.js] Socket error:', err.message);
        setAccelStatus(1, 'not-connected');
        setAccelStatus(2, 'not-connected');
    });

    // ── Main data event ───────────────────────────────────────────────────
    socket.on('accelerometer-data', data => {
        /*
          data = { sensor, x, y, z, rmsV, rmsL, peak, gForce, timestamp }
          VERT = |Z|           (vertical peak from Z axis)
          LAT  = sqrt(X²+Y²)  (lateral peak from horizontal plane)
        */
        const side = data.sensor;
        if (side !== 'left' && side !== 'right') return;

        const x    = data.x ?? 0;
        const y    = data.y ?? 0;
        const z    = data.z ?? 0;
        const vert = Math.abs(z);
        const lat  = Math.sqrt(x * x + y * y);

        sensorCache[side].vert = vert;
        sensorCache[side].lat  = lat;

        // Estimate distance: increment by ~5m per packet (~500ms × ~36 km/h ≈ 5m)
        // If GPS coordinate is available it will be overridden by updateGPSDisplay
        currentDistanceM += 5;

        updateNorthernPanel();
    });

    socket.on('gps-update',  data   => updateGPSDisplay(data));
    socket.on('new-impact',  impact => addImpactAlert(impact));
}

// ── Load initial alerts from REST ─────────────────────────────────────────
async function loadInitialAlerts() {
    try {
        const res  = await fetch(SERVER_URL + '/api/impacts');
        const data = await res.json();
        updateRecentAlerts(data);
    } catch (e) {
        console.warn('[index.js] Could not load initial alerts:', e.message);
    }
}

// ── Data mode — live or historical ────────────────────────────────────────
let dataMode   = { mode: 'live' };   // or { mode: 'historical', from, to }
let mqttHandle = null;               // { pause, resume } returned by startMqttStatus

function broadcastMode() {
    const iframe = document.getElementById('content-frame');
    if (iframe?.contentWindow) iframe.contentWindow.postMessage(dataMode, '*');
}

function setMqttPill(mode) {
    const el   = document.getElementById('mqttStatus');
    const text = document.getElementById('mqttText');
    if (!el || !text) return;
    if (mode === 'historical') {
        el.className = 'mqtt-status historical';
        text.textContent = 'Historical';
    } else {
        el.classList.remove('historical');
    }
}

// ── iframe loader ─────────────────────────────────────────────────────────
function loadPage(pageUrl) {
    const dynamicContent = document.getElementById('dynamicContent');
    if (!dynamicContent) return false;

    let iframe = document.getElementById('content-frame');
    if (!iframe) {
        iframe = document.createElement('iframe');
        iframe.id = 'content-frame';
        iframe.style.cssText = 'width:100%;height:100%;border:none;';
        dynamicContent.innerHTML = '';
        dynamicContent.appendChild(iframe);
    }

    if (!pageUrl.startsWith('http')) {
        pageUrl = pageUrl.replace('html/', '');
        if (!pageUrl.startsWith('pages/')) pageUrl = 'pages/' + pageUrl;
    }

    // Append date range params when in historical mode
    if (dataMode.mode === 'historical') {
        pageUrl = pageUrl.split('?')[0] + `?from=${dataMode.from}&to=${dataMode.to}`;
    }

    iframe.src = pageUrl;
    return false;
}

window.loadPage       = loadPage;
window.setAccelStatus = setAccelStatus;

// ── Boot ──────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
    // Remove any stale iframe
    const old = document.getElementById('content-frame');
    if (old) old.remove();

    // Socket.IO is loaded from CDN in the HTML <head>; connect immediately
    connectToBackend();

    // MQTT status pill in top bar
    mqttHandle = startMqttStatus({
        interval: 2000,
        onChange({ online, time_since_last }) {
            const el   = document.getElementById('mqttStatus');
            const text = document.getElementById('mqttText');
            if (!el || !text) return;
            el.classList.remove('historical');
            el.classList.toggle('offline', !online);
            if (online) {
                text.textContent = 'LIVE';
            } else {
                const s   = time_since_last;
                const ago = s == null  ? 'Offline'
                          : s < 60    ? `${s}s ago`
                          : `${Math.floor(s / 60)}m ago`;
                text.textContent = ago;
            }
        }
    });

    // History dropdown toggle
    document.getElementById('historyBtn')?.addEventListener('click', () => {
        document.getElementById('historyDropdown')?.classList.toggle('open');
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!document.getElementById('historyControl')?.contains(e.target)) {
            document.getElementById('historyDropdown')?.classList.remove('open');
        }
    });

    // Apply historical range
    document.getElementById('applyRange')?.addEventListener('click', () => {
        const from = document.getElementById('rangeFrom').value;
        const to   = document.getElementById('rangeTo').value;
        if (!from || !to) return;
        dataMode = { mode: 'historical', from, to };
        // Update button label and pill
        document.getElementById('historyBtnLabel').textContent = `${from} – ${to}`;
        document.getElementById('historyBtn').classList.add('active');
        document.getElementById('historyDropdown').classList.remove('open');
        setMqttPill('historical');
        mqttHandle?.pause();
        // Reload current iframe with range params
        const iframe = document.getElementById('content-frame');
        if (iframe?.src) {
            iframe.src = iframe.src.split('?')[0] + `?from=${from}&to=${to}`;
        }
    });

    // Return to live
    document.getElementById('goLive')?.addEventListener('click', () => {
        dataMode = { mode: 'live' };
        document.getElementById('historyBtnLabel').textContent = 'History';
        document.getElementById('historyBtn').classList.remove('active');
        document.getElementById('historyDropdown').classList.remove('open');
        mqttHandle?.resume();
        // Reload current iframe without params
        const iframe = document.getElementById('content-frame');
        if (iframe?.src) iframe.src = iframe.src.split('?')[0];
    });
});
