# FRIDAY Temporal Orchestration — Decisions Log
## Date: 2026-03-30

### Step 1 — Temporal Docker Setup
- **Decision**: Used `temporalio/auto-setup:latest` with PostgreSQL backend (`postgres:16-alpine`)
- **Reason**: auto-setup requires a SQL database; SQLite not supported
- **Port 8080 conflict**: Coolify's Traefik proxy uses port 8080. Mapped Temporal UI to host port 8233 instead.
- **Containers**: `temporal-postgres` (port 5432) + `temporal` (ports 7233 gRPC, 8233 UI)
- **DB config**: `DB=postgres12`, `POSTGRES_SEEDS=postgres` (linked container)

### Step 2 — Temporal SDK
- **Decision**: Installed `@temporalio/client`, `@temporalio/worker`, `@temporalio/workflow`, `@temporalio/activity`
- **Note**: Project uses ES modules (`"type": "module"` in package.json). All temporal files use ESM imports.

### Step 3 — Directory Structure
- Created `temporal/`, `temporal/workflows/`, `temporal/activities/` via the running server's `/api/exec` endpoint (file ownership: claudeagent)

### Steps 4-13 — Activity Files
- **Decision**: Extracted each concern into its own activity file for clear separation
- **agents.js**: Accepts agent configs via `jobData._agentConfigs` to avoid circular dependency with server.js agent definitions
- **pipeline.js**: Contains its own copy of Supabase helper functions (sbFetch, sbPost, sbPatch) to be self-contained as a Temporal activity
- **brief-validation.js**: Uses `ApplicationFailure.nonRetryable()` from Temporal SDK for validation failures (non-retryable because the data won't change on retry)
- **approval.js**: Posts to n8n webhook but does NOT block — the workflow handles the signal wait via `condition()`

### Step 14 — Workflow Definition
- **Decision**: Used `Promise.all()` for parallel agent execution (agents 01-04)
- **Decision**: Approval loop uses `while(true)` with `condition()` waits — on "request-changes" signal, re-runs all 4 agents with change notes
- **Decision**: `charlieContextSignal` is optional — injected into contract if available before agent runs

### Step 15 — Worker
- **Decision**: Used `NativeConnection` (not `Connection`) for the worker — `Connection` from `@temporalio/client` is for the client SDK only, worker needs `NativeConnection` from `@temporalio/worker`
- **Decision**: Used `workflowsPath` with ESM `import.meta.url` resolution for Temporal's workflow sandbox
- **Decision**: All activities loaded via dynamic `import()` and spread into the activities object

### Step 16 — server.js Updates
- **Fixed**: Double response headers bug — old code sent `res.json()` at line 1145 (immediate response) then tried `return res.json()` again at line 1160 for needs_info case. New code has single response per code path via try/catch around Temporal start.
- **Decision**: Added Temporal fallback — if Temporal connection fails, falls back to direct `runSwarm()` call (backwards compatible)
- **Decision**: Added `logActivity()` helper for `friday_activity_log` table writes at key events
- **New endpoints**: `/api/build/brief`, `/api/build/:id/approve`, `/api/build/:id/request-changes`, `/api/build/:id/cancel`, `/api/build/:id/context`
- **Status endpoint**: Enhanced to include Temporal workflow status when available
- **Copilot tools**: Added `temporal_action` tool with list/cancel/signal/history actions

### Step 17 — ecosystem.config.js
- **Decision**: Added `friday-worker` PM2 process with `restart_delay: 5000` for resilience
- **Decision**: Worker env vars inherit from process since PM2 runs as root

### Step 18 — PM2 Startup
- Worker started successfully, workflow bundle compiled (1.36MB), state: RUNNING

### Step 19 — Test Results
1. **Temporal gRPC (7233)**: OPEN ✓
2. **Worker state**: RUNNING ✓ (connected to task queue `friday-builds`)
3. **Test build submission**: Returned `mode: "temporal_workflow"` ✓
4. **Workflow execution**: Brief validation passed, completeness check ran (scored 45/100), workflow paused waiting for answers signal ✓
5. **Status endpoint**: Returns both Supabase data AND `temporal: { status: "RUNNING" }` ✓
6. **Cancel endpoint**: Successfully terminated workflow ✓
7. **Approve/request-changes endpoints**: Return proper errors for non-existent workflows ✓

### Architecture Summary
```
Docker:
  temporal-postgres (5432) → temporal (7233 gRPC, 8233 UI)

PM2 Processes:
  manageai-build-api (port 3000) — Express API server
  friday-worker — Temporal worker polling friday-builds queue
  n8n — Workflow automation
  ttyd — Web terminal

Files Created:
  temporal/client.js                     — Temporal client singleton
  temporal/worker.js                     — Worker process (NativeConnection)
  temporal/workflows/friday-build.js     — FridayBuildWorkflow orchestration
  temporal/activities/completeness.js    — Completeness check activity
  temporal/activities/planner.js         — Planner activity
  temporal/activities/agents.js          — 4 agent activities
  temporal/activities/qa.js              — QA scoring activity
  temporal/activities/onedrive.js        — OneDrive upload activity
  temporal/activities/n8n-import.js      — n8n blueprint import activity
  temporal/activities/approval.js        — Human approval gate activity
  temporal/activities/pipeline.js        — Post-build pipeline activity
  temporal/activities/brief-validation.js — Brief validation activity
```
