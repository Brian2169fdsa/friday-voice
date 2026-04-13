#!/bin/bash
# Safe FRIDAY worker restart — always loads from ecosystem.config.js
echo "Stopping friday-worker..."
pm2 delete friday-worker 2>/dev/null || true
echo "Starting friday-worker from ecosystem.config.js..."
pm2 start /opt/manageai/ecosystem.config.js --only friday-worker
pm2 save
echo "Worker started. Verifying key..."
sleep 5
WPID=$(pm2 pid friday-worker)
WKEY=$(cat /proc/$WPID/environ 2>/dev/null | tr '\0' '\n' | grep ANTHROPIC | cut -c1-25)
echo "Worker key: $WKEY"
pm2 list | grep friday
