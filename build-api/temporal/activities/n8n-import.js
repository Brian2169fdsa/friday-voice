import fs from 'fs/promises';
import path from 'path';

const SMOKE_TEST_TIMEOUT = 10000;

export async function importBlueprintActivity(jobData, agentResults) {
  console.log('[BUILD-002] Importing and activating workflows...');
  const outputDir = '/tmp/friday-temporal-' + jobData.job_id;
  const workflowDir = path.join(outputDir, 'workflow');

  let files;
  try { files = await fs.readdir(workflowDir); } catch(e) { files = []; }
  if (!files.length) {
    console.log('[BUILD-002] No workflow files to import');
    return { imported: [], manifest: null };
  }

  const n8nKey = process.env.N8N_LOCAL_API_KEY || process.env.N8N_API_KEY;
  const base = (process.env.N8N_LOCAL_URL || 'http://localhost:5678') + '/api/v1';
  const webhookBase = process.env.WEBHOOK_URL || 'http://5.223.79.255:5678';
  const imported = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(workflowDir, file), 'utf8');
      let wfJson;
      try { wfJson = JSON.parse(raw); } catch(e) {
        console.warn('[BUILD-002] Invalid JSON in', file);
        continue;
      }
      wfJson.name = wfJson.name || jobData.project_name || file.replace('.json', '');
      wfJson.active = false;

      // Step 1: Import workflow
      const createRes = await fetch(base + '/workflows', {
        method: 'POST',
        headers: { 'X-N8N-API-KEY': n8nKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(wfJson)
      });
      const created = await createRes.json();

      if (!created.id) {
        console.warn('[BUILD-002] Import failed:', file, JSON.stringify(created).slice(0, 200));
        imported.push({ file, status: 'import_failed', error: JSON.stringify(created).slice(0, 200) });
        continue;
      }

      console.log('[BUILD-002] Imported:', created.name, '| ID:', created.id);

      // Step 2: Activate workflow
      let activated = false;
      try {
        const activateRes = await fetch(base + '/workflows/' + created.id + '/activate', {
          method: 'POST',
          headers: { 'X-N8N-API-KEY': n8nKey, 'Content-Type': 'application/json' }
        });
        if (activateRes.ok) {
          activated = true;
          console.log('[BUILD-002] Activated:', created.name);
        } else {
          // Try PATCH method (some n8n versions use this)
          const patchRes = await fetch(base + '/workflows/' + created.id, {
            method: 'PATCH',
            headers: { 'X-N8N-API-KEY': n8nKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ active: true })
          });
          if (patchRes.ok) {
            activated = true;
            console.log('[BUILD-002] Activated via PATCH:', created.name);
          } else {
            console.warn('[BUILD-002] Activation failed:', created.name);
          }
        }
      } catch(e) {
        console.warn('[BUILD-002] Activation error:', e.message);
      }

      // Step 3: Detect webhook URL
      let webhookUrl = null;
      try {
        // Fetch the created workflow to find webhook nodes
        const wfRes = await fetch(base + '/workflows/' + created.id, {
          headers: { 'X-N8N-API-KEY': n8nKey }
        });
        const wfData = await wfRes.json();
        const nodes = wfData.nodes || [];
        const webhookNode = nodes.find(n =>
          n.type === 'n8n-nodes-base.webhook' ||
          n.type === '@n8n/n8n-nodes-langchain.webhook'
        );
        if (webhookNode) {
          const webhookPath = webhookNode.parameters?.path || created.id;
          const httpMethod = (webhookNode.parameters?.httpMethod || 'POST').toUpperCase();
          webhookUrl = webhookBase + '/webhook/' + webhookPath;
          console.log('[BUILD-002] Webhook detected:', httpMethod, webhookUrl);
        }
      } catch(e) {
        console.warn('[BUILD-002] Webhook detection error:', e.message);
      }

      // Step 4: Smoke test webhook (if found and workflow is active)
      let smokeTestResult = null;
      if (webhookUrl && activated) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), SMOKE_TEST_TIMEOUT);
          const testRes = await fetch(webhookUrl + '-test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ _smoke_test: true, build_id: jobData.job_id }),
            signal: controller.signal
          });
          clearTimeout(timeout);

          // Any response (even 4xx) means n8n received it -- the workflow is reachable
          smokeTestResult = {
            reachable: true,
            status: testRes.status,
            note: testRes.status < 400 ? 'Webhook responding' : 'Webhook reachable but returned ' + testRes.status
          };
          console.log('[BUILD-002] Smoke test:', smokeTestResult.note);
        } catch(e) {
          // Try production webhook path (without -test suffix)
          try {
            const controller2 = new AbortController();
            const timeout2 = setTimeout(() => controller2.abort(), SMOKE_TEST_TIMEOUT);
            const testRes2 = await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ _smoke_test: true, build_id: jobData.job_id }),
              signal: controller2.signal
            });
            clearTimeout(timeout2);
            smokeTestResult = {
              reachable: true,
              status: testRes2.status,
              note: 'Production webhook responding (status ' + testRes2.status + ')'
            };
            console.log('[BUILD-002] Smoke test (prod):', smokeTestResult.note);
          } catch(e2) {
            smokeTestResult = { reachable: false, error: e2.message, note: 'Webhook not reachable' };
            console.warn('[BUILD-002] Smoke test failed:', e2.message);
          }
        }
      }

      imported.push({
        id: created.id,
        name: created.name,
        file: file,
        activated: activated,
        webhook_url: webhookUrl,
        smoke_test: smokeTestResult,
        status: activated ? 'active' : 'imported'
      });
    } catch(e) {
      console.warn('[BUILD-002] Error importing', file, ':', e.message);
      imported.push({ file, status: 'error', error: e.message });
    }
  }

  // Step 5: Write workflow-manifest.json
  const manifest = {
    build_id: jobData.job_id,
    client: jobData.client || jobData.client_name,
    project: jobData.project_name,
    deployed_at: new Date().toISOString(),
    n8n_instance: process.env.N8N_LOCAL_URL || 'http://localhost:5678',
    workflows: imported.filter(w => w.id).map(w => ({
      id: w.id,
      name: w.name,
      active: w.activated,
      webhook_url: w.webhook_url,
      smoke_test_passed: w.smoke_test?.reachable || false
    })),
    total_imported: imported.filter(w => w.id).length,
    total_activated: imported.filter(w => w.activated).length,
    total_webhooks: imported.filter(w => w.webhook_url).length,
    success: imported.filter(w => w.id).length > 0
  };

  try {
    const manifestPath = path.join(outputDir, 'workflow-manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    console.log('[BUILD-002] Manifest written:', manifestPath);
  } catch(e) {
    console.warn('[BUILD-002] Failed to write manifest:', e.message);
  }

  console.log('[BUILD-002] Complete: ' + manifest.total_imported + ' imported, ' +
    manifest.total_activated + ' activated, ' + manifest.total_webhooks + ' webhooks');

  return { imported, manifest };
}
