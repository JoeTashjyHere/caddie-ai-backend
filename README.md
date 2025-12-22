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


