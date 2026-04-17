/**
 * Push Phase 2 outputs to the same GitHub repo BUILD-005 created.
 *
 * Pushes:
 * - build-docs/ (Requirements, Architecture, Deployment Summary, Regression Suite)
 * - deployment-package/ (all subpackage JSONs)
 * - workflow/ (blueprint JSONs)
 * - deliverables/ (Solution Demo HTML, Build Manual HTML if they exist)
 * - comparison/comparison-results.json
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs/promises';
import * as path from 'path';

export async function pushPhase2ToGitHubActivity(jobData, buildDir) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const ticketId = jobData.ticket_id || jobData.ticketId;
  const startTime = Date.now();

  console.log('[PHASE2-GH] Starting Phase 2 GitHub push for ' + ticketId);

  // Get repo info from deployment-manifest.json
  let repoOwner, repoName, repoUrl;
  try {
    const manifestPath = path.join(buildDir, 'platform', 'deployment-manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    repoUrl = manifest.repo_url || '';
    repoName = manifest.repo_name || '';

    const urlMatch = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (urlMatch) {
      repoOwner = urlMatch[1];
      repoName = urlMatch[2].replace(/\/$/, '');
    }
  } catch (e) {
    console.warn('[PHASE2-GH] Could not read deployment manifest:', e.message);
    return { success: false, reason: 'No deployment manifest' };
  }

  if (!repoOwner || !repoName) {
    console.warn('[PHASE2-GH] Missing repo owner or name');
    return { success: false, reason: 'Missing repo info' };
  }

  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    console.warn('[PHASE2-GH] No GitHub token configured');
    return { success: false, reason: 'No token' };
  }

  // Remove scratch files before pushing to GitHub
  const scratchPatterns = ['prompt.txt', '.prompt.txt', 'agent-prompt.txt', '.scratch', '.DS_Store'];
  async function cleanupBeforePush(dir, depth) {
    depth = depth || 0;
    if (depth > 5) return;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          await cleanupBeforePush(fullPath, depth + 1);
        } else if (!entry.isDirectory()) {
          const shouldRemove = scratchPatterns.some(p => entry.name === p || entry.name.endsWith(p));
          if (shouldRemove) { try { await fs.unlink(fullPath); } catch (_) {} }
        }
      }
    } catch (_) {}
  }
  await cleanupBeforePush(buildDir);

  // Collect Phase 2 files to push
  const phase2Dirs = ['build-docs', 'deployment-package', 'workflow', 'deliverables', 'comparison'];
  const filesToPush = [];

  for (const dir of phase2Dirs) {
    const dirPath = path.join(buildDir, dir);
    try {
      const files = await fs.readdir(dirPath);
      for (const file of files) {
        if (file.startsWith('.')) continue;
        const filePath = path.join(dirPath, file);
        try {
          const content = await fs.readFile(filePath, 'utf8');
          filesToPush.push({
            path: dir + '/' + file,
            content: Buffer.from(content).toString('base64')
          });
        } catch (_) {}
      }
    } catch (_) {}
  }

  if (filesToPush.length === 0) {
    console.warn('[PHASE2-GH] No Phase 2 files found to push');
    return { success: false, reason: 'No files' };
  }

  console.log('[PHASE2-GH] Pushing ' + filesToPush.length + ' Phase 2 files to ' + repoOwner + '/' + repoName);

  // Push each file via GitHub Contents API
  let pushed = 0;
  let failed = 0;

  for (const file of filesToPush) {
    try {
      // Check if file exists (to get SHA for update)
      let sha = null;
      try {
        const checkResp = await fetch(
          'https://api.github.com/repos/' + repoOwner + '/' + repoName + '/contents/' + encodeURIComponent(file.path),
          {
            headers: {
              'Authorization': 'token ' + githubToken,
              'Accept': 'application/vnd.github.v3+json'
            }
          }
        );
        if (checkResp.ok) {
          const existing = await checkResp.json();
          sha = existing.sha;
        }
      } catch (_) {}

      // Push file
      const body = {
        message: sha ? 'Update Phase 2: ' + file.path : 'Add Phase 2: ' + file.path,
        content: file.content,
        branch: 'main'
      };
      if (sha) body.sha = sha;

      const pushResp = await fetch(
        'https://api.github.com/repos/' + repoOwner + '/' + repoName + '/contents/' + encodeURIComponent(file.path),
        {
          method: 'PUT',
          headers: {
            'Authorization': 'token ' + githubToken,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        }
      );

      if (pushResp.ok) {
        pushed++;
      } else {
        failed++;
        const err = await pushResp.text();
        console.warn('[PHASE2-GH] Failed to push ' + file.path + ':', err.slice(0, 100));
      }
    } catch (e) {
      failed++;
      console.warn('[PHASE2-GH] Error pushing ' + file.path + ':', e.message);
    }
  }

  const duration = Math.round((Date.now() - startTime) / 1000);
  console.log('[PHASE2-GH] Complete in ' + duration + 's | ' + pushed + ' pushed | ' + failed + ' failed');

  // Log to build_agent_runs
  try {
    await supabase.from('build_agent_runs').insert({
      ticket_id: ticketId,
      agent_id: 'PHASE2-GH-PUSH',
      agent_name: 'Phase 2 GitHub Push',
      status: pushed > 0 ? 'complete' : 'error',
      started_at: new Date(startTime).toISOString(),
      completed_at: new Date().toISOString(),
      duration_seconds: duration,
      output: { pushed, failed, total: filesToPush.length, repo: repoUrl }
    });
  } catch (_) {}

  return {
    success: pushed > 0,
    pushed,
    failed,
    total: filesToPush.length,
    repo_url: repoUrl
  };
}
