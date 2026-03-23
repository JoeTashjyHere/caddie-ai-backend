# Render Deployment - Automated Ingestion

## Data Pipeline (One-Time Setup)

### 1. Extract data from ZIP

Place `coursedb_america.zip` at `/mnt/data/` (or any path) and run:

```bash
cd backend
npm run extract-data -- /mnt/data/coursedb_america.zip
# Or: ZIP_PATH=/path/to/zip npm run extract-data
```

Validates and extracts `clubs.csv`, `courses.csv`, `tees.csv`, `coordinates.csv` to `data/`.
Overwrites existing data. Sample data (Pebble Beach) is included for testing; replace with full ZIP.

### 2. Commit and push

```bash
git add data/
git commit -m "Add production course ingestion data"
git push origin main
```

### 3. Raw GitHub URL

Base URL for ingestion:

```
https://raw.githubusercontent.com/JoeTashjyHere/caddie-ai-backend/main/data
```

Test: https://raw.githubusercontent.com/JoeTashjyHere/caddie-ai-backend/main/data/clubs.csv

## Render Environment Variables

### Initial deploy (ingestion runs)

| Variable | Value |
|----------|-------|
| `DATA_SOURCE_TYPE` | `url` |
| `DATA_SOURCE_PATH` | `https://raw.githubusercontent.com/JoeTashjyHere/caddie-ai-backend/main/data` |
| `RUN_INGEST_ON_START` | `true` |
| `DATABASE_URL` | (Render Postgres internal URL) |
| `GOOGLE_PLACES_API_KEY` | (your key) |

### After successful ingestion

Set `RUN_INGEST_ON_START` to `false` to skip ingestion on future deploys.

## Startup Flow

1. Migrations run (idempotent)
2. `SELECT COUNT(*) FROM golf_courses` — if > 0, skip ingestion
3. If empty + `RUN_INGEST_ON_START=true`, fetch CSVs from URL and ingest
4. Server listens
