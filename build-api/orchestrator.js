import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';
import path from 'path';

const anthropic = new Anthropic();

// ── Agent ID to contract key mapping ────────────────────────────────────────
const AGENT_CONTRACT_MAP = {
  agent_01: 'solutionDemo',
  agent_02: 'skillsetManual',
  agent_03: 'requirementsDoc',
  agent_04: 'blueprint',
  agent_05: 'deploymentPackage'
};

// ── Fallback contract (always works) ────────────────────────────────────────
function buildFallbackContract(job) {
  const ticketId = job.ticket_id || 'MAI';
  return {
    project: job.project_name,
    clientCode: (job.client || '').replace(/\s+/g, '').slice(0, 10),
    platform: job.platform,
    version: job.buildVersion || 'v1.0',
    outputFileNames: {
      solutionDemo: ticketId + ' Solution Demo.html',
      skillsetManual: ticketId + ' Skillset Manual.html',
      requirementsDoc: ticketId + ' Requirements Doc.html',
      blueprint: ticketId + ' Blueprint.json'
    },
    agentFocus: {
      solutionDemo: 'Create comprehensive interactive demo for ' + job.project_name,
      skillsetManual: 'Create complete training manual for ' + job.project_name,
      requirementsDoc: 'Create detailed requirements doc for ' + job.project_name,
      blueprint: 'Create complete ' + (job.platform || '') + ' workflow blueprint'
    },
    qualityCriteria: [
      'All sections complete and over 2000 characters',
      'Client name ' + (job.client || '') + ' referenced throughout',
      'Platform ' + (job.platform || '') + ' specific details included'
    ]
  };
}

// ── Planner Agent ───────────────────────────────────────────────────────────
export async function runPlanner(job) {
  const systemPrompt = 'You are the FRIDAY build planner. You receive build job details and produce a structured JSON contract that guides the 4 build agents. Return ONLY valid JSON with no markdown, no backticks, no explanation.';

  const userMessage = `Create a build contract for this job:
Client: ${job.client}
Project: ${job.project_name}
Platform: ${job.platform}
Version: ${job.buildVersion || 'v1.0'}
Description: ${job.request_description}
Priority: ${job.priority}

Return this exact JSON structure:
{
  "project": "string",
  "clientCode": "string",
  "platform": "string",
  "version": "string",
  "outputFileNames": {
    "solutionDemo": "string (e.g. '${job.ticket_id || 'MAI'} Solution Demo.html')",
    "skillsetManual": "string",
    "requirementsDoc": "string",
    "blueprint": "string"
  },
  "agentFocus": {
    "solutionDemo": "string (1-2 sentences of specific focus for this project)",
    "skillsetManual": "string",
    "requirementsDoc": "string",
    "blueprint": "string"
  },
  "qualityCriteria": ["3-5 specific things to check for quality"]
}`;

  try {
    const response = await Promise.race([
      anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Planner timeout 30s')), 30000))
    ]);

    const text = response.content[0].text;
    const cleanText = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const contract = JSON.parse(cleanText);
    console.log('[FRIDAY] Planner contract ready: ' + contract.project + ' v' + contract.version +
      ' | Focus areas: ' + Object.keys(contract.agentFocus).join(', '));
    return { contract, plannerUsed: 'claude' };
  } catch (e) {
    console.warn('[FRIDAY] Planner fallback triggered:', e.message);
    const contract = buildFallbackContract(job);
    console.log('[FRIDAY] Planner contract ready: ' + contract.project + ' v' + contract.version +
      ' | Focus areas: ' + Object.keys(contract.agentFocus).join(', '));
    return { contract, plannerUsed: 'fallback' };
  }
}

// ── Build contract focus string for agent prompts ───────────────────────────
export function getContractFocus(agentId, contract) {
  const key = AGENT_CONTRACT_MAP[agentId];
  if (!contract || !key) return '';
  return '\n\nBUILD CONTRACT FOCUS FOR THIS PROJECT:\n' +
    'Client: ' + (contract.clientCode || '') + '\n' +
    'Version: ' + (contract.version || '') + '\n' +
    'Your specific focus: ' + (contract.agentFocus?.[key] || '') + '\n' +
    'Output filename: ' + (contract.outputFileNames?.[key] || '');
}

