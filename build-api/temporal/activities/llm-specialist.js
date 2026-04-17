import fs from 'fs/promises';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { createClient } from '@supabase/supabase-js';
import { getGraphToken, uploadFile } from './onedrive.js';
import { Context } from '@temporalio/activity';

const CLAUDE = '/usr/bin/claude';
const LLM_TIMEOUT = 1100000;
let AGENT_UID, AGENT_GID;
try {
  AGENT_UID = parseInt(execSync('id -u claudeagent').toString().trim());
  AGENT_GID = parseInt(execSync('id -g claudeagent').toString().trim());
} catch(e) { AGENT_UID = null; AGENT_GID = null; }

function runClaudeAgent(promptFile, agentDir, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-c',
      CLAUDE + ' --dangerously-skip-permissions -p "$(cat ' + promptFile + ')"'
    ], {
      cwd: agentDir,
      uid: AGENT_UID, gid: AGENT_GID,
      env: { ...process.env, HOME: '/home/claudeagent', USER: 'claudeagent', CLAUDECODE: undefined },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const heartbeatInterval = setInterval(() => {
      try { Context.current().heartbeat('claude-code-running'); } catch(e) {}
    }, 30000);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('Timeout ' + Math.round(timeoutMs/1000) + 's')); }, timeoutMs);
    proc.on('close', code => {
      clearInterval(heartbeatInterval);
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('Exit ' + code + ': ' + stderr.slice(0, 500)));
    });
    proc.on('error', err => { clearInterval(heartbeatInterval); clearTimeout(timer); reject(err); });
  });
}

