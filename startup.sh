#!/bin/bash
# FRIDAY Full System Startup
# Run this as claudeagent: bash /opt/manageai/startup.sh
# Or as root: sudo -u claudeagent bash /opt/manageai/startup.sh

export HOME=/home/claudeagent
export PM2_HOME=/home/claudeagent/.pm2

echo "=== FRIDAY System Startup ==="
echo "Time: $(date)"
echo "User: $(whoami)"

# Make /tmp writable (fix for schema-architect EACCES)
chmod 1777 /tmp 2>/dev/null || true

# Start PM2 daemon and resurrect saved processes
pm2 resurrect 2>/dev/null || pm2 start /opt/manageai/ecosystem.config.js --update-env

sleep 5
pm2 save
pm2 status

echo ""
echo "=== Checking worker health ==="
sleep 5
pm2 logs friday-worker --lines 10 --nostream

echo ""
echo "=== Checking API health ==="
curl -s http://localhost:3000/health 2>/dev/null | head -3 || echo "API not yet ready"

echo ""
echo "=== Startup complete ==="
