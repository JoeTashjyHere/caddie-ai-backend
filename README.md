# Caddie.AI Backend Server

## Quick Start

### 1. Install Dependencies (First Time Only)
```bash
cd backend
npm install
```

### 2. Set OpenAI API Key (Optional - for AI features)
```bash
export OPENAI_API_KEY=sk-your-key-here
```

### 3. Start the Server
```bash
# Option 1: Use the startup script
./start-server.sh

# Option 2: Direct command
node index.js

# Option 3: Using npm
npm start
```

The server will start on **http://localhost:8080**

## Testing on Physical iPhone

### Step 1: Find Your Mac's IP Address
```bash
ifconfig | grep "inet " | grep -v 127.0.0.1
```

Look for an IP like `192.168.1.151` or `10.0.0.5` (your local network IP).

### Step 2: Update APIService.swift
Open `ios/Services/APIService.swift` and update the IP address in the `baseURL` and `healthCheckURL` properties (lines 24 and 33) to match your Mac's IP.

### Step 3: Ensure Same Wi-Fi Network
- Make sure your iPhone and Mac are connected to the **same Wi-Fi network**
- Disable VPN if active (it can block local network access)

### Step 4: Check Firewall
On your Mac, go to:
- **System Settings** → **Network** → **Firewall**
- Make sure the firewall allows incoming connections for Node.js, or temporarily disable it for testing

### Step 5: Start the Server
```bash
cd backend
./start-server.sh
```

You should see:
```
✅ Server Configuration:
   - Port: 8080
   - Local URL: http://localhost:8080
   - Network URL: http://192.168.1.151:8080
```

### Step 6: Test Connection
1. Open the Caddie.AI app on your iPhone
2. The "Backend offline" warning should disappear
3. You should see courses loading (if location is enabled)

## Troubleshooting

### "Backend offline" still showing
1. **Check server is running**: Look for "Server running on port 8080" in terminal
2. **Verify IP address**: Make sure the IP in `APIService.swift` matches your Mac's current IP
3. **Test from iPhone browser**: Open Safari on iPhone and go to `http://YOUR_MAC_IP:8080/health` - should return `{"status":"ok"}`
4. **Check network**: Ensure both devices are on the same Wi-Fi (not cellular on iPhone)
5. **Firewall**: Temporarily disable Mac firewall to test

### Server won't start
- Check if port 8080 is already in use: `lsof -i :8080`
- Kill the process if needed: `kill -9 <PID>`
- Or change the port in `index.js` and update `APIService.swift` accordingly

### Connection works on Simulator but not iPhone
- Simulator uses `localhost` which works automatically
- iPhone needs the Mac's network IP address
- Update `APIService.swift` with your Mac's IP (see Step 2 above)

## Health Check Endpoint

Test if the server is running:
```bash
curl http://localhost:8080/health
```

Should return: `{"status":"ok"}`

## Environment Variables

- `OPENAI_API_KEY`: Required for AI features (get from https://platform.openai.com/api-keys)
- `PORT`: Optional, defaults to 8080

## Stopping the Server

Press `Ctrl+C` in the terminal where the server is running.

---

## OSM Hazard Enrichment Operator Runbook

The hazard recommendation engine depends on per-hole hazard POIs. The
source CSV covers ~9% of courses. The other ~17,000 courses are enriched
from OpenStreetMap with full provenance (`source_type='source_osm'`,
confidence < 1.0, `osm_id`, `osm_tags`).

### Tools

| Tool | When to use |
|------|------------|
| `npm run osm:audit` | Inspect coverage health at any time. Read-only. |
| `npm run osm:batch:dry -- --limit=N` | Preview the next N courses the queue would enrich. No DB writes. |
| `npm run osm:batch:apply -- --limit=N` | Real enrichment for the next N weakest courses. |
| `POST /api/admin/enrich-osm/:courseId?apply=1` | Enrich a single course on demand (e.g. when a user reports missing hazards). |
| `POST /api/admin/osm-batch?limit=N&apply=1` | **Bounded** batch trigger (≤10 courses, 90 s) for sanity checks. NOT for production scale. |
| `GET  /api/admin/osm-batch-status` | Run history, queue depth, source breakdown. Read-only. |

### Recommended rollout

1. **Dry preview** the next 25 courses:
   ```bash
   DATABASE_URL=postgres://... npm run osm:batch:dry -- --limit=25
   ```

2. **Small first wave** (real writes):
   ```bash
   DATABASE_URL=postgres://... npm run osm:batch:apply -- --limit=25
   ```
   ~1 min run time. Validates the production DB connection and Overpass
   access end-to-end.

3. **Steady-state batches** of 200–500:
   ```bash
   DATABASE_URL=postgres://... node scripts/osm-enrich-batch.js \
     --limit=500 --apply --delay-ms=1500 --max-queries-per-run=2000
   ```
   ~12.5 min per 500 courses. The `--max-queries-per-run` cap pauses
   the run cleanly so you can chain multiple batches without exceeding
   Overpass's 10,000 queries/day soft limit.

4. **Resume after interruption**: just re-run the same command. Already-
   successful courses are excluded automatically (14-day cooldown). To
   force a retry of failed courses, pass `--retry-failed`.

### Safety guarantees

- Default mode is **dry**. `--apply` is required to write.
- Sequential by default (no Overpass parallelism).
- Exponential backoff on 429/504/timeout: 5 s → 15 s → 45 s.
- `--max-queries-per-run` hard caps Overpass usage per invocation.
- Native source data is **never overwritten**; OSM data is only added
  when no native hazard of the same coarse category exists within 15 y.
- Every run and every course attempt is durably persisted in
  `osm_enrichment_runs` / `osm_enrichment_attempts` so the script
  survives Render redeploys, Ctrl-C, and operator handoff.

### Tuning knobs

| Flag | Default | Purpose |
|------|---------|---------|
| `--limit=N` | 25 | Max courses to process this run. |
| `--max-score=N` | 50 | Skip courses already at this score or higher. |
| `--min-score=N` | -1 | Lower bound; rarely needed. |
| `--delay-ms=N` | 1500 | Inter-Overpass-call pause. |
| `--max-queries-per-run=N` | 2000 | Hard cap on Overpass calls per run. |
| `--cooldown-days=N` | 14 | Successful courses stay out of the queue this long. |
| `--retry-failed` | off | Force re-attempt of recently-failed courses. |
| `--course-id=UUID` | – | Single-course escape hatch via the batch script. |

### Future hooks

When `rounds_played_30d` becomes available, the priority formula
becomes `(1 - score/100) × max(rounds, 1)` — the field hook is already
documented in `scripts/osm-enrich-batch.js`. Until then, weakest score
+ most holes + name (deterministic) is the queue order.



