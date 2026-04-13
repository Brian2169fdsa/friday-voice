import { createClient } from '@supabase/supabase-js';
import { spawn, execSync } from 'child_process';
import fs from 'fs/promises';
import { getGraphToken, ensureFolder, uploadFile } from './onedrive.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── OBSERVER MODE: runs after every build ────────────────────────────────────
export async function buildObserverActivity(jobData) {
  const ticketId = jobData.ticket_id || jobData.ticketId;
  const buildId = jobData.supabaseBuildId;
  const clientName = jobData.client || jobData.client_name || 'Unknown';

  console.log(`[BUILD-016] Recording build observations for ${clientName} / ${ticketId}`);

  // Read all agent runs for this build
  const { data: agentRuns } = await supabase
    .from('build_agent_runs')
    .select('agent_id, agent_name, status, duration_ms, output, errors')
    .eq('ticket_id', ticketId)
    .order('created_at');

  // Read quality signals
  const { data: qualitySignals } = await supabase
    .from('build_quality_signals')
    .select('from_agent, to_agent, signal_type, payload, confidence')
    .eq('ticket_id', ticketId)
    .order('created_at');

  const observations = [];
  let autoFixCount = 0;
  let needsApprovalCount = 0;

  for (const run of (agentRuns || [])) {
    // Count fix requests targeted at this agent
    const fixRequests = (qualitySignals || []).filter(
      s => s.to_agent === run.agent_id &&
      (s.signal_type === 'fix_request' || s.signal_type === 'targeted_fix_request')
    );

    // Check if score improved after fixes
    const qaResults = (qualitySignals || []).filter(s => s.signal_type === 'qa_results');
    let fixSuccess = null;
    if (fixRequests.length > 0 && qaResults.length >= 2) {
      const scores = qaResults.map(s => s.payload?.scores?.overall || 0);
      fixSuccess = scores[scores.length - 1] > scores[0];
    }

    // Extract score if available
    let score = null;
    if (run.output?.scores?.overall != null) score = run.output.scores.overall;
    else if (run.output?.compliance_score != null) score = run.output.compliance_score;
    else if (run.output?.passed != null) score = run.output.passed ? 100 : 0;

    const observation = {
      build_id: buildId,
      agent_id: run.agent_id,
      duration_ms: run.duration_ms || 0,
      status: run.status,
      score,
      error_message: run.errors?.[0]?.message || (run.status === 'failed' ? (run.output?.error || 'Unknown failure') : null),
      fix_attempts: fixRequests.length,
      fix_success: fixSuccess,
      created_at: new Date().toISOString()
    };

    observations.push(observation);

    // Classify issues for maintenance queue
    if (run.status === 'failed') {
      const errorMsg = observation.error_message || '';

      // Timeout issues -> auto_fix (increase timeout config)
      if (errorMsg.includes('Timeout') || errorMsg.includes('timed out')) {
        autoFixCount++;
        await supabase.from('maintenance_fix_queue').insert({
          observation_id: null,
          file_path: 'temporal/workflows/friday-build.js',
          fix_description: `Increase timeout for ${run.agent_id} — timed out at ${run.duration_ms}ms. Current limit may be too low.`,
          classification: 'auto_fix',
          status: 'pending',
          created_at: new Date().toISOString()
        });
      }
      // Parse failures -> auto_fix
      else if (errorMsg.includes('parse') || errorMsg.includes('JSON')) {
        autoFixCount++;
        await supabase.from('maintenance_fix_queue').insert({
          observation_id: null,
          file_path: `temporal/activities/${run.agent_id.toLowerCase().replace('build-', '')}.js`,
          fix_description: `${run.agent_id} failed with parse error: "${errorMsg.slice(0, 200)}". Add fallback JSON parsing or default values.`,
          classification: 'auto_fix',
          status: 'pending',
          created_at: new Date().toISOString()
        });
      }
      // Repeated failures -> needs_approval
      else if (fixRequests.length >= 2 && !fixSuccess) {
        needsApprovalCount++;
        await supabase.from('maintenance_fix_queue').insert({
          observation_id: null,
          file_path: `temporal/activities/`,
          fix_description: `${run.agent_id} failed ${fixRequests.length} times with no score improvement. Root cause: "${errorMsg.slice(0, 200)}". Manual investigation needed.`,
          classification: 'needs_approval',
          status: 'pending',
          created_at: new Date().toISOString()
        });
      }
    }
  }

  // Bulk insert observations
  if (observations.length > 0) {
    const { error: insertErr } = await supabase.from('build_observations').insert(observations);
    if (insertErr) {
      console.warn(`[BUILD-016] Failed to insert observations: ${insertErr.message}`);
    }
  }

  console.log(`[BUILD-016] Recorded ${observations.length} observations | auto_fix: ${autoFixCount} | needs_approval: ${needsApprovalCount}`);

  return {
    observations_count: observations.length,
    auto_fix_count: autoFixCount,
    needs_approval_count: needsApprovalCount
  };
}

