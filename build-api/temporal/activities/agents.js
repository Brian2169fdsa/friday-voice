import fs from 'fs/promises';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { getContractFocus } from '../../orchestrator.js';

const CLAUDE = '/usr/bin/claude';
const AGENT_TIMEOUT = 1100000;
const AGENT_01_TIMEOUT = 1100000;

let AGENT_UID, AGENT_GID;
try {
  AGENT_UID = parseInt(execSync('id -u claudeagent').toString().trim());
  AGENT_GID = parseInt(execSync('id -g claudeagent').toString().trim());
} catch (e) {
  AGENT_UID = null;
  AGENT_GID = null;
}

function runClaudeAgent(promptFile, agentDir, timeoutMs) {
  timeoutMs = timeoutMs || AGENT_TIMEOUT;
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-c', CLAUDE + ' --dangerously-skip-permissions -p "$(cat ' + promptFile + ')"'], {
      cwd: agentDir,
      uid: AGENT_UID, gid: AGENT_GID,
      env: { ...process.env, HOME: '/home/claudeagent', USER: 'claudeagent', CLAUDECODE: undefined },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('Timeout ' + Math.round(timeoutMs/1000) + 's')); }, timeoutMs);
    proc.on('close', code => {
      clearTimeout(timer);
      // Kill any orphaned child processes from this agent run
      try {
        if (proc.pid) {
          execSync('pkill -9 -P ' + proc.pid + ' 2>/dev/null || true');
        }
      } catch(e) { /* already dead */ }
      if (code === 0) resolve();
      else reject(new Error('Exit ' + code + ': ' + stderr.slice(0, 300)));
    });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// Import the agent definitions from server.js would create circular deps,
