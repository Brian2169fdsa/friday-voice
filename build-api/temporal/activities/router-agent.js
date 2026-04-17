/**
 * BUILD-013 Router Upgrade — Deep Dispatch Router
 *
 * Agentic routing: decides whether a brief needs the fast queue, deep queue,
 * or both. Uses Claude Code for primary reasoning and OpenAI Codex for
 * adversarial verification when confidence is low.
 *
 * This runs BEFORE the existing BUILD-013 n8n/Temporal decision.
 * The existing BUILD-013 decision logic is preserved unchanged.
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { execFile } from 'child_process';

const execFileAsync = promisify(execFile);

const AGENT_UID = parseInt(process.env.CLAUDE_AGENT_UID || '1001', 10);
const AGENT_GID = parseInt(process.env.CLAUDE_AGENT_GID || '1001', 10);
const CONFIDENCE_THRESHOLD = 0.70;

/**
 * Main router activity — called from friday-build.js after brief analysis
 * Produces a dispatch plan that the workflow executes
 */
export async function deepRouterActivity(jobData) {
  const startTime = Date.now();
  const ticketId = jobData.ticket_id || jobData.ticketId;
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  console.log(`[BUILD-013-ROUTER] Starting deep router for ${ticketId}`);

  // 1. Load prior similar builds for pattern matching
  const similarBuilds = await loadSimilarBuilds(supabase, jobData);
  console.log(`[BUILD-013-ROUTER] Found ${similarBuilds.length} similar prior builds`);

  // 2. Agentic routing via Claude Code
  let plan = await runClaudeRouterAgent(jobData, similarBuilds, ticketId);
  console.log(`[BUILD-013-ROUTER] Claude routing: ${plan.primary_type} | confidence=${plan.confidence}`);

  // 3. If confidence below threshold, Codex adversarial review
  if (plan.confidence < CONFIDENCE_THRESHOLD) {
    console.log(`[BUILD-013-ROUTER] Low confidence — requesting Codex second opinion`);
    const codexReview = await runCodexRouterReview(jobData, plan, similarBuilds);
    plan = mergeRoutingPlans(plan, codexReview);
    console.log(`[BUILD-013-ROUTER] After Codex merge: ${plan.primary_type} | confidence=${plan.confidence}`);
  }

  // 4. Persist the routing decision
  try {
    await supabase.from('build_agent_runs').insert({
      ticket_id: ticketId,
      agent_id: 'BUILD-013-ROUTER',
      agent_name: 'Deep Dispatch Router',
      status: 'complete',
      started_at: new Date(startTime).toISOString(),
      completed_at: new Date().toISOString(),
      duration_seconds: Math.round((Date.now() - startTime) / 1000),
      output: plan
    });
  } catch (_) {}

  // 5. Persist routing signal for downstream agents
  try {
    await supabase.from('build_quality_signals').insert({
      ticket_id: ticketId,
      agent_id: 'BUILD-013-ROUTER',
      signal_type: 'routing_decision',
      confidence: plan.confidence,
      payload: plan
    });
  } catch (_) {}

  // 6. Emit inter-agent message so planner knows the plan
  try {
    await supabase.from('build_agent_messages').insert({
      ticket_id: ticketId,
      from_agent: 'BUILD-013-ROUTER',
      to_agent: 'BUILD-001',
      message_type: 'routing_plan',
      content: plan
    });
  } catch (_) {}

  console.log(`[BUILD-013-ROUTER] Complete in ${Math.round((Date.now() - startTime) / 1000)}s`);
  return plan;
}

/**
 * Load prior builds that are similar to this one (client, category, or tech stack)
 */
async function loadSimilarBuilds(supabase, jobData) {
  try {
    const { data: recent } = await supabase
      .from('friday_builds')
      .select('ticket_id, client, project_name, status, qa_score, brief_summary')
      .order('created_at', { ascending: false })
      .limit(20);

    if (!recent) return [];

    // Also load golden builds by category
    const { data: goldens } = await supabase
      .from('golden_builds')
      .select('*')
      .limit(10);

    return [...(recent || []), ...(goldens || []).map(g => ({
      ticket_id: g.ticket_id,
      project_name: g.category + ' (golden)',
      qa_score: g.qa_score,
      is_golden: true
    }))];
  } catch (e) {
    console.warn('[BUILD-013-ROUTER] Failed to load similar builds:', e.message);
    return [];
  }
}

/**
 * Run Claude Code as the routing agent
 * Claude reads the brief, sees similar past builds, produces structured plan
 */
