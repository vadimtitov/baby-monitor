# Baby Sleep Tracker

A simple, mobile-friendly baby sleep tracking application. Designed for one-click deployment via Portainer.

## Features

- **One-tap interface** - Large button to toggle sleep/awake state
- **Live timer** - Real-time duration display while sleeping
- **Statistics** - Total sleep, average session, session count, longest session
- **Charts** - Daily sleep hours bar chart (last 30 days)
- **Timezone support** - Switch between London, Barcelona, and Moscow
- **Home Assistant** - Optional event push on state changes
- **Mobile-ready** - Add to iPhone home screen as a web app
- **Auto-migration** - Database tables and indexes are created automatically on first start

## Deploy via Portainer

1. In Portainer, go to **Stacks** > **Add stack**
2. Select **Repository**
3. Enter repository URL and branch
4. Set **Compose path**: `docker-compose.yml`
5. Under **Environment variables**, add:

   | Variable | Required | Example |
   |----------|----------|---------|
   | `DB_URI` | Yes | `postgresql://user:pass@192.168.50.135:5432/baby_sleep` |
   | `HA_URL` | No | `http://homeassistant.local:8123` |
   | `HA_TOKEN` | No | your HA long-lived access token |
   | `PORT` | No | `3000` (default) |

6. Click **Deploy the stack**

That's it. The backend will automatically create the database table, indexes, and triggers on first startup.

The app will be available at `http://your-server-ip:3000`.

## Deploy via CLI

```bash
git clone https://github.com/your-user/baby-monitor.git
cd baby-monitor
cp .env.example .env
# Edit .env — set DB_URI at minimum
docker compose up -d
```

## Add to iPhone Home Screen

1. Open Safari on your iPhone
2. Navigate to `http://your-server-ip:3000`
3. Tap the Share button
4. Select "Add to Home Screen"
5. Name it "Baby Sleep" and tap Add

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DB_URI` | Yes | — | PostgreSQL connection string |
| `PORT` | No | `3000` | Port the app is exposed on |
| `HA_URL` | No | — | Home Assistant URL |
| `HA_TOKEN` | No | — | Home Assistant access token |

## Home Assistant Integration

When `HA_URL` and `HA_TOKEN` are set, the backend fires an event on every sleep state change:

**Endpoint:** `POST {HA_URL}/api/events/baby_sleep_state_changed`

**Payload:**
```json
{
  "state": "sleeping",
  "timestamp": "2024-01-15T22:30:00.000Z",
  "session_id": 42
}
```

To create a long-lived access token in Home Assistant:
1. Go to your Profile (bottom-left)
2. Scroll to "Long-Lived Access Tokens"
3. Click "Create Token"

The app works fine without Home Assistant configured.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/sleep/current` | Get active sleep session |
| `POST` | `/api/sleep/start` | Start sleep session |
| `POST` | `/api/sleep/end` | End sleep session |
| `GET` | `/api/sleep/sessions` | List sessions (query: `start_date`, `end_date`, `limit`) |
| `GET` | `/api/sleep/stats` | Get aggregated statistics |
| `DELETE` | `/api/sleep/sessions/:id` | Delete a session |

## Backup and Restore

```bash
# Backup
pg_dump "your_db_uri" > backup.sql

# Restore
psql "your_db_uri" < backup.sql
```

## Troubleshooting

### Backend can't connect to database
- Verify `DB_URI` is correct and the database host is reachable from Docker
- Check backend logs: click the backend container in Portainer > Logs
- The backend retries connection for up to 60 seconds on startup

### Frontend shows "Loading..." forever
- The backend might still be starting — wait a moment and refresh
- Check backend container logs for errors

### Charts not displaying
- Charts only appear after you have completed sleep sessions (start + stop)

### Home Assistant events not received
- Verify `HA_URL` is reachable from within Docker (not `localhost`)
- Check that `HA_TOKEN` is a valid long-lived access token
- Check backend logs for error messages

## Architecture

```
browser → nginx (port 3000) → node backend (port 3001) → your PostgreSQL
```

Two containers: frontend (nginx) and backend (node). Database is external (yours).

## Project Structure

```
baby-monitor/
├── README.md
├── docker-compose.yml
├── .env.example
├── .gitignore
├── database/
│   └── schema.sql          # Reference only — backend auto-migrates
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   ├── server.js
│   └── .dockerignore
└── frontend/
    ├── Dockerfile
    ├── nginx.conf
    └── index.html
```
