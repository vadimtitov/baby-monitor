const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Bearer token auth — if API_TOKEN is set, all /api requests require it
const API_TOKEN = process.env.API_TOKEN;
if (API_TOKEN) {
  const expectedBuf = Buffer.from(`Bearer ${API_TOKEN}`);
  app.use('/api', (req, res, next) => {
    const auth = req.headers.authorization || '';
    const authBuf = Buffer.from(auth);
    if (authBuf.length !== expectedBuf.length ||
        !crypto.timingSafeEqual(authBuf, expectedBuf)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });
}

// Database configuration — accepts DB_URI or falls back to individual vars
const pool = process.env.DB_URI
  ? new Pool({ connectionString: process.env.DB_URI })
  : new Pool({
      host: process.env.DB_HOST || 'postgres',
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME || 'baby_sleep',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD,
    });

// Night starts at this UTC hour (sessions before 07:00 or >= NIGHT_START_HOUR are "night")
const NIGHT_START_HOUR = parseInt(process.env.NIGHT_START_HOUR || '19');
const LANGUAGE = process.env.LANGUAGE || 'en';
const BABY_NAME = process.env.BABY_NAME || '';

// Home Assistant configuration
const HA_URL = process.env.HA_URL;
const HA_TOKEN = process.env.HA_TOKEN;

async function notifyHomeAssistant(state, timestamp, sessionId) {
  if (!HA_URL || !HA_TOKEN) return;
  try {
    const url = `${HA_URL.replace(/\/+$/, '')}/api/events/baby_sleep_state_changed`;
    await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HA_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state, timestamp, session_id: sessionId }),
    });
    console.log(`Home Assistant notified: ${state}`);
  } catch (err) {
    console.error('Failed to notify Home Assistant:', err.message);
  }
}

// Auto-migrate: create table, indexes, trigger on startup
async function migrate() {
  console.log('Running database migration...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sleep_sessions (
      id SERIAL PRIMARY KEY,
      start_time TIMESTAMPTZ NOT NULL,
      end_time TIMESTAMPTZ,
      duration_minutes INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_sleep_sessions_start_time ON sleep_sessions (start_time);
    CREATE INDEX IF NOT EXISTS idx_sleep_sessions_end_time ON sleep_sessions (end_time);

    CREATE OR REPLACE FUNCTION calculate_duration()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.end_time IS NOT NULL AND NEW.start_time IS NOT NULL THEN
        NEW.duration_minutes := EXTRACT(EPOCH FROM (NEW.end_time - NEW.start_time)) / 60;
      END IF;
      NEW.updated_at := NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_calculate_duration ON sleep_sessions;
    CREATE TRIGGER trg_calculate_duration
      BEFORE INSERT OR UPDATE ON sleep_sessions
      FOR EACH ROW
      EXECUTE FUNCTION calculate_duration();

    CREATE TABLE IF NOT EXISTS app_settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('Database migration complete');
}

// Wait for database to be ready
async function waitForDb(retries = 30, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      console.log('Database connected');
      return;
    } catch (err) {
      console.log(`Waiting for database... (${i + 1}/${retries})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Could not connect to database');
}

// Health check
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// App config (from env vars)
app.get('/api/config', (req, res) => {
  res.json({ language: LANGUAGE, baby_name: BABY_NAME });
});

// Persistent settings (stored in DB)
app.get('/api/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM app_settings');
    const settings = {};
    result.rows.forEach(row => { settings[row.key] = row.value; });
    res.json(settings);
  } catch (err) {
    console.error('Error getting settings:', err);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

app.put('/api/settings/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    await pool.query(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
    `, [key, value]);
    res.json({ key, value });
  } catch (err) {
    console.error('Error saving setting:', err);
    res.status(500).json({ error: 'Failed to save setting' });
  }
});

app.delete('/api/settings/:key', async (req, res) => {
  try {
    const { key } = req.params;
    await pool.query('DELETE FROM app_settings WHERE key = $1', [key]);
    res.json({ message: 'Setting deleted' });
  } catch (err) {
    console.error('Error deleting setting:', err);
    res.status(500).json({ error: 'Failed to delete setting' });
  }
});

// Get current active sleep session
app.get('/api/sleep/current', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM sleep_sessions WHERE end_time IS NULL ORDER BY start_time DESC LIMIT 1'
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error('Error getting current session:', err);
    res.status(500).json({ error: 'Failed to get current session' });
  }
});

