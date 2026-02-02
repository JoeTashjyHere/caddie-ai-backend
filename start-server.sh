#!/bin/bash

# Caddie.AI Backend Server Startup Script
# This script helps you start the backend server for iPhone testing

echo "🚀 Starting Caddie.AI Backend Server..."
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is not installed."
    echo "   Please install Node.js from https://nodejs.org/"
    exit 1
fi

# Check if we're in the backend directory
if [ ! -f "package.json" ]; then
    echo "⚠️  Warning: package.json not found. Make sure you're in the backend directory."
    echo "   Running: cd backend"
    cd "$(dirname "$0")" || exit 1
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
    echo ""
fi

# Check for OPENAI_API_KEY
if [ -z "$OPENAI_API_KEY" ]; then
    echo "⚠️  Warning: OPENAI_API_KEY environment variable is not set."
    echo "   The server will start, but AI features may not work."
    echo ""
    echo "   To set it, run:"
    echo "   export OPENAI_API_KEY=sk-your-key-here"
    echo ""
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Get the Mac's local IP address
MAC_IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | head -1 | awk '{print $2}')
if [ -z "$MAC_IP" ]; then
    MAC_IP="<YOUR_MAC_IP>"
fi

echo "✅ Server Configuration:"
echo "   - Port: 8080"
echo "   - Local URL: http://localhost:8080"
echo "   - Network URL: http://$MAC_IP:8080"
echo ""
echo "📱 For iPhone testing:"
echo "   1. Make sure your iPhone and Mac are on the same Wi-Fi network"
echo "   2. Update APIService.swift with IP: $MAC_IP"
echo ""
echo "🌐 Starting server..."
echo "   Press Ctrl+C to stop"
echo ""

# Start the server
node index.js



