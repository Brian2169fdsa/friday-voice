import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { ApplicationFailure } from '@temporalio/activity';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export async function deploymentVerifierActivity(jobData) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  const ticketId = jobData.ticket_id || jobData.ticketId;
  const customerId = jobData.customerId || jobData.customer_id;
  const clientName = jobData.client || jobData.client_name || jobData.clientName || 'Unknown';
  const buildContract = jobData._buildContract || jobData.buildContract;

  console.log(`[BUILD-010] Starting deployment verification for ${clientName} / ${ticketId}`);
  const startTime = Date.now();

  await supabase.from('build_agent_runs').upsert({
    ticket_id: ticketId,
    agent_id: 'BUILD-010',
    agent_name: 'Deployment Verifier',
    status: 'running',
    started_at: new Date().toISOString()
  }, { onConflict: 'ticket_id,agent_id' });

  const results = [];
  const N8N_URL = process.env.N8N_LOCAL_URL || 'http://localhost:5678';
  const N8N_KEY = process.env.N8N_LOCAL_API_KEY;
  const clientSlug = clientName.toLowerCase().replace(/[^a-z0-9]/g, '-');

  // 1. Verify n8n workflows are live and active
  try {
    const wfRes = await fetch(`${N8N_URL}/api/v1/workflows`, {
      headers: { 'X-N8N-API-KEY': N8N_KEY }
    });

    if (wfRes.ok) {
      const wfData = await wfRes.json();
      const clientWFs = (wfData.data || []).filter(w =>
        w.name.toLowerCase().includes(clientSlug) && w.active
      );

      if (clientWFs.length === 0) {
        results.push({ check: 'n8n_live_workflows', passed: false, error: 'No active workflows found for client' });
      } else {
        for (const wf of clientWFs.slice(0, 3)) {
          const execRes = await fetch(
            `${N8N_URL}/api/v1/executions?workflowId=${wf.id}&limit=1`,
            { headers: { 'X-N8N-API-KEY': N8N_KEY } }
          );

          if (execRes.ok) {
            const execData = await execRes.json();
            const lastExec = execData.data?.[0];
            results.push({
              check: `n8n_workflow_${wf.name.slice(0, 40)}`,
              passed: true,
              active: true,
              last_execution: lastExec?.startedAt || 'never',
              last_status: lastExec ? (lastExec.stoppedAt ? 'success' : 'running') : 'no_executions'
            });
          } else {
            results.push({ check: `n8n_workflow_${wf.name.slice(0, 40)}`, passed: true, active: true, last_execution: 'unknown' });
          }
        }
      }
    } else {
      results.push({ check: 'n8n_live_workflows', passed: false, error: `n8n API HTTP ${wfRes.status}` });
    }
  } catch(e) {
    results.push({ check: 'n8n_verification', passed: false, error: e.message });
  }

  // 2. Verify Supabase tables are accessible via PostgREST
  try {
    const schemaRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/`, {
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
      }
    });

    if (schemaRes.ok) {
      const schema = await schemaRes.json();
      const allTables = Object.keys(schema.paths || {})
        .map(p => p.replace('/', ''))
        .filter(t => t.length > 0);

      const clientDbSlug = clientName.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const clientTables = allTables.filter(t => t.includes(clientDbSlug));

      if (clientTables.length === 0) {
        results.push({ check: 'supabase_tables_accessible', passed: false, error: 'No client tables found in PostgREST schema' });
      } else {
        for (const table of clientTables.slice(0, 5)) {
          const { error } = await supabase.from(table).select('*').limit(1);
          results.push({
            check: `supabase_table_${table}`,
            passed: !error,
            error: error?.message
          });
        }
      }
    } else {
      results.push({ check: 'supabase_production_check', passed: false, error: `PostgREST schema HTTP ${schemaRes.status}` });
    }
  } catch(e) {
    results.push({ check: 'supabase_production_check', passed: false, error: e.message });
  }

  // FIX 6: Read deployment-manifest.json from build output to get repo info
  let manifestRepoName = null;
  let manifestRepoUrl = null;
  try {
    const buildDir = '/tmp/friday-temporal-' + (jobData.job_id || '');
    const manifestPath = buildDir + '/platform/deployment-manifest.json';
    const { readFile } = await import('fs/promises');
    const manifestRaw = await readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestRaw);
    manifestRepoName = manifest.repo_name || null;
    manifestRepoUrl = manifest.repo_url || null;
    console.log(`[BUILD-010] Read deployment manifest: repo=${manifestRepoName}, url=${manifestRepoUrl}`);
  } catch (e) {
    console.log('[BUILD-010] Could not read deployment-manifest.json:', e.message);
  }

  // 3. Verify GitHub repo is accessible with recent commit
  const githubToken = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
  const repoOwner = process.env.GITHUB_ORG || process.env.GITHUB_USERNAME;
  const repoName = manifestRepoName || buildContract?.repoName || jobData._buildContract?.repoName;

  if (repoName && githubToken && repoOwner) {
    try {
      const repoRes = await fetch(
        `https://api.github.com/repos/${repoOwner}/${repoName}`,
        { headers: { 'Authorization': `Bearer ${githubToken}`, 'Accept': 'application/vnd.github+json' } }
      );

      if (repoRes.ok) {
        const repo = await repoRes.json();
        const commitRes = await fetch(
          `https://api.github.com/repos/${repoOwner}/${repoName}/commits/${repo.default_branch}`,
          { headers: { 'Authorization': `Bearer ${githubToken}`, 'Accept': 'application/vnd.github+json' } }
        );

        const commit = commitRes.ok ? await commitRes.json() : null;
        const commitAge = commit ? (Date.now() - new Date(commit.commit.author.date).getTime()) / 1000 / 60 : null;

        results.push({
          check: 'github_repo_live',
          passed: true,
          repo: repoName,
          default_branch: repo.default_branch,
          last_commit: commit?.commit?.message?.slice(0, 80),
          commit_age_minutes: commitAge ? Math.round(commitAge) : null,
          recent_commit: commitAge ? commitAge < 120 : null
        });
      } else {
        results.push({ check: 'github_repo_live', passed: false, error: `Repo not accessible: HTTP ${repoRes.status}` });
      }
    } catch(e) {
      results.push({ check: 'github_repo_live', passed: false, error: e.message });
    }
  } else {
    results.push({ check: 'github_repo_live', passed: false, error: 'No GitHub config or repo name available' });
  }

  // 4. Collect QA and compliance signals for holistic validation
  const { data: qaSignalData } = await supabase
    .from('build_quality_signals')
    .select('payload')
    .eq('ticket_id', ticketId)
    .eq('signal_type', 'qa_results')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: complianceData } = await supabase
    .from('build_compliance_results')
    .select('compliance_score, criteria_met, criteria_total, passed')
    .eq('ticket_id', ticketId)
    .maybeSingle();

  const deploymentSummary = {
    n8n_checks: results.filter(r => r.check.startsWith('n8n')),
    supabase_checks: results.filter(r => r.check.startsWith('supabase')),
    github_checks: results.filter(r => r.check.startsWith('github')),
    qa_score: qaSignalData?.payload?.scores?.overall,
    compliance_score: complianceData?.compliance_score,
    compliance_passed: complianceData?.passed
  };

  const validationRes = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: `You are verifying a deployed AI system for ${clientName} is production-ready.

DEPLOYMENT CHECK RESULTS:
${JSON.stringify(deploymentSummary, null, 2)}

Assess: Is this system ready for real client traffic?
Consider: Are workflows live? Is database accessible? Is code deployed? Are QA and compliance scores acceptable?

Return ONLY JSON (no markdown):
{
  "production_ready": boolean,
  "confidence": number,
  "blockers": [string],
  "warnings": [string],
  "summary": string
}`
    }]
  });

  let validation;
  try {
    const raw = validationRes.content[0].text.replace(/```json\n?|\n?```/g, '').trim();
    validation = JSON.parse(raw);
  } catch(e) {
    const passedChecks = results.filter(r => r.passed).length;
    validation = {
      production_ready: passedChecks >= results.length * 0.8,
      confidence: passedChecks / Math.max(results.length, 1),
      blockers: [],
      warnings: ['Validation parse failed'],
      summary: `${passedChecks}/${results.length} deployment checks passed`
    };
  }

  const duration = Date.now() - startTime;
  const overallPassed = validation.production_ready && (validation.blockers || []).length === 0;

  await supabase.from('build_agent_runs').update({
    status: overallPassed ? 'complete' : 'failed',
    duration_ms: duration,
    output: {
      passed: overallPassed,
      production_ready: validation.production_ready,
      confidence: validation.confidence,
      checks_total: results.length,
      checks_passed: results.filter(r => r.passed).length,
      blockers: validation.blockers,
      summary: validation.summary,
      detailed_results: results
    },
    completed_at: new Date().toISOString()
  }).eq('ticket_id', ticketId).eq('agent_id', 'BUILD-010');

  await supabase.from('build_quality_signals').insert({
    ticket_id: ticketId,
    from_agent: 'BUILD-010',
    signal_type: 'deployment_verification',
    confidence: validation.confidence,
    payload: { results, validation, passed: overallPassed }
  });

  console.log(`[BUILD-010] Deployment verification complete | Ready: ${validation.production_ready} | Checks: ${results.filter(r => r.passed).length}/${results.length} | Duration: ${duration}ms`);

  if (!overallPassed && (validation.blockers || []).length > 0) {
    try { await supabase.from('build_agent_runs').update({ status: 'failed', completed_at: new Date().toISOString(), errors: [{ message: 'Deployment not production ready' }] }).eq('ticket_id', ticketId).eq('agent_id', 'BUILD-010'); } catch (_) {}
    throw ApplicationFailure.create({
      message: `[BUILD-010] DEPLOYMENT NOT PRODUCTION READY:\n${validation.blockers.join('\n')}\n\nSummary: ${validation.summary}`,
      type: 'DeploymentVerificationFailure',
      nonRetryable: false,
      details: [{ results, validation }]
    });
  }

  return {
    agent: 'BUILD-010',
    status: 'complete',
    production_ready: validation.production_ready,
    confidence: validation.confidence,
    checks_passed: results.filter(r => r.passed).length,
    checks_total: results.length,
    summary: validation.summary,
    duration_ms: duration
  };
}