// Start new sleep session
app.post('/api/sleep/start', async (req, res) => {
  try {
    const active = await pool.query('SELECT id FROM sleep_sessions WHERE end_time IS NULL');
    if (active.rows.length > 0) {
      return res.status(409).json({ error: 'A sleep session is already active' });
    }
    const startTime = req.body.start_time || new Date().toISOString();
    const result = await pool.query(
      'INSERT INTO sleep_sessions (start_time) VALUES ($1) RETURNING *',
      [startTime]
    );
    const session = result.rows[0];
    await notifyHomeAssistant('sleeping', startTime, session.id);
    res.status(201).json(session);
  } catch (err) {
    console.error('Error starting session:', err);
    res.status(500).json({ error: 'Failed to start sleep session' });
  }
});

// End current sleep session
app.post('/api/sleep/end', async (req, res) => {
  try {
    const active = await pool.query(
      'SELECT * FROM sleep_sessions WHERE end_time IS NULL ORDER BY start_time DESC LIMIT 1'
    );
    if (active.rows.length === 0) {
      return res.status(404).json({ error: 'No active sleep session found' });
    }
    const endTime = req.body.end_time || new Date().toISOString();
    const result = await pool.query(
      'UPDATE sleep_sessions SET end_time = $1 WHERE id = $2 RETURNING *',
      [endTime, active.rows[0].id]
    );
    const session = result.rows[0];
    await notifyHomeAssistant('awake', endTime, session.id);
    res.json(session);
  } catch (err) {
    console.error('Error ending session:', err);
    res.status(500).json({ error: 'Failed to end sleep session' });
  }
});

