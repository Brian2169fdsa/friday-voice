import fs from 'fs/promises';
import path from 'path';
import { spawn, execSync } from 'child_process';

const CLAUDE = '/usr/bin/claude';
const DEPLOY_TIMEOUT = 600000;

let AGENT_UID, AGENT_GID;
try {
  AGENT_UID = parseInt(execSync('id -u claudeagent').toString().trim());
  AGENT_GID = parseInt(execSync('id -g claudeagent').toString().trim());
} catch (e) { AGENT_UID = null; AGENT_GID = null; }

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
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    const timer = setTimeout(() => { proc.kill(); reject(new Error('Timeout ' + Math.round(timeoutMs/1000) + 's')); }, timeoutMs);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('Exit ' + code + ': ' + stderr.slice(0, 500)));
    });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

export async function platformBuilderActivity(jobData, contract, buildOutputs) {
  const outputDir = '/tmp/friday-temporal-' + jobData.job_id;
  const agentDir = path.join(outputDir, 'platform');
  await fs.mkdir(agentDir, { recursive: true });
  if (AGENT_UID) { try { await fs.chown(agentDir, AGENT_UID, AGENT_GID); } catch(e) {} }

  const githubToken = process.env.GITHUB_TOKEN;
  const githubOrg = process.env.GITHUB_ORG || '';

  const clientSlug = (jobData.client || jobData.client_name || 'client').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const projectSlug = (jobData.project_name || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const repoName = clientSlug + '-' + projectSlug;

  const prompt = `You are BUILD-005, the Platform Builder for ManageAI FRIDAY.

Your job: Create a GitHub repo for this build, push all code files, and prepare the deployment configuration.

## Build Context
Client: ${jobData.client || jobData.client_name}
Project: ${jobData.project_name}
Repo Name: ${repoName}
Platform: ${jobData.platform || 'n8n'}
Description: ${jobData.request_description || ''}

## Build Contract
${contract ? JSON.stringify(contract, null, 2) : 'No contract provided'}

## Credentials
GITHUB_TOKEN: ${githubToken}
${githubOrg ? 'GITHUB_ORG: ' + githubOrg : 'No org -- create under authenticated user account'}

## Source Files
The build output directory is: ${outputDir}
Look for code files in these subdirectories:
- ${outputDir}/ (root level files)
- ${outputDir}/workflow/ (n8n workflow JSONs)
- ${outputDir}/schema/ (confirmed-schema.json)

List all files in the output directory first to understand what was built.

## Instructions

### Step 1: Identify the GitHub user
curl -s -H "Authorization: token ${githubToken}" "https://api.github.com/user" | grep -o '"login":"[^"]*"'

Use the login value as OWNER for all subsequent API calls.

### Step 2: Create the GitHub repository
Check if repo exists:
curl -s -o /dev/null -w "%{http_code}" -H "Authorization: token ${githubToken}" "https://api.github.com/repos/OWNER/${repoName}"

If 404, create it:
curl -s -X POST -H "Authorization: token ${githubToken}" -H "Content-Type: application/json" \\
  "https://api.github.com/${githubOrg ? 'orgs/' + githubOrg + '/repos' : 'user/repos'}" \\
  -d '{"name": "${repoName}", "description": "AI Teammate: ${jobData.project_name} for ${jobData.client || jobData.client_name}", "private": true, "auto_init": true}'

### Step 3: Push code files using the Contents API
For each file, base64 encode and push:
CONTENT=$(base64 -w0 filepath)
curl -s -X PUT -H "Authorization: token ${githubToken}" -H "Content-Type: application/json" \\
  "https://api.github.com/repos/OWNER/${repoName}/contents/{filepath}" \\
  -d '{"message": "Deploy: {filepath}", "content": "'$CONTENT'"}'

Files to push: any .js, .json, .md, .html files from the output directory.
Skip files > 1MB. Skip node_modules.

### Step 4: Create ecosystem.config.cjs
Generate and push a PM2 config:

module.exports = {
  apps: [{
    name: '${repoName}',
    script: 'server.js',
    cwd: '/opt/${repoName}',
    env: {
      PORT: 3100,
      NODE_ENV: 'production'
    }
  }]
};

### Step 5: Create README.md
Generate and push a README with project name, client, description, and setup instructions.

### Step 6: Write deployment-manifest.json to OUTPUT DIRECTORY
{
  "client": "${jobData.client || jobData.client_name}",
  "project": "${jobData.project_name}",
  "repo_name": "${repoName}",
  "repo_url": "https://github.com/OWNER/${repoName}",
  "repo_private": true,
  "deployed_at": "<ISO timestamp>",
  "files_pushed": ["list of files pushed"],
  "pm2_config": {
    "name": "${repoName}",
    "port": 3100
  },
  "success": true,
  "notes": "Any deployment decisions"
}

## Rules
- Repository MUST be private
- Use the GitHub Contents API for all file operations (not git clone)
- Base64 encode all file contents before pushing
- Skip binary files and files > 1MB
- Do NOT deploy or start PM2 processes -- just create the repo and push code
- Work autonomously. Do not ask questions.
- Write deployment-manifest.json even if some operations fail.

OUTPUT DIRECTORY: ${agentDir}`;

  const promptFile = '/tmp/friday-platform-' + jobData.job_id + '.txt';
  await fs.writeFile(promptFile, prompt);
  console.log('[BUILD-005] Starting for ' + (jobData.client || jobData.client_name) + ' / ' + jobData.project_name);
  const t = Date.now();

  try {
    await runClaudeAgent(promptFile, agentDir, DEPLOY_TIMEOUT);
    const dur = Math.round((Date.now() - t) / 1000);
    await fs.rm(promptFile, { force: true });

    let manifest = null;
    try {
      const raw = await fs.readFile(path.join(agentDir, 'deployment-manifest.json'), 'utf8');
      manifest = JSON.parse(raw);
    } catch(e) { console.warn('[BUILD-005] Could not read deployment-manifest.json:', e.message); }

    const filesPushed = manifest?.files_pushed?.length || 0;
    console.log('[BUILD-005] Done in ' + dur + 's | Files pushed: ' + filesPushed + ' | Repo: ' + (manifest?.repo_url || 'unknown'));

    return {
      agent_id: 'platform_builder',
      specialist: 'BUILD-005 Platform Builder',
      status: manifest?.success ? 'complete' : 'partial',
      duration: dur,
      output_subdir: 'platform',
      deployment_manifest: manifest,
      repo_url: manifest?.repo_url || null,
      files_pushed: filesPushed
    };
  } catch(err) {
    const dur = Math.round((Date.now() - t) / 1000);
    console.error('[BUILD-005] Error:', err.message.slice(0, 300));
    await fs.rm(promptFile, { force: true });
    return {
      agent_id: 'platform_builder',
      specialist: 'BUILD-005 Platform Builder',
      status: 'error',
      error: err.message.slice(0, 200),
      duration: dur,
      output_subdir: 'platform',
      deployment_manifest: null,
      repo_url: null,
      files_pushed: 0
    };
  }
}
