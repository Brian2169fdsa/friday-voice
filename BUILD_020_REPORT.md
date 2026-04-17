# BUILD-020 Browser Automation Specialist — Sprint Report
## Date: 2026-04-17
## Status: LIVE on deep worker (Playwright install in progress)

## What Was Added

### Agent
- `build-api/temporal/activities/deep/browser-automation-dev.js` — BUILD-020 activity
  - Claude Code writes complete Playwright/Python project
  - Revision loop (up to 2 retries on pytest failure)
  - Produces: auth module, scrapers, extractors, pydantic models, Supabase sink, pytest suite, n8n workflow JSON, Dockerfile

### Wiring
- `temporal/deep-worker.js` — BUILD-020 activity imported and registered
- `temporal/workflows/deep-build.js` — `browser_automation` + `browser-automation` cases added to switch
- `temporal/activities/router-agent.js` — types added to `validTypes` array + `typeToBuilder` map
- `temporal/activities/deep-dispatcher.js` — `mapTypeToDeepBuildType` updated
- `server.js` — `validDeepTypes` array updated for `/api/build/deep` endpoint

## Opt-In Usage

Brief must include:
```json
{
  "enable_deep_builds": true,
  "deep_builds": ["browser_automation"]
}
```

Can combine with other deep builds:
```json
{
  "deep_builds": ["browser_automation", "frontend_app", "custom_service"]
}
```

## What BUILD-020 Produces

- Complete Playwright automation project (Python 3.11+)
- Login/auth module with credential management (no hardcoded creds)
- Per-system scrapers (selectors centralized in utils/selectors.py)
- Pydantic v2 data models with validation
- Supabase sink with upsert + audit timestamps
- Tenacity retry logic on all network calls
- Anti-detection: user agent rotation, variable delays
- Mock HTML fixtures for offline testing
- Full pytest suite with 80%+ coverage (all tests offline)
- n8n workflow JSON for scheduled execution
- Dockerfile for containerized runs
- README with setup, troubleshooting, how to add extractors

## Playwright Install Status

- System-level Playwright: NOT YET INSTALLED (install triggered in background)
- The BUILD-020 activity handles per-build Playwright install inside venv (`./venv/bin/python -m playwright install chromium`)
- This means each build installs Playwright independently — slower but self-contained
- For production: Jacob should pre-install: `sudo -u claudeagent python3 -m playwright install chromium`

## Revision Loop

| Phase | Timeout | Action |
|-------|---------|--------|
| Initial build | 60 min | Claude Code writes full project |
| Test run 1 | 10 min | pytest -v --tb=short |
| Revision 1 | 30 min | Claude Code fixes with test output |
| Test run 2 | 10 min | pytest rerun |
| Revision 2 | 30 min | Claude Code fixes again |
| Final | — | Return partial if still failing |

## Syntax Checks

```
✓ BUILD-020
✓ deep-worker
✓ deep-build workflow
✓ router
✓ dispatcher
✓ server
```

All 6 passed.

## PM2 Status

- manageai-build-api: online
- friday-worker: online
- friday-deep-worker: online (BUILD-020 registered)

## What Did NOT Change

- Fast queue (friday-worker activities) — untouched
- BUILD-001 through BUILD-019 — untouched
- Main workflow (friday-build.js) — untouched
- Watchdog/ecosystem.config.js — untouched

## Example Brief

```json
{
  "client": "Pinnacle Property Group",
  "project_name": "AppFolio Tenant Sync",
  "enable_deep_builds": true,
  "deep_builds": ["browser_automation"],
  "request_description": "Nightly scrape tenant data from AppFolio and sync to Supabase. Handle 47 properties, 340+ tenants. Schedule: 2 AM Arizona time. Validate: email, phone format, unit numbers."
}
```

## Files Created / Modified

| File | Action |
|------|--------|
| build-api/temporal/activities/deep/browser-automation-dev.js | CREATED |
| build-api/temporal/deep-worker.js | +import + spread |
| build-api/temporal/workflows/deep-build.js | +2 switch cases |
| build-api/temporal/activities/router-agent.js | +2 validTypes + 2 typeToBuilder entries |
| build-api/temporal/activities/deep-dispatcher.js | +2 mapTypeToDeepBuildType entries |
| build-api/server.js | validDeepTypes updated |

## Next Steps

- [ ] Pre-install Playwright binaries: `sudo -u claudeagent python3 -m playwright install chromium`
- [ ] Test with Pinnacle AppFolio brief
- [ ] BUILD-021 Voice Agent (Retell/Vapi)
- [ ] BUILD-022 Integration Specialist (Salesforce, HubSpot)
- [ ] FRIDAY Remote browser UI for monitoring runs
