# Full Coder Deep Build Queue — Sprint Report
## Date: 2026-04-17
## Status: READY TO LAYER IN (not yet wired to main workflow)

## What Was Added

### Infrastructure
- [x] friday-deep-builds Temporal task queue
- [x] deep-worker.js process (separate from friday-worker)
- [x] DeepBuildWorkflow routes to language-specific agents
- [x] friday_deep_builds Supabase table
- [x] PM2 config entry (not yet started)

### Agents
- [x] BUILD-017 Node.js Service Developer
- [x] BUILD-018 Python Developer
- [x] BUILD-019 Frontend Developer
- [x] Revision loops (up to 2 retries on test/build failure)
- [x] Shared utilities (Claude Code runner, test runner, GitHub push)

### API
- [x] POST /api/build/deep — trigger a deep build
- [x] GET /api/build/deep/:ticketId — check status

## How To Activate (when ready)

1. Start the deep worker:
   ```
   cd /opt/manageai && pm2 start ecosystem.config.js --only friday-deep-worker
   pm2 save
   ```

2. Fire a test build (Node.js service):
   ```
   curl -X POST http://localhost:3000/api/build/deep \
     -H "x-cockpit-key: friday-cockpit-2026" \
     -H "Content-Type: application/json" \
     -d '{
       "deep_build_type": "node-service",
       "project_name": "Test Webhook Receiver",
       "client": "Internal",
       "agent_owner_email": "brian@manageai.io",
       "brief": {
         "request_description": "Build a webhook receiver that accepts Stripe events, validates signatures, and logs to console.",
         "success_criteria": "Service starts, health check works, webhook endpoint validates and logs"
       }
     }'
   ```

3. Check status:
   ```
   curl http://localhost:3000/api/build/deep/MAI-DEEP-[id] -H "x-cockpit-key: friday-cockpit-2026"
   ```

## What Was NOT Changed

- [x] friday-build.js (main workflow) — untouched
- [x] friday-worker (main worker) — untouched
- [x] BUILD-001 through BUILD-016 — untouched
- [x] BUILD-020 through BUILD-026 — untouched
- [x] Phase 2 agents — untouched
- [x] Main brief endpoint — untouched

## Next Steps (Future Sprints)

- [ ] Add BUILD-013 routing logic to auto-dispatch to deep queue
- [ ] Wire main brief workflow to call deep builds as sub-workflows
- [ ] Add BUILD-020 Browser Automation (Playwright)
- [ ] Add BUILD-021 Voice Agent Developer (Retell/Twilio)
- [ ] Add BUILD-022 Integration Specialist (Salesforce, HubSpot, etc.)
- [ ] Email notifications on deep build completion (currently console log only)
- [ ] FRIDAY Remote UI for deep build monitoring

## Files Created

| File | Purpose |
|------|---------|
| build-api/temporal/deep-worker.js | Separate worker process for friday-deep-builds queue |
| build-api/temporal/workflows/deep-build.js | Routing workflow (node-service / python / frontend) |
| build-api/temporal/activities/deep/deep-shared.js | Shared utilities: Claude Code runner, test runner, GitHub push, dir init |
| build-api/temporal/activities/deep/node-service-dev.js | BUILD-017: TypeScript/Express/Fastify services |
| build-api/temporal/activities/deep/python-dev.js | BUILD-018: Python scripts, services, CLIs |
| build-api/temporal/activities/deep/frontend-dev.js | BUILD-019: Next.js 15 + Tailwind + shadcn apps |
| deploy-deep-builds-table.js | Supabase migration (run once, table created) |
| DEEP_BUILD_REPORT.md | This report |

## Files Modified (Additive Only)

| File | Change |
|------|--------|
| build-api/server.js | Added POST /api/build/deep and GET /api/build/deep/:ticketId |
| ecosystem.config.js | Added friday-deep-worker app entry (not yet started) |

## Syntax Check Results

```
✓ deep-worker
✓ deep-build workflow
✓ deep-shared
✓ BUILD-017
✓ BUILD-018
✓ BUILD-019
✓ server
✓ ecosystem
```

All 8 checks passed.