// so we accept the agent config as a parameter from the workflow
async function runSingleAgent(agentConfig, jobData, contract, outputDir) {
  const agentDir = path.join(outputDir, agentConfig.output_subdir);
  await fs.mkdir(agentDir, { recursive: true });
  if (AGENT_UID) {
    try { await fs.chown(agentDir, AGENT_UID, AGENT_GID); } catch(e) {}
  }
  const contractFocus = contract ? getContractFocus(agentConfig.agent_id, contract) : '';
  let phase1Context = '';
  if (contract && contract.phase1Results) {
    try {
      const p1 = contract.phase1Results;
      const safe = (v, max) => { try { const s = JSON.stringify(v, null, 2); return s.slice(0, max || 4000); } catch(e) { return String(v).slice(0, 500); } };

      const schemaBlock = [
        'Status: ' + (p1.schema?.status || 'unknown'),
        'Tables Verified: ' + safe(p1.schema?.tables_verified || p1.schema?.tables_created || [], 3000),
        'Tables Count: ' + (p1.schema?.tables_count || p1.schema?.tables_verified?.length || 0),
        'Full Schema Output: ' + safe(p1.schema, 4000)
      ].join('\n');

      const workflowBlock = [
        'Status: ' + (p1.workflow?.status || 'unknown'),
        'Manifest: ' + safe(p1.workflow?.manifest || {}, 4000),
        'Imported Workflows: ' + safe(p1.workflow?.imported || p1.workflow?.manifest?.workflows || [], 3000),
        'Total Imported: ' + (p1.workflow?.manifest?.total_imported || 0),
        'Total Activated: ' + (p1.workflow?.manifest?.total_activated || 0)
      ].join('\n');

      const llmBlock = [
        'Status: ' + (p1.llm?.status || 'unknown'),
        'Files Produced: ' + safe(p1.llm?.files_produced || [], 2000),
        'Full LLM Output: ' + safe(p1.llm, 4000)
      ].join('\n');

      const externalBlock = [
        'Status: ' + (p1.external?.status || 'unknown'),
        'Platforms: ' + safe(p1.external?.platforms || [], 2000),
        'Full External Output: ' + safe(p1.external, 3000)
      ].join('\n');

      const platformBlock = [
        'Status: ' + (p1.platform?.status || 'unknown'),
        'Repo URL: ' + (p1.platform?.manifest?.repo_url || 'N/A'),
        'Tech Stack: ' + safe(p1.platform?.manifest?.tech_stack || [], 1000),
        'Environment Variables: ' + safe(p1.platform?.manifest?.environment_variables || [], 2000),
        'Full Platform Output: ' + safe(p1.platform, 4000)
      ].join('\n');

      const qaBlock = [
        'Status: ' + (p1.qa?.status || 'unknown'),
        'Pass Rate: ' + (p1.qa?.pass_rate || 0) + '%',
        'Passed: ' + (p1.qa?.passed || 0) + ' / Total: ' + (p1.qa?.total || 0) + ' / Failed: ' + (p1.qa?.failed || 0),
        'Duration: ' + (p1.qa?.duration || 0) + 's',
        'Failures: ' + safe(p1.qa?.failures || [], 3000),
        'Test Results: ' + safe(p1.qa?.test_results, 4000),
        'Iteration Cycles: ' + (p1.iteration_cycles || 0)
      ].join('\n');

      phase1Context = '\n\n══════════════════════════════════════════════════════\n' +
        'PHASE 1 BUILD RESULTS — Use this data to populate your document with ACTUAL names, values, and details.\n' +
        '══════════════════════════════════════════════════════\n\n' +
        '── Schema (BUILD-006 output) ──\n' + schemaBlock + '\n\n' +
        '── Workflow (BUILD-002 output) ──\n' + workflowBlock + '\n\n' +
        '── LLM/Prompts (BUILD-004 output) ──\n' + llmBlock + '\n\n' +
        '── External Integrations (BUILD-007 output) ──\n' + externalBlock + '\n\n' +
        '── Platform/GitHub (BUILD-005 output) ──\n' + platformBlock + '\n\n' +
        '── QA Results (BUILD-003 output) ──\n' + qaBlock;
    } catch(e) { phase1Context = ''; }
  }
  // FULL BRIEF — all section_a fields + guardrails + success metrics + acceptance criteria
  const fullBriefContext = '\n\n=== CLIENT BRIEF (section_a) ===\n' + JSON.stringify(jobData.section_a || {}, null, 2) +
    '\n\n=== QUALITY CRITERIA ===\n' + (jobData._buildContract?.qualityCriteria || jobData.acceptance_criteria || 'None specified') +
    '\n\n=== GUARDRAILS ===\n' + (jobData.guardrails || 'None specified') +
    '\n\n=== SUCCESS METRICS ===\n' + (jobData.success_metrics || 'None specified');

  // Reference template instruction for Phase 2 document agents
  const referenceInstruction = '\n\n=== REFERENCE TEMPLATES ===\n' +
    'CRITICAL: Before generating your output, read the appropriate reference template file:\n' +
    '- For Solution Demo: read /opt/manageai/build-api/templates/solution-demo-reference.html\n' +
    '- For Build Manual: read /opt/manageai/build-api/templates/build-manual-reference.html\n' +
    'Match the design system, component patterns, fonts, colors, and structure EXACTLY.\n' +
    'Replace all content with this build\'s data but keep the visual design identical to the reference.\n' +
    'Output must be a single-file HTML React 18 SPA using React.createElement (NOT JSX).';

  // Inject repo URL if available (for Solution Demo and Build Manual)
  let repoContext = '';
  try {
    const manifestPath = path.join(outputDir, 'platform', 'deployment-manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (manifest.repo_url) {
      repoContext = '\n\n=== GITHUB REPO ===\n' +
        'This agent code lives at: ' + manifest.repo_url + '\n' +
        'Reference this URL in the Solution Demo (Build Spec tab) and Build Manual (Overview section) so users can find the source code.';
    }
  } catch (_) {}

  const prompt = agentConfig.task + '\n\nOUTPUT DIRECTORY: ' + agentDir +
    '\n\nWrite ALL files directly to ' + agentDir + '. Use exact filenames specified. Work autonomously. Do not ask questions.' + contractFocus + phase1Context + fullBriefContext + referenceInstruction + repoContext;
  const promptFile = '/tmp/friday-temporal-' + jobData.job_id + '-' + agentConfig.agent_id + '.txt';
  await fs.writeFile(promptFile, prompt);
  console.log('[TEMPORAL][' + agentConfig.agent_id + '] Starting: ' + agentConfig.specialist);
  // H6: Blocked paths — check after agent exits
  const blockedPaths = ['/root/.ssh', '/root/.aws', '/etc/shadow', '/opt/manageai/build-api/.env'];

  const startTime = Date.now();
  let result;
  try {
    const timeoutMs = agentConfig.agent_id === 'agent_01' ? AGENT_01_TIMEOUT : AGENT_TIMEOUT;
    await runClaudeAgent(promptFile, agentDir, timeoutMs);
    const dur = Math.round((Date.now() - startTime) / 1000);
    console.log('[TEMPORAL][' + agentConfig.agent_id + '] Done in ' + dur + 's');
    await fs.rm(promptFile, { force: true });

    // H6: Post-agent filesystem integrity check
    for (const p of blockedPaths) {
      try {
        const stat = await fs.stat(p);
        const mtime = stat.mtimeMs;
        if (mtime > startTime) {
          console.warn(`[SECURITY] Agent ${agentConfig.agent_id} modified blocked path: ${p}`);
        }
      } catch (_) { /* path doesn't exist — fine */ }
    }

    result = { agent_id: agentConfig.agent_id, specialist: agentConfig.specialist, status: 'complete', duration: dur, output_subdir: agentConfig.output_subdir };
  } catch (err) {
    const dur = Math.round((Date.now() - startTime) / 1000);
    console.error('[TEMPORAL][' + agentConfig.agent_id + '] Error:', err.message.slice(0, 300));
    await fs.rm(promptFile, { force: true });
    // File recovery: check if agent wrote files despite non-zero exit
    try {
      const files = await fs.readdir(agentDir);
      const outputFiles = files.filter(f => !f.startsWith('.') && f !== 'prompt.txt');
      if (outputFiles.length > 0) {
        console.log('[TEMPORAL][' + agentConfig.agent_id + '] Command failed but ' + outputFiles.length + ' files written — recovering');
        result = { agent_id: agentConfig.agent_id, specialist: agentConfig.specialist, status: 'complete', files: outputFiles, recovered: true, duration: dur, output_subdir: agentConfig.output_subdir };
      } else {
        result = { agent_id: agentConfig.agent_id, specialist: agentConfig.specialist, status: 'error', error: err.message.slice(0, 200), duration: dur, output_subdir: agentConfig.output_subdir };
      }
    } catch (recoveryErr) {
      result = { agent_id: agentConfig.agent_id, specialist: agentConfig.specialist, status: 'error', error: err.message.slice(0, 200), duration: dur, output_subdir: agentConfig.output_subdir };
    }
  }

  // Persist agent run to build_agent_runs
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    await sb.from('build_agent_runs').insert({
      ticket_id: jobData.ticket_id || jobData.job_id,
      agent_id: agentConfig.agent_id,
      agent_name: agentConfig.specialist,
      status: result.status === 'complete' ? 'complete' : 'error',
      started_at: new Date(startTime).toISOString(),
      completed_at: new Date().toISOString(),
      duration_seconds: Math.round((Date.now() - startTime) / 1000),
      output: { files: result.files || [], status: result.status }
    });
  } catch (_) {}

  return result;
}

