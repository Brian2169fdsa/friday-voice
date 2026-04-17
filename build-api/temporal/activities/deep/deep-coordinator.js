/**
 * BUILD-030: Deep Build Coordinator
 * Orchestrates multi-agent deep builds — shared schema, coordination contract,
 * integration analysis, and cross-agent consistency.
 * Not wired into the main workflow yet — used by siblings for context.
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { runClaudeCode } from './deep-shared.js';

const AGENT_UID = parseInt(process.env.CLAUDE_AGENT_UID || '1001', 10);
const AGENT_GID = parseInt(process.env.CLAUDE_AGENT_GID || '1001', 10);

/**
 * Map deep build types to their owning agents
 */
export function typeToBuilder(type) {
  const map = {
    'custom_service': 'BUILD-017',
    'node-service': 'BUILD-017',
    'node_service': 'BUILD-017',
    'data_pipeline': 'BUILD-018',
    'python': 'BUILD-018',
    'frontend_app': 'BUILD-019',
    'frontend': 'BUILD-019',
    'browser_automation': 'BUILD-020',
    'browser-automation': 'BUILD-020',
    'voice_agent': 'BUILD-021',
    'voice-agent': 'BUILD-021',
    'integration_salesforce': 'BUILD-022',
    'integration_hubspot': 'BUILD-022',
    'integration_slack': 'BUILD-022',
    'integration_teams': 'BUILD-022',
    'integration_shopify': 'BUILD-022',
    'integration_zendesk': 'BUILD-022',
    'integration_gworkspace': 'BUILD-022'
  };
  return map[type] || 'BUILD-017';
}

/**
 * Create coordination contract for a multi-agent build group
 * Analyzes all requested deep build types and produces a shared schema
 */
export async function createCoordinationContractActivity(parentJobData, dispatchPlan) {
  const parentTicketId = parentJobData.ticket_id || parentJobData.ticketId;
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  console.log(`[BUILD-030] Creating coordination contract for ${parentTicketId}`);

  const deepBuilds = (dispatchPlan.dispatches || []).filter(d => d.queue === 'friday-deep-builds');
  if (deepBuilds.length <= 1) {
    console.log(`[BUILD-030] Only ${deepBuilds.length} deep builds — no coordination needed`);
    return { contract: null, skipped: true };
  }

  const workDir = `/tmp/friday-coordinator-${parentTicketId}`;
  await fs.mkdir(workDir, { recursive: true, mode: 0o777 });

  await fs.writeFile(
    path.join(workDir, 'PARENT_BRIEF.json'),
    JSON.stringify(parentJobData, null, 2)
  );

  await fs.writeFile(
    path.join(workDir, 'DISPATCH_PLAN.json'),
    JSON.stringify(dispatchPlan, null, 2)
  );

  const prompt = buildCoordinatorPrompt(deepBuilds);
  const { output, exitCode } = await runClaudeCode(workDir, prompt, 'BUILD-030', 300000);

  let contract = null;
  try {
    const contractPath = path.join(workDir, 'CONTRACT.json');
    const content = await fs.readFile(contractPath, 'utf8');
    contract = JSON.parse(content);
  } catch (e) {
    console.warn('[BUILD-030] Contract parse failed:', e.message);
    contract = {
      parent_ticket_id: parentTicketId,
      agents_involved: deepBuilds.map(d => typeToBuilder(d.type)),
      shared_supabase_schema: {},
      shared_auth: 'service_role_key',
      coordination_notes: 'Auto-generated fallback — coordinator parse failed'
    };
  } finally {
    try { await fs.rm(workDir, { recursive: true, force: true }); } catch (_) {}
  }

  contract.parent_ticket_id = parentTicketId;

  try {
    await supabase.from('build_contracts').upsert({
      ticket_id: parentTicketId,
      ...contract,
      created_at: new Date().toISOString()
    }, { onConflict: 'ticket_id' });
  } catch (e) {
    console.warn('[BUILD-030] Contract persist failed:', e.message);
  }

  console.log(`[BUILD-030] Contract created for ${parentTicketId}`);
  return { contract };
}

