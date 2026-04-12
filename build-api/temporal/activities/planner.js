import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execFileAsync = promisify(execFile);

// UID/GID for claudeagent user
let AGENT_UID = null;
let AGENT_GID = null;
try {
  const { execSync } = await import('child_process');
  const uid = execSync('id -u claudeagent 2>/dev/null').toString().trim();
  const gid = execSync('id -g claudeagent 2>/dev/null').toString().trim();
  AGENT_UID = parseInt(uid) || null;
  AGENT_GID = parseInt(gid) || null;
} catch(e) {}

export async function runPlannerActivity(jobData) {
  console.log('[BUILD-001] Starting orchestrator for:', jobData.project_name);

  const outputDir = '/tmp/friday-temporal-' + jobData.job_id;
  const agentDir = path.join(outputDir, 'planner');
  await fs.mkdir(agentDir, { recursive: true });
  if (AGENT_UID) { try { await fs.chown(agentDir, AGENT_UID, AGENT_GID); } catch(e) {} }

  // Extract Brief sections and Must-Never-Ask items from jobData
  const briefSections = jobData.brief_sections || {};
  const mustNeverAsk = {
    workflow_steps: jobData.workflow_steps || briefSections.workflow_steps || null,
    decision_authority: jobData.decision_authority || briefSections.decision_authority || null,
    data_sources: jobData.data_sources || briefSections.data_sources || null,
    guardrails: jobData.guardrails || briefSections.guardrails || null,
    edge_cases: jobData.edge_cases || briefSections.edge_cases || null,
    acceptance_criteria: jobData.acceptance_criteria || briefSections.acceptance_criteria || null,
    success_metrics: briefSections.success_metrics?.content || jobData.success_metrics || null
  };

  // Prior engagement context from OneDrive (from previous builds for this client)
  const priorCtx = jobData.priorEngagementContext || null;
  let engagementBlock = '';
  if (priorCtx) {
    engagementBlock = `

## Prior Engagement Context (from previous FRIDAY builds for this client)
This client has been built for before. Use this context to avoid rediscovering what is already known.

Tech Stack: ${JSON.stringify(priorCtx.tech_stack || {}, null, 2)}
Schema Tables Already Created: ${JSON.stringify(priorCtx.schema_tables || [], null, 2)}
Workflow Patterns Used: ${JSON.stringify(priorCtx.workflow_patterns || [], null, 2)}
API Endpoints Confirmed Working: ${JSON.stringify(priorCtx.api_endpoints || {}, null, 2)}
Integration Quirks Found: ${JSON.stringify(priorCtx.integration_quirks || [], null, 2)}
QA Failure Patterns (avoid repeating): ${JSON.stringify(priorCtx.qa_failure_patterns || [], null, 2)}
Previous QA Summary: ${JSON.stringify(priorCtx.qa_summary || {}, null, 2)}
Previous Build Notes: ${JSON.stringify(priorCtx.build_notes || {}, null, 2)}

IMPORTANT: Reference existing tables and workflows when planning — do not recreate what already exists unless the Brief explicitly requires changes. Note any integration quirks so downstream agents avoid known pitfalls.`;
  }

  const prompt = `You are BUILD-001, the Orchestrator for ManageAI FRIDAY.

Your job: Read the full customer Brief and produce a structured build-contract.json that gives each downstream build agent precise, tailored instructions for this specific client and use case.

## Customer Brief

Client: ${jobData.client || jobData.client_name}
Project: ${jobData.project_name}
Platform: ${jobData.platform || 'n8n'}
Job ID: ${jobData.job_id}

### Brief Sections
${JSON.stringify(briefSections, null, 2)}
${engagementBlock}

### Must-Never-Ask Items (pre-populated by Charlie -- use these directly)
Workflow Steps: ${mustNeverAsk.workflow_steps || 'Not specified'}
Decision Authority: ${mustNeverAsk.decision_authority || 'Not specified'}
Data Sources: ${mustNeverAsk.data_sources || 'Not specified'}
Guardrails: ${mustNeverAsk.guardrails || 'Not specified'}
Edge Cases: ${mustNeverAsk.edge_cases || 'Not specified'}
Acceptance Criteria: ${mustNeverAsk.acceptance_criteria || 'Not specified'}
Success Metrics: ${mustNeverAsk.success_metrics || 'Not specified'}

## Your Task

Analyze the Brief thoroughly and produce a build-contract.json file in ${agentDir}/ with this exact structure:

{
  "build_id": "${jobData.job_id}",
  "client": "${jobData.client || jobData.client_name}",
  "project": "${jobData.project_name}",
  "platform": "${jobData.platform || 'n8n'}",
  "version": "v1.0",
  "generated_at": "<ISO timestamp>",

  "system_summary": "2-3 sentence description of exactly what AI teammate is being built and what it does",

  "BUILD_006": {
    "agent": "Schema Architect",
    "tables_required": ["list every Supabase table this AI teammate needs with purpose"],
    "key_columns": "description of critical columns and relationships",
    "rls_notes": "any row-level security requirements for this client",
    "special_requirements": "anything unusual about this client's data model"
  },

  "BUILD_002": {
    "agent": "Workflow Builder",
    "workflow_name": "specific name for the n8n workflow",
    "trigger_type": "webhook|schedule|manual",
    "workflow_steps": ${JSON.stringify(mustNeverAsk.workflow_steps || 'Derive from Brief')},
    "decision_points": "where the workflow branches based on conditions",
    "integrations": "external systems this workflow calls",
    "webhook_paths": ["suggested webhook endpoint paths"]
  },

  "BUILD_004": {
    "agent": "LLM Integration Specialist",
    "primary_use_case": "what Claude is doing in this AI teammate",
    "model_routing": {
      "sonnet": "tasks requiring generation, analysis, complex reasoning",
      "haiku": "tasks requiring scoring, classification, simple extraction"
    },
    "system_prompt_guidance": "key instructions for this client's AI personality and constraints",
    "guardrails": ${JSON.stringify(mustNeverAsk.guardrails || 'Derive from Brief')},
    "edge_cases": ${JSON.stringify(mustNeverAsk.edge_cases || 'Derive from Brief')}
  },

  "BUILD_005": {
    "agent": "Platform Builder",
    "repo_name": "suggested GitHub repo name (kebab-case)",
    "tech_stack": ["list of technologies"],
    "entry_point": "main file name",
    "environment_variables": ["list of env vars this build will need"],
    "decision_authority": ${JSON.stringify(mustNeverAsk.decision_authority || 'Derive from Brief')}
  },

  "BUILD_003": {
    "agent": "QA Tester",
    "acceptance_criteria": ${JSON.stringify(mustNeverAsk.acceptance_criteria || 'Derive from Brief')},
    "test_scenarios": ["3-5 specific test cases derived from the workflow steps and edge cases"],
    "success_thresholds": {
      "schema": "all required tables exist and accept CRUD",
      "workflow": "webhook responds within 5 seconds",
      "integration": "end-to-end flow completes without error"
    }
  },

  "phase2_docs": {
    "client_name_display": "how client name should appear in documents",
    "solution_demo_focus": "what the Solution Demo should highlight for this client",
    "training_manual_focus": "who the Training Manual is written for and their technical level",
    "deployment_summary_focus": "key deployment details specific to this client"
  },

  "quality_criteria": ["5-7 specific measurable quality checks for this build"],
  "risk_flags": ["any risks or unknowns identified from the Brief that agents should watch for"],

  "output_file_names": {
    "solution_demo": "${jobData.job_id || jobData.project_name} Solution Demo.html",
    "training_manual": "${jobData.job_id || jobData.project_name} Training Manual.html",
    "deployment_summary": "${jobData.job_id || jobData.project_name} Deployment Summary.md",
    "blueprint": "${jobData.job_id || jobData.project_name} Blueprint.json"
  }
}

## Instructions

1. Read the Brief carefully -- every agent instruction must be specific to THIS client, not generic
2. Derive specific table names, workflow steps, and test cases from the Brief content
3. Use the Must-Never-Ask items directly -- do not paraphrase or summarize them
4. If a Must-Never-Ask item says "Not specified", derive a reasonable value from the Brief context
5. Write the completed build-contract.json to ${agentDir}/build-contract.json
6. Then output a brief confirmation: "BUILD-001 complete. Contract written to build-contract.json. System: <one sentence summary>"

Do not ask questions. Do not request more information. Everything you need is in the Brief above.`;

  // Run as claudeagent
  const claudePath = '/usr/bin/claude';
  const args = ['--print', '--dangerously-skip-permissions', prompt];

  try {
    const sudoArgs = ['-u', 'claudeagent', claudePath, ...args];
    const { stdout, stderr } = await execFileAsync('sudo', sudoArgs, {
      timeout: 300000,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        HOME: '/home/claudeagent',
        USER: 'claudeagent'
      }
    });

    if (stderr) console.warn('[BUILD-001] stderr:', stderr.slice(0, 500));

    // Read the contract file
    const contractPath = path.join(agentDir, 'build-contract.json');
    let contract;
    try {
      const raw = await fs.readFile(contractPath, 'utf-8');
      contract = JSON.parse(raw);
      console.log('[BUILD-001] Contract loaded. System:', contract.system_summary?.slice(0, 100));
    } catch(e) {
      console.warn('[BUILD-001] Could not read build-contract.json, falling back to parse from stdout');
      // Try to extract JSON from stdout
      const match = stdout.match(/\{[\s\S]+\}/);
      if (match) {
        try {
          contract = JSON.parse(match[0]);
        } catch(pe) {
          contract = buildFallbackContract(jobData);
        }
      } else {
        contract = buildFallbackContract(jobData);
      }
    }

    // Merge Must-Never-Ask items directly into contract so downstream agents always have them
    contract.mustNeverAsk = mustNeverAsk;
    contract.plannerUsed = 'BUILD-001-claude-code';

    // Cost estimation based on contract complexity
    const tables = contract.BUILD_006?.tables_required || [];
    const tableCount = Array.isArray(tables) ? tables.length : 1;
    const wfSteps = contract.BUILD_002?.workflow_steps;
    const wfCount = Array.isArray(wfSteps) ? wfSteps.length : (typeof wfSteps === 'string' ? Math.max(1, Math.ceil(wfSteps.length / 200)) : 2);
    const briefLen = JSON.stringify(jobData.brief || {}).length;
    const briefTokens = Math.ceil(briefLen / 4);

    const phase1Tokens = 4000 + briefTokens + (tableCount * 800) + (wfCount * 2000) + 3000 + 3000 + 4000 + (tableCount * 500) + (wfCount * 500);
    const phase2Tokens = 8000 + 6000 + 8000 + 5000 + (wfCount * 1500) + 6000;
    const totalTokens = phase1Tokens + phase2Tokens;
    const phase1Min = Math.ceil(3 + (tableCount * 0.5) + (wfCount * 1.5));
    const totalMin = phase1Min + 8;
    const storageKB = (tableCount * 5) + (wfCount * 25) + 150 + 80;
    const costUsd = Math.round(((totalTokens * 0.7 / 1e6) * 3 + (totalTokens * 0.3 / 1e6) * 15) * 100) / 100;

    contract.cost_estimate = {
      tokens: { phase1: phase1Tokens, phase2: phase2Tokens, total: totalTokens },
      time_minutes: { phase1: phase1Min, phase2: 8, total: totalMin },
      storage_kb: storageKB,
      estimated_cost_usd: costUsd,
      scope: { tables: tableCount, workflows: wfCount, brief_tokens: briefTokens }
    };
    console.log('[BUILD-001] Cost estimate: ~' + totalTokens + ' tokens, ~' + totalMin + 'min, ~$' + costUsd);

    // Write final merged contract
    await fs.writeFile(contractPath, JSON.stringify(contract, null, 2));

    console.log('[BUILD-001] Complete. Planner: BUILD-001-claude-code');
    return contract;

  } catch(e) {
    console.warn('[BUILD-001] Claude Code agent failed, using fallback:', e.message);
    const contract = buildFallbackContract(jobData);
    contract.mustNeverAsk = mustNeverAsk;
    contract.plannerUsed = 'fallback';
    contract.cost_estimate = { tokens: { phase1: 25000, phase2: 33000, total: 58000 }, time_minutes: { phase1: 8, phase2: 8, total: 16 }, storage_kb: 300, estimated_cost_usd: 0.32, scope: { tables: 3, workflows: 2, brief_tokens: 500 } };

    const contractPath = path.join(agentDir, 'build-contract.json');
    await fs.writeFile(contractPath, JSON.stringify(contract, null, 2));

    return contract;
  }
}

