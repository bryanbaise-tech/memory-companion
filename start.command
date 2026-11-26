#!/bin/bash
# Double-click this file (or run ./start.command) to open the app in your browser.
cd "$(dirname "$0")"
PORT=8080
echo "Memory Companion is running at http://localhost:$PORT"
echo "On a phone on the same Wi-Fi, open: http://$(ipconfig getifaddr en0 2>/dev/null || echo YOUR-MAC-IP):$PORT"
echo "Close this window to stop it."
(sleep 1 && open "http://localhost:$PORT") &
python3 serve.py "$PORT"
