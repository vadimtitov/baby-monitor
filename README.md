# Baby Sleep Tracker

A simple, mobile-friendly baby sleep tracking application with Docker deployment and optional Home Assistant integration.

## Features

- **One-tap interface** - Large button to toggle sleep/awake state
- **Live timer** - Real-time duration display while sleeping
- **Statistics** - Total sleep, average session, session count, longest session
- **Charts** - Daily sleep hours bar chart (last 30 days)
- **Timezone support** - Switch between London, Barcelona, and Moscow
- **Home Assistant** - Optional event push on state changes
- **Mobile-ready** - Add to iPhone home screen as a web app

## Architecture

| Container | Image | Port |
|-----------|-------|------|
| Frontend | Nginx Alpine | 3000 |
| Backend | Node 18 Alpine | 3001 |
| Database | PostgreSQL 16 Alpine | 5432 (internal) |

## Quick Start

### 1. Clone and configure

```bash
git clone https://github.com/your-user/baby-monitor.git
cd baby-monitor
cp .env.example .env
```

Edit `.env` and set a strong password:

```
DB_PASSWORD=your_strong_password_here
```

### 2. Start the stack

```bash
docker-compose up -d
```

The app will be available at `http://localhost:3000`.

### 3. Add to iPhone home screen

1. Open Safari on your iPhone
2. Navigate to `http://your-server-ip:3000`
3. Tap the Share button
4. Select "Add to Home Screen"
5. Name it "Baby Sleep" and tap Add

## Deploy via Portainer

1. In Portainer, go to **Stacks** > **Add stack**
2. Select **Repository**
3. Enter repository URL: `https://github.com/your-user/baby-monitor.git`
4. Set **Compose path**: `docker-compose.yml`
5. Under **Environment variables**, add:
   - `DB_PASSWORD` = your strong password
   - `HA_URL` = your Home Assistant URL (optional)
   - `HA_TOKEN` = your HA access token (optional)
6. Click **Deploy the stack**

## Using an Existing PostgreSQL Instance

To use an external PostgreSQL database instead of the bundled container:

1. Run the schema on your existing database:
   ```bash
   psql -h your-db-host -U your-user -d your-db -f database/schema.sql
   ```

2. Modify `docker-compose.yml`:
   - Remove the `postgres` service
   - Remove the `postgres_data` volume
   - Remove `depends_on: postgres` from the backend service
   - Update backend environment variables:
     ```yaml
     environment:
       DB_HOST: your-db-host
       DB_PORT: 5432
       DB_NAME: your-db-name
       DB_USER: your-user
       DB_PASSWORD: ${DB_PASSWORD}
     ```

## Environment Variables

### Backend

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_HOST` | `postgres` | Database hostname |
| `DB_PORT` | `5432` | Database port |
| `DB_NAME` | `baby_sleep` | Database name |
| `DB_USER` | `postgres` | Database user |
| `DB_PASSWORD` | *(required)* | Database password |
| `PORT` | `3001` | API server port |
| `HA_URL` | *(optional)* | Home Assistant URL |
| `HA_TOKEN` | *(optional)* | Home Assistant access token |

### Docker Compose

| Variable | Default | Description |
|----------|---------|-------------|
| `FRONTEND_PORT` | `3000` | Host port for frontend |
| `BACKEND_PORT` | `3001` | Host port for backend |

## Home Assistant Integration

When `HA_URL` and `HA_TOKEN` are set, the backend sends events on every sleep state change:

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

The app works without Home Assistant configured.

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

### Backup

```bash
# Backup the database
docker-compose exec postgres pg_dump -U postgres baby_sleep > backup.sql
```

### Restore

```bash
# Restore from backup
docker-compose exec -T postgres psql -U postgres baby_sleep < backup.sql
```

### Full data directory backup

```bash
# Stop the stack first
docker-compose down

# Backup the volume
docker run --rm -v baby-monitor_postgres_data:/data -v $(pwd):/backup alpine tar czf /backup/db-backup.tar.gz /data

# Restore
docker run --rm -v baby-monitor_postgres_data:/data -v $(pwd):/backup alpine tar xzf /backup/db-backup.tar.gz -C /
```

## Troubleshooting

### Containers won't start
```bash
# Check logs
docker-compose logs

# Check specific service
docker-compose logs backend
```

### Database connection errors
- Verify `DB_PASSWORD` is set in `.env`
- Check that the postgres container is healthy: `docker-compose ps`
- Wait for the health check to pass before the backend connects

### Frontend shows "Loading..." forever
- Check backend logs: `docker-compose logs backend`
- Verify the backend container is running: `docker-compose ps`
- Check nginx config proxies `/api/` to the backend correctly

### Charts not displaying
- Charts only appear when there are completed sleep sessions
- Ensure sessions have both start and end times

### Home Assistant events not received
- Verify `HA_URL` is reachable from the Docker network
- Check that `HA_TOKEN` is a valid long-lived access token
- Check backend logs for error messages

## Project Structure

```
baby-monitor/
├── README.md
├── docker-compose.yml
├── .env.example
├── .gitignore
├── database/
│   └── schema.sql
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
