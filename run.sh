#!/bin/bash

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

echo "[Runner] Zalo-TG bridge runner started"
echo "[Runner] Working directory: $PROJECT_DIR"

export ZALO_TG_RUNNER=1

while true; do
  echo "[Runner] Starting bridge..."
  npm start
  EXIT_CODE=$?

  if [ "$EXIT_CODE" = "42" ]; then
    echo "[Runner] Update signal received (code 42). Pulling latest changes..."
    
    echo "[Runner] git pull origin main..."
    git pull --autostash origin main
    if [ $? -ne 0 ]; then
      echo "[Runner] git pull failed — aborting update loop"
      exit 1
    fi

    echo "[Runner] npm install..."
    npm install --production=false
    if [ $? -ne 0 ]; then
      echo "[Runner] npm install failed — aborting update loop"
      exit 1
    fi

    echo "[Runner] npm run build..."
    npm run build
    if [ $? -ne 0 ]; then
      echo "[Runner] build failed — aborting update loop"
      exit 1
    fi

    echo "[Runner] Update complete. Restarting..."
    continue
  fi

  if [ "$EXIT_CODE" = "43" ]; then
    echo "[Runner] Restart signal received (code 43). Restarting..."
    continue
  fi

  echo "[Runner] Bridge exited with code $EXIT_CODE — stopping."
  break
done
