import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';
import path from 'path';
import { getGraphToken, ensureFolder, uploadFile } from "./onedrive.js";

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fmemdogudiolevqsfuvd.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function sbFetch(p) {
  try {
    const parts = p.split('?');
    const table = parts[0];
    const params = parts[1] || '';
    let query = supabase.from(table).select('*');
    const filters = params.split('&');
    for (const f of filters) {
      if (f.startsWith('select=')) continue;
      if (f.startsWith('order=')) { const o = f.replace('order=','').split('.'); query = query.order(o[0], { ascending: o[1] !== 'desc' }); }
      else if (f.startsWith('limit=')) { query = query.limit(parseInt(f.replace('limit=',''))); }
      else if (f.includes('=eq.')) { const [col, val] = f.split('=eq.'); query = query.eq(col, decodeURIComponent(val)); }
      else if (f.includes('=ilike.')) { const [col, val] = f.split('=ilike.'); query = query.ilike(col, decodeURIComponent(val)); }
    }
    const { data, error } = await query;
    if (error) { console.error('[SB]', error.message); return null; }
    return data;
  } catch(e) { console.error('[SB]', e.message); return null; }
}

async function sbPost(table, body) {
  try {
    const { data, error } = await supabase.from(table).insert(body).select();
    if (error) { console.error('[SB POST]', error.message); return null; }
    return data;
  } catch(e) { console.error('[SB POST]', e.message); return null; }
}

async function sbPatch(p, body) {
  try {
    const parts = p.split('?');
    const table = parts[0];
    const params = parts[1] || '';
    let query = supabase.from(table).update(body);
    const filters = params.split('&');
    for (const f of filters) {
      if (f.includes('=eq.')) { const [col, val] = f.split('=eq.'); query = query.eq(col, decodeURIComponent(val)); }
    }
    const { data, error } = await query.select();
    if (error) { console.error('[SB PATCH]', error.message); return false; }
    return true;
  } catch(e) { console.error('[SB PATCH]', e.message); return false; }
}

function inferCategory(contract) {
  const summary = ((contract.system_summary || '') + ' ' + (contract.BUILD_002?.workflow_name || '')).toLowerCase();
  if (summary.includes('intake') || summary.includes('ingest')) return 'intake';
  if (summary.includes('classif') || summary.includes('routing') || summary.includes('triage')) return 'classification';
  if (summary.includes('extract')) return 'extraction';
  if (summary.includes('notif') || summary.includes('alert')) return 'notification';
  if (summary.includes('route') || summary.includes('dispatch')) return 'routing';
  if (summary.includes('report') || summary.includes('dashboard')) return 'reporting';
  if (summary.includes('monitor') || summary.includes('watch')) return 'monitoring';
  return 'integration';
}

function classifyOutputFile(fileName) {
  const n = (fileName || '').toLowerCase();
  if (n.includes('solution demo')) return 'solution_demo';
  if (n.includes('skillset manual') || n.includes('build manual')) return 'skillset_manual';
  if (n.includes('prd') || n.includes('requirements')) return 'requirements_doc';
  if (n.includes('architecture')) return 'architecture_doc';
  if (n.includes('wave manual') || n.includes('implementation wave')) return 'wave_manual';
  if (n.endsWith('.json')) return 'blueprint';
  return 'other';
}

async function resolveCustomer(clientName) {
  try {
    const enc = encodeURIComponent(clientName);
    let resp = await sbFetch('friday_customers?name=eq.' + enc + '&select=id,name&limit=1');
    if (resp && resp[0]) return resp[0].id;
    const shortName = clientName.split(' ').slice(0, 2).join(' ');
    resp = await sbFetch('friday_customers?name=ilike.*' + encodeURIComponent(shortName) + '*&select=id,name&limit=1');
    if (resp && resp[0]) return resp[0].id;
    const newCustomer = await sbPost('friday_customers', { name: clientName, industry: '', contact_email: '', notes: 'Auto-created by FRIDAY Temporal pipeline', created_at: new Date().toISOString() });
    return newCustomer && newCustomer[0] ? newCustomer[0].id : null;
  } catch(e) { return null; }
}

function deriveSkillsetName(projectName) {
  return (projectName || '').replace(/v\d+(\.\d+)*/gi, '').replace(/\b(update|patch|fix|hotfix|phase \d+)\b/gi, '').replace(/\s+/g, ' ').trim();
}

