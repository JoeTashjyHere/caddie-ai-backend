# 🚀 Quick Start Guide - Backend Server

## The Problem
Your iPhone can't connect to the backend because the server isn't running.

## The Solution (3 Steps)

### Step 1: Open Terminal
Open Terminal on your Mac.

### Step 2: Navigate to Backend Folder
```bash
cd ~/Desktop/Caddie.AI/backend
```

### Step 3: Start the Server
```bash
node index.js
```

You should see:
```
✅ API running on http://localhost:8080
📱 Network URL: http://192.168.1.151:8080
🏥 Health check: http://192.168.1.151:8080/health
```

**Keep this terminal window open!** The server runs until you press `Ctrl+C`.

---

## Verify It's Working

### On Your Mac:
Open Safari and go to: `http://localhost:8080/health`
- Should show: `{"status":"ok"}`

### On Your iPhone:
1. Make sure iPhone and Mac are on the **same Wi-Fi network**
2. Open Safari on iPhone
3. Go to: `http://192.168.1.151:8080/health`
4. Should show: `{"status":"ok"}`

If the iPhone can't connect:
- ✅ Check both devices are on the same Wi-Fi
- ✅ Check Mac's firewall (System Settings → Network → Firewall)
- ✅ Make sure the IP in `APIService.swift` matches `192.168.1.151`

---

## Optional: Set OpenAI API Key
If you want AI features to work:
```bash
export OPENAI_API_KEY=sk-your-key-here
node index.js
```

---

## Stop the Server
Press `Ctrl+C` in the terminal where it's running.

---

## Your Current Configuration
- **Mac IP**: 192.168.1.151 ✅ (matches APIService.swift)
- **Port**: 8080
- **Status**: Server needs to be started