export async function agent01Activity(jobData, contract) {
  const outputDir = '/tmp/friday-temporal-' + jobData.job_id;
  // We need to dynamically import the agent definitions - pass them through jobData._agentConfigs
  // or reconstruct them here. For now, use the config passed from workflow
  const agentConfig = jobData._agentConfigs?.[0];
  if (!agentConfig) throw new Error('No agent config for agent_01');
  return runSingleAgent(agentConfig, jobData, contract, outputDir);
}

export async function agent02Activity(jobData, contract) {
  const outputDir = '/tmp/friday-temporal-' + jobData.job_id;
  const agentConfig = jobData._agentConfigs?.[1];
  if (!agentConfig) throw new Error('No agent config for agent_02');
  return runSingleAgent(agentConfig, jobData, contract, outputDir);
}

export async function agent03Activity(jobData, contract) {
  const outputDir = '/tmp/friday-temporal-' + jobData.job_id;
  const agentConfig = jobData._agentConfigs?.[2];
  if (!agentConfig) throw new Error('No agent config for agent_03');
  return runSingleAgent(agentConfig, jobData, contract, outputDir);
}

export async function agent04Activity(jobData, contract) {
  const outputDir = '/tmp/friday-temporal-' + jobData.job_id;
  const agentConfig = jobData._agentConfigs?.[3];
  if (!agentConfig) throw new Error('No agent config for agent_04');
  return runSingleAgent(agentConfig, jobData, contract, outputDir);
}

export async function agent05Activity(jobData, contract) {
  const outputDir = '/tmp/friday-temporal-' + jobData.job_id;
  const agentConfig = jobData._agentConfigs?.[4];
  if (!agentConfig) throw new Error('No agent config for agent_05');
  return runSingleAgent(agentConfig, jobData, contract, outputDir);
}

// Cleanup: kill all orphaned claudeagent processes after a build completes
export async function cleanupAgentProcessesActivity() {
  try {
    execSync('pkill -9 -u claudeagent 2>/dev/null || true');
    console.log('[TEMPORAL] Cleaned up orphaned claudeagent processes');
  } catch(e) {
    // No processes to kill — that's fine
  }
}
