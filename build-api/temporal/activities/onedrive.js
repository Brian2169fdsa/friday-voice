import fs from 'fs/promises';
import path from 'path';

const ONEDRIVE_USER = process.env.ONEDRIVE_USER_EMAIL || 'brian@manageai.io';
const MAX_SCAN_DEPTH = 5;
const MAX_RETRIES = 3;

async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.status >= 500 && i < retries - 1) {
        console.warn('[OneDrive] Server error ' + res.status + ', retry ' + (i+1) + '/' + retries);
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        continue;
      }
      return res;
    } catch (e) {
      if (i < retries - 1) {
        console.warn('[OneDrive] Network error, retry ' + (i+1) + '/' + retries + ':', e.message);
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
}

export async function getGraphToken() {
  const res = await fetchWithRetry('https://login.microsoftonline.com/' + process.env.AZURE_TENANT_ID + '/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.AZURE_CLIENT_ID,
      client_secret: process.env.AZURE_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials'
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token error: ' + JSON.stringify(data).slice(0, 200));
  return data.access_token;
}

export async function ensureFolder(token, folderPath) {
  const base = 'https://graph.microsoft.com/v1.0/users/' + ONEDRIVE_USER + '/drive';
  const h = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
  const parts = folderPath.split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    const prev = cur;
    cur = cur ? cur + '/' + part : part;
    const check = await fetchWithRetry(base + '/root:/' + cur, { headers: h });
    if (check.status === 404) {
      const parentRef = prev ? base + '/root:/' + prev + ':/children' : base + '/root/children';
      await fetchWithRetry(parentRef, { method: 'POST', headers: h, body: JSON.stringify({ name: part, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' }) });
    }
  }
}

export async function uploadFile(token, folderPath, fileName, content, mimeType) {
  const base = 'https://graph.microsoft.com/v1.0/users/' + ONEDRIVE_USER + '/drive';
  const encodedPath = folderPath.split('/').map(p => encodeURIComponent(p)).join('/');
  const encodedFile = encodeURIComponent(fileName);
  const up = await fetchWithRetry(base + '/root:/' + encodedPath + '/' + encodedFile + ':/content', {
    method: 'PUT',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': mimeType || 'application/octet-stream' },
    body: content
  });
  const uploaded = await up.json();
  if (!uploaded.id) throw new Error('Upload failed: ' + JSON.stringify(uploaded).slice(0, 200));

  let shareUrl = '';
  for (const scope of ['organization', 'anonymous']) {
    try {
      const link = await fetchWithRetry(base + '/items/' + uploaded.id + '/createLink', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'view', scope })
      });
      const linkData = await link.json();
      if (linkData.link?.webUrl) { shareUrl = linkData.link.webUrl; break; }
    } catch (e) {
      console.warn('[OneDrive] createLink scope=' + scope + ' error:', e.message);
    }
  }
  if (!shareUrl) shareUrl = uploaded.webUrl || '';
  return shareUrl;
}

export async function fetchEngagementContextActivity(clientName) {
  const sanitize = s => (s || '').replace(/[<>:"\/|?*]/g, '-').trim();
  const safeName = sanitize(clientName);
  if (!safeName) return null;
  try {
    const token = await getGraphToken();
    const base = 'https://graph.microsoft.com/v1.0/users/' + ONEDRIVE_USER + '/drive';
    const filePath = 'ManageAI/Clients/' + safeName + '/FRIDAY/engagement-context.json';
    const encodedPath = filePath.split('/').map(p => encodeURIComponent(p)).join('/');
    const res = await fetchWithRetry(base + '/root:/' + encodedPath + ':/content', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) {
      console.log('[ENGAGEMENT] No prior context for', clientName, '(HTTP', res.status + ')');
      return null;
    }
    const text = await res.text();
    const ctx = JSON.parse(text);
    console.log('[ENGAGEMENT] Loaded prior context for', clientName, '— version', ctx.version || '?', ', tables:', (ctx.schema_tables || []).length);
    return ctx;
  } catch(e) {
    console.log('[ENGAGEMENT] Could not fetch context for', clientName + ':', e.message.slice(0, 100));
    return null;
  }
}

export async function uploadToOnedriveActivity(jobData, agentResults) {
  console.log('[TEMPORAL] Uploading to OneDrive...');
  const outputDir = '/tmp/friday-temporal-' + jobData.job_id;
  const buildVersion = jobData.buildVersion || 'v1.0';
  const sanitize = s => (s || '').replace(/[<>:"\/\\|?*]/g, '-').trim();
  const ticketId = jobData.ticket_id || jobData.ticketId || '';
  const clientDisplay = jobData.client || jobData.client_name || '';
  const buildFolderName = sanitize(ticketId + ' - ' + clientDisplay);
  const basePath = 'FRIDAY Builds/' + buildFolderName;
  const versionPath = basePath + '/Phase 2';
  const currentPath = basePath + '/Phase 2';

  const token = await getGraphToken();
  await ensureFolder(token, versionPath);
  await ensureFolder(token, currentPath);

  const mimes = {
    '.html': 'text/html', '.pdf': 'application/pdf', '.json': 'application/json',
    '.md': 'text/markdown', '.txt': 'text/plain', '.js': 'text/javascript', '.css': 'text/css'
  };
  const uploaded = [];

  async function scan(dir, rel, depth) {
    rel = rel || '';
    depth = depth || 0;
    if (depth > MAX_SCAN_DEPTH) {
      console.warn('[OneDrive] Max scan depth reached at:', dir);
      return;
    }
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        await scan(path.join(dir, e.name), rel + e.name + '/', depth + 1);
      } else {
        try {
          const fileContent = await fs.readFile(path.join(dir, e.name));
          const ext = path.extname(e.name).toLowerCase();
          const url = await uploadFile(token, versionPath, rel + e.name, fileContent, mimes[ext]);
          uploaded.push({ name: rel + e.name, url });
          try {
            await uploadFile(token, currentPath, rel + e.name, fileContent, mimes[ext]);
          } catch (copyErr) {
            console.warn('[OneDrive] /current/ copy failed:', copyErr.message);
          }
        } catch (fileErr) {
          console.error('[OneDrive] Upload failed for', rel + e.name, ':', fileErr.message);
        }
      }
    }
  }

  await scan(outputDir);
  console.log('[TEMPORAL] Uploaded', uploaded.length, 'files to OneDrive');
  return uploaded.filter(u => u.url);
}

// Upload Phase 1 build manifests to OneDrive
export async function uploadPhase1ManifestsActivity(jobData, phase1Results) {
  const { client_name = 'Unknown', project_name = 'Build', job_id = 'unknown' } = jobData;
  const clientDisplay = jobData.client || client_name;
  const aitm = jobData.aitm_name || project_name || jobData.ticket_id;
  console.log('[FRIDAY] Uploading Phase 1 manifests to OneDrive for', clientDisplay);

  const sanitize = s => (s || '').replace(/[<>:"\\/|?*]/g, '-').trim();
  const ticketId = jobData.ticket_id || jobData.ticketId || '';
  const buildFolderName = sanitize(ticketId + ' - ' + clientDisplay);
  const basePath = 'FRIDAY Builds/' + buildFolderName + '/Phase 1';

  const token = await getGraphToken();
  const results = [];

  const manifests = [
    {
      name: 'confirmed-schema.json',
      data: phase1Results?.schema || null,
      label: 'Schema'
    },
    {
      name: 'workflow-manifest.json',
      data: phase1Results?.workflow?.manifest || phase1Results?.workflow || null,
      label: 'Workflow'
    },
    {
      name: 'deployment-manifest.json',
      data: phase1Results?.platform || null,
      label: 'Platform'
    },
    {
      name: 'test-results.json',
      data: phase1Results?.qa || null,
      label: 'QA'
    },
    {
      name: 'phase1-summary.json',
      data: {
        job_id,
        client_name,
        project_name,
        generated_at: new Date().toISOString(),
        iteration_cycles: phase1Results?.iteration_cycles || 0,
        schema_status: phase1Results?.schema?.status || 'unknown',
        workflows_imported: phase1Results?.workflow?.manifest?.total_imported || 0,
        platform_status: phase1Results?.platform?.status || 'unknown',
        qa_pass_rate: phase1Results?.qa?.pass_rate || 0
      },
      label: 'Summary'
    }
  ];

  for (const manifest of manifests) {
    if (!manifest.data) {
      console.warn('[FRIDAY] Skipping', manifest.name, '-- no data');
      continue;
    }
    try {
      const content = JSON.stringify(manifest.data, null, 2);
      const url = await uploadFile(token, basePath, manifest.name, content, 'application/json');
      results.push({ name: manifest.name, url, status: 'uploaded' });
      console.log(`[FRIDAY] Uploaded ${manifest.label} manifest:`, manifest.name);
    } catch(e) {
      console.warn(`[FRIDAY] Failed to upload ${manifest.name}:`, e.message);
      results.push({ name: manifest.name, status: 'failed', error: e.message });
    }
  }

  console.log(`[FRIDAY] Phase 1 manifests: ${results.filter(r => r.status === 'uploaded').length}/${manifests.length} uploaded`);
  return { uploaded: results.filter(r => r.status === 'uploaded').length, results };
}

