#!/bin/sh
# Wrapper portable — pakai lokasi script ini sendiri, bukan path hardcoded.
# Berguna kalau mau jalankan manual tanpa systemd (development/testing).
DIR="$(cd "$(dirname "$0")" && pwd)"
exec /usr/bin/node "$DIR/dynalloc-daemon.js"
