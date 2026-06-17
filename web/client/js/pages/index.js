/* =============================================================================
   index.js — Datalogger shell: left panel, accel status, clock, iframe loader
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
let currentDistanceM = 0; // meters, updated from GPS or estimated

// ── Header connection status ─────────────────────────────────────────────
let lastSensorDataTime = 0;
const DATA_TIMEOUT_MS = 10000; // 10 seconds

function updateHeaderStatus() {
    const dot = document.querySelector('.mqtt-dot');
    const text = document.getElementById('mqttText');
    if (!dot || !text) return;

    const connected = socket && socket.connected;
    const hasRecentData = (Date.now() - lastSensorDataTime) < DATA_TIMEOUT_MS;

    if (connected && hasRecentData) {
        text.textContent = 'LIVE';
        text.style.color = '#22c55e';
        dot.style.background = '#22c55e';
        dot.classList.add('pulsing');
    } else {
        text.textContent = 'OFFLINE';
        text.style.color = '#ef4444';
        dot.style.background = '#ef4444';
        dot.classList.remove('pulsing');
    }
}

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

// ── Dark Mode ─────────────────────────────────────────────────────────────
(function initDarkMode() {
    const btn  = document.getElementById('darkModeBtn');
    const icon = document.getElementById('darkModeIcon');
    if (!btn) return;

    const apply = (dark) => {
        document.body.classList.toggle('dark', dark);
        if (icon) {
            icon.className = dark ? 'fas fa-sun' : 'fas fa-moon';
        }
        localStorage.setItem('railmonitor-dark', dark ? '1' : '0');
    };

    // Restore saved preference
    apply(localStorage.getItem('railmonitor-dark') === '1');

    btn.addEventListener('click', () => {
        apply(!document.body.classList.contains('dark'));
    });
})();

// ── Accel status pills ────────────────────────────────────────────────────
function setAccelStatus(accelId, status) {
    ACCEL_STATES.forEach(state => {
        const pill = document.getElementById('accel' + accelId + '-' + state);
        if (!pill) return;
        pill.classList.toggle('active', state === status);
    });
}

// ── Northern Central panel updater ───────────────────────────────────────
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

// ── Notification Bell ─────────────────────────────────────────────────────
const _notifAlerts = [];
let   _notifBellOpen = false;

function _notifRender() {
    const badge    = document.getElementById('notifBadge');
    const listEl   = document.getElementById('notifList');
    if (!badge || !listEl) return;

    badge.textContent = _notifAlerts.length > 99 ? '99+' : _notifAlerts.length;
    badge.style.display = _notifAlerts.length ? 'flex' : 'none';

    listEl.innerHTML = _notifAlerts.length
        ? _notifAlerts.slice(0, 8).map(a => `
            <div class="notif-item">
                <div class="notif-item-peak">${a.peak.toFixed(2)}g — ${a.sensor} (${a.pClass || '—'})</div>
                <div class="notif-item-meta">${a.time}</div>
            </div>`).join('')
        : '<p class="notif-empty">No alerts yet</p>';
}

(function initNotifBell() {
    const btn      = document.getElementById('notifBellBtn');
    const dropdown = document.getElementById('notifDropdown');
    const clearBtn = document.getElementById('notifClear');
    if (!btn) return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        _notifBellOpen = !_notifBellOpen;
        dropdown.style.display = _notifBellOpen ? 'block' : 'none';
    });

    document.addEventListener('click', () => {
        _notifBellOpen = false;
        if (dropdown) dropdown.style.display = 'none';
    });

    if (clearBtn) {
        clearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _notifAlerts.length = 0;
            _notifRender();
        });
    }
})();

function _notifAddHighAlert(impact) {
    if ((impact.severity || '').toUpperCase() !== 'HIGH') return;
    _notifAlerts.unshift({
        peak:   impact.peak_g || impact.gForce || 0,
        sensor: impact.sensor || '—',
        pClass: impact.p_class || null,
        time:   new Date(impact.timestamp || Date.now()).toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata', hour12: false
        })
    });
    if (_notifAlerts.length > 50) _notifAlerts.pop();
    _notifRender();
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

    _notifAddHighAlert(impact);
    if (impact.severity === 'HIGH') showHighSeverityPopup(impact);
}

function showHighSeverityPopup(impact) {
    const popup = document.createElement('div');
    popup.className = 'high-severity-popup';
    popup.innerHTML = `<strong>HIGH SEVERITY IMPACT</strong><br>
                       ${impact.peak_g.toFixed(2)}g detected<br>
                       ${new Date(impact.timestamp).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })}`;
    document.body.appendChild(popup);
    setTimeout(() => popup.remove(), 5000);
}

// ── GPS display ───────────────────────────────────────────────────────────
function updateGPSDisplay(location) {
    const coordEl = document.getElementById('coordinate');
    const speedEl = document.getElementById('speed');

    if (location.coordinate_km !== undefined && coordEl) {
        const km  = Math.floor(location.coordinate_km);
        const m   = Math.round((location.coordinate_km - km) * 1000);
        coordEl.textContent = km + ' km ' + m + ' m';
        currentDistanceM = Math.round(location.coordinate_km * 1000);
    } else if (location.latitude && coordEl) {
        coordEl.textContent = location.latitude.toFixed(4) + '°, ' + location.longitude.toFixed(4) + '°';
    }

    const spd = location.speedKmh ?? location.speed;
    if (spd !== undefined && speedEl) {
        speedEl.textContent = (+spd).toFixed(2) + ' km/h';
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
        updateHeaderStatus();
        loadInitialAlerts();
    });

    socket.on('disconnect', reason => {
        console.warn('[index.js] Socket disconnected:', reason);
        setAccelStatus(1, 'not-connected');
        setAccelStatus(2, 'not-connected');
        updateHeaderStatus();
    });

    socket.on('connect_error', err => {
        console.error('[index.js] Socket error:', err.message);
        setAccelStatus(1, 'not-connected');
        setAccelStatus(2, 'not-connected');
        updateHeaderStatus();
    });

    // Periodic check for data timeout
    setInterval(updateHeaderStatus, 2000);

    socket.on('accelerometer-data', data => {
        const side = data.sensor;
        if (side !== 'left' && side !== 'right') return;

        lastSensorDataTime = Date.now();
        updateHeaderStatus();

        const x    = data.x ?? 0;
        const y    = data.y ?? 0;
        const z    = data.z ?? 0;
        const vert = Math.abs(z);
        const lat  = Math.sqrt(x * x + y * y);

        sensorCache[side].vert = vert;
        sensorCache[side].lat  = lat;

        updateNorthernPanel();
    });

    socket.on('gps-data',    data   => updateGPSDisplay(data));
    socket.on('new-impact',  impact => addImpactAlert(impact));

    socket.on('display-reset', () => {
        currentDistanceM = 0;
        const counter = document.getElementById('counter');
        if (counter) counter.textContent = '0';
        const alertsList = document.querySelector('.alerts-mini-list');
        if (alertsList) alertsList.innerHTML = '';
        _notifAlerts.length = 0;
        _notifRender();
    });
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

    iframe.src = pageUrl;
    localStorage.setItem('last_page', pageUrl);
    return false;
}

window.loadPage      = loadPage;
window.setAccelStatus = setAccelStatus;

// ── History range (shared with iframe pages via window.HISTORY_FROM/TO) ──
window.HISTORY_FROM = null;
window.HISTORY_TO   = null;

function applyHistoryRange() {
    const dateVal = document.getElementById('rangeDate').value;
    if (!dateVal) { alert('Please select a date.'); return; }

    const start = new Date(dateVal);
    start.setHours(0, 0, 0, 0);
    const end = new Date(dateVal);
    end.setHours(23, 59, 59, 999);

    window.HISTORY_FROM = start.toISOString();
    window.HISTORY_TO   = end.toISOString();

    const label = document.getElementById('historyBtnLabel');
    if (label) label.textContent = start.toLocaleDateString('en-IN');

    // Reload the current iframe with range params
    const iframe = document.getElementById('content-frame');
    if (iframe && iframe.src) {
        const url = new URL(iframe.src);
        url.searchParams.set('from', window.HISTORY_FROM);
        url.searchParams.set('to',   window.HISTORY_TO);
        iframe.src = url.toString();
    }

    // Close dropdown
    document.getElementById('historyDropdown').style.display = 'none';
}

function goLive() {
    window.HISTORY_FROM = null;
    window.HISTORY_TO   = null;

    const label = document.getElementById('historyBtnLabel');
    if (label) label.textContent = 'History';

    // Reload iframe without range params
    const iframe = document.getElementById('content-frame');
    if (iframe && iframe.src) {
        const url = new URL(iframe.src);
        url.searchParams.delete('from');
        url.searchParams.delete('to');
        iframe.src = url.toString();
    }

    document.getElementById('historyDropdown').style.display = 'none';
}

// ── Boot ──────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
    // Remove any stale iframe
    const old = document.getElementById('content-frame');
    if (old) old.remove();

    // Restore last visited page
    const lastPage = localStorage.getItem('last_page');
    if (lastPage) loadPage(lastPage);

    // Socket.IO is loaded from CDN in the HTML <head>; connect immediately
    connectToBackend();

    // Wire history button toggle
    document.getElementById('historyBtn').addEventListener('click', () => {
        const dd = document.getElementById('historyDropdown');
        dd.style.display = dd.style.display === 'block' ? 'none' : 'block';
    });

    document.getElementById('applyRange').addEventListener('click', applyHistoryRange);
    document.getElementById('goLive').addEventListener('click', goLive);

    // Close dropdown when clicking outside
    document.addEventListener('click', e => {
        const wrap = document.getElementById('historyControl');
        if (wrap && !wrap.contains(e.target)) {
            document.getElementById('historyDropdown').style.display = 'none';
        }
    });
});
