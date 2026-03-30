/* events.js — Realtime Impact Events polled from DB every 2s */

const API = window.location.origin;

// Read date-range params (set by index.js when in historical mode)
const _p        = new URLSearchParams(location.search);
const _histFrom = _p.get('from');
const _histTo   = _p.get('to');

let allImpacts = [];

async function loadImpacts() {
    try {
        const url = new URL(`${API}/api/impacts`);
        if (_histFrom) url.searchParams.set('from', _histFrom);
        if (_histTo)   url.searchParams.set('to',   _histTo);
        const res  = await fetch(url);
        allImpacts = await res.json();
    } catch (e) {
        console.error('[events] Failed to load impacts:', e.message);
        allImpacts = [];
    }
    displayEvents();
}

function displayEvents() {
    const filter   = document.getElementById('severityFilter').value;
    const filtered = filter === 'all'
        ? allImpacts
        : allImpacts.filter(e => (e.severity || '').toLowerCase() === filter);

    document.getElementById('totalEvents').textContent  = filtered.length;
    document.getElementById('highEvents').textContent   = filtered.filter(e => (e.severity || '').toUpperCase() === 'HIGH').length;
    document.getElementById('mediumEvents').textContent = filtered.filter(e => (e.severity || '').toUpperCase() === 'MEDIUM').length;
    document.getElementById('lowEvents').textContent    = filtered.filter(e => (e.severity || '').toUpperCase() === 'LOW').length;

    document.getElementById('eventsList').innerHTML = filtered.map(event => {
        const sev      = (event.severity || 'low').toLowerCase();
        const peak     = event.peak_g != null ? (+event.peak_g).toFixed(1) + ' g' : '—';
        const time     = event.timestamp ? new Date(event.timestamp).toLocaleString() : (event.time || '—');
        const location = event.distance_m != null
            ? 'KM ' + (event.distance_m / 1000).toFixed(3)
            : (event.location || '—');
        return `
        <div class="event-card event-${sev}">
            <div class="event-info">
                <span class="event-time">${time}</span>
                <span class="event-location">${location}</span>
            </div>
            <span class="event-peak peak-${sev}">${peak}</span>
        </div>`;
    }).join('');
}

function renderAll(flashDot = false) {
    const list = filtered();
    document.getElementById('totalEvents').textContent  = list.length;
    document.getElementById('highEvents').textContent   = list.filter(e => e.severity === 'high').length;
    document.getElementById('mediumEvents').textContent = list.filter(e => e.severity === 'medium').length;
    document.getElementById('lowEvents').textContent    = list.filter(e => e.severity === 'low').length;
    document.getElementById('eventsList').innerHTML =
        list.length ? list.map(cardHTML).join('') : '<p class="empty">No events found.</p>';

    if (flashDot) {
        const dot = document.getElementById('liveDot');
        dot.classList.add('pulse');
        setTimeout(() => dot.classList.remove('pulse'), 800);
    }
}

// ── Filter ────────────────────────────────────────────────────────────────
document.getElementById('severityFilter').addEventListener('change', e => {
    filterVal = e.target.value;
    renderAll();
});

// ── Export ────────────────────────────────────────────────────────────────
function exportEvents() {
    const params = new URLSearchParams();
    if (_histFrom) params.set('from', _histFrom);
    if (_histTo)   params.set('to',   _histTo);
    window.location.href = `${API}/api/impacts/export/csv?${params}`;
}

document.getElementById('severityFilter').addEventListener('change', displayEvents);

// Respond to mode changes from the shell (index.js postMessage)
window.addEventListener('message', (e) => {
    if (!e.data || e.data.type !== undefined) return; // ignore non-mode messages
    if (e.data.mode === 'historical' || e.data.mode === 'live') {
        location.href = e.data.mode === 'historical'
            ? `${location.pathname}?from=${e.data.from}&to=${e.data.to}`
            : location.pathname;
    }
});

window.exportEvents = exportEvents;

loadImpacts();
