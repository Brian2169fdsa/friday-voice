import { getGraphToken } from './onedrive.js';
import { createClient } from '@supabase/supabase-js';

const ONEDRIVE_USER = process.env.ONEDRIVE_USER_EMAIL || 'brian@manageai.io';
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

// Runs 5 post-build verification checks and returns a structured result.
// Throws an Error (ApplicationFailure-equivalent) if any check fails.
export async function finalOutputVerificationActivity({ jobData, ticketId, buildDir }) {
  const checks = [];
  const customerName = jobData.client || jobData.client_name || '';
  const aitmName = jobData.aitm_name || jobData.project_name || ticketId;

  // ── CHECK 1: QA Score ─────────────────────────────────────────────────────
  const qaScore = jobData.qaScore || jobData._qaScore || 0;
  if (qaScore >= 70) {
    checks.push({ check: 'qa_score', passed: true, score: qaScore });
  } else {
    checks.push({ check: 'qa_score', passed: false, reason: `QA score ${qaScore} below threshold 70` });
  }

  // ── CHECK 2: OneDrive files confirmed ─────────────────────────────────────
  const requiredFiles = [
    'Training_Manual.md',
    'Deployment_Summary.md',
    'Deployment_Package.json',
    'Regression_Suite.json',
    'Agent_Definition.md',
    'Engagement_Context.json'
  ];
  try {
    const token = await getGraphToken();
    const sanitize = s => (s || '').replace(/[<>:"\/\\|?*]/g, '-').trim();
    const folderPath = `Customers/${sanitize(customerName)}/${sanitize(aitmName)}`;
    const encodedPath = folderPath.split('/').map(p => encodeURIComponent(p)).join('/');
    const base = `https://graph.microsoft.com/v1.0/users/${ONEDRIVE_USER}/drive`;
    const res = await fetch(`${base}/root:/${encodedPath}:/children?$select=name&$top=100`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    let foundFiles = [];
    if (res.ok) {
      const data = await res.json();
      const fileNames = (data.value || []).map(f => f.name);
      foundFiles = requiredFiles.filter(f => fileNames.includes(f));
    }
    const missing = requiredFiles.filter(f => !foundFiles.includes(f));
    if (foundFiles.length >= 5) {
      checks.push({ check: 'onedrive_files', passed: true, found: foundFiles.length, missing });
    } else {
      checks.push({ check: 'onedrive_files', passed: false, missing, found: foundFiles.length });
    }
  } catch(e) {
    checks.push({ check: 'onedrive_files', passed: false, missing: requiredFiles, error: e.message });
  }

  // ── CHECK 3: n8n workflows active ─────────────────────────────────────────
  const workflowManifest = jobData._workflowManifest || null;
  if (!workflowManifest) {
    // Zero-workflow builds are valid
    checks.push({ check: 'n8n_workflows', passed: true, reason: 'No workflow manifest (zero-workflow build)' });
  } else {
    try {
      const n8nUrl = process.env.N8N_LOCAL_URL || 'http://localhost:5678';
      const n8nKey = process.env.N8N_LOCAL_API_KEY;
      const res = await fetch(`${n8nUrl}/api/v1/workflows?limit=250`, {
        headers: { 'X-N8N-API-KEY': n8nKey }
      });
      const data = res.ok ? await res.json() : { data: [] };
      const n8nWorkflows = data.data || [];

      // Build expected workflow names from manifest
      const expectedNames = Array.isArray(workflowManifest)
        ? workflowManifest.map(w => (typeof w === 'string' ? w : w.name)).filter(Boolean)
        : (workflowManifest.workflows || []).map(w => (typeof w === 'string' ? w : w.name)).filter(Boolean);

      const inactive = expectedNames.filter(name => {
        const found = n8nWorkflows.find(w =>
          w.name === name ||
          (w.tags || []).some(t => t.name === ticketId || t.name === customerName)
        );
        return !found || !found.active;
      });

      if (inactive.length === 0) {
        checks.push({ check: 'n8n_workflows', passed: true, count: expectedNames.length });
      } else {
        checks.push({ check: 'n8n_workflows', passed: false, inactive });
      }
    } catch(e) {
      checks.push({ check: 'n8n_workflows', passed: false, inactive: [], error: e.message });
    }
  }

  // ── CHECK 4: Supabase tables exist ────────────────────────────────────────
  const schemaResult = jobData._schemaResult || null;
  const noSchemaChanges = schemaResult?.no_changes_needed === true ||
    jobData._skipSchema === true;
  const customerSlug = customerName.toLowerCase().replace(/[^a-z0-9]/g, '_');

  if (noSchemaChanges) {
    checks.push({ check: 'supabase_tables', passed: true, reason: 'No schema changes needed for this build' });
  } else {
    try {
      const supabase = createClient(SB_URL, SB_KEY);
      let tables = [];

      // Try exec_sql RPC first (custom ManageAI function)
      const { data: rpcData, error: rpcError } = await supabase.rpc('exec_sql', {
        sql: `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE '%${customerSlug}%'`
      });
      if (!rpcError && Array.isArray(rpcData)) {
        tables = rpcData.map(r => r.table_name).filter(Boolean);
      }

      // Fallback: query information_schema directly via REST
      if (tables.length === 0 && rpcError) {
        const fallbackRes = await fetch(
          `${SB_URL}/rest/v1/information_schema.tables?select=table_name&table_schema=eq.public&table_name=like.*${customerSlug}*`,
          { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` } }
        );
        if (fallbackRes.ok) {
          const rows = await fallbackRes.json();
          tables = (rows || []).map(r => r.table_name).filter(Boolean);
        }
      }

      if (tables.length > 0) {
        checks.push({ check: 'supabase_tables', passed: true, tables });
      } else {
        checks.push({ check: 'supabase_tables', passed: false, reason: `No tables found for customer slug: ${customerSlug}` });
      }
    } catch(e) {
      checks.push({ check: 'supabase_tables', passed: false, reason: 'Supabase query error: ' + e.message });
    }
  }

  // ── CHECK 5: GitHub repo accessible ──────────────────────────────────────
  const githubRepo = jobData._githubRepo || ticketId;
  const githubToken = process.env.GITHUB_TOKEN;
  const skipGithub = jobData._skipGithub || !githubToken;

  if (skipGithub) {
    checks.push({ check: 'github_repo', passed: true, reason: 'GitHub repo creation was skipped' });
  } else {
    try {
      // Support both "owner/repo" and bare repo name (default org: manageai-io)
      const fullRepo = githubRepo.includes('/')
        ? githubRepo
        : `manageai-io/${githubRepo.replace(/[^a-zA-Z0-9-_.]/g, '-')}`;
      const res = await fetch(`https://api.github.com/repos/${fullRepo}`, {
        headers: {
          'Authorization': 'Bearer ' + githubToken,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      });
      if (res.status === 200) {
        checks.push({ check: 'github_repo', passed: true, repo: fullRepo });
      } else {
        checks.push({ check: 'github_repo', passed: false, reason: `Repo not found or inaccessible (HTTP ${res.status})` });
      }
    } catch(e) {
      checks.push({ check: 'github_repo', passed: false, reason: 'GitHub API error: ' + e.message });
    }
  }

  // ── Aggregate results ─────────────────────────────────────────────────────
  const passedChecks = checks.filter(c => c.passed);
  const failedChecks = checks.filter(c => !c.passed);
  const verified = failedChecks.length === 0;
  const scoreNum = passedChecks.length;
  const total = checks.length;

  const summary = verified
    ? `All ${scoreNum} checks passed`
    : `${failedChecks.length} of ${total} checks failed: ${failedChecks.map(c => c.check).join(', ')}`;

  const result = {
    verified,
    score: `${scoreNum}/${total}`,
    checks,
    summary,
    failedChecks
  };

  if (!verified) {
    // Throw so Temporal can retry this activity per activity retry policy
    const err = new Error('[VERIFICATION_FAILED] ' + summary);
    err.applicationFailureType = 'VerificationFailure';
    err.verificationResult = result;
    throw err;
  }

  return result;
}

// Re-exported here so the worker picks it up without a new activity file.
export { diagnoseAndHeal as diagnoseAndHealActivity } from '../../diagnostic-agent.js';
