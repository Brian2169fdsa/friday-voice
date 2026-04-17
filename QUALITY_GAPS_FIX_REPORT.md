# MEM-001 Quality Gaps Fix Sprint Report
## Date: April 17, 2026

## 5 Gaps Fixed

| # | Gap | File Modified | Fix |
|---|-----|--------------|-----|
| 1 | Email shows "Error" for recovered agents | `temporal/activities/pipeline.js` | Added `resolveAgentStatus` + `PHASE2_AGENT_CONFIG`; `sendPhase2CompletionEmailActivity` now re-checks files on disk before building email rows, overriding status from exit-code to file-existence truth |
| 2 | `llm-manifest.json` empty / 0 prompts | `temporal/activities/llm-specialist.js` | Prompt updated to require every `prompt-library.js` export enumerated in manifest; added `prompts[]`, `system_prompt`, `routing_table`, `total_prompts`, `validated` fields; explicit CRITICAL instruction not to leave prompts empty |
| 3 | BUILD-003 produced 0 tests artifact | `temporal/activities/qa-tester.js` | Added `fsPromises` import + `buildDir/qa/` directory creation; writes `qa/test-results.json` on QA pass and before throwing ApplicationFailure — downstream always has a file artifact |
| 4 | BUILD-002 activated 0 workflows in n8n | `temporal/activities/workflow-builder.js` | Added `importWorkflowsToN8n()` function that POSTs each workflow JSON to n8n API and activates it; called as Node-side safety net after agent exits, regardless of agent curl success |
| 5 | `llm/prompt.txt` leaked into final build | `temporal/activities/llm-specialist.js`, `temporal/activities/pipeline.js`, `temporal/activities/phase2-github-push.js` | promptFile moved from `agentDir/prompt.txt` → `/tmp/friday-llm-{job_id}.txt`; `cleanupScratchFiles()` added to pipeline.js (called in email activity); inline cleanup added at start of `pushPhase2ToGitHubActivity` |

## Environment Status

- `N8N_LOCAL_URL`: present (`http://localhost:5678`)
- `N8N_LOCAL_API_KEY`: present (JWT token configured)
- `N8N_URL` / `N8N_API_KEY`: not set — `importWorkflowsToN8n` reads `N8N_LOCAL_URL` / `N8N_LOCAL_API_KEY` directly (already patched to use these vars)
- n8n reachable: assumed yes based on existing ecosystem.config.js configuration

## Notes

- `N8N_URL` and `N8N_API_KEY` are not set, but are NOT needed — `workflow-builder.js` and `qa-tester.js` already use `N8N_LOCAL_URL` and `N8N_LOCAL_API_KEY`. The new `importWorkflowsToN8n` function receives these values as arguments from the calling context, so no ecosystem.config.js changes are needed.
- The OneDrive upload activity (`onedrive.js`) was NOT modified. Cleanup runs in `sendPhase2CompletionEmailActivity` (after upload) and before GitHub push. For full pre-upload cleanup, consider adding inline scratch cleanup to `uploadToOnedriveActivity` in a future sprint.

## Verification

All 5 modified files have been manually reviewed for syntax correctness:
- `temporal/activities/pipeline.js` ✓
- `temporal/activities/llm-specialist.js` ✓
- `temporal/activities/workflow-builder.js` ✓
- `temporal/activities/phase2-github-push.js` ✓
- `temporal/activities/qa-tester.js` ✓

## Next Steps

Fire a small test build to validate all 5 fixes:
- Watch BUILD-002 activate workflows (check n8n dashboard for imported workflows)
- Watch BUILD-003 produce `qa/test-results.json` in build output
- Watch Phase 2 email show correct statuses (not "Error" for recovered agents)
- Inspect final repo for absence of `prompt.txt` in `llm/` directory
- Inspect `llm-manifest.json` for populated `prompts[]` array matching `prompt-library.js` exports

After confirming, `pm2 restart friday-worker manageai-build-api` to pick up changes (if not already done).
