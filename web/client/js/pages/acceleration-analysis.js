/* acceleration-analysis.js — uses loadStoredThresholds / loadStoredLimits from common.js */

// Impact database
const impacts = [
    { km: 1392, location: 'KM 1392+450', lat: 28.613567, lon: 77.209967, peak: 16.8, speed: 93.6 },
    { km: 1395, location: 'KM 1395+120', lat: 28.613040, lon: 77.210347, peak: 15.2, speed: 92.8 },
    { km: 1401, location: 'KM 1401+780', lat: 28.613351, lon: 77.210007, peak: 7.3,  speed: 94.1 },
    { km: 1412, location: 'KM 1412+210', lat: 28.613030, lon: 77.210199, peak: 22.5, speed: 91.5 },
    { km: 1425, location: 'KM 1425+560', lat: 28.613697, lon: 77.210048, peak: 12.8, speed: 95.2 },
    { km: 1438, location: 'KM 1438+330', lat: 28.613946, lon: 77.209744, peak: 8.9,  speed: 88.4 },
    { km: 1452, location: 'KM 1452+670', lat: 28.613975, lon: 77.209744, peak: 18.3, speed: 92.3 },
    { km: 1467, location: 'KM 1467+890', lat: 28.613511, lon: 77.210000, peak: 4.2,  speed: 87.7 },
    { km: 1482, location: 'KM 1482+340', lat: 28.613656, lon: 77.209382, peak: 3.1,  speed: 90.3 },
    { km: 1495, location: 'KM 1495+670', lat: 28.613557, lon: 77.210000, peak: 5.8,  speed: 86.5 }
];

let thresholds = { ...DEFAULT_THRESHOLDS };
let peakLimits = [...DEFAULT_LIMITS];

function loadConfig() {
    thresholds = loadStoredThresholds();
    peakLimits = loadStoredLimits();
    updateDisplay();
}

function getPriority(peak) {
    if (peak > thresholds.p3Min) return { class: 'P3', name: 'Critical', badge: 'badge-p3', threshold: thresholds.p3Min, color: '#b91c1c' };
    if (peak > thresholds.p2Min) return { class: 'P2', name: 'High',     badge: 'badge-p2', threshold: thresholds.p2Min, color: '#c2410c' };
    if (peak > thresholds.p1Min) return { class: 'P1', name: 'Medium',   badge: 'badge-p1', threshold: thresholds.p1Min, color: '#b45309' };
    return null;
}

function getNearestLimit(peak) {
    const sorted = [...peakLimits].sort((a, b) => a - b);
    for (const limit of sorted) {
        if (limit >= peak) return limit;
    }
    return sorted[sorted.length - 1] || 50;
}

function updateThresholdsBar() {
    document.getElementById('thresholdsBar').innerHTML = `
        <div class="threshold-item">
            <div class="threshold-marker marker-p1"></div>
            <div class="threshold-info">
                <span class="threshold-label">P1 Medium</span>
                <span class="threshold-value">${thresholds.p1Min}g - ${thresholds.p1Max}g</span>
            </div>
        </div>
        <div class="threshold-item">
            <div class="threshold-marker marker-p2"></div>
            <div class="threshold-info">
                <span class="threshold-label">P2 High</span>
                <span class="threshold-value">${thresholds.p2Min}g - ${thresholds.p2Max}g</span>
            </div>
        </div>
        <div class="threshold-item">
            <div class="threshold-marker marker-p3"></div>
            <div class="threshold-info">
                <span class="threshold-label">P3 Critical</span>
                <span class="threshold-value">&gt; ${thresholds.p3Min}g</span>
            </div>
        </div>
        <div class="peak-limits-info">
            <i class="fas fa-chart-line"></i>
            <span>Peak Limits: ${peakLimits.join(', ')}g</span>
        </div>
    `;
}

