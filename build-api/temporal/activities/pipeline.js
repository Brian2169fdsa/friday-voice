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

    const sanitize = s => (s || '').replace(/[<>:"\/|?*]/g, '-').trim();
    const basePath = 'ManageAI/Clients/' + sanitize(clientName) + '/Builds/' + sanitize(projectName);

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

      // Also upload to the client build folder
      const aitm2 = jobData.aitm_name || projectName;
      const clientBuildPath = 'ManageAI/Clients/' + sanitize(clientName) + '/' + sanitize(aitm2);
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

    // Step 10d: Save OneDrive folder URL to build record
    try {
      const aitm2 = jobData.aitm_name || projectName;
      const folderPath = 'ManageAI/Clients/' + sanitize(clientName) + '/' + sanitize(aitm2);
      const encodedPath = folderPath.split('/').map(p => encodeURIComponent(p)).join('/');
      const onedriveFolderUrl = 'https://managepartners-my.sharepoint.com/personal/brian_manageai_io/Documents/' + encodedPath;
      const folderPatchOk = await sbPatch('friday_builds?id=eq.' + buildId, { onedrive_folder_url: onedriveFolderUrl, updated_at: new Date().toISOString() });
      if (folderPatchOk) {
        console.log('[TEMPORAL PIPELINE] OneDrive folder URL saved:', onedriveFolderUrl);
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
      const engPath = 'ManageAI/Clients/' + sanitize(clientName) + '/FRIDAY';
      await ensureFolder(engToken, engPath);
      await uploadFile(engToken, engPath, 'engagement-context.json', engagementJson, 'application/json');
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