function buildFallbackContract(job) {
  const ticketId = job.ticket_id || job.job_id || 'MAI';
  const clientName = job.client || job.client_name || 'Client';
  return {
    build_id: job.job_id,
    client: clientName,
    project: job.project_name,
    platform: job.platform || 'n8n',
    version: 'v1.0',
    generated_at: new Date().toISOString(),
    system_summary: `AI teammate build for ${clientName} - ${job.project_name}`,
    BUILD_006: { agent: 'Schema Architect', tables_required: [], special_requirements: 'Derive from Brief' },
    BUILD_002: { agent: 'Workflow Builder', workflow_name: job.project_name, trigger_type: 'webhook', workflow_steps: 'Derive from Brief' },
    BUILD_004: { agent: 'LLM Integration Specialist', primary_use_case: 'Derive from Brief', model_routing: { sonnet: 'generation', haiku: 'scoring' } },
    BUILD_005: { agent: 'Platform Builder', repo_name: job.project_name?.toLowerCase().replace(/\s+/g, '-'), tech_stack: ['node', 'n8n'] },
    BUILD_003: { agent: 'QA Tester', acceptance_criteria: 'Derive from Brief', test_scenarios: [] },
    phase2_docs: {
      client_name_display: clientName,
      solution_demo_focus: 'Core capabilities and workflow',
      training_manual_focus: 'End users and operators',
      deployment_summary_focus: 'Technical deployment details'
    },
    quality_criteria: ['All tables created', 'Workflow imports successfully', 'Webhook responds', 'QA passes'],
    risk_flags: [],
    output_file_names: {
      solution_demo: ticketId + ' Solution Demo.html',
      training_manual: ticketId + ' Training Manual.html',
      deployment_summary: ticketId + ' Deployment Summary.md',
      blueprint: ticketId + ' Blueprint.json'
    }
  };
}
