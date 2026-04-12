# FRIDAY Tool Deployer — Claude Code Prompt
# Run this in Claude Code on the Hetzner server (root@5.223.79.255)
# Working directory: /opt/manageai/

You are deploying 8 read-only webhook workflows to n8n at manageai2026.app.n8n.cloud.
These back the Tavus FRIDAY agent tools. Do not touch any existing workflows or server.js.
Work in small verified steps. Stop and report if anything fails.

---

## STEP 1 — Upload the deploy script

The deploy script is at /opt/manageai/deploy-friday-tools.js on this server.
If it is not there, download it:

```bash
ls -la /opt/manageai/deploy-friday-tools.js
```

If missing, stop and tell me. Do not proceed without it.

---

## STEP 2 — Verify n8n connectivity

Before running the full deploy, confirm the n8n API is reachable and the key is valid:

```bash
curl -s -o /dev/null -w "%{http_code}" \
  -H "X-N8N-API-KEY: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIzODFlMDYxNy0yYTI3LTQwODEtYTIyMy0yZWM0NjBhNzE1YjAiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiOTY1OTdkMDEtNDhlMi00MjkzLThiNjktMWRmOWU1OTY2YjgwIiwiaWF0IjoxNzczNzEyODU1fQ.JItkazLteYTwTnVjEij6wSTd8bZtajuDA6l9Di1tDxM" \
  https://manageai2026.app.n8n.cloud/api/v1/workflows
```

Expected: 200. If not 200, stop and report the status code. Do not proceed.

---

## STEP 3 — Check for existing FRIDAY tool workflows

Check if any of these already exist to avoid duplicates:

```bash
curl -s \
  -H "X-N8N-API-KEY: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIzODFlMDYxNy0yYTI3LTQwODEtYTIyMy0yZWM0NjBhNzE1YjAiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiOTY1OTdkMDEtNDhlMi00MjkzLThiNjktMWRmOWU1OTY2YjgwIiwiaWF0IjoxNzczNzEyODU1fQ.JItkazLteYTwTnVjEij6wSTd8bZtajuDA6l9Di1tDxM" \
  https://manageai2026.app.n8n.cloud/api/v1/workflows \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
wfs = d.get('data', [])
friday = [w for w in wfs if 'manageai-friday' in w.get('name','')]
print(f'Total workflows: {len(wfs)}')
print(f'Existing FRIDAY tools: {len(friday)}')
for w in friday:
    print(f\"  [{w['id']}] {w['name']} active={w.get('active')}\")
"
```

If any manageai-friday-* workflows already exist, list them and ask Brian whether to
delete them first or skip. Do not deploy duplicates without asking.

---

## STEP 4 — Run the deploy script

```bash
cd /opt/manageai
node deploy-friday-tools.js
```

Watch for:
- Each workflow printing ✅ with an ID
- Any ❌ lines — if one appears, stop immediately and report the error message
- The final "All 8 workflows deployed and active" message

---

## STEP 5 — Verify the manifest was written

```bash
cat /opt/manageai/friday-tools-manifest.json
```

Confirm:
- All 8 workflows are present
- Each has an `id`, `url`, and `active: true`
- `deployed_at` timestamp is current

---

## STEP 6 — Verify the env block

```bash
cat /opt/manageai/friday-tools.env
```

Should contain 8 lines like:
```
N8N_TOOL_BRIEFING=https://manageai2026.app.n8n.cloud/webhook/friday-tool-briefing
N8N_TOOL_ACTIVE_BUILDS=https://...
...
```

---

## STEP 7 — Smoke test two workflows

Test T1 (pipeline briefing):
```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{}' \
  https://manageai2026.app.n8n.cloud/webhook/friday-tool-briefing \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('active_count:', d.get('active_count')); print('summary:', d.get('summary'))"
```

Test T4 (build status with a fake ID):
```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"identifier": "MAI-0000"}' \
  https://manageai2026.app.n8n.cloud/webhook/friday-tool-build-status \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d, indent=2))"
```

T1 should return a JSON object with `active_count` and `summary` fields (values may be 0/empty if Supabase tables are empty — that is fine).
T4 should return `{ build: null, ticket: null, time_in_status: null, is_stuck: false }` for a non-existent ID.

---

## STEP 8 — Append env vars to server .env

```bash
# Back up current .env first
cp /opt/manageai/.env /opt/manageai/.env.bak.$(date +%Y%m%d_%H%M%S)

# Append the new tool URLs (skip if already present)
grep -q "N8N_TOOL_BRIEFING" /opt/manageai/.env \
  && echo "⚠️  N8N_TOOL vars already in .env — skipping append" \
  || cat /opt/manageai/friday-tools.env >> /opt/manageai/.env

echo "Current .env tail:"
tail -15 /opt/manageai/.env
```

---

## STEP 9 — Report

When complete, output a table with:
- Workflow name
- n8n workflow ID
- Webhook URL
- Active status (true/false)
- Smoke test result (pass/fail)

Then confirm:
- Manifest written to /opt/manageai/friday-tools-manifest.json ✅
- Env vars appended to /opt/manageai/.env ✅
- server.js NOT modified ✅
- No existing workflows deleted ✅

---

## RULES

- Do not modify server.js during this session
- Do not delete any existing n8n workflows — only create new ones
- Do not touch /data/vault or any Docker services
- If any step fails, stop and report — do not skip ahead
- Use pm2 list at the end to confirm the build API is still running