// Continue (reopen) a completed sleep session
app.post('/api/sleep/sessions/:id/continue', async (req, res) => {
  try {
    const active = await pool.query('SELECT id FROM sleep_sessions WHERE end_time IS NULL');
    if (active.rows.length > 0) {
      return res.status(409).json({ error: 'A sleep session is already active' });
    }
    const { id } = req.params;
    const result = await pool.query(
      'UPDATE sleep_sessions SET end_time = NULL, duration_minutes = NULL WHERE id = $1 RETURNING *',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const session = result.rows[0];
    await notifyHomeAssistant('sleeping', session.start_time, session.id);
    res.json(session);
  } catch (err) {
    console.error('Error continuing session:', err);
    res.status(500).json({ error: 'Failed to continue session' });
  }
});

// Get sleep sessions with optional filters
app.get('/api/sleep/sessions', async (req, res) => {
  try {
    const { start_date, end_date, limit } = req.query;
    let query = 'SELECT * FROM sleep_sessions WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    if (start_date) { query += ` AND start_time >= $${paramIndex++}`; params.push(start_date); }
    if (end_date) { query += ` AND start_time <= $${paramIndex++}`; params.push(end_date); }
    query += ' ORDER BY start_time DESC';
    if (limit) { query += ` LIMIT $${paramIndex++}`; params.push(parseInt(limit)); }
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error getting sessions:', err);
    res.status(500).json({ error: 'Failed to get sessions' });
  }
});

// Create a backfilled session (manual entry)
app.post('/api/sleep/sessions', async (req, res) => {
  try {
    const { start_time, end_time } = req.body;
    if (!start_time || !end_time) {
      return res.status(400).json({ error: 'start_time and end_time are required' });
    }
    if (new Date(end_time) <= new Date(start_time)) {
      return res.status(400).json({ error: 'end_time must be after start_time' });
    }
    const result = await pool.query(
      'INSERT INTO sleep_sessions (start_time, end_time) VALUES ($1, $2) RETURNING *',
      [start_time, end_time]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating session:', err);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// Update an existing session
app.put('/api/sleep/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { start_time, end_time } = req.body;
    if (!start_time || !end_time) {
      return res.status(400).json({ error: 'start_time and end_time are required' });
    }
    if (new Date(end_time) <= new Date(start_time)) {
      return res.status(400).json({ error: 'end_time must be after start_time' });
    }
    const result = await pool.query(
      'UPDATE sleep_sessions SET start_time = $1, end_time = $2 WHERE id = $3 RETURNING *',
      [start_time, end_time, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating session:', err);
    res.status(500).json({ error: 'Failed to update session' });
  }
});

// Today stats — anchored to morning wake-up (last sleep end between 04:00–12:00 UTC today)
app.get('/api/sleep/stats/today', async (req, res) => {
  try {
    const wakeUpResult = await pool.query(`
      SELECT end_time FROM sleep_sessions
      WHERE end_time IS NOT NULL
        AND end_time >= CURRENT_DATE + INTERVAL '4 hours'
        AND end_time <  CURRENT_DATE + INTERVAL '12 hours'
      ORDER BY end_time DESC
      LIMIT 1
    `);

    if (wakeUpResult.rows.length === 0) {
      return res.json({ woke_up: null, day_sleep_minutes: 0, awake_minutes: 0, naps: 0 });
    }

    const wakeUpTime = wakeUpResult.rows[0].end_time;

    const napsResult = await pool.query(`
      SELECT
        COUNT(*) as naps,
        COALESCE(SUM(duration_minutes), 0) as day_sleep_minutes
      FROM sleep_sessions
      WHERE end_time IS NOT NULL
        AND start_time > $1
    `, [wakeUpTime]);

    const daySleptMinutes = Math.round(parseFloat(napsResult.rows[0].day_sleep_minutes));
    const naps = parseInt(napsResult.rows[0].naps);
    const awakeMinutes = Math.max(
      0,
      Math.round((Date.now() - new Date(wakeUpTime).getTime()) / 60000) - daySleptMinutes
    );

    res.json({ woke_up: wakeUpTime, day_sleep_minutes: daySleptMinutes, awake_minutes: awakeMinutes, naps });
  } catch (err) {
    console.error('Error getting today stats:', err);
    res.status(500).json({ error: 'Failed to get today stats' });
  }
});

// Weekly stats — last 7 days, split by day/night
app.get('/api/sleep/stats/weekly', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        DATE(start_time AT TIME ZONE 'UTC') as day,
        COALESCE(SUM(duration_minutes), 0) as total_minutes,
        COALESCE(SUM(CASE
          WHEN EXTRACT(HOUR FROM start_time AT TIME ZONE 'UTC') >= $1
            OR EXTRACT(HOUR FROM start_time AT TIME ZONE 'UTC') < 7
          THEN duration_minutes ELSE 0 END), 0) as night_minutes,
        COALESCE(SUM(CASE
          WHEN EXTRACT(HOUR FROM start_time AT TIME ZONE 'UTC') >= 7
           AND EXTRACT(HOUR FROM start_time AT TIME ZONE 'UTC') < $1
          THEN duration_minutes ELSE 0 END), 0) as day_minutes,
        COUNT(CASE
          WHEN EXTRACT(HOUR FROM start_time AT TIME ZONE 'UTC') >= 7
           AND EXTRACT(HOUR FROM start_time AT TIME ZONE 'UTC') < $1
          THEN 1 END) as nap_count
      FROM sleep_sessions
      WHERE end_time IS NOT NULL
        AND start_time >= NOW() - INTERVAL '7 days'
      GROUP BY DATE(start_time AT TIME ZONE 'UTC')
      ORDER BY day
    `, [NIGHT_START_HOUR]);

    const days = result.rows;
    const n = Math.max(days.length, 1);

    res.json({
      averages: {
        total_minutes: Math.round(days.reduce((s, d) => s + parseFloat(d.total_minutes), 0) / n),
        night_minutes: Math.round(days.reduce((s, d) => s + parseFloat(d.night_minutes), 0) / n),
        day_minutes:   Math.round(days.reduce((s, d) => s + parseFloat(d.day_minutes),   0) / n),
        naps: Math.round(days.reduce((s, d) => s + parseInt(d.nap_count), 0) / n * 10) / 10,
      },
      daily: days.map(d => ({
        date: d.day,
        night_minutes: Math.round(parseFloat(d.night_minutes)),
        day_minutes:   Math.round(parseFloat(d.day_minutes)),
      })),
    });
  } catch (err) {
    console.error('Error getting weekly stats:', err);
    res.status(500).json({ error: 'Failed to get weekly stats' });
  }
});

// Delete a session
app.delete('/api/sleep/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'DELETE FROM sleep_sessions WHERE id = $1 RETURNING *',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json({ message: 'Session deleted', session: result.rows[0] });
  } catch (err) {
    console.error('Error deleting session:', err);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// Start server
const PORT = parseInt(process.env.PORT || '3001');

waitForDb()
  .then(() => migrate())
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Baby Sleep Tracker API running on port ${PORT}`);
      console.log(`Night/day boundary: ${NIGHT_START_HOUR}:00 UTC`);
      console.log(`Language: ${LANGUAGE}${BABY_NAME ? `, Baby name: ${BABY_NAME}` : ''}`);
      console.log(`API auth: ${API_TOKEN ? 'enabled (Bearer token required)' : 'disabled (no API_TOKEN set)'}`);
      if (HA_URL) {
        console.log(`Home Assistant integration enabled: ${HA_URL}`);
      } else {
        console.log('Home Assistant integration not configured');
      }
    });
  })
  .catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
