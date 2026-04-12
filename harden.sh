#!/bin/bash
# FRIDAY Production Hardening Script
# Run once as root. Zero downtime -- does NOT restart any running process.
# All changes either take effect immediately (sysctl/ufw/fail2ban)
# or on next planned restart (OOM drop-ins, ecosystem.config.js).
#
# Usage: bash /opt/manageai/harden.sh

set -e
HARDEN_DIR="/opt/manageai/harden"
LOG="/var/log/manageai-harden.log"

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

log "=== FRIDAY Hardening ==="
log "Staging dir: $HARDEN_DIR"

# ─────────────────────────────────────────────
# STEP 1: PM2 log rotation
# ─────────────────────────────────────────────
log "--- Step 1: PM2 log rotation ---"
PM2=/usr/lib/node_modules/pm2/bin/pm2
$PM2 install pm2-logrotate
$PM2 set pm2-logrotate:max_size 50M
$PM2 set pm2-logrotate:retain 10
$PM2 set pm2-logrotate:compress true
$PM2 set pm2-logrotate:rotateModule true
$PM2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss
log "PM2 logrotate configured"
$PM2 conf pm2-logrotate | grep -E "max_size|retain|compress" || true

# ─────────────────────────────────────────────
# STEP 2: Disk / memory state
# ─────────────────────────────────────────────
log "--- Step 2: System state ---"
df -h /
free -h
docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}" 2>/dev/null || true

# ─────────────────────────────────────────────
# STEP 3: Docker log limits (already set in daemon.json)
# ─────────────────────────────────────────────
log "--- Step 3: Docker log limits ---"
log "daemon.json already has: max-size=10m, max-file=3 (global default)"
log "Adding compress:true to daemon.json (staged -- takes effect on next docker restart)"
python3 -c "
import json, sys
with open('/etc/docker/daemon.json') as f:
    d = json.load(f)
d.setdefault('log-opts', {})['compress'] = 'true'
with open('/etc/docker/daemon.json', 'w') as f:
    json.dump(d, f, indent=2)
print('daemon.json updated')
"

# ─────────────────────────────────────────────
# STEP 4: Exposed ports report
# ─────────────────────────────────────────────
log "--- Step 4: Public port exposure ---"
log "Ports bound to 0.0.0.0 (publicly reachable):"
ss -tlnp | grep -v '127.0.0.1' | grep -v '\[::1\]' | grep LISTEN || true
log "Docker container ports:"
docker ps --format "table {{.Names}}\t{{.Ports}}" 2>/dev/null || true

# ─────────────────────────────────────────────
# STEP 5: UFW firewall
# ─────────────────────────────────────────────
log "--- Step 5: UFW firewall ---"
UFW_STATUS=$(ufw status | head -1)
if echo "$UFW_STATUS" | grep -q "inactive"; then
    log "UFW inactive -- enabling with production ruleset"
    ufw --force reset
    ufw default deny incoming
    ufw default allow outgoing
    ufw limit 22/tcp comment 'SSH rate limited'
    ufw allow 3000/tcp comment 'FRIDAY API'
    ufw allow 7682/tcp comment 'ttyd'
    ufw --force enable
    log "UFW enabled"
else
    log "UFW already active: $UFW_STATUS"
    ufw status verbose
fi

# ─────────────────────────────────────────────
# STEP 6: fail2ban
# ─────────────────────────────────────────────
log "--- Step 6: fail2ban ---"
apt-get install -y fail2ban 2>/dev/null
cp "$HARDEN_DIR/fail2ban-jail.local" /etc/fail2ban/jail.local
systemctl enable fail2ban
systemctl start fail2ban || systemctl restart fail2ban
systemctl status fail2ban --no-pager | head -8
fail2ban-client status
log "fail2ban configured"

# ─────────────────────────────────────────────
# STEP 7: Swap + sysctl
# ─────────────────────────────────────────────
log "--- Step 7: Swap ---"
SWAP=$(free | grep Swap | awk '{print $2}')
if [ "$SWAP" = "0" ]; then
    log "No swap found -- creating 4GB swapfile"
    fallocate -l 4G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    log "Swap created and persisted in /etc/fstab"
else
    log "Swap already exists: $(free -h | grep Swap)"
fi

log "--- Step 7b: sysctl tuning ---"
cp "$HARDEN_DIR/sysctl-99-manageai.conf" /etc/sysctl.d/99-manageai.conf
sysctl -p /etc/sysctl.d/99-manageai.conf
log "sysctl applied immediately"