// ── Collect outputs from build directory for QA scoring ─────────────────────
export async function collectOutputsFromDir(outputDir, job, contract) {
  const outputs = [];
  const typePatterns = [
    { type: 'solution_demo', subdir: 'deliverables', match: /solution\s*demo/i },
    { type: 'skillset_manual', subdir: 'deliverables', match: /training\s*manual|skillset\s*manual/i },
    { type: 'requirements_doc', subdir: 'build-docs', match: /requirements|architecture|implementation/i },
    { type: 'deployment_summary', subdir: 'build-docs', match: /deployment\s*summary/i },
    { type: 'blueprint', subdir: 'workflow', match: /\.json$/i }
  ];

  for (const tp of typePatterns) {
    const subPath = path.join(outputDir, tp.subdir);
    let files;
    try { files = await fs.readdir(subPath); } catch { files = []; }

    let bestContent = '';
    let bestName = contract?.outputFileNames?.[tp.type === 'solution_demo' ? 'solutionDemo'
      : tp.type === 'skillset_manual' ? 'skillsetManual'
      : tp.type === 'requirements_doc' ? 'requirementsDoc'
      : 'blueprint'] || tp.type;

    for (const f of files) {
      if (tp.match.test(f)) {
        try {
          const content = await fs.readFile(path.join(subPath, f), 'utf-8');
          if (content.length > bestContent.length) {
            bestContent = content;
            bestName = f;
          }
        } catch { /* skip unreadable */ }
      }
    }

    outputs.push({
      type: tp.type,
      name: bestName,
      content: bestContent,
      success: bestContent.length > 0,
      duration: 0
    });
  }

  // Collect Deployment Package subpackages (agent_05 output)
  const dpSubdir = path.join(outputDir, 'deployment-package');
  const dpSubpackages = ['workflows.json','prompts.json','schemas.json','knowledge.json','templates.json','mcp-servers.json','environment.json','infrastructure.json','deployment-ops.json'];
  let dpFiles;
  try { dpFiles = await fs.readdir(dpSubdir); } catch { dpFiles = []; }
  for (const spName of dpSubpackages) {
    if (dpFiles.includes(spName)) {
      try {
        const spContent = await fs.readFile(path.join(dpSubdir, spName), 'utf-8');
        outputs.push({ type: 'deployment_subpackage', name: spName, content: spContent, success: spContent.length > 0, duration: 0 });
      } catch { /* skip unreadable */ }
    }
  }
  // Collect root package.json descriptor
  if (dpFiles.includes('package.json')) {
    try {
      const pkgContent = await fs.readFile(path.join(dpSubdir, 'package.json'), 'utf-8');
      outputs.push({ type: 'deployment_package', name: 'package.json', content: pkgContent, success: pkgContent.length > 0, duration: 0 });
    } catch { /* skip */ }
  }

  return outputs;
}

// ── QA Scoring (programmatic — no Claude API needed) ────────────────────────
export function scoreOutputs(outputs, job) {
  const scores = {};
  const errors = [];
  let successCount = 0;

  for (const output of outputs) {
    let score = 0;

    if (!output.success || !output.content) {
      scores[output.type] = 0;
      errors.push(output.type + ': empty or failed');
      continue;
    }

    successCount++;
    const content = output.content;
    const len = content.length;

    // Length scoring (mutually exclusive tiers)
    if (len > 5000) score += 35;
    else if (len > 2000) score += 20;

    // Client name check
    if (job.client && content.toLowerCase().includes(job.client.toLowerCase())) {
      score += 20;
    }

    // Platform name check
    if (job.platform && content.toLowerCase().includes(job.platform.toLowerCase())) {
      score += 15;
    }

    // Format check
    const name = (output.name || '').toLowerCase();
    if (name.endsWith('.html')) {
      if (content.includes('<html') || content.includes('<!DOCTYPE') || content.includes('<div')) {
        score += 10;
      }
    } else if (name.endsWith('.json')) {
      try { JSON.parse(content); score += 10; } catch { /* not valid JSON */ }
    } else if (name.endsWith('.md')) {
      // Markdown gets format points if it has headers
      if (content.includes('# ') || content.includes('## ')) {
        score += 10;
      }
    }

    scores[output.type] = score;
  }

  const scoreValues = Object.values(scores).filter(s => s > 0);
  const overallScore = scoreValues.length > 0
    ? Math.round(scoreValues.reduce((a, b) => a + b, 0) / Math.max(scoreValues.length, 3))
    : 0;

  const qaResult = {
    passed: overallScore >= 60 && successCount >= 3,
    overallScore,
    scores,
    successCount,
    errors
  };

  console.log('[FRIDAY] QA complete: score=' + overallScore + '/100 | passed=' +
    qaResult.passed + ' | ' + successCount + '/4 agents succeeded');

  return qaResult;
}

// ── Full orchestrated swarm (standalone pipeline) ───────────────────────────
export async function runOrchestratedSwarm(job) {
  // Phase 1: Planner
  const { contract, plannerUsed } = await runPlanner(job);

  // Phase 2: Build agents would run here in standalone mode
  // When integrated into server.js, the existing runSwarm handles agent execution
  // This function is primarily used for its planner + QA capabilities
  const outputs = [];

  // Phase 3: QA scoring
  const qaResult = scoreOutputs(outputs, job);

  return { contract, outputs, qaResult, plannerUsed };
}