function updateStats() {
    const classified = impacts.map(i => ({ ...i, priority: getPriority(i.peak) })).filter(i => i.priority);

    const total    = classified.length;
    const p1Count  = classified.filter(i => i.priority.class === 'P1').length;
    const p2Count  = classified.filter(i => i.priority.class === 'P2').length;
    const p3Count  = classified.filter(i => i.priority.class === 'P3').length;
    const avgPeak  = total > 0 ? (classified.reduce((s, i) => s + i.peak, 0) / total).toFixed(1) : 0;
    const maxPeak  = total > 0 ? Math.max(...classified.map(i => i.peak)).toFixed(1) : 0;

    document.getElementById('statsGrid').innerHTML = `
        <div class="stat-card">
            <div class="stat-icon"><i class="fas fa-chart-bar"></i></div>
            <div class="stat-content">
                <div class="stat-label">Total Exceeding</div>
                <div class="stat-value">${total}</div>
                <div class="stat-sub">out of ${impacts.length} total</div>
            </div>
        </div>
        <div class="stat-card">
            <div class="stat-icon"><i class="fas fa-layer-group"></i></div>
            <div class="stat-content">
                <div class="stat-label">By Priority</div>
                <div class="stat-value">P1:${p1Count} P2:${p2Count} P3:${p3Count}</div>
                <div class="stat-sub">distribution</div>
            </div>
        </div>
        <div class="stat-card">
            <div class="stat-icon"><i class="fas fa-calculator"></i></div>
            <div class="stat-content">
                <div class="stat-label">Average Peak</div>
                <div class="stat-value">${avgPeak}g</div>
                <div class="stat-sub">across all</div>
            </div>
        </div>
        <div class="stat-card">
            <div class="stat-icon"><i class="fas fa-arrow-up"></i></div>
            <div class="stat-content">
                <div class="stat-label">Maximum Peak</div>
                <div class="stat-value">${maxPeak}g</div>
                <div class="stat-sub">${maxPeak > thresholds.p3Min ? 'Critical' : maxPeak > thresholds.p2Min ? 'High' : 'Medium'}</div>
            </div>
        </div>
    `;

    document.getElementById('recordCount').textContent = `${total} records`;
}

function updateReport() {
    const classified = impacts
        .map(i => ({ ...i, priority: getPriority(i.peak), nearestLimit: getNearestLimit(i.peak) }))
        .filter(i => i.priority)
        .sort((a, b) => b.peak - a.peak);

    if (classified.length === 0) {
        document.getElementById('reportBody').innerHTML =
            '<tr><td colspan="6" class="no-data">No impacts exceed current thresholds</td></tr>';
        return;
    }

    document.getElementById('reportBody').innerHTML = classified.map(i => `
        <tr>
            <td><strong>${i.location}</strong></td>
            <td style="font-family: monospace;">${i.lat.toFixed(6)}° N, ${i.lon.toFixed(6)}° E</td>
            <td style="color: ${i.priority.color}; font-weight: 600;">${i.peak.toFixed(1)} g</td>
            <td><span class="threshold-highlight">${i.priority.threshold} g</span> (ref: ${i.nearestLimit}g)</td>
            <td><span class="priority-badge ${i.priority.badge}">${i.priority.class}</span></td>
            <td>${i.speed.toFixed(1)} km/h</td>
        </tr>
    `).join('');
}

function updateDisplay() {
    updateThresholdsBar();
    updateStats();
    updateReport();
}

function exportReport() {
    const classified = impacts
        .map(i => ({ ...i, priority: getPriority(i.peak), nearestLimit: getNearestLimit(i.peak) }))
        .filter(i => i.priority)
        .sort((a, b) => b.peak - a.peak);

    if (classified.length === 0) { alert('No data to export'); return; }

    const headers = ['KM Location', 'GPS Coordinates', 'Peak (g)', 'Applied Threshold (g)', 'Peak Limit (g)', 'Priority Class', 'Speed (km/h)'];
    const rows = classified.map(i => [
        i.location,
        `${i.lat.toFixed(6)}° N, ${i.lon.toFixed(6)}° E`,
        i.peak.toFixed(1),
        i.priority.threshold,
        i.nearestLimit,
        i.priority.class,
        i.speed.toFixed(1)
    ]);

    const metadata = [
        `Report Generated: ${new Date().toLocaleString()}`,
        `Active Thresholds: P1:${thresholds.p1Min}-${thresholds.p1Max}g, P2:${thresholds.p2Min}-${thresholds.p2Max}g, P3:>${thresholds.p3Min}g`,
        `Peak Limits: ${peakLimits.join(', ')}g`,
        `Total Records: ${classified.length}`,
        ''
    ];

    const csvContent = [headers, ...rows].map(row => row.join(',')).join('\n');
    const fullReport = metadata.join('\n') + csvContent;

    const blob = new Blob([fullReport], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Acceleration_Analysis_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
}

// Sync when configuration.html saves new values
window.addEventListener('storage', e => {
    if (e.key === RM_THRESHOLDS_KEY || e.key === RM_LIMITS_KEY) loadConfig();
});

setInterval(loadConfig, 2000);
loadConfig();

window.exportReport = exportReport;