export async function llmSpecialistActivity(jobData, contract, priorResults) {
  const startTime = Date.now();
  const outputDir = '/tmp/friday-temporal-' + jobData.job_id;
  const agentDir = path.join(outputDir, 'llm');
  await fs.mkdir(agentDir, { recursive: true });
  if (AGENT_UID) { try { await fs.chown(agentDir, AGENT_UID, AGENT_GID); } catch(e) {} }

  const ticketId = jobData.ticket_id || jobData.ticketId;
  const client = jobData.client || jobData.client_name || 'Client';
  const project = jobData.project_name || 'AI Teammate';
  const build004 = contract?.BUILD_004 || {};
  const mustNeverAsk = contract?.mustNeverAsk || {};
  const schemaResult = priorResults?.schema || contract?.phase1Results?.schema || null;
  const workflowResult = priorResults?.workflow || contract?.phase1Results?.workflow || null;

  // Read upstream quality signals and engagement context (REST query for initial load)
  let upstreamContext = '';
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: signals } = await supabase
      .from('build_quality_signals')
      .select('from_agent, signal_type, confidence, payload, flags')
      .eq('ticket_id', ticketId)
      .in('signal_type', ['quality_review', 'engagement_context', 'targeted_fix_request'])
      .order('created_at', { ascending: false })
      .limit(10);

    if (signals && signals.length > 0) {
      const lowConfidence = signals.filter(s => s.confidence < 0.75 && s.signal_type === 'quality_review');
      const fixRequests = signals.filter(s => s.signal_type === 'targeted_fix_request' && s.to_agent === 'BUILD-004');
      const engagementCtx = signals.find(s => s.signal_type === 'engagement_context');

      if (lowConfidence.length > 0) {
        upstreamContext += `\nIMPORTANT: Upstream agents have low confidence scores. Design defensively with extra validation and fallback handling.\n`;
      }
      if (fixRequests.length > 0) {
        upstreamContext += `\nFIX REQUESTS FROM QA:\n${fixRequests.map(f => f.payload?.fix_instructions || '').join('\n')}\n`;
      }
      if (engagementCtx) {
        upstreamContext += `\nCLIENT HISTORY CONTEXT:\n${JSON.stringify(engagementCtx.payload?.agent_instructions || {})}\n`;
      }
    }
  } catch(e) {
    console.log('[BUILD-004] Could not read upstream signals:', e.message);
  }

  // GAP A-009: Supabase Realtime blackboard — subscribe for 2s to catch any live signals
  try {
    const realtimeClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const liveSignals = [];
    await new Promise((resolve) => {
      const channel = realtimeClient
        .channel(`llm-blackboard-${ticketId}`)
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'build_quality_signals',
          filter: `ticket_id=eq.${ticketId}`
        }, (payload) => {
          liveSignals.push(payload.new);
        })
        .subscribe();
      setTimeout(() => { channel.unsubscribe(); resolve(); }, 10000);
    });

    if (liveSignals.length > 0) {
      console.log('[BUILD-004] Realtime blackboard: received', liveSignals.length, 'live signal(s)');
      const liveFixRequests = liveSignals.filter(s =>
        s.signal_type === 'targeted_fix_request' && s.to_agent === 'BUILD-004'
      );
      if (liveFixRequests.length > 0) {
        upstreamContext += `\nLIVE FIX REQUESTS (Realtime):\n${liveFixRequests.map(f => f.payload?.fix_instructions || '').join('\n')}\n`;
      }
    }
  } catch(e) {
    console.log('[BUILD-004] Realtime blackboard unavailable (non-blocking):', e.message);
  }

  // Check for revision feedback from quality gate or compliance judge
  const revisionFeedback = jobData._revisionFeedback || jobData._complianceFeedback;
  if (revisionFeedback) {
    upstreamContext += `\nREVISION FEEDBACK (attempt ${jobData._revisionCount || 1}):\n`;
    if (revisionFeedback.fix_instructions) upstreamContext += revisionFeedback.fix_instructions + '\n';
    if (revisionFeedback.revisions) upstreamContext += revisionFeedback.revisions.join('\n') + '\n';
    if (revisionFeedback.gaps && revisionFeedback.gaps.length > 0) {
      upstreamContext += `\nCOMPLIANCE GAPS TO ADDRESS:\n${revisionFeedback.gaps.map(g => `- ${g.requirement}: ${g.revision_instruction || ''}`).join('\n')}\n`;
    }
  }

  const prompt = `You are BUILD-004, the LLM Integration Specialist for ManageAI FRIDAY.

Your job: Design and write all Claude AI integration code for this AI teammate build. You produce the complete AI brain -- system prompts, model routing, API call patterns, and a working integration file.

## Build Context
Client: ${client}
Project: ${project}
Platform: ${jobData.platform || 'n8n'}
Job ID: ${jobData.job_id}

## What This AI Teammate Does
${build004.primary_use_case || contract?.system_summary || 'Derive from Brief sections below'}

## Brief -- Must-Never-Ask Items
Workflow Steps: ${mustNeverAsk.workflow_steps || 'See brief sections'}
Decision Authority: ${mustNeverAsk.decision_authority || 'See brief sections'}
Guardrails: ${mustNeverAsk.guardrails || 'None specified'}
Edge Cases: ${mustNeverAsk.edge_cases || 'None specified'}
Acceptance Criteria: ${mustNeverAsk.acceptance_criteria || 'None specified'}

## Model Routing Guidance
${JSON.stringify(build004.model_routing || { sonnet: 'generation, analysis, complex reasoning', haiku: 'scoring, classification, simple extraction' }, null, 2)}

## System Prompt Guidance
${build004.system_prompt_guidance || 'Design appropriate for the use case above'}

## Schema Context (from BUILD-006)
${schemaResult ? JSON.stringify(schemaResult, null, 2).slice(0, 3000) : 'Not available -- design generically'}

## Workflow Context (from BUILD-002)
${workflowResult ? JSON.stringify(workflowResult, null, 2).slice(0, 500) : 'Not available -- design generically'}
${upstreamContext ? '\n## Upstream Signals & Revision Context\n' + upstreamContext : ''}

## Your Deliverables

Produce these files in ${agentDir}/:

### 1. ai-integration.js
A complete Node.js module (ESM) that exports:
- getSystemPrompt(context) -- returns the system prompt string for this AI teammate, personalized to ${client}
- callSonnet(systemPrompt, userMessage, maxTokens) -- wraps Anthropic SDK for generation tasks
- callHaiku(systemPrompt, userMessage, maxTokens) -- wraps Anthropic SDK for scoring/classification
- scoreResponse(response, criteria) -- Haiku-based quality scorer, returns { score: 0-100, passed: bool, feedback: string }
- extractStructured(text, schema) -- Haiku-based structured extraction, returns parsed JSON
- handleEdgeCase(input, edgeCaseType) -- handles the specific edge cases for this client

The system prompt must:
- Give the AI teammate a clear role and identity specific to ${client}
- Include the decision authority boundaries (what it can decide vs escalate)
- Include the guardrails (what it must never do)
- Be written in customer language -- no MAI internal terms
- Reference specific workflow steps so the AI knows its place in the process

### 2. prompt-library.js
A module exporting named prompt templates specific to this build:
- SYSTEM_PROMPT -- main system prompt
- EXTRACTION_PROMPT -- for pulling structured data from inputs
- SCORING_PROMPT -- for quality/compliance scoring
- ESCALATION_PROMPT -- for deciding when to escalate to human
- Any additional prompts specific to the workflow steps

### 3. model-routing.js
A module that exports:
- route(taskType) -- returns 'sonnet' or 'haiku' based on task type
- ROUTING_TABLE -- the full routing config as an exported object
- Task types must cover: generation, analysis, extraction, scoring, classification, summarization, escalation_check

### 4. llm-manifest.json
A JSON file that MUST enumerate every prompt exported from prompt-library.js:
{
  "build_id": "${jobData.job_id}",
  "client": "${client}",
  "project": "${project}",
  "generated_at": "<ISO timestamp>",
  "primary_model": "claude-sonnet-4-6",
  "secondary_model": "claude-haiku-4-5-20251001",
  "system_prompt": {
    "export_name": "SYSTEM_PROMPT",
    "description": "Main system prompt for the agent's persona and boundaries",
    "model": "claude-sonnet-4-6"
  },
  "prompts": [
    {
      "id": "<EXPORT_NAME>",
      "export_name": "<EXPORT_NAME>",
      "description": "<what this prompt does>",
      "model": "claude-sonnet-4-6",
      "variables": ["<list of template variables>"],
      "used_in_workflows": ["<workflow names that call this prompt>"]
    }
  ],
  "routing_table": [
    { "scenario": "classification", "model": "claude-haiku-4-5-20251001", "prompt_ids": [] },
    { "scenario": "generation", "model": "claude-sonnet-4-6", "prompt_ids": [] }
  ],
  "system_prompt_length": <char count>,
  "routing_rules": <count>,
  "edge_cases_handled": ["list of edge cases covered"],
  "guardrails_enforced": ["list of guardrails in system prompt"],
  "files_produced": ["ai-integration.js", "prompt-library.js", "model-routing.js"],
  "total_prompts": <count of prompts array>,
  "validated": true
}

CRITICAL: Do NOT leave the prompts array empty. Every named export in prompt-library.js MUST appear in the manifest.
Do NOT write prompt.txt. All prompts live in prompt-library.js only. If you want a plain-text reference, write prompts-reference.md in ${agentDir}/ — but prompt-library.js is the source of truth.

## Instructions

1. Read the Brief context carefully -- every prompt must be specific to ${client}, not generic
2. The system prompt is the most important deliverable -- make it precise and client-specific
3. Use ANTHROPIC_API_KEY from process.env -- do not hardcode keys
4. Model strings: sonnet = 'claude-sonnet-4-6', haiku = 'claude-haiku-4-5-20251001'
5. All files must be valid ESM (import/export syntax, not CommonJS)
6. Write all 4 files to ${agentDir}/
7. After writing, output: "BUILD-004 complete. Files: ai-integration.js, prompt-library.js, model-routing.js, llm-manifest.json. Primary use case: <one sentence>"

Do not ask questions. Everything you need is above.`;

  const promptFile = '/tmp/friday-llm-' + jobData.job_id + '.txt';
  await fs.writeFile(promptFile, prompt);

  const start = Date.now();
  console.log('[BUILD-004] Starting LLM Integration Specialist for', client, '/', project + (jobData._revisionCount ? ' (revision ' + jobData._revisionCount + ')' : ''));

  try {
    await runClaudeAgent(promptFile, agentDir, LLM_TIMEOUT);
    await fs.rm(promptFile, { force: true });
    const dur = ((Date.now() - start) / 1000).toFixed(1);

    // Read manifest
    let manifest = null;
    try {
      const raw = await fs.readFile(path.join(agentDir, 'llm-manifest.json'), 'utf8');
      manifest = JSON.parse(raw);
    } catch(e) { console.warn('[BUILD-004] Could not read llm-manifest.json:', e.message); }

    // Verify files exist
    const files = ['ai-integration.js', 'prompt-library.js', 'model-routing.js'];
    const verified = [];
    for (const f of files) {
      try { await fs.access(path.join(agentDir, f)); verified.push(f); } catch(e) {}
    }

    console.log('[BUILD-004] Done in ' + dur + 's | Files: ' + verified.length + '/3 verified');

    let onedriveUrl = null;
    try {
      const token = await getGraphToken();
      const fileContent = await fs.readFile(path.join(agentDir, 'ai-integration.js'), 'utf8');
      onedriveUrl = await uploadFile(token, `FRIDAY Builds/${(ticketId + ' - ' + (jobData.client || jobData.client_name || '')).replace(/[<>:"\\/|?*]/g, '-').trim()}/Phase 1`, 'ai-integration.js', fileContent, 'application/javascript');
      console.log('[BUILD-004] OneDrive upload:', onedriveUrl);
    } catch(upErr) { console.warn('[BUILD-004] OneDrive upload failed (non-blocking):', upErr.message); }
    try {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/build_agent_runs`, {
        method: 'POST',
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({ ticket_id: ticketId, agent_id: 'BUILD-004', agent_name: 'LLM Specialist', status: verified.length >= 2 ? 'complete' : 'partial', output: { files_produced: verified, primary_model: manifest?.primary_model, system_prompt_length: manifest?.system_prompt_length, prompt_templates: manifest?.prompt_templates, edge_cases_handled: manifest?.edge_cases_handled, onedrive_url: onedriveUrl }, duration_ms: Date.now() - startTime, started_at: new Date(startTime).toISOString(), completed_at: new Date().toISOString() })
      });
    } catch(dbErr) { console.warn('[BUILD-004] DB write failed (non-blocking):', dbErr.message); }

    // Emit test_pairs signal to Supabase so QA tester can evaluate LLM accuracy
    try {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      // Read system prompt from prompt-library.js or llm-manifest metadata
      // Use empty string if not found — QA judge works without a system prompt
      let systemPromptText = '';
      try {
        const promptLib = await fs.readFile(path.join(agentDir, 'prompt-library.js'), 'utf8');
        const m = promptLib.match(/export\s+(?:const|function)\s+\w*[Ss]ystem[Pp]rompt\w*\s*[=(][^{]*\{([^}]{100,})\}/);
        if (m) systemPromptText = m[1].replace(/[`'"\\]/g, '').trim().slice(0, 500);
      } catch(_) {}
      // Use expected_output (field name QA judge requires, not expected_output_pattern)
      const testPairs = manifest?.test_pairs || manifest?.prompt_templates?.map((t, i) => ({
        id: i,
        input: 'Test input for ' + t + ': provide a structured JSON response for a legal matter intake system.',
        expected_output: 'Valid JSON object with fields appropriate for ' + t + ' such as matter_type, confidence, status.',
        use_case: t
      })) || [{ id: 0, input: 'Classify this matter: employment dispute regarding wrongful termination.', expected_output: 'JSON with matter_type: employment, confidence >= 0.7, and a requires_review flag.', use_case: 'matter_classification' }];
      await supabase.from('build_quality_signals').insert({
        ticket_id: ticketId,
        from_agent: 'BUILD-004',
        signal_type: 'test_pairs',
        confidence: verified.length >= 2 ? 0.85 : 0.5,
        payload: { test_pairs: testPairs, system_prompt: systemPromptText, files_produced: verified, manifest }
      });
      console.log('[BUILD-004] Emitted test_pairs signal (' + testPairs.length + ' pairs) to Supabase');
    } catch(e) {
      console.warn('[BUILD-004] Could not emit test_pairs (non-blocking):', e.message.slice(0, 150));
    }

    return {
      agent_id: 'BUILD-004',
      specialist: 'BUILD-004 LLM Integration Specialist',
      status: verified.length >= 2 ? 'success' : 'partial',
      duration_seconds: parseFloat(dur),
      files_produced: verified,
      manifest,
      output_dir: agentDir
    };

  } catch(err) {
    const dur = ((Date.now() - start) / 1000).toFixed(1);
    try { await fs.rm(promptFile, { force: true }); } catch(_) {}
    console.error('[BUILD-004] Error:', err.message.slice(0, 300));

    try {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/build_agent_runs`, {
        method: 'POST',
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({ ticket_id: ticketId, agent_id: 'BUILD-004', agent_name: 'LLM Specialist', status: 'error', output: { error: err.message.slice(0, 200), files_produced: [] }, duration_ms: Date.now() - startTime, started_at: new Date(startTime).toISOString(), completed_at: new Date().toISOString() })
      });
    } catch(dbErr) { console.warn('[BUILD-004] DB write failed (non-blocking):', dbErr.message); }

    return {
      agent_id: 'BUILD-004',
      specialist: 'BUILD-004 LLM Integration Specialist',
      status: 'error',
      duration_seconds: parseFloat(dur),
      error: err.message.slice(0, 500),
      files_produced: [],
      manifest: null,
      output_dir: agentDir
    };
  }
}
