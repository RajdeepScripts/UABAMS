require('dotenv').config();
const express   = require('express');
const http      = require('http');
const socketIo  = require('socket.io');
const mqtt      = require('mqtt');
const cors      = require('cors');
const path      = require('path');
const fs        = require('fs');
const os        = require('os');
const { DateTime } = require("luxon");

// ── Timezone configuration (change as needed) ─────────────────────────────
const TIMEZONE = "Asia/Kolkata";

function getTimezoneTimestamp() {
return DateTime.now().setZone(TIMEZONE).toFormat("yyyy-MM-dd'T'HH:mm:ss.SSS");
}

// ── Persistent JSON fallback ──────────────────────────────────────────────
const PEAKS_LOG_FILE    = path.join(__dirname, 'peaks_log.json');
const LIMITS_CONFIG_FILE = path.join(__dirname, 'limits_config.json');

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces)) {
        for (const addr of iface) {
            if (addr.family === 'IPv4' && !addr.internal) {
                return addr.address;
            }
        }
    }
    return '127.0.0.1';
}

const LOCAL_IP = getLocalIP();

function loadPeaksLog() {
    try {
        if (fs.existsSync(PEAKS_LOG_FILE))
            return JSON.parse(fs.readFileSync(PEAKS_LOG_FILE, 'utf8'));
    } catch (e) { console.error('peaks_log.json read error:', e.message); }
    return [];
}


function savePeaksLog(log) {
    try { fs.writeFileSync(PEAKS_LOG_FILE, JSON.stringify(log, null, 2)); }
    catch (e) { console.error('peaks_log.json write error:', e.message); }
}

let peaksLog = loadPeaksLog();
console.log(`Loaded ${peaksLog.length} existing impact records from JSON fallback`);

function loadLimitsConfig() {
    try {
        if (fs.existsSync(LIMITS_CONFIG_FILE))
            return JSON.parse(fs.readFileSync(LIMITS_CONFIG_FILE, 'utf8'));
    } catch (e) { console.error('limits_config.json read error:', e.message); }
    return { uml: null, limitClass: null };
}
function saveLimitsConfig(cfg) {
    try { fs.writeFileSync(LIMITS_CONFIG_FILE, JSON.stringify(cfg, null, 2)); }
    catch (e) { console.error('limits_config.json write error:', e.message); }
}

let limitsConfig = loadLimitsConfig();
console.log('[limits] Config loaded:', JSON.stringify(limitsConfig));

// ── Express / Socket.IO ───────────────────────────────────────────────────
const { Pool } = require('pg');
const pool = new Pool({
    host:     process.env.PG_HOST     || 'localhost',
    port:     parseInt(process.env.PG_PORT) || 5432,
    database: process.env.PG_DB       || 'uabams',
    user:     process.env.PG_USER     || 'uabams_user',
    password: process.env.PG_PASSWORD || 'uabams123',
});

const app    = express();
const server = http.createServer(app);
const io     = socketIo(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));

