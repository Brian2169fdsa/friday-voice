/**
 * Shared utilities for deep build agents
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { execFile } from 'child_process';

const execFileAsync = promisify(execFile);

const AGENT_UID = parseInt(process.env.CLAUDE_AGENT_UID || '1001', 10);
const AGENT_GID = parseInt(process.env.CLAUDE_AGENT_GID || '1001', 10);

export async function initDeepBuildDirActivity(jobData) {
  const buildDir = `/tmp/friday-deep-${jobData.ticket_id}`;
  await fs.mkdir(buildDir, { recursive: true, mode: 0o777 });

  // Write brief to file for agent reference
  await fs.writeFile(
    path.join(buildDir, 'BRIEF.json'),
    JSON.stringify(jobData, null, 2)
  );

  // Set ownership to claudeagent
  try {
    await execFileAsync('chown', ['-R', `${AGENT_UID}:${AGENT_GID}`, buildDir]);
  } catch (e) {
    console.warn('[DEEP] chown warning:', e.message);
  }

  console.log(`[DEEP] Build dir ready: ${buildDir}`);
  return { buildDir };
}

/**
 * Run Claude Code with a prompt file, recover from file on non-zero exit
 */
export async function runClaudeCode(buildDir, promptText, agentId, timeoutMs = 3600000) {
  const promptPath = path.join(buildDir, '.prompt.txt');
  await fs.writeFile(promptPath, promptText);

  console.log(`[${agentId}] Claude Code starting — timeout ${Math.round(timeoutMs/60000)}min`);
  const startTime = Date.now();

  let output = '';
  let exitCode = 0;

  try {
    const result = await execFileAsync('bash', ['-c',
      `export ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY} && ` +
      `cd ${buildDir} && ` +
      `cat ${promptPath} | /usr/bin/claude --dangerously-skip-permissions --print`
    ], {
      timeout: timeoutMs,
      maxBuffer: 50 * 1024 * 1024,  // 50MB for large outputs
      uid: AGENT_UID,
      gid: AGENT_GID
    });
    output = result.stdout;
  } catch (e) {
    exitCode = e.code || 1;
    output = e.stdout || '';
    console.warn(`[${agentId}] Claude Code exit ${exitCode} — checking for written files`);
  }

  const duration = Math.round((Date.now() - startTime) / 1000);
  console.log(`[${agentId}] Complete in ${duration}s | exit=${exitCode}`);

  // Clean up prompt file
  try { await fs.unlink(promptPath); } catch (_) {}

  return { output, exitCode, duration };
}

/**
 * Verify generated code by running its test suite
 */
export async function runTests(buildDir, testCommand, agentId) {
  console.log(`[${agentId}] Running tests: ${testCommand}`);
  try {
    const result = await execFileAsync('bash', ['-c',
      `cd ${buildDir} && ${testCommand}`
    ], {
      timeout: 600000,
      maxBuffer: 10 * 1024 * 1024,
      uid: AGENT_UID,
      gid: AGENT_GID
    });
    console.log(`[${agentId}] Tests passed`);
    return { passed: true, output: result.stdout };
  } catch (e) {
    console.warn(`[${agentId}] Tests failed (exit ${e.code})`);
    return { passed: false, output: e.stdout || '', error: e.stderr || '' };
  }
}

/**
 * Count files written by agent
 */
export async function countOutputFiles(buildDir) {
  try {
    const result = await execFileAsync('bash', ['-c',
      `find ${buildDir} -type f ! -name 'BRIEF.json' ! -name '.prompt.txt' ! -path '*/node_modules/*' ! -path '*/.git/*' | wc -l`
    ]);
    return parseInt(result.stdout.trim(), 10) || 0;
  } catch (_) {
    return 0;
  }
}

/**
 * Push completed build to GitHub as a private repo
 */
export async function deepGitHubPushActivity(jobData, buildResult) {
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    return { success: false, reason: 'No GitHub token' };
  }

  const buildDir = `/tmp/friday-deep-${jobData.ticket_id}`;
  const repoName = `deep-${jobData.deep_build_type}-${jobData.ticket_id.toLowerCase().replace('mai-', '')}`;

  console.log(`[DEEP-GH] Creating repo: ${repoName}`);

  // Create private repo
  try {
    const createResp = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        'Authorization': 'token ' + githubToken,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: repoName,
        private: true,
        description: `FRIDAY Deep Build: ${jobData.project_name || jobData.deep_build_type}`
      })
    });

    if (!createResp.ok && createResp.status !== 422) {
      const err = await createResp.text();
      return { success: false, reason: 'Repo create failed: ' + err.slice(0, 200) };
    }

    const repoData = createResp.status === 422 ?
      { html_url: `https://github.com/Brian2169fdsa/${repoName}`, owner: { login: 'Brian2169fdsa' } } :
      await createResp.json();

    // Init git, add remote, push
    await execFileAsync('bash', ['-c',
      `cd ${buildDir} && ` +
      `git init -b main && ` +
      `git config user.email 'friday@manageai.io' && ` +
      `git config user.name 'FRIDAY Deep Build' && ` +
      `git add -A && ` +
      `git commit -m "Initial deep build: ${jobData.project_name || jobData.deep_build_type}" && ` +
      `git remote add origin https://${githubToken}@github.com/${repoData.owner.login}/${repoName}.git && ` +
      `git push -u origin main`
    ], { uid: AGENT_UID, gid: AGENT_GID });

    console.log(`[DEEP-GH] Pushed: ${repoData.html_url}`);
    return {
      success: true,
      repo_url: repoData.html_url,
      repo_name: repoName
    };
  } catch (e) {
    console.error(`[DEEP-GH] Push failed:`, e.message);
    return { success: false, reason: e.message };
  }
}

/**
 * Send completion email with repo link
 */
export async function deepCompletionNotifyActivity(jobData, result) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Update build status
  try {
    await supabase.from('friday_deep_builds').update({
      status: 'complete',
      completed_at: new Date().toISOString(),
      repo_url: result.repo?.repo_url,
      file_count: result.file_count,
      duration_seconds: result.duration_seconds
    }).eq('ticket_id', jobData.ticket_id);
  } catch (_) {}

  console.log(`[DEEP-NOTIFY] Build ${jobData.ticket_id} complete`);
  console.log(`[DEEP-NOTIFY] Repo: ${result.repo?.repo_url || 'n/a'}`);
  console.log(`[DEEP-NOTIFY] Files: ${result.file_count}`);
  console.log(`[DEEP-NOTIFY] Duration: ${Math.round((result.duration_seconds || 0) / 60)}min`);

  return { notified: true };
}