async function runClaudeRouterAgent(jobData, similarBuilds, ticketId) {
  const workDir = `/tmp/friday-router-${ticketId}`;
  await fs.mkdir(workDir, { recursive: true, mode: 0o777 });

  // Write context files for Claude to read
  await fs.writeFile(
    path.join(workDir, 'BRIEF.json'),
    JSON.stringify(jobData, null, 2)
  );

  await fs.writeFile(
    path.join(workDir, 'SIMILAR_BUILDS.json'),
    JSON.stringify(similarBuilds.slice(0, 15), null, 2)
  );

  const promptPath = path.join(workDir, 'router-prompt.txt');
  await fs.writeFile(promptPath, buildRouterPrompt(ticketId));

  try {
    await execFileAsync('chown', ['-R', `${AGENT_UID}:${AGENT_GID}`, workDir]);
  } catch (_) {}

  let output = '';
  try {
    const result = await execFileAsync('bash', ['-c',
      `export ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY} && ` +
      `cd ${workDir} && ` +
      `cat ${promptPath} | /usr/bin/claude --dangerously-skip-permissions --print`
    ], {
      timeout: 180000,  // 3 min — router decisions should be fast
      maxBuffer: 5 * 1024 * 1024,
      uid: AGENT_UID,
      gid: AGENT_GID
    });
    output = result.stdout;
  } catch (e) {
    // File recovery pattern
    output = e.stdout || '';
    console.warn(`[BUILD-013-ROUTER] Claude Code exit ${e.code} — attempting file recovery`);
  }

  // Parse the plan — should be in PLAN.json written by Claude
  try {
    const planPath = path.join(workDir, 'PLAN.json');
    const content = await fs.readFile(planPath, 'utf8');
    const plan = JSON.parse(content);

    // Validate plan structure
    if (!plan.primary_type || !Array.isArray(plan.dispatches)) {
      throw new Error('Plan missing required fields');
    }

    // Ensure confidence is a number
    plan.confidence = parseFloat(plan.confidence) || 0.5;

    return plan;
  } catch (parseErr) {
    console.warn(`[BUILD-013-ROUTER] Plan parse failed: ${parseErr.message}`);
    // Fallback: single n8n agent dispatch
    return {
      primary_type: 'n8n_agent',
      dispatches: [{
        queue: 'friday-builds',
        type: 'n8n_agent',
        role: 'primary',
        reason: 'Default fallback — router parse failed'
      }],
      confidence: 0.3,
      reasoning: 'Router agent failed to produce valid plan; defaulting to n8n pipeline',
      pattern_match: 'none',
      router_error: parseErr.message
    };
  } finally {
    // Cleanup working dir
    try { await fs.rm(workDir, { recursive: true, force: true }); } catch (_) {}
  }
}

function buildRouterPrompt(ticketId) {
  return `You are BUILD-013-ROUTER, the Deep Dispatch Router for ManageAI FRIDAY.

Your job: read the brief and decide what kind of build(s) are needed.

CONTEXT FILES (read them):
- BRIEF.json — the client's requirements brief
- SIMILAR_BUILDS.json — prior builds for pattern matching

YOUR TASK:
1. Read BRIEF.json to understand what the client actually needs
2. Read SIMILAR_BUILDS.json to see what similar briefs produced before
3. Classify the brief into one of these primary types:

   - **n8n_agent** — Pure workflow automation. Can be built with n8n + Supabase + Claude API. Examples: email triage, scheduled jobs, simple integrations, at-risk detection with human review, onboarding sequences. This is the DEFAULT for most AI automation briefs.

   - **custom_service** — Needs a custom Node.js or Python service that n8n cannot build. Examples: webhook receivers with specific signature validation, services with complex business logic, middleware that sits between systems, long-running processes, anything that needs custom code beyond n8n nodes.

   - **data_pipeline** — Needs Python for data processing, ETL, scraping, document intelligence, or ML inference. Examples: PDF extraction at scale, legacy system scraping (no API), data migration scripts, report generation, OCR workflows.

   - **frontend_app** — Needs a Next.js/React application. Examples: customer portal, admin dashboard, tenant self-service interface, member-facing UI, public-facing website.

   - **hybrid** — Needs multiple pieces. Most complex. Example: n8n agent + custom webhook service + customer portal, or n8n agent + browser scraper.

4. Produce a dispatch plan. Each dispatch has:
   - queue: "friday-builds" (fast) or "friday-deep-builds" (deep)
   - type: one of the primary types above
   - role: "primary" (the main deliverable) or "sub-build" (supports primary)
   - reason: why this dispatch is needed
   - builder: for deep dispatches, which agent (BUILD-017 node-service, BUILD-018 python, BUILD-019 frontend)

5. Set confidence 0.0-1.0 based on how certain you are:
   - 0.9+ when brief explicitly states the technology
   - 0.7-0.9 when pattern clearly matches prior builds
   - 0.5-0.7 when requirements are ambiguous
   - Below 0.5 when you're guessing — DO NOT hide this

6. Document your reasoning. Name the similar build(s) you matched against.

OUTPUT FORMAT — write your plan to PLAN.json:

\`\`\`json
{
  "primary_type": "hybrid",
  "dispatches": [
    {
      "queue": "friday-builds",
      "type": "n8n_agent",
      "role": "primary",
      "reason": "Three core workflows (onboarding, at-risk detection, booking assistance) are pure event-driven n8n work"
    },
    {
      "queue": "friday-deep-builds",
      "type": "frontend_app",
      "role": "sub-build",
      "reason": "Member-facing self-service portal for class bookings explicitly requested",
      "builder": "BUILD-019"
    }
  ],
  "confidence": 0.82,
  "reasoning": "Brief describes 3 event-driven workflows (n8n territory) plus a member portal (frontend_app). Pattern matches MEM-001 workflow structure + adds a UI layer. High confidence because workflow scope is explicit and portal is explicitly requested.",
  "pattern_match": "MEM-001 (similar workflows) + hypothetical portal extension",
  "estimated_duration_min": 85,
  "risk_factors": ["Portal auth requirements not fully specified in brief"]
}
\`\`\`

IMPORTANT DEFAULTS:
- If you cannot determine a clear dispatch need, default to a single n8n_agent on the fast queue
- If the brief clearly says "customer portal" or "dashboard" or "web app" — add a frontend_app dispatch
- If the brief says "scrape", "extract PDFs", "import from legacy system" without API — add a data_pipeline dispatch
- If the brief says "webhook receiver", "custom API", "middleware service" — add a custom_service dispatch

Do NOT over-dispatch. Only add a deep build when the brief genuinely requires it. An email triage agent does not need a custom service.

Do NOT under-dispatch. If the brief clearly says "with a web portal for customers" — you MUST dispatch a frontend_app.

Be honest about confidence. A low confidence score triggers Codex review — that is fine. Do not inflate confidence.

Write the plan to PLAN.json now. Work in the current directory. When complete, the file must exist with valid JSON.`;
}