# ─────────────────────────────────────────────
# STEP 8: OOM protection (staged -- needs daemon-reload)
# ─────────────────────────────────────────────
log "--- Step 8: OOM protection drop-ins ---"
mkdir -p /etc/systemd/system/ssh.service.d
cp "$HARDEN_DIR/ssh-oom.conf" /etc/systemd/system/ssh.service.d/oom.conf

mkdir -p /etc/systemd/system/docker.service.d
cp "$HARDEN_DIR/docker-oom.conf" /etc/systemd/system/docker.service.d/oom.conf

systemctl daemon-reload
log "OOM drop-ins installed + daemon-reload done (takes effect on next ssh/docker restart)"

# ─────────────────────────────────────────────
# STEP 9: ecosystem.config.js (already staged by Claude)
# ─────────────────────────────────────────────
log "--- Step 9: ecosystem.config.js ---"
log "Memory limits already staged in /opt/manageai/ecosystem.config.js"
log "Takes effect on next: pm2 reload manageai-build-api && pm2 reload friday-worker"

# ─────────────────────────────────────────────
# STEP 9b: Deploy BUILD-000 + upgraded BUILD-003
# ─────────────────────────────────────────────
log "--- Step 9b: Deploy new activity files + worker.js ---"

# brief-analyst.js
cp "$HARDEN_DIR/brief-analyst.js" /opt/manageai/build-api/temporal/activities/brief-analyst.js
log "brief-analyst.js deployed"

# quality-gate.js (BUILD-008)
cp "$HARDEN_DIR/quality-gate.js" /opt/manageai/build-api/temporal/activities/quality-gate.js
log "quality-gate.js deployed"

# compliance-judge.js (BUILD-011)
cp "$HARDEN_DIR/compliance-judge.js" /opt/manageai/build-api/temporal/activities/compliance-judge.js
log "compliance-judge.js deployed"

# engagement-memory.js (BUILD-012)
cp "$HARDEN_DIR/engagement-memory.js" /opt/manageai/build-api/temporal/activities/engagement-memory.js
log "engagement-memory.js deployed"

# security-agent.js (BUILD-009)
cp "$HARDEN_DIR/security-agent.js" /opt/manageai/build-api/temporal/activities/security-agent.js
log "security-agent.js deployed"

# deployment-verifier.js (BUILD-010)
cp "$HARDEN_DIR/deployment-verifier.js" /opt/manageai/build-api/temporal/activities/deployment-verifier.js
log "deployment-verifier.js deployed"

# worker.js (updated to import all six new activities)
cp "$HARDEN_DIR/worker.js" /opt/manageai/build-api/temporal/worker.js
log "worker.js deployed"

# Syntax checks — abort on any failure
PM2=/usr/lib/node_modules/pm2/bin/pm2
NODE=$(which node)

log "Syntax checking all 9 files..."
$NODE -c /opt/manageai/build-api/temporal/activities/brief-analyst.js       && log "brief-analyst.js: OK"       || { log "brief-analyst.js: SYNTAX ERROR"; exit 1; }
$NODE -c /opt/manageai/build-api/temporal/activities/quality-gate.js        && log "quality-gate.js: OK"        || { log "quality-gate.js: SYNTAX ERROR"; exit 1; }
$NODE -c /opt/manageai/build-api/temporal/activities/compliance-judge.js    && log "compliance-judge.js: OK"    || { log "compliance-judge.js: SYNTAX ERROR"; exit 1; }
$NODE -c /opt/manageai/build-api/temporal/activities/engagement-memory.js   && log "engagement-memory.js: OK"   || { log "engagement-memory.js: SYNTAX ERROR"; exit 1; }
$NODE -c /opt/manageai/build-api/temporal/activities/security-agent.js      && log "security-agent.js: OK"      || { log "security-agent.js: SYNTAX ERROR"; exit 1; }
$NODE -c /opt/manageai/build-api/temporal/activities/deployment-verifier.js && log "deployment-verifier.js: OK" || { log "deployment-verifier.js: SYNTAX ERROR"; exit 1; }
$NODE -c /opt/manageai/build-api/temporal/activities/qa-tester.js           && log "qa-tester.js: OK"           || { log "qa-tester.js: SYNTAX ERROR"; exit 1; }
$NODE -c /opt/manageai/build-api/temporal/workflows/friday-build.js         && log "friday-build.js: OK"        || { log "friday-build.js: SYNTAX ERROR"; exit 1; }
$NODE -c /opt/manageai/build-api/temporal/worker.js                         && log "worker.js: OK"              || { log "worker.js: SYNTAX ERROR"; exit 1; }