function buildCoordinatorPrompt(deepBuilds) {
  const builderList = deepBuilds.map(d => `- ${typeToBuilder(d.type)} (${d.type}): ${d.reason}`).join('\n');

  return `You are BUILD-030, the Deep Build Coordinator for ManageAI FRIDAY.

Multiple deep build agents will work in parallel on the same customer project. Your job is to define the coordination contract — shared Supabase schema, auth model, API conventions — so agents can integrate cleanly.

AGENTS INVOLVED:
${builderList}

Read PARENT_BRIEF.json and DISPATCH_PLAN.json.

Produce a coordination contract that defines:

1. **Shared Supabase tables** — tables that multiple agents will read/write
   - Table name, columns, which agent owns it (writes), which agents read it

2. **Shared auth model** — how the system authenticates
   - "service_role_key" for server-only
   - "jwt_rls" for user-facing (Next.js)
   - "api_key" for service-to-service

3. **API conventions** — if agents expose APIs, what format?
   - Base URL pattern (e.g., /api/v1)
   - Auth header format (Bearer token, x-api-key, etc.)
   - Error format

4. **Cross-agent dependencies** — which agents need what from siblings
   - agent_id: what it produces
   - agent_id: what it consumes from which sibling

5. **Integration notes** — patterns for this specific combination

VOICE + FRONTEND PATTERNS:
- voice_agent + frontend_app: Frontend reads call_logs, call_transcripts, call_sentiment from Supabase (voice agent writes them)
- voice_agent + custom_service: Service is the webhook handler. Voice agent config points to service endpoints.

BROWSER + DATA PATTERNS:
- browser_automation + data_pipeline: Scraper writes raw rows, pipeline transforms and aggregates
- browser_automation + frontend_app: Frontend reads data scraped by browser agent

SERVICE + FRONTEND PATTERNS:
- custom_service + frontend_app: Service is the backend API. Frontend calls it. Shared auth.

INTEGRATION + OTHER PATTERNS:
- integration_salesforce + custom_service: Service handles webhook callbacks from Salesforce. Integration writes Apex triggers that call service endpoints.
- integration_hubspot + frontend_app: Frontend embeds HubSpot timeline cards and contact widgets. Integration exposes Custom Card API endpoints.
- integration_slack + custom_service: Slack Bolt app receives events, calls service for business logic. Shared auth via signing secret.
- integration_teams + frontend_app: Teams tab embeds frontend. SSO via MSAL. Shared user identity.
- integration_shopify + data_pipeline: Shopify webhooks feed order/product events into pipeline for analytics.
- integration_zendesk + custom_service: Zendesk app sidebar calls service for enrichment data. Service owns the data layer.
- integration_gworkspace + data_pipeline: Apps Script pushes Sheets/Drive data into pipeline for processing.

Write your contract to CONTRACT.json:

\`\`\`json
{
  "shared_supabase_schema": {
    "call_logs": {
      "owner": "BUILD-021",
      "readers": ["BUILD-019"],
      "columns": ["id", "ticket_id", "call_id", "status", "duration_seconds", "created_at"]
    }
  },
  "shared_auth": "jwt_rls",
  "api_gateway_url": "https://api.{client}.manageai.io",
  "api_conventions": {
    "base_path": "/api/v1",
    "auth_header": "Authorization: Bearer {token}",
    "error_format": { "error": "string", "code": "string" }
  },
  "cross_agent_dependencies": {
    "BUILD-019": {
      "consumes_from": "BUILD-021",
      "what": "call_logs, call_transcripts tables"
    }
  },
  "integration_notes": [
    "Frontend (BUILD-019) dashboard tab shows call history from call_logs table",
    "Voice agent (BUILD-021) writes to call_logs, frontend reads — no API needed, direct Supabase"
  ],
  "coordination_notes": "Generated by BUILD-030"
}
\`\`\`

Write CONTRACT.json now.`;
}