// ── PostgreSQL schema init ────────────────────────────────────────────────
let pgReady = false;

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS accelerometer_events (
                id          SERIAL PRIMARY KEY,
                timestamp   TIMESTAMPTZ NOT NULL,
                sensor      TEXT NOT NULL,
                severity    TEXT NOT NULL,
                peak_g      REAL, g_force REAL,
                rms_v REAL, rms_l REAL, sd_v REAL, sd_l REAL,
                p2p_v REAL, p2p_l REAL,
                x REAL, y REAL, z REAL,
                fs REAL, window_ms REAL, distance_m REAL, p_class TEXT,
                lat REAL, lng REAL
            );
            ALTER TABLE accelerometer_events ADD COLUMN IF NOT EXISTS lat REAL;
            ALTER TABLE accelerometer_events ADD COLUMN IF NOT EXISTS lng REAL;
            CREATE TABLE IF NOT EXISTS monitoring_data (
                id        SERIAL PRIMARY KEY,
                timestamp TIMESTAMPTZ NOT NULL,
                type      TEXT DEFAULT 'accelerometer',
                device_id TEXT NOT NULL,
                x_axis REAL, y_axis REAL, z_axis REAL,
                g_force REAL, rms_v REAL, rms_l REAL,
                sd_v REAL, sd_l REAL, p2p_v REAL, p2p_l REAL,
                peak REAL, fs REAL, window_ms REAL
            );
            CREATE TABLE IF NOT EXISTS realtime_data (
                id        SERIAL PRIMARY KEY,
                timestamp TIMESTAMPTZ NOT NULL,
                sensor    TEXT NOT NULL,
                x REAL, y REAL, z REAL,
                g_force REAL, rms_v REAL, rms_l REAL,
                sd_v REAL, sd_l REAL, p2p_v REAL, p2p_l REAL, peak REAL
            );
            CREATE TABLE IF NOT EXISTS rm_gps (
                id               SERIAL PRIMARY KEY,
                timestamp        TIMESTAMPTZ NOT NULL,
                lat REAL, lng REAL, speed_kmh REAL, total_distance_m REAL
            );
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_ae_timestamp   ON accelerometer_events(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_ae_ts_sev      ON accelerometer_events(timestamp DESC, severity);
            CREATE INDEX IF NOT EXISTS idx_md_timestamp   ON monitoring_data(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_rd_timestamp   ON realtime_data(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_rd_sensor_ts   ON realtime_data(sensor, timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_gps_timestamp  ON rm_gps(timestamp DESC);
        `);
        pgReady = true;
        console.log('PostgreSQL connected and schema ready');
    } catch (e) {
        console.error('PostgreSQL init error:', e.message);
    }
}
initDB();

// ── Row → camelCase normaliser (keeps frontend contracts unchanged) ────────
function normImpact(r) {
    return {
        timestamp:  r.timestamp, sensor: r.sensor, severity: r.severity,
        peak_g:     r.peak_g,    gForce: r.g_force,
        rmsV:  r.rms_v,  rmsL:  r.rms_l,
        sdV:   r.sd_v,   sdL:   r.sd_l,
        p2pV:  r.p2p_v,  p2pL:  r.p2p_l,
        x: r.x, y: r.y, z: r.z,
        fs: r.fs, window_ms: r.window_ms,
        distance_m: r.distance_m, p_class: r.p_class,
        lat: r.lat || null, lng: r.lng || null
    };
}
function normMonitoring(r) {
    return {
        timestamp: r.timestamp, device_id: r.device_id, type: r.type,
        x_axis: r.x_axis, y_axis: r.y_axis, z_axis: r.z_axis,
        gForce: r.g_force,
        rmsV: r.rms_v, rmsL: r.rms_l,
        sdV:  r.sd_v,  sdL:  r.sd_l,
        p2pV: r.p2p_v, p2pL: r.p2p_l,
        peak: r.peak, fs: r.fs, window_ms: r.window_ms
    };
}

// ── DB clock anchor — returns latest timestamp in realtime_data ──────────
let _dbLatestTs = null;
async function getDBNow() {
    try {
        const r = await pool.query(
            'SELECT timestamp FROM realtime_data ORDER BY timestamp DESC LIMIT 1'
        );
        if (r.rows.length) {
            let dbTs = new Date(r.rows[0].timestamp);
            if (peaksLog && peaksLog.length) {
                const logLatest = new Date(peaksLog[peaksLog.length - 1].timestamp);
                if (logLatest > dbTs) dbTs = logLatest;
            }
            _dbLatestTs = dbTs;
        }
    } catch (e) { /* use cached or server clock */ }
    return _dbLatestTs || new Date();
}
setInterval(() => getDBNow(), 30000);

// ── MQTT ──────────────────────────────────────────────────────────────────
let lastDataTimestamp = null;
let mqttConnected     = false;
const mqttClient = mqtt.connect(`mqtt://${process.env.MQTT_HOST}:${process.env.MQTT_PORT}`);

// ── ODR decimation — server-side emit gating ──────────────────────────────
// Hardware always publishes at 200 Hz. odrConfig controls how many of those
// messages are forwarded to all Socket.IO clients.
//   200 Hz → factor 1 → every message emitted
//   100 Hz → factor 2 → 1 of every 2 messages emitted
//    50 Hz → factor 4 → 1 of every 4 messages emitted
let odrConfig   = { accel1: 100, accel2: 100 };
const odrCounters = { accel1: 0, accel2: 0 };

// Track last packet time per sensor to detect offline sensors
const sensorLastSeen = { s1: 0, s2: 0 };
const SENSOR_TIMEOUT_MS = 10000; // 10 s — mark FAIL if no packet in this window

function shouldEmit(sensorKey) {
    const odr    = odrConfig[sensorKey] || 200;
    const factor = Math.round(200 / odr);
    odrCounters[sensorKey] = (odrCounters[sensorKey] + 1) % factor;
    return odrCounters[sensorKey] === 0;
}

// ── Health parser ─────────────────────────────────────────────────────────
// TODO: Details of peripherals to be fetched from controller encoded in msg.
function parseHealthMessage(msgStr) {
    const get = pattern => {
        const m = msgStr.match(pattern);
        if (!m) return 'UNKNOWN';
        return m[1].trim().toUpperCase() === 'OK' ? 'OK' : 'FAIL';
    };
    return {
        usart2:     get(/USART2\s*:\s*(OK|FAIL)/i),
        spi1:       get(/SPI1\s*:\s*(OK|FAIL)/i),
        adxl345_s1: get(/ADXL345\s+S1\s*:\s*(OK|FAIL)/i),
        adxl345_s2: get(/ADXL345\s+S2\s*:\s*(OK|FAIL)/i),
        w5500:      get(/W5500\s*:\s*(OK|FAIL)/i),
        phyLink:    get(/PHY\s*Link\s*:\s*(OK|FAIL)/i),
        tcp:        get(/TCP\s*:\s*(OK|FAIL)/i),
        timestamp:  new Date().toISOString(),
        raw:        msgStr.trim()
    };
}

// ── Stats helper — single source of truth ────────────────────────────────
// Used by both REST and socket broadcasts
// Tries CouchDB first (authoritative), falls back to peaksLog JSON
// ── P-class thresholds — persisted to file so they survive restarts ───────
const THRESHOLDS_FILE = path.join(__dirname, 'thresholds.json');

function loadThresholds() {
    try {
        if (fs.existsSync(THRESHOLDS_FILE))
            return JSON.parse(fs.readFileSync(THRESHOLDS_FILE, 'utf8'));
    } catch (e) { console.error('thresholds.json read error:', e.message); }
    return { p1Min: 5, p1Max: 10, p2Min: 10, p2Max: 20, p3Min: 20 };
}

function saveThresholds(t) {
    try { fs.writeFileSync(THRESHOLDS_FILE, JSON.stringify(t, null, 2)); }
    catch (e) { console.error('thresholds.json write error:', e.message); }
}

let pClassThresholds = loadThresholds();
console.log('[thresholds] Loaded:', pClassThresholds);

function getPClass(peakG) {
    if (peakG == null) return null;
    const g = +peakG;
    if (g >= pClassThresholds.p3Min)                                    return 'P3';
    if (g >= pClassThresholds.p2Min && g < pClassThresholds.p2Max)      return 'P2';
    if (g >= pClassThresholds.p1Min && g < pClassThresholds.p1Max)      return 'P1';
    return null;
}

// Severity follows the configured P-class thresholds: P3→HIGH, P2→MEDIUM, P1→LOW
function getSeverity(peakG) {
    const pc = getPClass(peakG);
    if (pc === 'P3') return 'HIGH';
    if (pc === 'P2') return 'MEDIUM';
    if (pc === 'P1') return 'LOW';
    return 'LOW';
}

// GET /api/thresholds
app.get('/api/thresholds', (req, res) => res.json(pClassThresholds));

// POST /api/thresholds  body: { p1Min, p1Max, p2Min, p2Max, p3Min }
app.post('/api/thresholds', (req, res) => {
    const { p1Min, p1Max, p2Min, p2Max, p3Min } = req.body;
    if ([p1Min, p1Max, p2Min, p2Max, p3Min].some(v => v == null || isNaN(v)))
        return res.status(400).json({ error: 'All threshold values required' });
    pClassThresholds = { p1Min: +p1Min, p1Max: +p1Max, p2Min: +p2Min, p2Max: +p2Max, p3Min: +p3Min };
    saveThresholds(pClassThresholds);
    console.log('[thresholds] Updated and saved:', pClassThresholds);
    // Broadcast to all connected clients so dashboards update live
    io.emit('thresholds-updated', pClassThresholds);
    res.json({ success: true, thresholds: pClassThresholds });
});

// ── Last health status (kept in memory, served via /api/latest/health) ───
let lastHealthStatus = null;


// Increments when GPS data arrives with a new coordinate
// 0 when system is static
let totalDistanceM = 0;
let lastGpsCoord   = null; // { lat, lng } — used to calculate delta distance

// ── computeStats ──────────────────────────────────────────────────────────
async function computeStats(hours = 24) {
    const dbNow  = await getDBNow();
    const cutoff = new Date(dbNow.getTime() - hours * 3600000).toISOString();

    // ── PostgreSQL path ───────────────────────────────────────────────────
    if (pgReady) {
        try {
            const agg = await pool.query(`
                SELECT
                    COUNT(*)                                        AS total,
                    COUNT(*) FILTER (WHERE severity = 'HIGH')      AS high,
                    COUNT(*) FILTER (WHERE severity = 'MEDIUM')    AS medium,
                    COUNT(*) FILTER (WHERE severity = 'LOW')       AS low,
                    COALESCE(MAX(peak_g), 0)                       AS max_peak,
                    COALESCE(AVG(peak_g), 0)                       AS avg_peak
                FROM accelerometer_events
                WHERE timestamp >= $1
            `, [cutoff]);

            const last = await pool.query(`
                SELECT peak_g, sensor, timestamp, p_class
                FROM accelerometer_events
                WHERE timestamp >= $1
                ORDER BY timestamp DESC LIMIT 1
            `, [cutoff]);

            const row     = agg.rows[0];
            const lastDoc = last.rows[0] || null;
            const stats   = {
                total:             parseInt(row.total),
                highSeverity:      parseInt(row.high),
                medium:            parseInt(row.medium),
                low:               parseInt(row.low),
                maxPeak:           parseFloat(row.max_peak),
                avgPeak:           parseFloat(row.avg_peak),
                lastPeak:          lastDoc ? (lastDoc.peak_g || 0) : 0,
                lastPeakClass:     lastDoc ? (lastDoc.p_class || getPClass(lastDoc.peak_g) || '—') : '—',
                lastPeakTimestamp: lastDoc ? lastDoc.timestamp : null,
                lastPeakSensor:    lastDoc ? lastDoc.sensor    : null,
                totalDistanceM,
                source: 'postgres'
            };
            console.log(`[stats] PG: ${stats.total} impacts, lastPeak=${stats.lastPeak}g (${stats.lastPeakClass})`);
            return stats;
        } catch (e) {
            console.error('[stats] PG failed, falling back to JSON:', e.message);
        }
    }

    // ── JSON fallback ─────────────────────────────────────────────────────
    const recent  = peaksLog
        .filter(p => p.timestamp >= cutoff)
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const peaks   = recent.map(p => p.peak_g || 0);
    const lastDoc = recent[0];
    const stats   = {
        total:              recent.length,
        highSeverity:       recent.filter(p => p.severity === 'HIGH').length,
        medium:             recent.filter(p => p.severity === 'MEDIUM').length,
        low:                recent.filter(p => p.severity === 'LOW').length,
        maxPeak:            peaks.length ? Math.max(...peaks) : 0,
        avgPeak:            peaks.length ? peaks.reduce((a,b) => a+b,0) / peaks.length : 0,
        lastPeak:           lastDoc ? (lastDoc.peak_g || 0) : 0,
        lastPeakClass:      lastDoc ? (getPClass(lastDoc.peak_g) || '—') : '—',
        lastPeakTimestamp:  lastDoc ? lastDoc.timestamp : null,
        lastPeakSensor:     lastDoc ? lastDoc.sensor    : null,
        totalDistanceM,
        source: 'json_fallback'
    };
    console.log(`[stats] JSON: ${stats.total} impacts, lastPeak=${stats.lastPeak}g (${stats.lastPeakClass})`);
    return stats;
}

// ── API endpoints ─────────────────────────────────────────────────────────
app.get('/api/impacts/stats', async (req, res) => {
    try {
        const hours = parseInt(req.query.hours) || 24;
        const stats = await computeStats(hours);
        res.json(stats);
    } catch (e) {
        console.error('/api/impacts/stats error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/latest/sensor ────────────────────────────────────────────────
app.get('/api/latest/sensor', async (req, res) => {
    try {
        const result = { left: null, right: null };

        if (pgReady) {
            for (const side of ['left', 'right']) {
                const r = await pool.query(`
                    SELECT * FROM monitoring_data
                    WHERE device_id = $1
                    ORDER BY timestamp DESC LIMIT 1
                `, [side]);
                if (r.rows.length) {
                    const d = r.rows[0];
                    result[side] = {
                        sensor: side,
                        x: d.x_axis ?? 0, y: d.y_axis ?? 0, z: d.z_axis ?? 0,
                        rmsV: d.rms_v, rmsL: d.rms_l,
                        sdV:  d.sd_v,  sdL:  d.sd_l,
                        p2pV: d.p2p_v, p2pL: d.p2p_l,
                        peak: d.peak, gForce: d.g_force,
                        fs: d.fs, window: d.window_ms,
                        timestamp: d.timestamp
                    };
                }
            }
        }

        // Fallback: use peaksLog
        if (!result.left || !result.right) {
            const sorted = [...peaksLog].sort((a,b) => b.timestamp.localeCompare(a.timestamp));
            for (const p of sorted) {
                if ((p.sensor === 'left' || p.sensor === 'right') && !result[p.sensor]) {
                    result[p.sensor] = {
                        sensor: p.sensor, x: p.x ?? 0, y: p.y ?? 0, z: p.z ?? 0,
                        rmsV: p.rmsV, rmsL: p.rmsL, sdV: p.sdV, sdL: p.sdL,
                        p2pV: p.p2pV, p2pL: p.p2pL, peak: p.peak_g,
                        gForce: p.gForce, timestamp: p.timestamp
                    };
                }
                if (result.left && result.right) break;
            }
        }

        res.json(result);
    } catch (e) {
        console.error('/api/latest/sensor error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/latest/health ────────────────────────────────────────────────
// Returns the most recent system health status (stored in memory from MQTT)
// On server restart we have no history, so returns null if never received
app.get('/api/latest/health', (req, res) => {
    res.json(lastHealthStatus);
});

// ── GET /api/history/sensor ───────────────────────────────────────────────
app.get('/api/history/sensor', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    try {
        if (pgReady) {
            const r = await pool.query(`
                SELECT sensor, x_axis, y_axis, z_axis, g_force, rms_v, rms_l, timestamp
                FROM (
                    SELECT device_id AS sensor, x_axis, y_axis, z_axis,
                           g_force, rms_v, rms_l, timestamp
                    FROM monitoring_data
                    ORDER BY timestamp DESC LIMIT $1
                ) sub
                ORDER BY timestamp ASC
            `, [limit]);
            return res.json(r.rows.map(d => ({
                sensor: d.sensor,
                x: d.x_axis ?? 0, y: d.y_axis ?? 0, z: d.z_axis ?? 0,
                rmsV: d.rms_v, rmsL: d.rms_l,
                gForce: d.g_force, timestamp: d.timestamp
            })));
        }
    } catch (e) {
        console.error('/api/history/sensor error:', e.message);
    }
    res.json([]);
});

// GET /api/history/distance-chart?from=ISO&to=ISO&limit=5000
// Returns paired left/right sensor history for the Acceleration vs Distance chart.
// Supports explicit from/to ISO timestamps OR hours= fallback.
app.get('/api/history/distance-chart', async (req, res) => {
    try {
        if (!pgReady) return res.json({ left: [], right: [] });

        const limit = Math.min(parseInt(req.query.limit) || 5000, 10000);
        let startTime, endTime;

        if (req.query.from && req.query.to) {
            startTime = new Date(req.query.from).toISOString();
            endTime   = new Date(req.query.to).toISOString();
        } else {
            const hours = parseInt(req.query.hours) || 24;
            const dbNow = await getDBNow();
            endTime   = dbNow.toISOString();
            startTime = new Date(dbNow.getTime() - hours * 3600000).toISOString();
        }

        const r = await pool.query(`
            SELECT sensor, x, y, z, timestamp
            FROM realtime_data
            WHERE timestamp >= $1 AND timestamp <= $2
            ORDER BY timestamp ASC
            LIMIT $3
        `, [startTime, endTime, limit * 2]);

        const left  = r.rows.filter(d => d.sensor === 'left');
        const right = r.rows.filter(d => d.sensor === 'right');
        res.json({ left, right });
    } catch (e) {
        console.error('/api/history/distance-chart error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/impacts', async (req, res) => {
    try {
        const { from, to, hours } = req.query;

        // Build WHERE clause — prefer explicit from/to, fall back to hours
        let where = '', params = [];
        if (from && to) {
            where = 'WHERE timestamp >= $1 AND timestamp <= $2';
            params = [new Date(from).toISOString(), new Date(to).toISOString()];
        } else if (from) {
            where = 'WHERE timestamp >= $1';
            params = [new Date(from).toISOString()];
        } else if (parseInt(hours) > 0) {
            where = 'WHERE timestamp >= $1';
            params = [new Date(Date.now() - parseInt(hours) * 3600000).toISOString()];
        }

        if (pgReady) {
            const r = await pool.query(`
                SELECT * FROM accelerometer_events
                ${where}
                ORDER BY timestamp DESC LIMIT 2000
            `, params);
            // Always return DB result when a date filter was applied — even if empty.
            // Without this guard, 0 DB rows would fall through to the fallback and
            // return unfiltered data.
            if (where || r.rows.length) return res.json(r.rows.map(normImpact));
        }
    } catch (e) {
        console.error('/api/impacts error:', e.message);
    }

    // Fallback to JSON log (only reached when DB is unavailable and no date filter)
    let fallback = [...peaksLog].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    if (from) fallback = fallback.filter(p => p.timestamp >= new Date(from).toISOString());
    if (to)   fallback = fallback.filter(p => p.timestamp <= new Date(to).toISOString());
    else if (parseInt(hours) > 0) {
        const cutoff = new Date(Date.now() - parseInt(hours) * 3600000).toISOString();
        fallback = fallback.filter(p => p.timestamp >= cutoff);
    }
    res.json(fallback.slice(0, 2000));
});

// GET /api/history/g-value?from=ISO&to=ISO — peak g per sensor for operator dashboard
app.get('/api/history/g-value', async (req, res) => {
    try {
        if (!pgReady) return res.json([]);
        const { from, to } = req.query;
        if (!from || !to) return res.status(400).json({ error: 'from and to required' });
        const r = await pool.query(`
            SELECT sensor, peak, timestamp
            FROM realtime_data
            WHERE timestamp >= $1 AND timestamp <= $2
            ORDER BY timestamp ASC
            LIMIT 5000
        `, [new Date(from).toISOString(), new Date(to).toISOString()]);
        res.json(r.rows);
    } catch (e) {
        console.error('/api/history/g-value error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/historical/graph/:hours', async (req, res) => {
    try {
        const hours     = parseInt(req.params.hours) || 24;
        const dbNow     = await getDBNow();
        const timeLimit = new Date(dbNow.getTime() - hours * 3600000).toISOString();
        const r = await pool.query(`
            SELECT x_axis, y_axis, z_axis, timestamp,
                   rms_v, rms_l, sd_v, sd_l, p2p_v, p2p_l
            FROM monitoring_data
            WHERE timestamp >= $1
            ORDER BY timestamp ASC LIMIT 2000
        `, [timeLimit]);
        res.json(r.rows.map((doc, i) => ({
            distance:  i * 100,
            accel1:    doc.x_axis  || 0,
            accel2:    doc.y_axis  || 0,
            magnitude: doc.z_axis  || 0,
            timestamp: doc.timestamp,
            rmsV: doc.rms_v, rmsL: doc.rms_l,
            sdV:  doc.sd_v,  sdL:  doc.sd_l,
            p2pV: doc.p2p_v, p2pL: doc.p2p_l
        })));
    } catch (e) {
        console.error('/api/historical/graph error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/realtime/status', (req, res) => {
    res.json({
        connected:          mqttConnected,
        receiving_data:     mqttConnected && lastDataTimestamp && (Date.now() - lastDataTimestamp < 10000),
        last_data_received: lastDataTimestamp,
        time_since_last:    lastDataTimestamp ? Math.floor((Date.now() - lastDataTimestamp) / 1000) : null
    });
});

// GET /api/realtime/impacts
// Returns recent real-time data directly from the realtime_data database
app.get('/api/realtime/impacts', async (req, res) => {
    try {
        const minutes = parseInt(req.query.minutes) || 1;
        const cutoffTime = new Date(Date.now() - minutes * 60000).toISOString();
        
        if (realtimeDataDB) {
            const response = await realtimeDataDB.find({
                selector: { timestamp: { $gte: cutoffTime } },
                sort: [{ timestamp: 'desc' }],
                limit: 500
            });
            
            const impacts = response.docs.map(doc => ({
                timestamp: doc.timestamp,
                sensor: doc.sensor,
                peak_g: doc.peak || doc.gForce || 0,
                peak: doc.peak,
                gForce: doc.gForce || 0,
                x: doc.x || 0,
                y: doc.y || 0,
                z: doc.z || 0,
                rmsV: doc.rmsV,
                rmsL: doc.rmsL,
                sdV: doc.sdV,
                sdL: doc.sdL,
                p2pV: doc.p2pV,
                p2pL: doc.p2pL,
                distance_m: doc.distance_m || totalDistanceM || 0,
                source: 'realtime'
            }));
            
            console.log('[/api/realtime/impacts] Returned', impacts.length, 'readings');
            return res.json(impacts);
        }
        
        res.json([]);
    } catch (e) {
        console.error('[/api/realtime/impacts] Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/monitoring/peaks
// Returns monitoring_data docs with peak/gForce above a threshold (default 5g)
// (removed monitoring peaks endpoint — restored to previous server state)

// ── Management Dashboard APIs ─────────────────────────────────────────────

// GET /api/management/sensor-chart?hours=24
app.get('/api/management/sensor-chart', async (req, res) => {
    const hours = Math.min(parseInt(req.query.hours) || 24, 168);
    try {
        const dbNow  = await getDBNow();
        const cutoff = new Date(dbNow.getTime() - hours * 3600000).toISOString();
        const r = await pool.query(`
            SELECT to_char(date_trunc('hour', timestamp AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24') AS h,
                   AVG(g_force) AS avg_g
            FROM realtime_data
            WHERE timestamp >= $1
            GROUP BY h ORDER BY h
        `, [cutoff]);

        const buckets = {};
        for (const row of r.rows) buckets[row.h] = +parseFloat(row.avg_g).toFixed(4);

        const now    = new Date();
        const result = [];
        for (let i = hours - 1; i >= 0; i--) {
            const d     = new Date(now.getTime() - i * 3600000);
            const h     = d.toISOString().slice(0, 13);
            const label = `${String(d.getHours()).padStart(2, '0')}:00`;
            result.push({ label, avg: buckets[h] ?? null });
        }
        res.json(result);
    } catch (e) {
        console.error('/api/management/sensor-chart error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/acceleration/channels?minutes=2
app.get('/api/acceleration/channels', async (req, res) => {
    try {
        const minutes = Math.min(parseInt(req.query.minutes) || 2, 1440);
        const anchorR = await pool.query(
            'SELECT timestamp FROM realtime_data ORDER BY timestamp DESC LIMIT 1'
        );
        const anchorTs = anchorR.rows.length ? new Date(anchorR.rows[0].timestamp) : new Date();
        const cutoff   = new Date(anchorTs.getTime() - minutes * 60000).toISOString();

        const r = await pool.query(`
            SELECT sensor, x, y, z, timestamp
            FROM realtime_data
            WHERE timestamp >= $1
            ORDER BY timestamp ASC LIMIT 20000
        `, [cutoff]);

        const buckets = {};
        for (const doc of r.rows) {
            const sec = new Date(doc.timestamp).toISOString().slice(0, 19);
            if (!buckets[sec]) buckets[sec] = { ts: sec, lv: null, ll: null, rv: null, rl: null };
            if (doc.sensor === 'left') {
                buckets[sec].lv = doc.z != null ? +parseFloat(doc.z).toFixed(4) : null;
                buckets[sec].ll = doc.x != null ? +parseFloat(doc.x).toFixed(4) : null;
            } else if (doc.sensor === 'right') {
                buckets[sec].rv = doc.z != null ? +parseFloat(doc.z).toFixed(4) : null;
                buckets[sec].rl = doc.x != null ? +parseFloat(doc.x).toFixed(4) : null;
            }
        }
        res.json(Object.values(buckets).sort((a, b) => a.ts.localeCompare(b.ts)));
    } catch (e) {
        console.error('/api/acceleration/channels error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/management/sensor-chart-recent
app.get('/api/management/sensor-chart-recent', async (_req, res) => {
    try {
        const cutoff = new Date(Date.now() - 2 * 60000).toISOString();
        const r = await pool.query(`
            SELECT sensor, g_force, timestamp FROM realtime_data
            WHERE timestamp >= $1
            ORDER BY timestamp ASC LIMIT 5000
        `, [cutoff]);
        const buckets = {};
        for (const doc of r.rows) {
            const sec = new Date(doc.timestamp).toISOString().slice(0, 19);
            if (!buckets[sec]) buckets[sec] = { ts: sec, left: null, right: null };
            buckets[sec][doc.sensor] = doc.g_force || 0;
        }
        res.json(Object.values(buckets).sort((a, b) => a.ts.localeCompare(b.ts)));
    } catch (e) {
        console.error('/api/management/sensor-chart-recent error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/management/uptime
app.get('/api/management/uptime', async (req, res) => {
    const hours = 24;
    try {
        const dbNow  = await getDBNow();
        const cutoff = new Date(dbNow.getTime() - hours * 3600000).toISOString();
        const r = await pool.query(`
            SELECT COUNT(DISTINCT date_trunc('hour', timestamp AT TIME ZONE 'UTC')) AS active_hours
            FROM realtime_data WHERE timestamp >= $1
        `, [cutoff]);
        const activeHours = parseInt(r.rows[0].active_hours);
        const pct         = +((activeHours / hours) * 100).toFixed(1);
        res.json({
            uptime_pct:      pct,
            active_hours:    activeHours,
            window_hours:    hours,
            server_uptime_s: Math.floor(process.uptime())
        });
    } catch (e) {
        console.error('/api/management/uptime error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/latest/gps
app.get('/api/latest/gps', async (_req, res) => {
    try {
        const r = await pool.query(`
            SELECT lat, lng, speed_kmh AS "speedKmh",
                   total_distance_m AS "totalDistanceM", timestamp
            FROM rm_gps ORDER BY timestamp DESC LIMIT 1
        `);
        res.json(r.rows.length ? r.rows[0] : null);
    } catch (e) {
        console.error('/api/latest/gps error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/management/active-sensors
app.get('/api/management/active-sensors', async (req, res) => {
    try {
        const cutoff10s = new Date(Date.now() - 10 * 1000).toISOString();
        const r = await pool.query(`
            SELECT DISTINCT ON (sensor) sensor, timestamp
            FROM realtime_data ORDER BY sensor, timestamp DESC
        `);
        const lastSeen = {};
        for (const row of r.rows) {
            const ts = new Date(row.timestamp).toISOString();
            lastSeen[row.sensor] = ts;
        }
        const sensors       = Object.keys(lastSeen);
        const onlineSensors = sensors.filter(s => lastSeen[s] >= cutoff10s);
        const knownSensors  = sensors.filter(s => lastSeen[s] <  cutoff10s);
        res.json({
            count: onlineSensors.length, total_known: sensors.length,
            online: onlineSensors, last_known: knownSensors, last_seen: lastSeen
        });
    } catch (e) {
        console.error('/api/management/active-sensors error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/management/active-alerts
// HIGH/MEDIUM/LOW impact counts from peaksLog in last 24 h
app.get('/api/management/active-alerts', async (req, res) => {
    try {
        const dbNow  = await getDBNow();
        const cutoff = new Date(dbNow.getTime() - 24 * 3600000).toISOString();
        const recent = peaksLog.filter(p => p.timestamp >= cutoff);
        const high   = recent.filter(p => p.severity === 'HIGH').length;
        const medium = recent.filter(p => p.severity === 'MEDIUM').length;
        const low    = recent.filter(p => p.severity === 'LOW').length;
        res.json({
            total:             recent.length,
            high, medium, low,
            require_attention: high + medium,
            latest: [...recent].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 5)
        });
    } catch (e) {
        console.error('/api/management/active-alerts error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/management/system-health
app.get('/api/management/system-health', async (req, res) => {
    try {
        const cutoff10s = new Date(Date.now() - 10 * 1000).toISOString();
        const r = await pool.query(`
            SELECT DISTINCT ON (sensor) sensor, g_force, timestamp
            FROM realtime_data ORDER BY sensor, timestamp DESC
        `);
        let operational = 0, warning = 0, critical = 0;
        for (const doc of r.rows) {
            const g      = doc.g_force || 0;
            const isLive = new Date(doc.timestamp).toISOString() >= cutoff10s;
            if (!isLive)       critical++;
            else if (g >= 15)  critical++;
            else if (g >= 5)   warning++;
            else               operational++;
        }
        if (r.rows.length === 0) critical = 2;
        res.json({ operational, warning, critical, total: operational + warning + critical });
    } catch (e) {
        console.error('/api/management/system-health error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/monitoring/all
app.get('/api/monitoring/all', async (req, res) => {
    try {
        if (!pgReady) return res.status(503).json({ error: 'Database not ready' });
        const r = await pool.query(`
            SELECT device_id, x_axis, y_axis, z_axis, g_force, rms_v, rms_l,
                   sd_v, sd_l, p2p_v, p2p_l, peak, fs, window_ms, timestamp, type
            FROM monitoring_data ORDER BY timestamp ASC LIMIT 500000
        `);
        res.json(r.rows.map(normMonitoring));
    } catch (e) {
        console.error('/api/monitoring/all error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/rci/average?days=1|7|30 ──────────────────────────────────────
app.get('/api/rci/average', async (req, res) => {
    const days = Math.min(parseInt(req.query.days) || 1, 365);
    try {
        const dbNow  = await getDBNow();
        const cutoff = new Date(dbNow.getTime() - days * 86400000).toISOString();

        const r = await pool.query(`
            SELECT rms_v 
            FROM realtime_data 
            WHERE timestamp >= $1 
              AND sensor = 'left' 
              AND rms_v IS NOT NULL
        `, [cutoff]);

        if (!r.rows.length) {
            console.log(`[RCI] No data for ${days} days`);
            return res.json({ avgRms: null, sampleCount: 0 });
        }

        const sum = r.rows.reduce((acc, row) => acc + parseFloat(row.rms_v || 0), 0);
        const avgRms = sum / r.rows.length;

        console.log(`[RCI] ${days} day avg RMS = ${avgRms.toFixed(4)} g (${r.rows.length} samples)`);
        res.json({ 
            avgRms: parseFloat(avgRms.toFixed(4)), 
            sampleCount: r.rows.length 
        });
    } catch (e) {
        console.error('/api/rci/average error:', e.message);
        res.status(500).json({ error: e.message, avgRms: null });
    }
});

// ── GET /api/rci/timeseries?period=24h|7d|30d ─────────────────────────────
// Returns time-bucketed avg RMS values (left sensor, stored in g-units) DESC.
// Wz computation is intentionally NOT done here — all Sperling math lives in
// the frontend (graphs.js) so unit conversions stay in one place.
//
// Bucket granularity:  24h → 1-minute buckets  (yesterday, IST midnight→midnight)
//                       7d → 1-hour  buckets   (last 7 days from latest record)
//                      30d → 4-hour  buckets   (last 30 days from latest record)
// Response: { period, freq_hz, points: [{ timestamp, rms_v_g }], sampleCount }
app.get('/api/rci/timeseries', async (req, res) => {
    const period = (req.query.period || '24h').toLowerCase();
    let hours, truncUnit, maxPoints;
    if      (period === '7d')  { hours = 7  * 24; truncUnit = 'hour';    maxPoints = 168;  }
    else if (period === '30d') { hours = 30 * 24; truncUnit = '4 hours'; maxPoints = 180;  }
    else                       { hours = 24;       truncUnit = 'minute';  maxPoints = 1440; }

    try {
        const dbNow = await getDBNow();
        let cutoff, upperBound;

        if (period === '24h') {
            // Yesterday in IST: from midnight yesterday to midnight today
            const istNow           = DateTime.fromJSDate(dbNow).setZone('Asia/Kolkata');
            const startOfToday     = istNow.startOf('day');
            const startOfYesterday = startOfToday.minus({ days: 1 });
            cutoff     = startOfYesterday.toISO();
            upperBound = startOfToday.toISO();
        } else {
            cutoff     = new Date(dbNow.getTime() - hours * 3600000).toISOString();
            upperBound = dbNow.toISOString();
        }

        const r = await pool.query(`
            SELECT
                date_trunc($1, timestamp AT TIME ZONE 'Asia/Kolkata') AS bucket,
                AVG(rms_v)  AS avg_rms_v,
                COUNT(*)    AS sample_count
            FROM realtime_data
            WHERE sensor      = 'left'
              AND rms_v IS NOT NULL
              AND rms_v > 0
              AND timestamp  >= $2
              AND timestamp  <  $3
            GROUP BY bucket
            ORDER BY bucket DESC
            LIMIT $4
        `, [truncUnit, cutoff, upperBound, maxPoints]);

        if (!r.rows.length) {
            console.log(`[RCI timeseries] No data for period=${period}`);
            return res.json({ period, freq_hz: 100, points: [], sampleCount: 0 });
        }

        // Return raw rms_v in g — Sperling Wz computation is done entirely in frontend
        const points = r.rows.map(row => ({
            timestamp: row.bucket,                          // IST bucket timestamp
            rms_v_g:   parseFloat(parseFloat(row.avg_rms_v).toFixed(5)),
            n:         parseInt(row.sample_count)           // samples in bucket (debug aid)
        }));

        console.log(`[RCI timeseries] period=${period} → ${points.length} buckets | ` +
                    `rms range: ${Math.min(...points.map(p=>p.rms_v_g)).toFixed(4)}–` +
                    `${Math.max(...points.map(p=>p.rms_v_g)).toFixed(4)} g`);

        res.json({ period, freq_hz: 100, points, sampleCount: points.length });

    } catch (e) {
        console.error('/api/rci/timeseries error:', e.message);
        res.status(500).json({ error: e.message, points: [] });
    }
});

// POST /api/device/reset — publishes RESET command to the embedded device
app.post('/api/device/reset', (_req, res) => {
    mqttClient.publish('adj/datalogger/client_request', 'RESET', { qos: 1 }, (err) => {
        if (err) {
            console.error('RESET publish error:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
        console.log('RESET command sent to device');
        res.json({ success: true });
    });
});

app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'OK', timestamp: new Date(), postgres: 'connected',
                   mqtt: mqttConnected, last_data: lastDataTimestamp });
    } catch (e) {
        res.json({ status: 'ERROR', timestamp: new Date(), postgres: 'disconnected', error: e.message });
    }
});

// GET /api/dates-with-data — returns array of "YYYY-MM-DD" strings that have records
app.get('/api/dates-with-data', async (_req, res) => {
    try {
        if (pgReady) {
            const r = await pool.query(`
                SELECT DISTINCT to_char(DATE(timestamp AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS day
                FROM realtime_data
                ORDER BY day DESC
                LIMIT 365
            `);
            return res.json(r.rows.map(r => r.day));
        }
        // JSON fallback
        const days = [...new Set(peaksLog.map(p => p.timestamp.slice(0, 10)))].sort().reverse();
        res.json(days);
    } catch (e) {
        console.error('/api/dates-with-data error:', e.message);
        res.status(500).json([]);
    }
});

app.get('/api', (req, res) => {
    res.json({ message: 'Railway Monitoring API', endpoints: {
        impacts:          'GET /api/impacts',
        impacts_stats:    'GET /api/impacts/stats?hours=24',
        historical_graph: 'GET /api/historical/graph/:hours',
        realtime_status:  'GET /api/realtime/status',
        health:           'GET /health'
    }});
});

// ── WebSocket ─────────────────────────────────────────────────────────────
io.on('connection', async (socket) => {
    console.log('Client connected:', socket.id);

    // Send historical chart data
    try {
        const dbNow     = await getDBNow();
        const timeLimit = new Date(dbNow.getTime() - 86400000).toISOString();
        const r = await pool.query(`
            SELECT x_axis, y_axis, z_axis, timestamp,
                   rms_v, rms_l, sd_v, sd_l, p2p_v, p2p_l
            FROM monitoring_data
            WHERE timestamp >= $1
            ORDER BY timestamp ASC LIMIT 2000
        `, [timeLimit]);
        socket.emit('historical-data', r.rows.map((doc, i) => ({
            distance:  i * 100,
            accel1:    doc.x_axis || 0, accel2: doc.y_axis || 0,
            magnitude: doc.z_axis || 0, timestamp: doc.timestamp,
            rmsV: doc.rms_v, rmsL: doc.rms_l,
            sdV:  doc.sd_v,  sdL:  doc.sd_l,
            p2pV: doc.p2p_v, p2pL: doc.p2p_l
        })));
    } catch (e) {
        console.error('sendHistoricalData error:', e.message);
        socket.emit('historical-data', []);
    }

    // Send current stats immediately on connect so frontend shows correct counts
    try {
        const stats = await computeStats(24);
        socket.emit('stats-update', stats);
        console.log(`Sent stats to ${socket.id}: total=${stats.total}`);
    } catch (e) {
        console.error('stats-update on connect error:', e.message);
    }

    socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// ── MQTT handler ──────────────────────────────────────────────────────────
mqttClient.on('error', err => { console.error('MQTT error:', err.message); mqttConnected = false; });
mqttClient.on('close', ()  => { console.warn('MQTT closed'); mqttConnected = false; });

mqttClient.on('connect', () => {
    console.log(`MQTT Connected to ${process.env.MQTT_HOST}:${process.env.MQTT_PORT}`);
    mqttConnected = true;
    [
        'adj/datalogger/sensors/left',
        'adj/datalogger/sensors/right',
        'adj/datalogger/sensors/event',
        'adj/datalogger/health',
        'adj/datalogger/sensors/accelerometer',
        'adj/datalogger/sensors/gps'

    ].forEach(topic => {
        mqttClient.subscribe(topic, err => {
            if (err) console.error(`Subscribe failed ${topic}:`, err.message);
            else     console.log(`Subscribed: ${topic}`);
        });
    });
});

mqttClient.on('message', async (topic, message) => {
    try {
        const timestamp = new Date().toISOString();
        lastDataTimestamp = Date.now();

        console.log(`\n=== Received on: ${topic} ===`);

        // ── Binary packet path (STM32 via W5500 Ethernet → MQTT directly) ───
        // S1/S2: 66 bytes, first byte 0x01 or 0x02
        // EVENT:  13 bytes, first byte 0x03
        const pktType = message[0];

        if (pktType === 0x03 && message.length === 15) {
            const ts     = message.readUInt32LE(1);
            const s1_mag = message.readFloatLE(5);
            const s2_mag = message.readFloatLE(9);
            console.log(`[binary EVENT] ts=${ts} S1=${s1_mag.toFixed(3)}g S2=${s2_mag.toFixed(3)}g`);
            io.emit('binary-event', { timestamp_ms: ts, s1: { magnitude: +s1_mag.toFixed(4) }, s2: { magnitude: +s2_mag.toFixed(4) } });
            return;
        }

        if ((pktType === 0x01 || pktType === 0x02) && message.length === 68) {
            const sensorSide = pktType === 0x01 ? 'left' : 'right';

            // ── Accelerometer fields (offsets per official packet spec) ───
            const x     = message.readFloatLE(1);   // Ax
            const y     = message.readFloatLE(5);   // Ay
            const z     = message.readFloatLE(9);   // Az
            const rmsV  = message.readFloatLE(13);  // RMS-V  (vertical RMS)
            const rmsL  = message.readFloatLE(17);  // RMS-L  (lateral RMS)
            const sdV   = message.readFloatLE(21);  // SD-V   (vertical std dev)
            const sdL   = message.readFloatLE(25);  // SD-L   (lateral std dev)
            const p2pV  = message.readFloatLE(29);  // P2P-V  (peak-to-peak vertical)
            const p2pL  = message.readFloatLE(33);  // P2P-L  (peak-to-peak lateral)
            const peak  = message.readFloatLE(37);  // PEAK   (max G-force)
            const ts    = message.readUInt32LE(41); // Timestamp (ms)
            const latRaw = message.readFloatLE(45); // Latitude  (raw × 1e6)
            const lonRaw = message.readFloatLE(49); // Longitude (raw × 1e6)
            const sats    = message.readUInt16LE(53); // Satellites (uint16)
            const speedMs = message.readFloatLE(55);  // Speed cm/s (firmware packs gps_data.speed_cms)
            const hh    = message.readUInt8(59);    // Hour
            const mm_t  = message.readUInt8(60);    // Minute
            const ss    = message.readUInt8(61);    // Second
            const dd    = message.readUInt8(62);    // Day
            const mo    = message.readUInt8(63);    // Month
            const yr    = message.readUInt16LE(64); // Year

            const lat    = +(latRaw / 1e6).toFixed(6);
            const lng    = +(lonRaw / 1e6).toFixed(6);
            const gForce = Math.sqrt(x**2 + y**2 + z**2);

            console.log(`[binary] [${sensorSide}]: Ax=${x.toFixed(4)} Ay=${y.toFixed(4)} Az=${z.toFixed(4)} gForce=${gForce.toFixed(4)} PEAK=${peak.toFixed(4)} RMS-V=${rmsV.toFixed(4)} RMS-L=${rmsL.toFixed(4)} SD-V=${sdV.toFixed(4)} SD-L=${sdL.toFixed(4)} P2P-V=${p2pV.toFixed(4)} P2P-L=${p2pL.toFixed(4)} GPS=${lat},${lng} SAT=${sats} SPD=${(speedMs*3.6).toFixed(1)}km/h ${String(hh).padStart(2,'0')}:${String(mm_t).padStart(2,'0')}:${String(ss).padStart(2,'0')} ${String(dd).padStart(2,'0')}/${String(mo).padStart(2,'0')}/${yr}`);

            // Track last-seen time per sensor
            if (pktType === 0x01) sensorLastSeen.s1 = Date.now();
            if (pktType === 0x02) sensorLastSeen.s2 = Date.now();

            const now = Date.now();
            const inferredHealth = Object.assign({}, lastHealthStatus || {}, {
                w5500:      'OK',
                phyLink:    'OK',
                tcp:        'OK',
                spi1:       'OK',
                usart2:     'OK',
                adxl345_s1: (now - sensorLastSeen.s1) < SENSOR_TIMEOUT_MS ? 'OK' : 'FAIL',
                adxl345_s2: (now - sensorLastSeen.s2) < SENSOR_TIMEOUT_MS ? 'OK' : 'FAIL',
            });
            lastHealthStatus = inferredHealth;
            io.emit('system-health', inferredHealth);

            // GPS update — lat/lon decoded from float in packet (already decimal degrees ÷ 1e6)
            if (lat && lng) {
                if (lastGpsCoord) {
                    const dLat = (lat - lastGpsCoord.lat) * Math.PI / 180;
                    const dLon = (lng - lastGpsCoord.lng) * Math.PI / 180;
                    const a    = Math.sin(dLat/2)**2 +
                                 Math.cos(lastGpsCoord.lat * Math.PI/180) *
                                 Math.cos(lat * Math.PI/180) *
                                 Math.sin(dLon/2)**2;
                    const d    = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
                    // 5 m minimum filters float32 GPS noise when stationary
                    if (d >= 5 && d < 500) totalDistanceM += d;
                }
                lastGpsCoord = { lat, lng };
                const speedKmh = +(speedMs * 0.036).toFixed(2); // cm/s → km/h
                io.emit('gps-data', { lat, lng, speedKmh, totalDistanceM, timestamp });
                if (pgReady) {
                    pool.query(
                        'INSERT INTO rm_gps (timestamp, lat, lng, speed_kmh, total_distance_m) VALUES ($1,$2,$3,$4,$5)',
                        [timestamp, lat, lng, speedKmh, totalDistanceM]
                    ).catch(e => console.error('gps insert:', e.message));
                }
            }

            // Store readings
            if (pgReady) {
                pool.query(
                    `INSERT INTO monitoring_data
                     (timestamp, type, device_id, x_axis, y_axis, z_axis,
                      g_force, rms_v, rms_l, sd_v, sd_l, p2p_v, p2p_l, peak)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
                    [timestamp, 'accelerometer', sensorSide,
                     x, y, z, gForce, rmsV, rmsL, sdV, sdL, p2pV, p2pL, peak]
                ).catch(e => console.error('monitoring_data insert:', e.message));

                pool.query(
                    `INSERT INTO realtime_data
                     (timestamp, sensor, x, y, z, g_force, rms_v, rms_l, sd_v, sd_l, p2p_v, p2p_l, peak)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
                    [timestamp, sensorSide, x, y, z, gForce, rmsV, rmsL, sdV, sdL, p2pV, p2pL, peak]
                ).catch(e => console.error('realtime_data insert:', e.message));
            }

            // Impact detection
            const peakVal = peak || gForce;
            if (peakVal > 2) {
                const pClass   = getPClass(peakVal);
                const severity = getSeverity(peakVal);
                const impact   = {
                    timestamp, sensor: sensorSide, severity, peak_g: peakVal, gForce,
                    rmsV, rmsL, sdV, sdL, p2pV, p2pL,
                    x, y, z, distance_m: totalDistanceM, p_class: pClass
                };
                peaksLog.push(impact);
                savePeaksLog(peaksLog);
                if (pgReady) {
                    const hasGpsFix = lastGpsCoord?.lat && lastGpsCoord?.lng;
                    pool.query(
                        `INSERT INTO accelerometer_events
                         (timestamp, sensor, severity, peak_g, g_force,
                          rms_v, rms_l, sd_v, sd_l, p2p_v, p2p_l,
                          x, y, z, distance_m, p_class, lat, lng)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
                        [timestamp, sensorSide, severity, peakVal, gForce,
                         rmsV, rmsL, sdV, sdL, p2pV, p2pL,
                         x, y, z, totalDistanceM, pClass,
                         hasGpsFix ? lastGpsCoord.lat : null,
                         hasGpsFix ? lastGpsCoord.lng : null]
                    ).catch(e => console.error('events insert:', e.message));
                }
                io.emit('new-impact', impact);
                computeStats(24).then(stats => io.emit('stats-update', stats)).catch(() => {});
            }

            // Real-time broadcast (respects ODR decimation)
            const odrKey = sensorSide === 'left' ? 'accel1' : 'accel2';
            if (shouldEmit(odrKey)) {
                io.emit('accelerometer-data', {
                    sensor: sensorSide, x, y, z, gForce,
                    rmsV, rmsL, sdV, sdL, p2pV, p2pL, peak, timestamp
                });
            } else {
                console.log(`[ODR] Dropped: ${sensorSide} @ ${odrConfig[odrKey]}Hz`);
            }
            return;
        }

        // ── Text path (legacy / health) ───────────────────────────────────
        const msgStr = message.toString();
        console.log(`Raw: ${msgStr.substring(0, 200)}`);

        // ── Health topic ──────────────────────────────────────────────────
        if (topic === 'adj/datalogger/health') {
            const health = parseHealthMessage(msgStr);
            lastHealthStatus = health; // persist for /api/latest/health
            console.log('Health:', health);
            io.emit('system-health', health);
            return;
        }

        // ── GPS — detect by message content (may be embedded in sensor message) ──
        // Format: GPS:T-13:13:47 D-27-03-2026 LAT:28584835N LON:77315948E SPD:25cm/s
        if (msgStr.includes('[GPS]') || msgStr.includes('GPS:')) {
            const latM  = msgStr.match(/LAT:(\d+)([NS])/i);
            const lonM  = msgStr.match(/LON:(\d+)([EW])/i);
            const spdM  = msgStr.match(/SPD:(\d+(?:\.\d+)?)cm\/s/i);

            if (latM && lonM) {
                const rawLat = parseInt(latM[1]);
                const rawLon = parseInt(lonM[1]);
                const lat = (rawLat / 1e6) * (latM[2].toUpperCase() === 'S' ? -1 : 1);
                const lng = (rawLon / 1e6) * (lonM[2].toUpperCase() === 'W' ? -1 : 1);
                const speedCms = spdM ? parseFloat(spdM[1]) : 0;
                const speedKmh = +(speedCms * 0.036).toFixed(2);

                if (lastGpsCoord) {
                    const R    = 6371000;
                    const dLat = (lat - lastGpsCoord.lat) * Math.PI / 180;
                    const dLon = (lng - lastGpsCoord.lng) * Math.PI / 180;
                    const a    = Math.sin(dLat/2)**2 +
                                 Math.cos(lastGpsCoord.lat * Math.PI/180) *
                                 Math.cos(lat * Math.PI/180) *
                                 Math.sin(dLon/2)**2;
                    const d    = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
                    if (d >= 5 && d < 500) totalDistanceM += d;
                }
                lastGpsCoord = { lat, lng };

                const gpsPayload = { lat, lng, speedKmh, totalDistanceM, timestamp };
                io.emit('gps-data', gpsPayload);
                if (pgReady) {
                    pool.query(
                        'INSERT INTO rm_gps (timestamp, lat, lng, speed_kmh, total_distance_m) VALUES ($1,$2,$3,$4,$5)',
                        [timestamp, lat, lng, speedKmh, totalDistanceM]
                    ).catch(e => console.error('gps insert:', e.message));
                }
                console.log(`GPS: lat=${lat} lng=${lng} spd=${speedKmh}km/h`);
            }

            // If message is ONLY GPS (dedicated topic), stop here
            if (topic === 'adj/datalogger/sensors/gps' || topic.includes('gps')) return;
            // Otherwise fall through to also parse sensor data below
        }

        // ── Sensor topics only ────────────────────────────────────────────
        const sensorSide = topic.includes('right') ? 'right'
                         : topic.includes('left')  ? 'left' : null;
        if (!sensorSide) return;

        // Parse axes
        const ax = msgStr.match(/Ax\s*:\s*([+-]?\d+\.?\d*)/i);
        const ay = msgStr.match(/Ay\s*:\s*([+-]?\d+\.?\d*)/i);
        const az = msgStr.match(/Az\s*:\s*([+-]?\d+\.?\d*)/i);
        const xm = msgStr.match(/X=([+-]?\d+\.?\d*)/);
        const ym = msgStr.match(/Y=([+-]?\d+\.?\d*)/);
        const zm = msgStr.match(/Z=([+-]?\d+\.?\d*)/);

        const x = ax ? parseFloat(ax[1]) : (xm ? parseFloat(xm[1]) : 0);
        const y = ay ? parseFloat(ay[1]) : (ym ? parseFloat(ym[1]) : 0);
        const z = az ? parseFloat(az[1]) : (zm ? parseFloat(zm[1]) : 0);

        const rmsVm = msgStr.match(/RMS-V\s*:\s*([+-]?\d+\.?\d*)/i);
        const rmsLm = msgStr.match(/RMS-L\s*:\s*([+-]?\d+\.?\d*)/i);
        const sdVm  = msgStr.match(/SD-V\s*:\s*([+-]?\d+\.?\d*)/i);
        const sdLm  = msgStr.match(/SD-L\s*:\s*([+-]?\d+\.?\d*)/i);
        const p2pVm = msgStr.match(/P2P-V\s*:\s*([+-]?\d+\.?\d*)/i);
        const p2pLm = msgStr.match(/P2P-L\s*:\s*([+-]?\d+\.?\d*)/i);
        const pkm   = msgStr.match(/PEAK\s*:\s*([+-]?\d+\.?\d*)/i);
        const fsm   = msgStr.match(/FS\s*:\s*(\d+)/i);
        const winm  = msgStr.match(/WINDOW\s*:\s*(\d+)/i);

        const rmsV = rmsVm ? parseFloat(rmsVm[1]) : null;
        const rmsL = rmsLm ? parseFloat(rmsLm[1]) : null;
        const sdV  = sdVm  ? parseFloat(sdVm[1])  : null;
        const sdL  = sdLm  ? parseFloat(sdLm[1])  : null;
        const p2pV = p2pVm ? parseFloat(p2pVm[1]) : null;
        const p2pL = p2pLm ? parseFloat(p2pLm[1]) : null;
        const peak = pkm   ? parseFloat(pkm[1])   : null;
        const fs   = fsm   ? parseInt(fsm[1])      : null;
        const win  = winm  ? parseInt(winm[1])     : null;

        const gForce = Math.sqrt(x**2 + y**2 + z**2);

        console.log(`Parsed [${sensorSide}]: x=${x} y=${y} z=${z} peak=${peak} gForce=${gForce.toFixed(4)}`);

        // ── Store in monitoring_data ──────────────────────────────────────
        if (pgReady) {
            pool.query(
                `INSERT INTO monitoring_data
                 (timestamp, type, device_id, x_axis, y_axis, z_axis,
                  g_force, rms_v, rms_l, sd_v, sd_l, p2p_v, p2p_l, peak, fs, window_ms)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
                [timestamp, 'accelerometer', sensorSide,
                 x, y, z, gForce, rmsV, rmsL, sdV, sdL, p2pV, p2pL, peak, fs, win]
            ).catch(e => console.error('monitoring_data insert:', e.message));

            pool.query(
                `INSERT INTO realtime_data
                 (timestamp, sensor, x, y, z, g_force, rms_v, rms_l, sd_v, sd_l, p2p_v, p2p_l, peak)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
                [timestamp, sensorSide, x, y, z, gForce, rmsV, rmsL, sdV, sdL, p2pV, p2pL, peak]
            ).catch(e => console.error('realtime_data insert:', e.message));
        }

        // ── Impact detection ──────────────────────────────────────────────
        const peakVal = peak || gForce;
        if (peakVal > 2) {
            const pClass    = getPClass(peakVal);
            const severity  = getSeverity(peakVal);
            const impact    = {
                timestamp, sensor: sensorSide, severity, peak_g: peakVal, gForce,
                rmsV, rmsL, sdV, sdL, p2pV, p2pL, x, y, z, fs, window_ms: win,
                distance_m: totalDistanceM,   // 0 when static, real value when GPS active
                p_class:    pClass            // P1 / P2 / P3 / null
            };

            // Save to JSON fallback (always reliable)
            peaksLog.push(impact);
            savePeaksLog(peaksLog);

            // Save to PostgreSQL
            if (pgReady) {
                const hasGpsFix = lastGpsCoord && lastGpsCoord.lat && lastGpsCoord.lng;
                pool.query(
                    `INSERT INTO accelerometer_events
                     (timestamp, sensor, severity, peak_g, g_force,
                      rms_v, rms_l, sd_v, sd_l, p2p_v, p2p_l,
                      x, y, z, fs, window_ms, distance_m, p_class,
                      lat, lng)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
                    [timestamp, sensorSide, impact.severity, impact.peak_g, gForce,
                     rmsV, rmsL, sdV, sdL, p2pV, p2pL,
                     x, y, z, fs, win, totalDistanceM, impact.p_class,
                     hasGpsFix ? lastGpsCoord.lat : null,
                     hasGpsFix ? lastGpsCoord.lng : null]
                ).catch(e => console.error('accelerometerEvents insert:', e.message));
            }

            // Broadcast impact event
            io.emit('new-impact', impact);
            console.log(`IMPACT: ${peakVal.toFixed(3)}g (${severity}) on ${sensorSide}`);

            // ── Broadcast fresh stats to ALL connected clients immediately ──
            // This is what keeps the counters live without polling
            computeStats(24).then(stats => {
                io.emit('stats-update', stats);
                console.log(`[stats-update] broadcast: total=${stats.total} max=${stats.maxPeak.toFixed(2)}g source=${stats.source}`);
            }).catch(e => console.error('stats broadcast error:', e.message));
        }

        // Broadcast raw sensor data — gated by server-side ODR decimation
        const _odrKey = sensorSide === 'left' ? 'accel1' : 'accel2';
        if (shouldEmit(_odrKey)) {
            io.emit('accelerometer-data', {
                sensor: sensorSide, x, y, z, gForce,
                rmsV, rmsL, sdV, sdL, p2pV, p2pL, peak, timestamp
            });
            console.log(`Broadcast: X=${x}, Y=${y}, Z=${z}, gForce=${gForce.toFixed(4)}g`);
        } else {
            console.log(`[ODR] Dropped: ${sensorSide} @ ${odrConfig[_odrKey]}Hz`);
        }

    } catch (error) {
        console.error('MQTT message error:', error);
    }
});

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Local IP: ${LOCAL_IP}`);
    console.log(`Frontend: http://${LOCAL_IP}:${PORT}/index.html`);

    console.log(`PostgreSQL: ${process.env.PG_HOST || 'localhost'}:${process.env.PG_PORT || 5432}/${process.env.PG_DB || 'uabams'}`);
});

// ── Reset endpoint ────────────────────────────────────────────────────────
// POST /api/reset
// Body: { saveToDb: true }  → keep CouchDB, reset display only (peaksLog cleared)
// Body: { saveToDb: false } → wipe CouchDB + peaksLog, everything back to 0
app.post('/api/reset', async (req, res) => {
    const saveToDb = req.body?.saveToDb === true;
    console.log(`[reset] requested — saveToDb=${saveToDb}`);

    try {
        if (!saveToDb) {
            // ── Truncate PostgreSQL tables ────────────────────────────────
            try {
                await pool.query('TRUNCATE TABLE accelerometer_events, monitoring_data, realtime_data');
                console.log('[reset] PostgreSQL tables truncated');
            } catch (e) {
                console.error('[reset] Failed to truncate tables:', e.message);
            }

            // Wipe JSON fallback file
            peaksLog = [];
            savePeaksLog(peaksLog);
            console.log('[reset] JSON fallback cleared');
        }

        // Always broadcast zero stats to all clients
        const zeroStats = { total: 0, highSeverity: 0, medium: 0, low: 0, maxPeak: 0, avgPeak: 0, source: 'reset' };
        io.emit('stats-update', zeroStats);
        io.emit('display-reset', { saveToDb });

        console.log(`[reset] Complete — saveToDb=${saveToDb}`);
        res.json({ success: true, saveToDb, message: saveToDb ? 'Display reset — DB preserved' : 'Full reset — DB cleared' });

    } catch (e) {
        console.error('[reset] Error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── CSV Export endpoint ───────────────────────────────────────────────────
// GET /api/test-report/csv?from=ISO&to=ISO
// Exports every sensor window in the range as a paired S1+S2 CSV test report
app.get('/api/test-report/csv', async (req, res) => {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).send('from and to required');

    try {
        if (!pgReady) return res.status(503).send('DB not ready');

        const r = await pool.query(`
            SELECT rd.sensor, rd.timestamp, rd.x, rd.y, rd.z, rd.g_force,
                   rd.rms_v, rd.rms_l, rd.sd_v, rd.sd_l, rd.p2p_v, rd.p2p_l, rd.peak,
                   g.lat, g.lng, g.speed_kmh, g.total_distance_m
            FROM realtime_data rd
            LEFT JOIN LATERAL (
                SELECT lat, lng, speed_kmh, total_distance_m
                FROM rm_gps
                WHERE timestamp <= rd.timestamp
                ORDER BY timestamp DESC
                LIMIT 1
            ) g ON true
            WHERE rd.timestamp >= $1 AND rd.timestamp <= $2
            ORDER BY rd.timestamp ASC
        `, [new Date(from).toISOString(), new Date(to).toISOString()]);

        // Pair S1 and S2 readings by index order
        const left  = r.rows.filter(r => r.sensor === 'left');
        const right = r.rows.filter(r => r.sensor === 'right');
        const n     = Math.max(left.length, right.length);

        const fromDt  = new Date(from);
        const toDt    = new Date(to);
        const durMs   = toDt - fromDt;
        const durSec  = Math.round(durMs / 1000);
        const durStr  = `${Math.floor(durSec/60)}m ${durSec%60}s`;

        const lines = [];
        // Report header block
        lines.push(`# UABAMS TEST RUN REPORT`);
        lines.push(`# Date,${fromDt.toLocaleDateString('en-IN')}`);
        lines.push(`# Start Time,${fromDt.toLocaleTimeString('en-IN')}`);
        lines.push(`# End Time,${toDt.toLocaleTimeString('en-IN')}`);
        lines.push(`# Duration,${durStr}`);
        lines.push(`# Total Windows,${n}`);
        lines.push(`# S1 Readings,${left.length}`);
        lines.push(`# S2 Readings,${right.length}`);
        lines.push('#');

        // Column headers
        lines.push([
            'Window#','Timestamp',
            'S1_Ax(g)','S1_Ay(g)','S1_Az(g)','S1_GForce(g)',
            'S1_RMS_V','S1_RMS_L','S1_SD_V','S1_SD_L','S1_P2P_V','S1_P2P_L','S1_Peak(g)',
            'S2_Ax(g)','S2_Ay(g)','S2_Az(g)','S2_GForce(g)',
            'S2_RMS_V','S2_RMS_L','S2_SD_V','S2_SD_L','S2_P2P_V','S2_P2P_L','S2_Peak(g)',
            'Lat','Lng','Speed_kmh','Distance_m'
        ].join(','));

        const fmt  = (v, d=4) => v != null ? (+v).toFixed(d) : '';
        const fmt6 = (v)      => v != null ? (+v).toFixed(6) : '';

        for (let i = 0; i < n; i++) {
            const l  = left[i]  || {};
            const r2 = right[i] || {};
            const ts = (l.timestamp || r2.timestamp || '').toString();
            // GPS comes from whichever sensor row has it (prefer left)
            const gps = l.lat != null ? l : r2;
            lines.push([
                i + 1,
                ts,
                fmt(l.x), fmt(l.y), fmt(l.z), fmt(l.g_force),
                fmt(l.rms_v), fmt(l.rms_l), fmt(l.sd_v), fmt(l.sd_l),
                fmt(l.p2p_v), fmt(l.p2p_l), fmt(l.peak),
                fmt(r2.x), fmt(r2.y), fmt(r2.z), fmt(r2.g_force),
                fmt(r2.rms_v), fmt(r2.rms_l), fmt(r2.sd_v), fmt(r2.sd_l),
                fmt(r2.p2p_v), fmt(r2.p2p_l), fmt(r2.peak),
                fmt6(gps.lat), fmt6(gps.lng), fmt(gps.speed_kmh, 2), fmt(gps.total_distance_m, 1)
            ].join(','));
        }

        const filename = `test_report_${fromDt.toISOString().slice(0,10)}_${fromDt.toTimeString().slice(0,8).replace(/:/g,'-')}.csv`;
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(lines.join('\r\n'));
    } catch (e) {
        console.error('/api/test-report/csv error:', e.message);
        res.status(500).send('Export failed: ' + e.message);
    }
});

// GET /api/impacts/export/csv?hours=24
// Returns a properly formatted CSV matching the impact_report.csv structure
// Columns: timestamp,sensor,severity,peak_g,rmsV,rmsL,sdV,sdL,p2pV,p2pL,x,y,z,fs,window_ms
app.get('/api/impacts/export/csv', async (req, res) => {
    const { from, to, hours } = req.query;

    let where = '', params = [], label = '';
    if (from && to) {
        where  = 'WHERE timestamp >= $1 AND timestamp <= $2';
        params = [new Date(from).toISOString(), new Date(to).toISOString()];
        label  = new Date(from).toISOString().slice(0, 10);
    } else {
        const h      = parseInt(hours) || 24;
        const dbNow  = await getDBNow();
        const cutoff = new Date(dbNow.getTime() - h * 3600000).toISOString();
        where  = 'WHERE timestamp >= $1';
        params = [cutoff];
        label  = `last_${h}h`;
    }

    let docs = [];

    // Try PostgreSQL first
    if (pgReady) {
        try {
            const r = await pool.query(`
                SELECT * FROM accelerometer_events
                ${where}
                ORDER BY timestamp DESC
            `, params);
            docs = r.rows.map(normImpact);
        } catch (e) {
            console.error('[csv] PG read failed, using JSON fallback:', e.message);
        }
    }

    // Fallback to peaks_log.json
    if (!docs.length && !where.includes('$2')) {
        docs = peaksLog
            .filter(p => p.timestamp >= params[0])
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    }

    console.log(`[csv] Exporting ${docs.length} records (${label})`);

    // Build CSV
    const headers = [
        'timestamp', 'sensor', 'severity', 'p_class',
        'peak_g', 'rmsV', 'rmsL', 'sdV', 'sdL', 'p2pV', 'p2pL',
        'x', 'y', 'z', 'fs', 'window_ms', 'distance_m',
        'lat', 'lng'
    ];

    const fmt = v => (v == null || v === undefined) ? '' : String(v);

    const rows = docs.map(d => [
        fmt(d.timestamp),
        fmt(d.sensor),
        fmt(d.severity),
        fmt(d.p_class   || getPClass(d.peak_g) || ''),
        fmt(d.peak_g    != null ? (+d.peak_g).toFixed(6)  : ''),
        fmt(d.rmsV      != null ? (+d.rmsV).toFixed(3)    : ''),
        fmt(d.rmsL      != null ? (+d.rmsL).toFixed(3)    : ''),
        fmt(d.sdV       != null ? (+d.sdV).toFixed(3)     : ''),
        fmt(d.sdL       != null ? (+d.sdL).toFixed(3)     : ''),
        fmt(d.p2pV      != null ? (+d.p2pV).toFixed(3)    : ''),
        fmt(d.p2pL      != null ? (+d.p2pL).toFixed(3)    : ''),
        fmt(d.x         != null ? (+d.x).toFixed(3)       : ''),
        fmt(d.y         != null ? (+d.y).toFixed(3)       : ''),
        fmt(d.z         != null ? (+d.z).toFixed(3)       : ''),
        fmt(d.fs        != null ? d.fs                     : ''),
        fmt(d.window_ms != null ? d.window_ms              : ''),
        fmt(d.distance_m != null ? d.distance_m            : '0'),
        fmt(d.lat       != null ? (+d.lat).toFixed(6)      : ''),
        fmt(d.lng       != null ? (+d.lng).toFixed(6)      : '')
    ].join(','));

    const csv = [headers.join(','), ...rows].join('\n');

    const filename = `impact_report_${label}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-cache');
    res.send(csv);
});

// ── ODR config endpoints ──────────────────────────────────────────────────
// GET /api/odr-config
// Returns the current ODR setting for both accelerometers.
app.get('/api/odr-config', (req, res) => {
    res.json(odrConfig);
});

// POST /api/odr-config  body: { accel1: 100, accel2: 50 }
// Updates ODR and resets counters so the next sample is always accepted.
// Broadcasts 'odr-config-changed' to all connected clients.
app.post('/api/odr-config', (req, res) => {
    const { accel1, accel2 } = req.body;
    const valid = [50, 100, 200];
    if (!valid.includes(Number(accel1)) || !valid.includes(Number(accel2))) {
        return res.status(400).json({ error: 'ODR must be 50, 100, or 200 Hz' });
    }
    odrConfig.accel1   = Number(accel1);
    odrConfig.accel2   = Number(accel2);
    odrCounters.accel1 = 0;   // reset so next sample is always accepted
    odrCounters.accel2 = 0;
    console.log(`[ODR] Updated → accel1=${odrConfig.accel1}Hz  accel2=${odrConfig.accel2}Hz`);
    io.emit('odr-config-changed', odrConfig);   // notify all open pages
    res.json({ success: true, odrConfig });
});

// ── Limits config endpoints ───────────────────────────────────────────────
// GET /api/limits-config
// Returns the current UML and Limit Class configuration.
app.get('/api/limits-config', (req, res) => {
    res.json(limitsConfig);
});

// POST /api/limits-config  body: { uml: {...}, limitClass: {...} }
// Saves UML and Limit Class values to memory + disk and notifies all pages.
app.post('/api/limits-config', (req, res) => {
    const { uml, limitClass } = req.body;
    limitsConfig.uml        = uml        ?? null;
    limitsConfig.limitClass = limitClass ?? null;
    saveLimitsConfig(limitsConfig);
    console.log('[limits] Config updated and saved to limits_config.json');
    io.emit('limits-config-changed', limitsConfig);   // notify all open pages
    res.json({ success: true, limitsConfig });
});