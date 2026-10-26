#!/bin/zsh
# Double-click this in Finder to start USER UNFRIENDLY: no typing. It starts the way it was started
# last time (LAN, same Wi-Fi, the first time) and carries on the saved event. Close it with Ctrl+C.
cd "$(dirname "$0")"
npm run unfriendly