/**
 * Codex adversarial review when Claude's confidence is low
 */
async function runCodexRouterReview(jobData, claudePlan, similarBuilds) {
  const openAIKey = process.env.OPENAI_API_KEY;
  if (!openAIKey) {
    console.log('[BUILD-013-ROUTER] No OpenAI key — skipping Codex review');
    return null;
  }

  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: openAIKey });

    const systemPrompt = `You are BUILD-013-CODEX-VERIFIER. A Claude-based router produced a dispatch plan with low confidence. Your job is to independently review the brief and produce your own routing recommendation. You are adversarial — find what Claude might have missed.

Your output must be valid JSON with the same schema as Claude's plan (primary_type, dispatches, confidence, reasoning, pattern_match).`;

    const userPrompt = `CLIENT BRIEF:
${JSON.stringify(jobData, null, 2).slice(0, 8000)}

CLAUDE'S PROPOSED PLAN (low confidence — needs verification):
${JSON.stringify(claudePlan, null, 2)}

SIMILAR PRIOR BUILDS:
${JSON.stringify(similarBuilds.slice(0, 10), null, 2).slice(0, 3000)}

Review Claude's plan independently. Produce your own routing plan. If you agree with Claude, say so with your own reasoning. If you disagree, explain why. Output ONLY valid JSON.`;

    const response = await client.chat.completions.create({
      model: 'gpt-5.2-codex',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 2000
    });

    const text = response.choices[0]?.message?.content || '{}';
    return JSON.parse(text);
  } catch (e) {
    console.warn(`[BUILD-013-ROUTER] Codex review failed:`, e.message);
    // Fallback to gpt-4o
    try {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: openAIKey });
      const response = await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are a routing verifier. Output valid JSON only.' },
          { role: 'user', content: `Brief: ${JSON.stringify(jobData).slice(0, 4000)}\nClaude plan: ${JSON.stringify(claudePlan)}\n\nProduce your own routing plan in the same JSON schema.` }
        ],
        response_format: { type: 'json_object' },
        max_tokens: 1500
      });
      return JSON.parse(response.choices[0]?.message?.content || '{}');
    } catch (e2) {
      console.warn('[BUILD-013-ROUTER] Codex fallback also failed:', e2.message);
      return null;
    }
  }
}

/**
 * Merge Claude's plan with Codex's review
 * If they agree, boost confidence. If they disagree, take Codex's plan with mid confidence.
 */
function mergeRoutingPlans(claudePlan, codexPlan) {
  if (!codexPlan || !codexPlan.primary_type) {
    return claudePlan;
  }

  const agrees = claudePlan.primary_type === codexPlan.primary_type;
  const claudeTypes = claudePlan.dispatches.map(d => d.type).sort().join(',');
  const codexTypes = (codexPlan.dispatches || []).map(d => d.type).sort().join(',');
  const dispatchesAgree = claudeTypes === codexTypes;

  if (agrees && dispatchesAgree) {
    return {
      ...claudePlan,
      confidence: Math.min(0.95, claudePlan.confidence + 0.2),
      reasoning: claudePlan.reasoning + ' [Codex verified agreement]',
      codex_verification: 'agreed'
    };
  }

  // Disagreement — take Codex's plan but flag it
  if (codexPlan.dispatches && codexPlan.dispatches.length > 0) {
    return {
      ...codexPlan,
      confidence: 0.65,
      reasoning: (codexPlan.reasoning || '') + ' [Codex override of Claude]',
      codex_verification: 'disagreed',
      claude_original: claudePlan
    };
  }

  return claudePlan;
}
