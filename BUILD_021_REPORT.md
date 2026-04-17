# BUILD-021 Voice Agent Developer — Sprint Report
## Date: 2026-04-17
## Status: LIVE on deep worker

## What Was Added

### New Files
- `build-api/temporal/activities/deep/voice-agent-dev.js` — BUILD-021 activity
- `build-api/temporal/activities/deep/coordination.js` — Shared coordination helpers (publishState, buildSiblingContext, sendAgentMessage, waitForResponse)
- `build-api/temporal/activities/deep/deep-coordinator.js` — BUILD-030 coordinator (creates contracts for multi-agent builds)
- `build-api/add-coordination-tables.js` — Supabase migration

### Supabase Tables Created
- `deep_build_sibling_state` — agents publish phase/progress/artifacts for siblings to read
- `build_contracts` — coordination contracts for multi-agent builds (shared schema, auth, conventions)

### Wiring Updates (additive only)
- `temporal/deep-worker.js` — BUILD-021 imported + registered
- `temporal/workflows/deep-build.js` — voice_agent + voice-agent cases added
- `temporal/activities/router-agent.js` — voice_agent types in validTypes + typeToBuilder
- `temporal/activities/deep-dispatcher.js` — voice_agent mapped
- `server.js` — voice_agent in validDeepTypes

## Coordination System

All deep agents now share coordination infrastructure:

```
Deep build starts
    │
    ▼
publishState() — agent announces itself to siblings
    │
    ▼
buildSiblingContext() — reads all other agents' states + contract
    │
    ▼
Enhanced prompt = base prompt + sibling context
    │
    ▼
Claude Code builds with awareness of what siblings produce/consume
    │
    ▼
publishState(complete, exposed_artifacts) — siblings can now consume
```

## Opt-In Usage

Solo voice agent:
```json
{
  "enable_deep_builds": true,
  "deep_builds": ["voice_agent"],
  "voice_provider": "retell"
}
```

Voice + frontend call dashboard:
```json
{
  "enable_deep_builds": true,
  "deep_builds": ["voice_agent", "frontend_app"]
}
```

Enterprise combo:
```json
{
  "enable_deep_builds": true,
  "deep_builds": ["voice_agent", "custom_service", "frontend_app", "browser_automation"]
}
```

## What BUILD-021 Produces

- Retell AI or Vapi agent configuration (system prompt, tools, voice selection)
- Twilio integration (phone number routing, TwiML templates)
- Webhook handlers with HMAC signature verification (Retell + Twilio)
- Call transcription: speaker labels, sentiment scoring, ASR cleanup
- Supabase tables: call_logs, call_transcripts, call_sentiment
- Outbound call API for n8n campaign workflows
- Warm transfer logic (by intent, by hours, by location)
- TCPA/HIPAA compliance controls
- n8n workflows: outbound campaign trigger + post-call followup
- Full Jest test suite with webhook fixtures
- SETUP.md: account creation walkthrough for Retell + Twilio

## Coordination Behavior (when siblings present)

BUILD-021 exposes:
- webhook_endpoints: /webhooks/retell/*, /webhooks/twilio/*
- call_initiation_api: /api/calls/outbound
- supabase_tables_written: call_logs, call_transcripts, call_sentiment

BUILD-021 consumes from siblings:
- Shared Supabase schema (from coordination contract)
- Shared auth model (JWT, service role, or API key)
- Sibling API endpoints (if custom_service provides business logic)

## Syntax Checks

```
✓ coordination
✓ BUILD-030
✓ BUILD-021
✓ deep-worker
✓ deep-build
✓ router
✓ dispatcher
✓ server
```

All 8 passed.

## PM2 Status

- manageai-build-api: online
- friday-worker: online
- friday-deep-worker: online (BUILD-021 registered alongside 017/018/019/020)

## What Did NOT Change

- Fast queue (friday-worker, friday-build.js) — untouched
- BUILD-001 through BUILD-020 — untouched
- Watchdog, ecosystem.config.js — untouched

## Example Brief (Apex Dental)

```json
{
  "client": "Apex Dental Partners",
  "project_name": "Voice Appointment Reminders",
  "enable_deep_builds": true,
  "deep_builds": ["voice_agent"],
  "voice_provider": "retell",
  "request_description": "Automated phone reminders for patient appointments. Call 24h before, confirm or reschedule, transfer to front desk if complex. HIPAA compliant."
}
```

## Files Created / Modified

| File | Action |
|------|--------|
| temporal/activities/deep/voice-agent-dev.js | CREATED |
| temporal/activities/deep/coordination.js | CREATED |
| temporal/activities/deep/deep-coordinator.js | CREATED (BUILD-030) |
| add-coordination-tables.js | CREATED (migration) |
| temporal/deep-worker.js | +import + spread |
| temporal/workflows/deep-build.js | +2 switch cases |
| temporal/activities/router-agent.js | +2 validTypes + 2 typeToBuilder |
| temporal/activities/deep-dispatcher.js | +2 mapTypeToDeepBuildType |
| server.js | +2 validDeepTypes |

## Next Steps

- [ ] BUILD-022 Integration Specialist (Salesforce, HubSpot, Slack)
- [ ] Wire BUILD-030 coordinator into dispatcher (auto-create contracts for multi-agent builds)
- [ ] Test hybrid brief: voice_agent + frontend_app
- [ ] FRIDAY Remote UI: sibling state timeline visualization