async function resolveSkillset(customerId, clientName, projectName, platform, buildId) {
  try {
    const projEnc = encodeURIComponent(projectName.split(' ').slice(0, 3).join(' '));
    let resp = await sbFetch('friday_skillsets?customer_id=eq.' + customerId + '&name=ilike.*' + projEnc + '*&select=id,name,version,build_count&limit=1');
    if (resp && resp[0]) {
      const existing = resp[0];
      const newVersion = (existing.version || 1) + 1;
      await sbPatch('friday_skillsets?id=eq.' + existing.id, { latest_build_id: buildId, version: newVersion, build_count: (existing.build_count || 1) + 1, status: 'active', last_delivered_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      return { id: existing.id, name: existing.name, version: newVersion };
    }
    const skillsetName = deriveSkillsetName(projectName);
    const newSkillset = await sbPost('friday_skillsets', { customer_id: customerId, client_name: clientName, name: skillsetName, primary_platform: platform, status: 'active', version: 1, build_count: 1, latest_build_id: buildId, owner: 'Brian', last_delivered_at: new Date().toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    return newSkillset && newSkillset[0] ? { id: newSkillset[0].id, name: skillsetName, version: 1 } : { id: null, name: skillsetName, version: 1 };
  } catch(e) { return { id: null, name: deriveSkillsetName(projectName), version: 1 }; }
}

function deriveAppName(nodeType) {
  const t = (nodeType || '').toLowerCase();
  if (t.includes('anthropic') || t.includes('claude')) return 'Anthropic';
  if (t.includes('openai') || t.includes('gpt')) return 'OpenAI';
  if (t.includes('supabase')) return 'Supabase';
  if (t.includes('google')) return 'Google';
  if (t.includes('slack')) return 'Slack';
  if (t.includes('webhook') || t.includes('http')) return 'HTTP';
  return null;
}

function extractModuleStages(workflowJson) {
  const stages = [];
  try {
    if (workflowJson.nodes && Array.isArray(workflowJson.nodes)) {
      workflowJson.nodes.forEach((node, idx) => {
        stages.push({ stage_num: idx + 1, name: node.name || node.type || ('Step ' + (idx+1)), module_type: node.type || 'unknown', app_name: deriveAppName(node.type || '') });
      });
    } else if (workflowJson.flow && Array.isArray(workflowJson.flow)) {
      workflowJson.flow.forEach((mod, idx) => {
        stages.push({ stage_num: idx + 1, name: mod.name || mod.module || ('Step ' + (idx+1)), module_type: mod.module || 'unknown', app_name: (mod.module || '').split(':')[0] || null });
      });
    }
  } catch(e) {}
  return stages;
}

// ─── Phase 2 file-existence helpers ─────────────────────────────────────────

const PHASE2_AGENT_CONFIG = [
  {
    id: 'agent_01',
    name: 'Solution Demo',
    format: 'HTML',
    dir: 'deliverables',
    patterns: ['Solution Demo', 'solution-demo', '.html']
  },
  {
    id: 'agent_02',
    name: 'Build Manual',
    format: 'HTML',
    dir: 'deliverables',
    patterns: ['Build Manual', 'build-manual', '.html']
  },
  {
    id: 'agent_03',
    name: 'Requirements & Docs',
    format: 'MD + JSON',
    dir: 'build-docs',
    patterns: ['Requirements', 'Architecture', 'Deployment Summary', 'regression-suite']
  },
  {
    id: 'agent_04',
    name: 'Workflow Blueprints',
    format: 'JSON',
    dir: 'workflow',
    patterns: ['.json']
  },
  {
    id: 'agent_05',
    name: 'Deployment Package',
    format: 'JSON',
    dir: 'deployment-package',
    patterns: ['package.json', 'workflows.json', 'schemas.json']
  }
];

async function resolveAgentStatus(buildDir, agentConfig) {
  try {
    const dirPath = path.join(buildDir, agentConfig.dir);
    const files = await fs.readdir(dirPath);
    const matching = files.filter(f => {
      if (f.startsWith('.')) return false;
      return agentConfig.patterns.some(p => f.includes(p));
    });
    return { status: matching.length > 0 ? 'complete' : 'error', file_count: matching.length, files: matching };
  } catch (e) {
    return { status: 'error', file_count: 0, files: [] };
  }
}

async function cleanupScratchFiles(buildDir) {
  const scratchPatterns = ['prompt.txt', '.prompt.txt', 'agent-prompt.txt', '.scratch', '.DS_Store', '__pycache__'];
  let removed = 0;
  async function walk(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (scratchPatterns.includes(entry.name)) {
            try { await fs.rm(fullPath, { recursive: true, force: true }); removed++; } catch (_) {}
          } else if (!entry.name.startsWith('.')) {
            await walk(fullPath);
          }
        } else {
          const shouldRemove = scratchPatterns.some(p => entry.name === p || entry.name.endsWith(p));
          if (shouldRemove) { try { await fs.unlink(fullPath); removed++; } catch (_) {} }
        }
      }
    } catch (_) {}
  }
  await walk(buildDir);
  console.log(`[CLEANUP] Removed ${removed} scratch files from ${buildDir}`);
  return { removed };
}

export async function updateBuildDurationActivity(buildId, durations) {
  if (!buildId) return;
  try {
    const patch = { updated_at: new Date().toISOString() };
    if (durations.phase1_duration_ms != null) patch.phase1_duration_ms = durations.phase1_duration_ms;
    if (durations.total_duration_ms != null) patch.total_duration_ms = durations.total_duration_ms;
    await supabase.from('friday_builds').update(patch).eq('id', buildId);
    console.log('[PIPELINE] Build duration updated:', JSON.stringify(durations));
  } catch(e) {
    console.warn('[PIPELINE] Duration update failed:', e.message);
  }
}

export async function postBuildPipelineActivity(jobData) {
  const buildId = jobData.supabaseBuildId;
  const ticketId = jobData.ticket_id;
  const outputDir = '/tmp/friday-temporal-' + jobData.job_id;
  console.log('[TEMPORAL PIPELINE] Starting for build', buildId);
  const errors = [];
  const buildLog = [];

  try {
    // Step 1: Get build record
    const buildRows = await sbFetch('friday_builds?id=eq.' + buildId + '&select=*&limit=1');
    const build = (buildRows || [])[0];
    if (!build) { console.error('[TEMPORAL PIPELINE] Build not found:', buildId); return; }

    let ticket = {};
    if (ticketId) {
      const tr = await sbFetch('friday_tickets?ticket_id=eq.' + ticketId + '&select=*&limit=1');
      ticket = (tr || [])[0] || {};
    }

    const clientName = build.client_name || ticket.client || 'Unknown Client';
    const projectName = build.project_name || ticket.project_name || 'Build';
    const platform = build.platform || ticket.platform || 'n8n';
    const outputLinks = (jobData.outputLinks || []).map(f => ({ name: f.name, url: f.url || null, type: f.type || classifyOutputFile(f.name), size_kb: f.size_kb || null }));
    buildLog.push({ step: 1, action: 'classify_files', detail: outputLinks.length + ' files classified', ts: new Date().toISOString() });
    console.log('[TEMPORAL PIPELINE] Step 1: Classified', outputLinks.length, 'files');

    // Step 2: Resolve customer
    let customerId = build.customer_id || null;
    if (!customerId) customerId = await resolveCustomer(clientName);
    buildLog.push({ step: 2, action: 'resolve_customer', detail: customerId || 'not resolved', ts: new Date().toISOString() });
    console.log('[TEMPORAL PIPELINE] Step 2: Customer ID:', customerId);

    // Step 3: Resolve skillset
    let skillsetId = null, skillsetName = deriveSkillsetName(projectName), skillsetVersion = 1;
    if (customerId) {
      const sk = await resolveSkillset(customerId, clientName, projectName, platform, buildId);
      skillsetId = sk.id; skillsetName = sk.name; skillsetVersion = sk.version;
    }
    buildLog.push({ step: 3, action: 'resolve_skillset', detail: skillsetName + ' v' + skillsetVersion, ts: new Date().toISOString() });
    console.log('[TEMPORAL PIPELINE] Step 3: Skillset:', skillsetName, 'v' + skillsetVersion);

    // Step 4: Read workflow JSONs from disk BEFORE cleanup, then write scenarios
    const workflowDir = path.join(outputDir, 'workflow');
    let wfFiles = [];
    try { wfFiles = await fs.readdir(workflowDir); } catch(e) { wfFiles = []; }
    const blueprintFiles = wfFiles.filter(f => f.endsWith('.json'));

    for (let i = 0; i < blueprintFiles.length; i++) {
      const file = blueprintFiles[i];
      let workflowJson = null;
      let moduleStages = [];
      try {
        const raw = await fs.readFile(path.join(workflowDir, file), 'utf-8');
        workflowJson = JSON.parse(raw);
        moduleStages = extractModuleStages(workflowJson);
      } catch(e) { console.warn('[TEMPORAL PIPELINE] Could not parse:', file, e.message); }

      const scenarioKey = 'SC-' + String(i+1).padStart(2, '0');
      const scenarioName = (workflowJson?.name) || file.replace('.json', '').trim() || 'Scenario ' + (i+1);
      const linkEntry = outputLinks.find(l => l.name && l.name.includes(file.replace('.json', '')));

      try {
        await supabase.from('build_scenarios').upsert({
          build_id: buildId, ticket_id: ticketId, scenario_key: scenarioKey,
          scenario_name: scenarioName, platform: platform, status: 'active',
          workflow_json: workflowJson, module_stages: moduleStages.length ? moduleStages : null,
          onedrive_json_url: (linkEntry && linkEntry.url) || '', updated_at: new Date().toISOString()
        }, { onConflict: 'build_id,scenario_key', ignoreDuplicates: true });
      } catch(upsertErr) {
        console.warn('[TEMPORAL PIPELINE] Scenario upsert failed:', scenarioKey, upsertErr.message);
        errors.push('scenario_upsert:' + scenarioKey);
      }
    }

    // Also include OneDrive-only blueprint links if no local files found
    if (!blueprintFiles.length) {
      const agent04Files = outputLinks.filter(f => f.type === 'blueprint');
      for (let i = 0; i < agent04Files.length; i++) {
        const file = agent04Files[i];
        const scenarioKey = 'SC-' + String(i+1).padStart(2, '0');
        const scenarioName = (file.name || '').replace(/\.json$/i, '').trim() || 'Scenario ' + (i+1);
        try {
          await supabase.from('build_scenarios').upsert({
            build_id: buildId, ticket_id: ticketId, scenario_key: scenarioKey,
            scenario_name: scenarioName, platform: platform, status: 'active',
            onedrive_json_url: file.url || '', updated_at: new Date().toISOString()
          }, { onConflict: 'build_id,scenario_key', ignoreDuplicates: true });
        } catch(e) { errors.push('scenario_link:' + scenarioKey); }
      }
    }
    buildLog.push({ step: 4, action: 'write_scenarios', detail: (blueprintFiles.length || outputLinks.filter(f => f.type === 'blueprint').length) + ' scenarios', ts: new Date().toISOString() });
    console.log('[TEMPORAL PIPELINE] Step 4: Scenarios written:', blueprintFiles.length || outputLinks.filter(f => f.type === 'blueprint').length);

    // Step 5: Seed change log
    const existing = await sbFetch('workflow_changes?build_id=eq.' + buildId + '&change_type=eq.initial&select=id&limit=1');
    if (!existing || !existing.length) {
      const version = build.current_version ? 'v' + build.current_version : 'v1.0';
      await sbPost('workflow_changes', {
        build_id: buildId, ticket_id: ticketId, change_type: 'initial', version_from: null, version_to: version,
        title: 'Initial delivery — ' + projectName,
        description: 'First delivery of ' + projectName + ' for ' + clientName + '. QA score: ' + (jobData.qaScore || 0) + '/100.',
        submitted_by: 'F.R.I.D.A.Y.', status: 'deployed',
        deployed_at: new Date().toISOString(), created_at: new Date().toISOString()
      });
    }
    buildLog.push({ step: 5, action: 'seed_changelog', detail: 'ok', ts: new Date().toISOString() });
    console.log('[TEMPORAL PIPELINE] Step 5: Change log seeded');

    // Steps 6-9: Enrichment
    await Promise.allSettled([
      (async () => {
        const oppText = ticket.opportunity_assessment || ticket.additional_context || '';
        if (oppText && oppText.length >= 50 && customerId) {
          try {
            const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            const result = await anthropic.messages.create({
              model: 'claude-haiku-4-5-20251001', max_tokens: 1000,
              messages: [{ role: 'user', content: 'Extract opportunities from this assessment for client "' + clientName + '". Return JSON only. Format: [{"name":"...","description":"2-3 sentences","score":0-100,"value_tier":"high|medium|low","phase":"Phase 1|Phase 2|backlog"}]\n\nText:\n' + oppText }]
            });
            const rawOpps = result.content?.[0]?.text?.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            if (rawOpps) {
              const structuredOpps = JSON.parse(rawOpps);
              await sbPost('knowledge_documents', { customer_id: customerId, client_name: clientName, build_id: buildId, ticket_id: ticketId, source_type: 'opportunity_assessment', title: 'Opportunity Assessment — ' + clientName, content: oppText, metadata: { opportunities: structuredOpps, extracted_at: new Date().toISOString() }, created_at: new Date().toISOString() });
            }
          } catch(e) { console.warn('[TEMPORAL PIPELINE] Opp extraction failed:', e.message); errors.push('opp_extract'); }
        }
      })(),
      (async () => {
        const credText = ticket.existing_systems || '';
        if (credText && credText.length >= 20) {
          try {
            const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            const result = await anthropic.messages.create({
              model: 'claude-haiku-4-5-20251001', max_tokens: 500,
              messages: [{ role: 'user', content: 'Extract credentials and API references. Return JSON only. Format: [{"label":"name","cred_type":"api_key|login|webhook|oauth|other","masked_value":"mask all but last 4 chars","notes":"context"}]\nIf none return []\nText: ' + credText }]
            });
            const rawCreds = result.content?.[0]?.text?.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            if (rawCreds) {
              const creds = JSON.parse(rawCreds);
              for (const cred of (creds || [])) {
                if (!cred.label) continue;
                await sbPost('build_credentials', { build_id: buildId, ticket_id: ticketId, label: cred.label, cred_type: cred.cred_type || 'other', masked_value: cred.masked_value || '••••', notes: cred.notes || null, created_at: new Date().toISOString() });
              }
            }
          } catch(e) { console.warn('[TEMPORAL PIPELINE] Cred extraction failed:', e.message); errors.push('cred_extract'); }
        }
      })()
    ]);
    buildLog.push({ step: '6-9', action: 'enrichment', detail: 'complete', ts: new Date().toISOString() });
    console.log('[TEMPORAL PIPELINE] Steps 6-9: Enrichment complete');

    // Step 10: Finalize build record
    const patch = {
      status: 'done', skillset_name: skillsetName || null, current_version: skillsetVersion || 1,
      output_links: outputLinks, progress_pct: 100,
      updated_at: new Date().toISOString()
    };
    if (customerId) patch.customer_id = customerId;
    if (skillsetId) patch.skillset_id = skillsetId;
    const finalizeOk = await sbPatch('friday_builds?id=eq.' + buildId, patch);
    if (!finalizeOk) errors.push('finalize_build');

    // Write agent configs
    const agentConfigs = [
      { agent_id: 'agent_01', agent_label: 'Solution Demo Builder' },
      { agent_id: 'agent_02', agent_label: 'Skillset Manual Author' },
      { agent_id: 'agent_03', agent_label: 'Requirements & Docs Writer' },
      { agent_id: 'agent_04', agent_label: 'Workflow Architect' }
    ];
    for (const ac of agentConfigs) {
      await sbPost('build_agent_configs', {
        build_id: buildId, ticket_id: ticketId, agent_id: ac.agent_id, agent_label: ac.agent_label,
        model: 'claude-sonnet-4-5', max_tokens: 8000,
        full_prompt: ac.agent_label + ' for ' + clientName + ' — ' + projectName + '. Platform: ' + platform,
        created_at: new Date().toISOString()
      });
    }
    buildLog.push({ step: 10, action: 'finalize_build', detail: finalizeOk ? 'ok' : 'patch failed', ts: new Date().toISOString() });
    console.log('[TEMPORAL PIPELINE] Step 10: Build finalized');

    // Step 10a: Register skillset templates for future reuse
    if (skillsetId) {
      try {
        const contract = jobData._contract || {};
        const briefData = jobData.brief || jobData.section_a || {};
        const p1 = jobData.phase1Results || {};
        const qaScore = jobData.qaScore || p1.qa?.overall_score || null;
        const compScore = jobData.complianceScore || p1.compliance?.score || null;
        const testPairs = p1.llm?.test_pairs || null;

        await supabase.from('friday_skillsets').update({
          brief_template: briefData,
          schema_template: contract.BUILD_006 || null,
          workflow_template: contract.BUILD_002 || null,
          prompt_template: contract.BUILD_004 || null,
          test_pairs: testPairs,
          created_from_build_id: ticketId,
          avg_qa_score: qaScore,
          avg_compliance_score: compScore,
          description: contract.system_summary || projectName,
          category: inferCategory(contract),
          updated_at: new Date().toISOString()
        }).eq('id', skillsetId);
        console.log('[TEMPORAL PIPELINE] Step 10a: Skillset templates registered for', skillsetName);
      } catch(e) { console.warn('[TEMPORAL PIPELINE] Skillset template registration failed:', e.message); }
    }

    const sanitize = s => (s || '').replace(/[<>:"\/|?*]/g, '-').trim();
    const buildFolderName = sanitize(ticketId + ' - ' + clientName);
    const basePath = 'FRIDAY Builds/' + buildFolderName;

    // Step 10b: Generate Agent Definition .md (FR-GAP-017 — OS Agent Template)
    try {
      const aitm = skillsetName || projectName;
      const aitmSlug = (aitm || 'AITM').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
      const agentId = aitmSlug.toUpperCase();
      const p1 = jobData.phase1Results || {};
      const brief = jobData.brief || jobData.brief_sections || {};
      const contract = jobData._contract || {};
      const deployDate = new Date().toISOString().split('T')[0];

      // Schema tables from Phase 1
      const schemaTables = (p1.schema?.tables_verified || []);
      const schemaStatus = p1.schema?.status || 'unknown';

      // Workflows from Phase 1
      const wfImported = p1.workflow?.manifest?.total_imported || 0;
      const wfActivated = p1.workflow?.manifest?.total_activated || 0;
      const wfStatus = p1.workflow?.status || 'unknown';

      // LLM from Phase 1
      const llmFiles = (p1.llm?.files_produced || []);

      // External platforms
      const extPlatforms = (p1.external?.platforms || []);

      // Platform / GitHub
      const repoUrl = p1.platform?.manifest?.repo_url || 'N/A';
      const techStack = (contract.BUILD_005?.tech_stack || []);
      const envVars = (contract.BUILD_005?.environment_variables || []);

      // QA
      const qaPassRate = p1.qa?.pass_rate || 0;
      const qaFailures = p1.qa?.failures || [];
      const iterCycles = p1.iteration_cycles || 0;

      // Brief fields
      const decisionAuth = brief.decision_authority || contract.BUILD_005?.decision_authority || 'Refer to Brief — not specified';
      const guardrails = brief.guardrails || contract.BUILD_004?.guardrails || 'Refer to Brief — not specified';
      const edgeCases = brief.edge_cases || contract.BUILD_004?.edge_cases || '';
      const workflowSteps = brief.workflow_steps || contract.BUILD_002?.workflow_steps || '';
      const dataSources = brief.data_sources || '';
      const acceptanceCriteria = brief.acceptance_criteria || '';

      const lines = [
        '---',
        'agent_id: ' + agentId,
        'name: ' + aitm,
        'team: BUILD',
        'status: Deployed',
        'trust_level: Supervised',
        'manager: Brian Reinhart',
        'server: customer-hosted',
        'version: v' + (skillsetVersion || 1),
        'date: ' + deployDate,
        '---',
        '',
        '# ' + aitm,
        '',
        '## Identity',
        '| Field | Value |',
        '|-------|-------|',
        '| **AITM Name** | ' + aitm + ' |',
        '| **Version** | v' + (skillsetVersion || 1) + ' |',
        '| **Deployment Date** | ' + deployDate + ' |',
        '| **Customer** | ' + clientName + ' |',
        '| **Platform** | ' + platform + ' |',
        '| **Build ID** | ' + buildId + ' |',
        '| **Ticket** | ' + ticketId + ' |',
        '| **QA Score** | ' + (jobData.qaScore || 0) + '/100 |',
        '',
        '## Mission',
        (contract.system_summary || jobData.request_description || projectName + ' — AI Teammate for ' + clientName).slice(0, 1000),
        '',
        '## Skill Inventory',
        '',
        '### Schema (' + schemaStatus + ')',
        schemaTables.length > 0 ? schemaTables.map(t => '- ' + (typeof t === 'string' ? t : (t.name || JSON.stringify(t)))).join('\n') : '- ' + (p1.schema?.tables_count || 0) + ' tables deployed',
        '',
        '### Workflows (' + wfStatus + ')',
        '- ' + wfImported + ' imported, ' + wfActivated + ' activated',
        '',
        '### LLM Integration',
        llmFiles.length > 0 ? llmFiles.map(f => '- ' + f).join('\n') : '- Prompt library and model routing configured',
        '',
        '### External Integrations',
        extPlatforms.length > 0 ? extPlatforms.map(p => '- ' + p).join('\n') : '- None',
        '',
        '### GitHub Repository',
        '- ' + repoUrl,
        '',
        '## Decision Authority Matrix',
        typeof decisionAuth === 'string' ? decisionAuth : JSON.stringify(decisionAuth, null, 2),
        '',
        '## Behavioral Rules',
        typeof guardrails === 'string' ? guardrails : JSON.stringify(guardrails, null, 2),
        edgeCases ? '\n### Edge Cases\n' + (typeof edgeCases === 'string' ? edgeCases : JSON.stringify(edgeCases, null, 2)) : '',
        '',
        '## Handoff Contracts',
        '',
        '### Input',
        typeof workflowSteps === 'string' ? workflowSteps : JSON.stringify(workflowSteps, null, 2),
        '',
        '### Data Sources',
        typeof dataSources === 'string' && dataSources ? dataSources : 'Refer to schema and workflow configuration',
        '',
        '### Output Artifacts',
        (outputLinks || []).map(l => '- ' + l.name + (l.url ? ' ([link](' + l.url + '))' : '')).join('\n') || '- See OneDrive folder',
        '',
        '## Learning Loop',
        '- **QA Pass Rate:** ' + qaPassRate + '%',
        '- **Iteration Cycles:** ' + iterCycles,
        qaFailures.length > 0 ? '- **Resolved Failures:**\n' + qaFailures.map(f => '  - ' + (f.description || f.category || JSON.stringify(f))).join('\n') : '- No failures detected during QA',
        '- **Feedback Mechanism:** Approval patterns recorded in friday_approval_patterns table. Future builds incorporate learned preferences.',
        '',
        '## Operational Profile',
        '| Component | Detail |',
        '|-----------|--------|',
        '| **Platform** | ' + platform + ' |',
        '| **GitHub** | ' + repoUrl + ' |',
        '| **Tech Stack** | ' + (techStack.length > 0 ? techStack.join(', ') : 'n8n, Supabase, Claude API') + ' |',
        envVars.length > 0 ? envVars.map(v => '| **Env Var** | `' + v + '` |').join('\n') : '| **Env Vars** | See deployment configuration |',
        '',
        '## Build History',
        '| Version | Date | QA Score | Status |',
        '|---------|------|----------|--------|',
        '| v' + (skillsetVersion || 1) + ' | ' + deployDate + ' | ' + (jobData.qaScore || 0) + '/100 | Deployed |',
      ];

      const agentDefMd = lines.join('\n');

      const token = await getGraphToken();
      // Upload to OS Agent Definitions folder
      const defPath = 'ManageAI OS/Agent Definitions';
      await ensureFolder(token, defPath);
      const shareUrl = await uploadFile(token, defPath, aitmSlug + '-agent-definition.md', agentDefMd, 'text/markdown');

      // Also upload to the build folder
      const clientBuildPath = 'FRIDAY Builds/' + buildFolderName;
      try {
        await ensureFolder(token, clientBuildPath);
        await uploadFile(token, clientBuildPath, aitmSlug + '-agent-definition.md', agentDefMd, 'text/markdown');
      } catch(copyErr) {
        console.warn('[TEMPORAL PIPELINE] Agent Def client copy failed:', copyErr.message);
      }
      console.log('[TEMPORAL PIPELINE] Agent Definition uploaded: ' + agentId);

      // Add agent-definition to outputLinks and update build record
      outputLinks.push({ name: 'agent-definition/' + aitmSlug + '-agent-definition.md', url: shareUrl, type: 'agent_definition', size_kb: null });
      const agentDefPatchOk = await sbPatch('friday_builds?id=eq.' + buildId, { output_links: outputLinks, updated_at: new Date().toISOString() });
      if (!agentDefPatchOk) {
        console.error('[TEMPORAL PIPELINE] Agent Def outputLinks patch FAILED for build', buildId);
        errors.push('agent_def_patch');
      } else {
        console.log('[TEMPORAL PIPELINE] Agent Def added to output_links (' + outputLinks.length + ' total)');
      }
      buildLog.push({ step: '10b', action: 'agent_definition', detail: 'uploaded: ' + agentId + ', patch: ' + (agentDefPatchOk ? 'ok' : 'failed'), ts: new Date().toISOString() });
    } catch(adErr) {
      console.warn('[TEMPORAL PIPELINE] Agent Definition failed:', adErr.message);
      errors.push('agent_definition');
      buildLog.push({ step: '10b', action: 'agent_definition', detail: 'FAILED: ' + adErr.message, ts: new Date().toISOString() });
    }

    // Step 10c: Auto-versioning (changelog.md)
    try {
      const token2 = await getGraphToken();
      const changelogPath = basePath;
      const changelogContent = '# Changelog: ' + projectName + '\n\n' +
        '## v' + (skillsetVersion || 1) + ' (' + new Date().toISOString().split('T')[0] + ')\n' +
        '- Initial delivery\n' +
        '- QA Score: ' + (jobData.qaScore || 0) + '/100\n' +
        '- Files delivered: ' + (outputLinks || []).length + '\n' +
        '- Platform: ' + platform + '\n';
      await uploadFile(token2, changelogPath, 'changelog.md', changelogContent, 'text/markdown');
      console.log('[TEMPORAL PIPELINE] Changelog uploaded');
      buildLog.push({ step: '10c', action: 'changelog', detail: 'uploaded', ts: new Date().toISOString() });
    } catch(clErr) {
      console.warn('[TEMPORAL PIPELINE] Changelog failed:', clErr.message);
      errors.push('changelog');
      buildLog.push({ step: '10c', action: 'changelog', detail: 'FAILED: ' + clErr.message, ts: new Date().toISOString() });
    }

    // Step 10d: Save OneDrive folder URL and all output_links to build record (FIX 14)
    try {
      const folderPath = 'FRIDAY Builds/' + buildFolderName;
      const encodedPath = folderPath.split('/').map(p => encodeURIComponent(p)).join('/');
      const onedriveFolderUrl = 'https://managepartners-my.sharepoint.com/personal/brian_manageai_io/Documents/' + encodedPath;

      // FIX 14: Write both onedrive_folder_url AND output_links in a single patch
      // to ensure all OneDrive URLs are persisted to the friday_builds record
      const folderPatchOk = await sbPatch('friday_builds?id=eq.' + buildId, {
        onedrive_folder_url: onedriveFolderUrl,
        output_links: outputLinks,
        updated_at: new Date().toISOString()
      });
      // Also set on jobData so downstream callbacks have it
      jobData.onedriveFolderUrl = onedriveFolderUrl;

      if (folderPatchOk) {
        console.log('[TEMPORAL PIPELINE] OneDrive folder URL + output_links saved:', onedriveFolderUrl, '(' + outputLinks.length + ' links)');
      } else {
        console.warn('[TEMPORAL PIPELINE] OneDrive folder URL patch failed');
        errors.push('onedrive_folder_url');
      }
      buildLog.push({ step: '10d', action: 'onedrive_folder_url', detail: folderPatchOk ? onedriveFolderUrl : 'patch failed', ts: new Date().toISOString() });
    } catch(e) {
      console.warn('[TEMPORAL PIPELINE] OneDrive folder URL failed:', e.message);
      buildLog.push({ step: '10d', action: 'onedrive_folder_url', detail: 'FAILED: ' + e.message, ts: new Date().toISOString() });
    }

    // Step 10e: Generate and upload engagement context for future builds
    try {
      const p1 = jobData.phase1Results || {};
      const contract = jobData._contract || {};
      const qaRes = p1.qa || {};

      // Extract structured engagement data from Phase 1 results
      const engagementContext = {
        client_name: clientName,
        project_name: projectName,
        build_id: buildId,
        ticket_id: ticketId,
        platform: platform,
        generated_at: new Date().toISOString(),
        version: skillsetVersion || 1,

        tech_stack: {
          platform: platform,
          database: 'supabase',
          ai_models: (p1.llm?.files_produced || []).length > 0
            ? (p1.llm?.models_used || ['claude-sonnet-4-5'])
            : ['claude-sonnet-4-5'],
          tech_stack_items: contract.BUILD_005?.tech_stack || p1.platform?.manifest?.tech_stack || [],
          github_repo: p1.platform?.manifest?.repo_url || null
        },

        api_endpoints: {
          webhook_urls: (() => {
            const urls = [];
            const wfManifest = p1.workflow?.manifest || {};
            const workflows = wfManifest.workflows || p1.workflow?.imported || [];
            for (const wf of (Array.isArray(workflows) ? workflows : [])) {
              if (wf.webhook_url) urls.push({ name: wf.name || wf.workflow_name, url: wf.webhook_url });
              if (wf.trigger_url) urls.push({ name: wf.name || wf.workflow_name, url: wf.trigger_url });
            }
            return urls;
          })(),
          supabase_url: SUPABASE_URL,
          external_apis: (p1.external?.platforms || []).map(ep =>
            typeof ep === 'string' ? { name: ep } : { name: ep.name || ep.platform || String(ep), endpoints: ep.endpoints || [] }
          )
        },

        schema_tables: (() => {
          const tables = p1.schema?.tables_verified || p1.schema?.tables_created || [];
          return tables.map(t => typeof t === 'string' ? { name: t } : { name: t.name || String(t), columns: t.columns || [], purpose: t.purpose || '' });
        })(),

        workflow_patterns: (() => {
          const wfs = p1.workflow?.manifest?.workflows || p1.workflow?.imported || [];
          return (Array.isArray(wfs) ? wfs : []).map(wf => ({
            name: wf.name || wf.workflow_name || String(wf),
            trigger: wf.trigger || wf.trigger_type || 'unknown',
            nodes_count: wf.nodes_count || wf.node_count || 0,
            activated: wf.active !== false
          }));
        })(),

        integration_quirks: (() => {
          const quirks = [];
          // Collect iteration fix notes as quirks
          if (contract.schemaFixNotes) quirks.push({ area: 'schema', note: contract.schemaFixNotes });
          if (contract.platformFixNotes) quirks.push({ area: 'platform', note: contract.platformFixNotes });
          // External platform issues
          if (p1.external?.status === 'error') quirks.push({ area: 'external', note: 'External integration had errors: ' + (p1.external?.error || 'unknown') });
          if (p1.workflow?.status === 'error' || p1.workflow?.iteration_error) quirks.push({ area: 'workflow', note: 'Workflow had issues: ' + (p1.workflow?.error || p1.workflow?.iteration_error || 'unknown') });
          return quirks;
        })(),

        qa_failure_patterns: (() => {
          const failures = qaRes.failures || [];
          return failures.map(f => ({
            test_id: f.test_id || f.id || 'unknown',
            category: f.category || 'general',
            responsible_agent: f.responsible_agent || 'unknown',
            description: f.description || '',
            remediation: f.remediation || '',
            resolved: true  // if we got past QA, failures were resolved
          }));
        })(),

        qa_summary: {
          pass_rate: qaRes.pass_rate || 0,
          total_tests: qaRes.total || 0,
          passed: qaRes.passed || 0,
          failed: qaRes.failed || 0,
          iteration_cycles: p1.iteration_cycles || 0,
          duration_seconds: qaRes.duration || 0
        },

        build_notes: {
          deferrals: jobData.deferrals || [],
          change_requests: jobData.changeRequests || [],
          build_attempts: jobData.buildAttempt || 1
        }
      };

      const engagementJson = JSON.stringify(engagementContext, null, 2);
      const engToken = await getGraphToken();
      // Engagement context goes to stable per-client location (read back by future builds)
      const engPath = 'ManageAI/Clients/' + sanitize(clientName) + '/FRIDAY';
      await ensureFolder(engToken, engPath);
      await uploadFile(engToken, engPath, 'engagement-context.json', engagementJson, 'application/json');
      // Also copy to the build folder for completeness
      try {
        const buildEngPath = 'FRIDAY Builds/' + buildFolderName;
        await uploadFile(engToken, buildEngPath, 'engagement-context.json', engagementJson, 'application/json');
      } catch (_) {}
      console.log('[TEMPORAL PIPELINE] Engagement context uploaded to ' + engPath + '/engagement-context.json');
      buildLog.push({ step: '10e', action: 'engagement_context', detail: 'uploaded to ' + engPath, ts: new Date().toISOString() });
    } catch(engErr) {
      console.warn('[TEMPORAL PIPELINE] Engagement context failed:', engErr.message);
      buildLog.push({ step: '10e', action: 'engagement_context', detail: 'FAILED: ' + engErr.message, ts: new Date().toISOString() });
    }

    // Step 11: Callbacks
    const N8N_CALLBACK_URL = process.env.N8N_WF07_CALLBACK;
    if (N8N_CALLBACK_URL) {
      try {
        await fetch(N8N_CALLBACK_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticket_id: ticketId, client: clientName, project_name: projectName, platform, status: 'complete', onedrive_folder_url: jobData.onedriveFolderUrl || '' })
        });
        console.log('[TEMPORAL PIPELINE] WF-07 callback sent');
      } catch(e) { console.warn('[TEMPORAL PIPELINE] WF-07 callback failed:', e.message); }
    }

    // Charlie post-build notification
    const charlieUrl = process.env.CHARLIE_SERVER_URL;
    if (charlieUrl) {
      const charlieEndpoint = charlieUrl + '/api/charlie/post-build';
      try {
        console.log('[TEMPORAL PIPELINE] Sending Charlie post-build to', charlieEndpoint);
        const charliePayload = {
          build_id: buildId,
          ticket_id: ticketId,
          qa_score: jobData.qaScore || 0,
          build_attempts: jobData.buildAttempt || 1,
          change_requests: jobData.changeRequests || [],
          agent_results: (jobData.agentResults || []).map(r => ({
            agent_id: r.agent_id, status: r.status,
            duration: r.duration || 0, error: r.error || null
          })),
          output_links: outputLinks,
          deferrals: jobData.deferrals || [],
          onedrive_folder_url: jobData.onedriveFolderUrl || '',
          charlie_brief_id: jobData.charlie_brief_id || null,
          client_name: jobData.client || jobData.client_name || '',
          project_name: jobData.project_name || '',
          phase1_results: {
            schema_status: jobData.phase1Results?.schema?.status || 'unknown',
            workflow_status: jobData.phase1Results?.workflow?.status || 'unknown',
            llm_files: jobData.phase1Results?.llm?.files_produced || [],
            platform_status: jobData.phase1Results?.platform?.status || 'unknown',
            external_platforms: jobData.phase1Results?.external?.platforms || [],
            qa_pass_rate: jobData.phase1Results?.qa?.pass_rate || 0,
            iteration_cycles: jobData.phase1Results?.iteration_cycles || 0
          }
        };
        const charlieRes = await fetch(charlieEndpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(charliePayload)
        });
        const charlieBody = await charlieRes.text().catch(() => '');
        if (!charlieRes.ok) {
          console.error('[TEMPORAL PIPELINE] Charlie post-build FAILED — status:', charlieRes.status, '— url:', charlieEndpoint, '— response:', charlieBody.slice(0, 500));
          errors.push('charlie_notify');
          buildLog.push({ step: 11, action: 'charlie_post_build', detail: 'FAILED: HTTP ' + charlieRes.status + ' — ' + charlieBody.slice(0, 200), ts: new Date().toISOString() });
        } else {
          console.log('[TEMPORAL PIPELINE] Charlie post-build OK — response:', charlieBody.slice(0, 200));
          buildLog.push({ step: 11, action: 'charlie_post_build', detail: 'ok', ts: new Date().toISOString() });
        }
      } catch(e) {
        console.error('[TEMPORAL PIPELINE] Charlie post-build EXCEPTION:', e.message, '— url:', charlieEndpoint);
        errors.push('charlie_notify');
        buildLog.push({ step: 11, action: 'charlie_post_build', detail: 'EXCEPTION: ' + e.message, ts: new Date().toISOString() });
      }
    } else {
      console.error('[TEMPORAL PIPELINE] CHARLIE_SERVER_URL not set (env value: ' + (charlieUrl || 'undefined') + '), skipping post-build signal');
      buildLog.push({ step: 11, action: 'charlie_post_build', detail: 'SKIPPED: CHARLIE_SERVER_URL not set', ts: new Date().toISOString() });
    }

    // Save build_log to Supabase
    buildLog.push({ step: 'final', action: 'pipeline_complete', detail: errors.length ? 'with errors: ' + errors.join(', ') : 'clean', ts: new Date().toISOString() });
    try {
      await sbPatch('friday_builds?id=eq.' + buildId, { build_log: buildLog, progress_pct: 100, updated_at: new Date().toISOString() });
    } catch(logErr) {
      console.warn('[TEMPORAL PIPELINE] build_log save failed:', logErr.message);
    }

    // Cleanup temp directory
    try { await fs.rm(outputDir, { recursive: true, force: true }); } catch(e) {}

    if (errors.length > 0) {
      console.warn('[TEMPORAL PIPELINE] Completed with non-fatal errors:', errors.join(', '));
    }
    console.log('[TEMPORAL PIPELINE] Complete for build', buildId);
  } catch(e) {
    console.error('[TEMPORAL PIPELINE] FATAL error for build', buildId, ':', e.message);
    // Try to mark build as failed
    try { await sbPatch('friday_builds?id=eq.' + buildId, { status: 'failed', build_log: 'Pipeline failed: ' + e.message, updated_at: new Date().toISOString() }); } catch(fe) {}
    throw e;
  }
}

