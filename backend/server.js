const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// Database configuration
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'baby_sleep',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
});

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
      body: JSON.stringify({
        state,
        timestamp,
        session_id: sessionId,
      }),
    });
    console.log(`Home Assistant notified: ${state}`);
  } catch (err) {
    console.error('Failed to notify Home Assistant:', err.message);
  }
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
    // Check if there's already an active session
    const active = await pool.query(
      'SELECT id FROM sleep_sessions WHERE end_time IS NULL'
    );
    if (active.rows.length > 0) {
      return res.status(409).json({ error: 'A sleep session is already active' });
    }

    const now = new Date().toISOString();
    const result = await pool.query(
      'INSERT INTO sleep_sessions (start_time) VALUES ($1) RETURNING *',
      [now]
    );

    const session = result.rows[0];
    await notifyHomeAssistant('sleeping', now, session.id);
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

    const now = new Date().toISOString();
    const result = await pool.query(
      'UPDATE sleep_sessions SET end_time = $1 WHERE id = $2 RETURNING *',
      [now, active.rows[0].id]
    );

    const session = result.rows[0];
    await notifyHomeAssistant('awake', now, session.id);
    res.json(session);
  } catch (err) {
    console.error('Error ending session:', err);
    res.status(500).json({ error: 'Failed to end sleep session' });
  }
});

// Get sleep sessions with optional filters
app.get('/api/sleep/sessions', async (req, res) => {
  try {
    const { start_date, end_date, limit } = req.query;
    let query = 'SELECT * FROM sleep_sessions WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (start_date) {
      query += ` AND start_time >= $${paramIndex++}`;
      params.push(start_date);
    }
    if (end_date) {
      query += ` AND start_time <= $${paramIndex++}`;
      params.push(end_date);
    }

    query += ' ORDER BY start_time DESC';

    if (limit) {
      query += ` LIMIT $${paramIndex++}`;
      params.push(parseInt(limit));
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error getting sessions:', err);
    res.status(500).json({ error: 'Failed to get sessions' });
  }
});

// Get aggregated stats
app.get('/api/sleep/stats', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    let dateFilter = '';
    const params = [];
    let paramIndex = 1;

    if (start_date) {
      dateFilter += ` AND start_time >= $${paramIndex++}`;
      params.push(start_date);
    }
    if (end_date) {
      dateFilter += ` AND start_time <= $${paramIndex++}`;
      params.push(end_date);
    }

    // Overall stats (only completed sessions)
    const overallQuery = `
      SELECT
        COUNT(*) as total_sessions,
        COALESCE(SUM(duration_minutes), 0) as total_minutes,
        COALESCE(AVG(duration_minutes), 0) as avg_minutes,
        COALESCE(MAX(duration_minutes), 0) as max_minutes
      FROM sleep_sessions
      WHERE end_time IS NOT NULL ${dateFilter}
    `;
    const overall = await pool.query(overallQuery, params);

    // Daily stats (last 30 days)
    const dailyQuery = `
      SELECT
        DATE(start_time AT TIME ZONE 'UTC') as date,
        COUNT(*) as sessions,
        COALESCE(SUM(duration_minutes), 0) as total_minutes
      FROM sleep_sessions
      WHERE end_time IS NOT NULL
        AND start_time >= NOW() - INTERVAL '30 days'
        ${dateFilter}
      GROUP BY DATE(start_time AT TIME ZONE 'UTC')
      ORDER BY date
    `;
    const daily = await pool.query(dailyQuery, params);

    // Hourly distribution
    const hourlyQuery = `
      SELECT
        EXTRACT(HOUR FROM start_time AT TIME ZONE 'UTC') as hour,
        COUNT(*) as sessions,
        COALESCE(AVG(duration_minutes), 0) as avg_minutes
      FROM sleep_sessions
      WHERE end_time IS NOT NULL ${dateFilter}
      GROUP BY EXTRACT(HOUR FROM start_time AT TIME ZONE 'UTC')
      ORDER BY hour
    `;
    const hourly = await pool.query(hourlyQuery, params);

    res.json({
      overall: {
        total_sessions: parseInt(overall.rows[0].total_sessions),
        total_minutes: Math.round(parseFloat(overall.rows[0].total_minutes)),
        avg_minutes: Math.round(parseFloat(overall.rows[0].avg_minutes)),
        max_minutes: Math.round(parseFloat(overall.rows[0].max_minutes)),
      },
      daily: daily.rows.map(r => ({
        date: r.date,
        sessions: parseInt(r.sessions),
        total_minutes: Math.round(parseFloat(r.total_minutes)),
      })),
      hourly: hourly.rows.map(r => ({
        hour: parseInt(r.hour),
        sessions: parseInt(r.sessions),
        avg_minutes: Math.round(parseFloat(r.avg_minutes)),
      })),
    });
  } catch (err) {
    console.error('Error getting stats:', err);
    res.status(500).json({ error: 'Failed to get stats' });
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

waitForDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Baby Sleep Tracker API running on port ${PORT}`);
    if (HA_URL) {
      console.log(`Home Assistant integration enabled: ${HA_URL}`);
    } else {
      console.log('Home Assistant integration not configured');
    }
  });
}).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