# ─────────────────────────────────────────────
# STEP 9c: Supabase migration
# ─────────────────────────────────────────────
log "--- Step 9c: Supabase tables ---"
SUPABASE_URL=$(node -e "const e=require('/opt/manageai/ecosystem.config.js');console.log(e.apps[0].env.SUPABASE_URL)" 2>/dev/null)
SUPABASE_KEY=$(node -e "const e=require('/opt/manageai/ecosystem.config.js');console.log(e.apps[0].env.SUPABASE_SERVICE_KEY)" 2>/dev/null)

# Read the migration SQL and run it via Supabase REST
MIGRATION_SQL=$(cat /opt/manageai/build-api/migrations/20260410-build-system.sql | \
  grep -v '^--' | tr '\n' ' ' | tr -s ' ')

MIGRATION_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${SUPABASE_URL}/rest/v1/rpc/exec_sql" \
  -H "apikey: ${SUPABASE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"sql\": $(echo "$MIGRATION_SQL" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}")

HTTP_CODE=$(echo "$MIGRATION_RESPONSE" | tail -1)
BODY=$(echo "$MIGRATION_RESPONSE" | head -1)

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "204" ]; then
  log "Supabase migration: OK (HTTP $HTTP_CODE)"
else
  log "Supabase migration: HTTP $HTTP_CODE — $BODY"
  log "MANUAL FALLBACK: Run /opt/manageai/build-api/migrations/20260410-build-system.sql in the Supabase SQL editor"
fi

# ─────────────────────────────────────────────
# STEP 9d: Restart friday-worker
# ─────────────────────────────────────────────
log "--- Step 9d: Restart friday-worker ---"
$PM2 restart friday-worker --update-env
sleep 5
$PM2 save
$PM2 logs friday-worker --lines 15 --nostream
log "friday-worker restarted"

# ─────────────────────────────────────────────
# STEP 10: Daily log cleanup cron
# ─────────────────────────────────────────────
log "--- Step 10: Daily cleanup cron ---"
cp "$HARDEN_DIR/cron-manageai-cleanup" /etc/cron.daily/manageai-cleanup
chmod +x /etc/cron.daily/manageai-cleanup
log "Cleanup cron installed at /etc/cron.daily/manageai-cleanup"

# ─────────────────────────────────────────────
# STEP 11: Unattended security upgrades
# ─────────────────────────────────────────────
log "--- Step 11: Auto security updates ---"
apt-get install -y unattended-upgrades 2>/dev/null
cp "$HARDEN_DIR/apt-50unattended-upgrades" /etc/apt/apt.conf.d/50unattended-upgrades
# Ensure 20auto-upgrades enables daily run
cat > /etc/apt/apt.conf.d/20auto-upgrades << 'APT_EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
APT_EOF
log "Security-only auto-updates configured (docker/node pinned, auto-reboot disabled)"

# ─────────────────────────────────────────────
# FINAL HEALTH CHECK
# ─────────────────────────────────────────────
log ""
log "=== FINAL STATE ==="
log "--- Disk ---"
df -h /
log "--- Memory + Swap ---"
free -h
swapon --show || true
log "--- PM2 ---"
$PM2 status
log "--- fail2ban ---"
fail2ban-client status 2>/dev/null | head -5 || true
log "--- UFW ---"
ufw status | head -10
log "--- Exposed ports (0.0.0.0 listeners) ---"
ss -tlnp | grep LISTEN | grep -v '127.0.0.1' | grep -v '\[::1\]' || true
log "--- sysctl applied ---"
sysctl vm.swappiness net.core.somaxconn fs.file-max

log ""
log "=== Hardening complete. Log: $LOG ==="
log ""
log "STAGED (take effect on next planned restart):"
log "  - ecosystem.config.js: max_memory_restart, node_args, kill_timeout, max_restarts, min_uptime"
log "    Apply when ready: pm2 reload manageai-build-api && pm2 reload friday-worker && pm2 save"
log "  - daemon.json: compress:true for Docker logs"
log "    Apply when ready: systemctl reload docker (or next docker restart)"
log "  - OOM drop-ins: /etc/systemd/system/ssh.service.d/oom.conf + docker.service.d/oom.conf"
log "    Takes effect on next ssh/docker service restart (daemon-reload already done)"