// ── MAINTENANCE MODE: runs on nightly cron ───────────────────────────────────
export async function maintenanceRunActivity() {
  console.log('[BUILD-016] Starting maintenance run');

  // Check: are any builds currently running?
  const { data: activeBuilds } = await supabase
    .from('friday_builds')
    .select('id, ticket_id, status')
    .eq('status', 'building')
    .limit(1);

  if (activeBuilds && activeBuilds.length > 0) {
    console.log('[BUILD-016] Active build detected — skipping maintenance');
    return { fixes_applied: 0, fixes_failed: 0, rolled_back: false, report_url: null, skipped: true };
  }

  // Set system_status to maintenance
  await supabase.from('system_config').upsert({
    key: 'system_status',
    value: 'maintenance',
    updated_at: new Date().toISOString()
  }, { onConflict: 'key' });

  let fixesApplied = 0;
  let fixesFailed = 0;
  let rolledBack = false;
  const fixLog = [];

  try {
    // Read pending auto_fix items
    const { data: pendingFixes } = await supabase
      .from('maintenance_fix_queue')
      .select('*')
      .eq('classification', 'auto_fix')
      .eq('status', 'pending')
      .order('created_at')
      .limit(10);

    if (!pendingFixes || pendingFixes.length === 0) {
      console.log('[BUILD-016] No pending auto-fixes');
      fixLog.push({ action: 'scan', result: 'No pending fixes found' });
    } else {
      // Git checkpoint
      try {
        execSync('cd /opt/manageai && git stash', { timeout: 10000, stdio: 'pipe' });
      } catch (e) {
        // No changes to stash — that's fine
      }

      for (const fix of pendingFixes) {
        console.log(`[BUILD-016] Applying fix: ${fix.fix_description.slice(0, 100)}`);

        try {
          // Write a targeted fix prompt
          const promptPath = '/tmp/friday-maintenance-fix.txt';
          await fs.writeFile(promptPath, `In file /opt/manageai/build-api/${fix.file_path}, make this specific change: ${fix.fix_description}. Run "node -c /opt/manageai/build-api/${fix.file_path}" to verify syntax. Do not change anything else.`);

          // Run Claude Code with targeted fix
          execSync(
            `/usr/bin/claude --dangerously-skip-permissions -p "$(cat ${promptPath})"`,
            {
              cwd: '/opt/manageai/build-api',
              timeout: 120000,
              stdio: 'pipe',
              env: { ...process.env, HOME: '/home/claudeagent', USER: 'claudeagent' }
            }
          );

          // Verify syntax
          execSync(`node -c /opt/manageai/build-api/${fix.file_path}`, { timeout: 10000, stdio: 'pipe' });

          await supabase.from('maintenance_fix_queue')
            .update({ status: 'applied', applied_at: new Date().toISOString() })
            .eq('id', fix.id);

          fixesApplied++;
          fixLog.push({ action: 'apply', file: fix.file_path, result: 'success' });
        } catch (e) {
          await supabase.from('maintenance_fix_queue')
            .update({ status: 'failed', applied_at: new Date().toISOString() })
            .eq('id', fix.id);

          fixesFailed++;
          fixLog.push({ action: 'apply', file: fix.file_path, result: 'failed', error: e.message.slice(0, 200) });
        }

        await fs.rm('/tmp/friday-maintenance-fix.txt', { force: true });
      }

      // If fixes were applied, restart worker and health check
      if (fixesApplied > 0) {
        try {
          execSync('cd /opt/manageai && bash restart-worker.sh', { timeout: 30000, stdio: 'pipe' });

          // Wait 10s and check PM2 health
          await new Promise(r => setTimeout(r, 10000));

          const pm2Status = execSync('pm2 jlist', { timeout: 10000, stdio: 'pipe' }).toString();
          const processes = JSON.parse(pm2Status);
          const workerProcess = processes.find(p => p.name === 'friday-worker');

          if (!workerProcess || workerProcess.pm2_env?.status !== 'online') {
            console.error('[BUILD-016] Worker unhealthy after fixes — rolling back');
            execSync('cd /opt/manageai && git stash pop', { timeout: 10000, stdio: 'pipe' });
            execSync('cd /opt/manageai && bash restart-worker.sh', { timeout: 30000, stdio: 'pipe' });
            rolledBack = true;
            fixLog.push({ action: 'rollback', result: 'Worker unhealthy — rolled back' });

            // Mark applied fixes as rolled_back
            for (const fix of pendingFixes) {
              await supabase.from('maintenance_fix_queue')
                .update({ status: 'rolled_back' })
                .eq('id', fix.id)
                .eq('status', 'applied');
            }
          } else {
            fixLog.push({ action: 'restart', result: 'Worker healthy after restart' });
          }
        } catch (restartErr) {
          console.error('[BUILD-016] Restart failed:', restartErr.message);
          try {
            execSync('cd /opt/manageai && git stash pop', { timeout: 10000, stdio: 'pipe' });
            execSync('cd /opt/manageai && bash restart-worker.sh', { timeout: 30000, stdio: 'pipe' });
          } catch (rbErr) {
            console.error('[BUILD-016] Rollback also failed:', rbErr.message);
          }
          rolledBack = true;
          fixLog.push({ action: 'rollback', result: 'Restart failed — rolled back', error: restartErr.message.slice(0, 200) });
        }
      }
    }
  } catch (e) {
    console.error('[BUILD-016] Maintenance run error:', e.message);
    fixLog.push({ action: 'error', result: e.message.slice(0, 300) });
  }

  // Generate report
  const report = [
    '# FRIDAY Maintenance Report',
    `**Date:** ${new Date().toISOString()}`,
    `**Fixes Applied:** ${fixesApplied}`,
    `**Fixes Failed:** ${fixesFailed}`,
    `**Rolled Back:** ${rolledBack}`,
    '',
    '## Fix Log',
    ...fixLog.map(l => `- **${l.action}**: ${l.file || ''} — ${l.result}${l.error ? ' (' + l.error + ')' : ''}`)
  ].join('\n');

  // Upload report to OneDrive
  let reportUrl = null;
  try {
    const token = await getGraphToken();
    const reportPath = 'ManageAI OS/Maintenance Reports';
    await ensureFolder(token, reportPath);
    const dateStr = new Date().toISOString().split('T')[0];
    reportUrl = await uploadFile(token, reportPath, `maintenance-${dateStr}.md`, report, 'text/markdown');
    console.log('[BUILD-016] Maintenance report uploaded:', reportUrl);
  } catch (uploadErr) {
    console.warn('[BUILD-016] Report upload failed:', uploadErr.message);
  }

  // Set system_status back to active
  await supabase.from('system_config').upsert({
    key: 'system_status',
    value: 'active',
    updated_at: new Date().toISOString()
  }, { onConflict: 'key' });

  console.log(`[BUILD-016] Maintenance complete | Applied: ${fixesApplied} | Failed: ${fixesFailed} | Rolled back: ${rolledBack}`);

  return {
    fixes_applied: fixesApplied,
    fixes_failed: fixesFailed,
    rolled_back: rolledBack,
    report_url: reportUrl
  };
}
