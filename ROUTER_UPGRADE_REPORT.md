# BUILD-013 Router Upgrade — Sprint Report
## Date: 2026-04-17
## Status: LIVE (workers restarted, both queues active)

## What Was Added

### Agents
- [x] BUILD-013-ROUTER — Agentic deep dispatch router (Claude Code reasoning + OpenAI Codex adversarial verification when confidence <70%)
- [x] Deep Dispatcher — Spawns DeepBuildWorkflow instances on friday-deep-builds queue from within the fast-queue workflow

### Infrastructure
- [x] friday_deep_builds.parent_ticket_id column — links deep builds to parent fast-queue build
- [x] friday_deep_builds.role column — primary vs sub-build
- [x] Both queues now running simultaneously (friday-worker + friday-deep-worker)

### API
- [x] GET /api/build/:ticketId/routing — view routing decision + spawned child deep builds

## How It Works

1. Brief arrives at POST /api/build/brief (existing endpoint — unchanged)
2. Workflow runs BUILD-000, BUILD-001 (existing — unchanged)
3. **NEW:** BUILD-013 Deep Router runs (router-agent.js)
   - Claude Code reads BRIEF.json + SIMILAR_BUILDS.json
   - Produces dispatch plan with confidence score
   - If confidence < 0.70, OpenAI Codex independently reviews the brief
   - Merged plan stored in build_quality_signals + build_agent_messages
4. **NEW:** Deep Dispatcher spawns deep builds on friday-deep-builds queue (non-blocking)
   - custom_service → BUILD-017 (Node.js service)
   - data_pipeline → BUILD-018 (Python)
   - frontend_app → BUILD-019 (Next.js)
   - n8n_agent dispatches on fast queue only (existing behavior)
5. Main workflow continues with existing BUILD-013 orchestrationDecisionActivity (unchanged)
6. Full Phase 1 build runs as normal (BUILD-006 → BUILD-002 → BUILD-004 → BUILD-005 → BUILD-003...)
7. **NEW:** Before workflow return, spawned deep builds status is checked + attached to result

## What Was NOT Changed

Protected files verified unchanged:
- [x] temporal/activities/planner.js (BUILD-001)
- [x] temporal/activities/schema-architect.js (BUILD-006)
- [x] temporal/activities/workflow-builder.js (BUILD-002)
- [x] temporal/activities/platform-builder.js (BUILD-005)
- [x] temporal/activities/agents.js (Phase 2)
- [x] temporal/activities/pipeline.js (Phase 2 email)

Modified files (additive only):
- temporal/worker.js — 2 import lines added at bottom of activities object
- temporal/workflows/friday-build.js — Router block added before BUILD-013 + status check added before return
- server.js — 1 GET endpoint added

## Dispatch Plan Schema

The router produces plans like:

```json
{
  "primary_type": "hybrid",
  "dispatches": [
    { "queue": "friday-builds", "type": "n8n_agent", "role": "primary", "reason": "..." },
    { "queue": "friday-deep-builds", "type": "frontend_app", "role": "sub-build", "builder": "BUILD-019", "reason": "..." }
  ],
  "confidence": 0.82,
  "reasoning": "...",
  "pattern_match": "MEM-001 + portal extension",
  "estimated_duration_min": 85,
  "risk_factors": []
}
```

## Confidence + Codex Flow

| Confidence | Action |
|-----------|--------|
| ≥ 0.70 | Claude's plan used directly |
| < 0.70 | Codex reviews independently |
| Codex agrees | Confidence boosted (min 0.95 cap) |
| Codex disagrees | Codex plan used at 0.65 confidence, Claude's plan preserved as claude_original |

Codex model: gpt-5.2-codex (falls back to gpt-4o if unavailable)

## How to Test

1. Fire a hybrid brief (n8n + portal):
   ```
   curl -X POST http://localhost:3000/api/build/brief \
     -H "x-cockpit-key: friday-cockpit-2026" \
     -H "Content-Type: application/json" \
     -d '{"project_name": "Member Portal + Automation", "request_description": "Build email automation for member onboarding plus a customer portal where members can view their history", "client": "TestClient"}'
   ```

2. Check routing decision:
   ```
   curl http://localhost:3000/api/build/<ticket>/routing -H "x-cockpit-key: friday-cockpit-2026"
   ```

3. Watch both workers in parallel:
   ```
   pm2 logs friday-worker friday-deep-worker --lines 0
   ```

## PM2 Status at Completion

- manageai-build-api: online
- friday-worker: online (fast queue + router activities registered)
- friday-deep-worker: online (deep queue)
- ttyd: errored (unrelated — no browser terminal binary)

## Files Created

| File | Purpose |
|------|---------|
| build-api/temporal/activities/router-agent.js | BUILD-013-ROUTER agentic routing |
| build-api/temporal/activities/deep-dispatcher.js | Deep workflow spawner + status checker |
| add-parent-tracking.js | Supabase migration (run once) |
| ROUTER_UPGRADE_REPORT.md | This report |

## Files Modified (Additive Only)

| File | Change |
|------|--------|
| build-api/temporal/worker.js | +2 activity imports |
| build-api/temporal/workflows/friday-build.js | +Router block before BUILD-013 + status check before return |
| build-api/server.js | +1 GET /api/build/:ticketId/routing endpoint |

## Next Steps

- [ ] Test with a real hybrid brief to observe routing in action
- [ ] Add deep build results to Phase 2 completion email
- [ ] FRIDAY Remote UI to visualize routing decisions tree
- [ ] BUILD-020 Browser Automation (next sprint)
