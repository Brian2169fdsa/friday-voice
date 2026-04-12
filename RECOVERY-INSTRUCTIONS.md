# FRIDAY System Recovery Instructions

## Current Status (as of 2026-04-10 ~22:50 UTC)
- PM2 daemon is STOPPED (all services down: build-api, friday-worker, n8n, ttyd)
- The PM2 dump.pm2 file has been written to /home/claudeagent/.pm2/dump.pm2
- All activity JS files are syntactically correct and match harden/ versions
- Worker code is clean - no syntax errors

## Quick Recovery (run as root or claudeagent)

```bash
# Option 1: Use the startup script
sudo -u claudeagent bash /opt/manageai/startup.sh

# Option 2: Manual PM2 restart
export HOME=/home/claudeagent
export PM2_HOME=/home/claudeagent/.pm2
sudo -u claudeagent pm2 resurrect
sudo -u claudeagent pm2 save
sudo -u claudeagent pm2 status

# Option 3: Start from ecosystem.config.js
sudo -u claudeagent bash -c "HOME=/home/claudeagent PM2_HOME=/home/claudeagent/.pm2 pm2 start /opt/manageai/ecosystem.config.js --update-env && pm2 save"
```

## Fix /tmp permissions (required for schema-architect to work)

```bash
chmod 1777 /tmp
```

## Fix systemd auto-start (prevents this happening again)

The existing /etc/systemd/system/pm2-root.service points to /root/.pm2 which doesn't exist.
Install the correct service:

```bash
cp /opt/manageai/pm2-friday.service /etc/systemd/system/pm2-friday.service
systemctl daemon-reload
systemctl disable pm2-root.service 2>/dev/null
systemctl enable pm2-friday.service
systemctl start pm2-friday.service
```

## Check Supabase Tables

```bash
bash /opt/manageai/check-supabase-tables.sh
```

Tables needed: build_briefs, build_agent_runs, build_quality_signals, build_compliance_results, cross_build_learnings

## Fire a Test Build (after services are up)

```bash
bash /opt/manageai/fire-test-build.sh
```

## Known Issues (from error logs)

1. **EACCES /tmp** - Fixed by `chmod 1777 /tmp`. Schema-architect (BUILD-006) tries to mkdir in /tmp and fails if /tmp isn't world-writable.

2. **Brief format mismatch** - Test builds using the `section_a/b/c/d/e/f/g` format (with `primary_objective`, `workflow_steps` etc.) skip brief validation (goes through the "raw ticket" path). This is correct behavior.

3. **build_agent_runs model** - The `claude-haiku-4-5-20251001` model name was used in some older builds. If it fails, check ANTHROPIC_API_KEY is valid.

4. **Systemd service misconfiguration** - The pm2-root.service uses PM2_HOME=/root/.pm2 but all FRIDAY processes run as claudeagent with PM2_HOME=/home/claudeagent/.pm2. This is why the system doesn't auto-recover after reboots.

## Files Created/Modified in This Session

- /home/claudeagent/.pm2/dump.pm2 (CREATED - enables pm2 resurrect)
- /opt/manageai/startup.sh (CREATED - full restart script)
- /opt/manageai/restart-all.js (CREATED - Node.js restart helper)
- /opt/manageai/check-supabase-tables.sh (CREATED - table check/create)
- /opt/manageai/fire-test-build.sh (CREATED - test build script)
- /opt/manageai/pm2-friday.service (CREATED - correct systemd service)
- /opt/manageai/RECOVERY-INSTRUCTIONS.md (THIS FILE)