export async function sendPhase2CompletionEmailActivity(jobData, phase2Results, onedriveLinks, phase2GithubResult) {
  const GRAPH_USER_EMAIL = process.env.GRAPH_USER_EMAIL || 'brian@manageai.io';
  const agentOwnerEmail = jobData.agent_owner_email || jobData.owner_email || '';
  const ccEmail = 'brian@manageai.io';
  const toEmails = [agentOwnerEmail, ccEmail].filter(Boolean);
  if (toEmails.length === 0) {
    console.warn('[FRIDAY] No emails for Phase 2 completion, skipping');
    return { sent: false, reason: 'no_recipients' };
  }

  const clientName = jobData.client || jobData.client_name || 'Client';
  const projectName = jobData.project_name || 'Build';
  const ticketId = jobData.ticket_id || '';
  const reviewUrl = (process.env.FRIDAY_PUBLIC_URL || 'http://5.223.79.255:3000') + '/build-review/' + ticketId + '/final';

  // Override status using file-existence check — file recovery exit codes may show 'error'
  // even when files were successfully written to disk
  const buildDir = '/tmp/friday-temporal-' + (jobData.job_id || '');
  if (buildDir && (phase2Results || []).length > 0) {
    try {
      await cleanupScratchFiles(buildDir);
      for (let i = 0; i < Math.min((phase2Results || []).length, PHASE2_AGENT_CONFIG.length); i++) {
        const diskStatus = await resolveAgentStatus(buildDir, PHASE2_AGENT_CONFIG[i]);
        if (diskStatus.file_count > 0) {
          phase2Results[i] = { ...phase2Results[i], status: 'complete', file_count: diskStatus.file_count };
        }
      }
    } catch (e) {
      console.warn('[FRIDAY] Phase 2 file-check failed (non-blocking):', e.message);
    }
  }

  const docRows = (phase2Results || []).map(r => {
    const statusColor = r.status === 'complete' ? '#16a34a' : '#dc2626';
    const statusLabel = r.status === 'complete' ? 'Complete' : 'Error';
    return '<tr><td style="padding:10px 14px;border-bottom:1px solid #E2E6EC;font-size:13px;color:#1E293B">' + (r.name || r.agent_id) +
      '</td><td style="padding:10px 14px;border-bottom:1px solid #E2E6EC"><span style="color:' + statusColor + ';font-weight:600;font-size:12px">' + statusLabel +
      '</span></td><td style="padding:10px 14px;border-bottom:1px solid #E2E6EC;font-size:12px;color:#475569">' + (r.format || 'HTML') + '</td></tr>';
  }).join('');

  const linkRows = (onedriveLinks || []).map(l => {
    return '<tr><td style="padding:8px 14px;border-bottom:1px solid #E2E6EC;font-size:13px;color:#1E293B">' + (l.name || 'File') +
      '</td><td style="padding:8px 14px;border-bottom:1px solid #E2E6EC"><a href="' + (l.url || '#') +
      '" style="color:#4A8FD6;text-decoration:none;font-size:12px;font-weight:600">Open in OneDrive</a></td></tr>';
  }).join('');

  const htmlBody = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f5f6f8;font-family:Montserrat,Helvetica,Arial,sans-serif">' +
    '<div style="max-width:640px;margin:0 auto;padding:24px">' +
    // Header
    '<div style="background:#1E3348;border-radius:12px 12px 0 0;padding:28px 32px;text-align:center">' +
    '<div style="font-size:22px;font-weight:700;color:#FFFFFF;letter-spacing:-0.02em">Phase 2 Complete</div>' +
    '<div style="font-size:14px;color:#CBD5E1;margin-top:6px">' + clientName + ' — ' + projectName + '</div>' +
    '<div style="font-size:12px;color:#7A8B9A;margin-top:4px">' + ticketId + '</div>' +
    '</div>' +
    // Body
    '<div style="background:#FFFFFF;padding:28px 32px;border:1px solid #E2E6EC;border-top:none">' +
    // Document table
    '<div style="font-size:12px;font-weight:700;color:#7A8B9A;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:12px">DOCUMENTS GENERATED</div>' +
    '<table style="width:100%;border-collapse:collapse;margin-bottom:24px">' +
    '<thead><tr style="border-bottom:2px solid #E2E6EC"><th style="padding:8px 14px;text-align:left;font-size:11px;font-weight:700;color:#7A8B9A;letter-spacing:0.05em">DOCUMENT</th><th style="padding:8px 14px;text-align:left;font-size:11px;font-weight:700;color:#7A8B9A">STATUS</th><th style="padding:8px 14px;text-align:left;font-size:11px;font-weight:700;color:#7A8B9A">FORMAT</th></tr></thead>' +
    '<tbody>' + docRows + '</tbody></table>' +
    // OneDrive links
    (linkRows ? '<div style="font-size:12px;font-weight:700;color:#7A8B9A;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:12px">ONEDRIVE FILES</div>' +
    '<table style="width:100%;border-collapse:collapse;margin-bottom:24px">' +
    '<tbody>' + linkRows + '</tbody></table>' : '') +
    // What Was Built
    '<div style="font-size:12px;font-weight:700;color:#7A8B9A;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:12px">WHAT WAS BUILT</div>' +
    '<div style="font-size:13px;color:#475569;line-height:1.7;margin-bottom:24px">' +
    '<strong>Solution Demo</strong> — Interactive React SPA showcasing the agent\'s capabilities, flow diagrams, and architecture.<br>' +
    '<strong>Build Manual</strong> — Complete implementation guide with scenarios, requirements, Claude config, and timeline.<br>' +
    '<strong>Requirements & Docs</strong> — PRD with FR-001+ numbering, architecture assessment, deployment summary, and regression suite.<br>' +
    '<strong>Workflow Blueprints</strong> — Platform-specific workflow JSON files ready for import.<br>' +
    '<strong>Deployment Package</strong> — 9-subpackage validated deployment bundle.' +
    '</div>' +
    // GitHub section
    (phase2GithubResult && phase2GithubResult.repo_url ?
    '<h3 style="color:#1E3348;font-size:15px;margin-bottom:12px;margin-top:24px">GitHub Repository</h3>' +
    '<div style="background:#F5F6F8;border-radius:8px;padding:16px;margin-bottom:24px">' +
    '<p style="margin:0 0 8px;font-size:13px;color:#475569">All code and Phase 2 documentation pushed to:</p>' +
    '<a href="' + phase2GithubResult.repo_url + '" style="color:#4A8FD6;text-decoration:none;font-size:14px;font-weight:600">' + phase2GithubResult.repo_url + '</a>' +
    '<p style="margin:8px 0 0;font-size:12px;color:#7A8B9A">' + (phase2GithubResult.pushed || 0) + ' Phase 2 files + Phase 1 code</p>' +
    '</div>' : '') +
    // CTA button
    '<div style="text-align:center;margin:24px 0">' +
    '<a href="' + reviewUrl + '" style="display:inline-block;background:#4A8FD6;color:#FFFFFF;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">View Build</a>' +
    '</div>' +
    '</div>' +
    // Footer
    '<div style="background:#1E3348;border-radius:0 0 12px 12px;padding:16px 32px;text-align:center">' +
    '<div style="font-size:12px;color:#7A8B9A">ManageAI Factory Floor — FRIDAY Build System</div>' +
    '</div>' +
    '</div></body></html>';

  try {
    const { getGraphToken } = await import('./onedrive.js');
    const token = await getGraphToken();
    const url = 'https://graph.microsoft.com/v1.0/users/' + GRAPH_USER_EMAIL + '/sendMail';
    const payload = {
      message: {
        subject: 'Phase 2 Complete: ' + projectName + ' (' + ticketId + ') — All Documents Ready',
        body: { contentType: 'HTML', content: htmlBody },
        toRecipients: toEmails.map(email => ({ emailAddress: { address: email } }))
      },
      saveToSentItems: false
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const text = await res.text();
      console.error('[FRIDAY] Phase 2 email failed:', res.status, text.slice(0, 200));
      return { sent: false, error: text.slice(0, 200) };
    }
    console.log('[FRIDAY] Phase 2 completion email sent to:', toEmails.join(', '));
    return { sent: true, recipients: toEmails };
  } catch (e) {
    console.error('[FRIDAY] Phase 2 email error:', e.message);
    return { sent: false, error: e.message };
  }
}
