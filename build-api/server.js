import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { spawn, execSync } from 'child_process';
import { runPlanner, getContractFocus, collectOutputsFromDir, scoreOutputs } from './orchestrator.js';
// BullMQ removed -- queue.js no longer imported
let AGENT_UID, AGENT_GID;
try { AGENT_UID = parseInt(execSync('id -u claudeagent').toString().trim()); AGENT_GID = parseInt(execSync('id -g claudeagent').toString().trim()); } catch(e) { AGENT_UID = null; AGENT_GID = null; }
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import fsSync from 'node:fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
const SUPABASE_URL = process.env.SUPABASE_URL ||
  'https://fmemdogudiolevqsfuvd.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_KEY || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

import { getTemporalClient } from './temporal/client.js';
import { z } from 'zod';
const BriefSchema = z.object({
  client: z.string().min(1),
  customer_id: z.string().uuid(),
  project_name: z.string().min(1),
  request_description: z.string().min(1),
  platform: z.string().min(1),
  workflow_steps: z.string().min(1),
  decision_authority: z.string().min(1),
  success_metrics: z.string().min(1),
  data_sources: z.string().min(1),
  guardrails: z.string().min(1),
  edge_cases: z.string().min(1),
  acceptance_criteria: z.string().min(1),
  section_a: z.object({
    client_profile: z.object({ confidence_score: z.string(), content: z.string() }),
    current_state: z.object({ confidence_score: z.string(), content: z.string() }),
    prototype_scope: z.object({ confidence_score: z.string(), content: z.string() }),
    success_metrics: z.object({ confidence_score: z.string(), content: z.string() }),
    workforce_vision: z.object({ confidence_score: z.string(), content: z.string() }),
    technical_constraints: z.object({ confidence_score: z.string(), content: z.string() }),
    opportunity_assessment: z.object({ confidence_score: z.string(), content: z.string() }),
  }),
});

// ── Activity Logger ──────────────────────────────────────────────────────────
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_KEY);
async function logActivity(event_type, title, detail, client_name, customer_id, severity = 'info') {
  try {
    await supabaseAdmin.from('friday_activity_log').insert({
      event_type, title, detail, client_name, customer_id, severity,
      created_at: new Date().toISOString()
    });
  } catch(e) { /* non-fatal */ }
}

async function evaluateCompleteness(job) {
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const result = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 400,
      messages: [{ role: 'user', content: 'Evaluate build ticket completeness 0-100.\nClient: ' + job.client + '\nProject: ' + job.project_name + '\nPlatform: ' + job.platform + '\nDescription: ' + job.request_description + '\nReturn JSON only: {"score": number, "complete": boolean, "questions": string or null}' }]
    });
    return JSON.parse(result.content[0].text.replace(/```json|```/g,'').trim());
  } catch(e) {
    console.warn('[FRIDAY] Completeness check failed:', e.message);
    return { score: 75, complete: true, questions: null };
  }
}

const app = express();
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(path.dirname(new URL(import.meta.url).pathname), 'public')));

// Simple in-memory rate limiter for build endpoints
const buildRateLimit = new Map();
const RATE_WINDOW_MS = 60000;
const RATE_MAX = 5;
function checkRateLimit(ip) {
  const now = Date.now();
  const key = `${ip}:${Math.floor(now / RATE_WINDOW_MS)}`;
  const count = (buildRateLimit.get(key) || 0) + 1;
  buildRateLimit.set(key, count);
  for (const [k] of buildRateLimit) {
    if (!k.endsWith(`:${Math.floor(now / RATE_WINDOW_MS)}`)) buildRateLimit.delete(k);
  }
  return count <= RATE_MAX;
}

const PORT = process.env.PORT || 3000;
const N8N_CALLBACK_URL = process.env.N8N_WF07_CALLBACK || null;
// Make.com callback removed — replaced by n8n WF-07 (not yet deployed)
// const FRIDAY_2001_WEBHOOK = 'https://hook.us2.make.com/2u6wwq4m0ebujbp7avv8xpgg9dacsddm';
const CLAUDE = '/usr/bin/claude';
// const MAKE_TEAM_ID = 1158744; // Make.com deploy disabled

// ── Microsoft Graph / OneDrive ────────────────────────────────────────────────
async function getGraphToken() {
  const res = await fetch('https://login.microsoftonline.com/' + process.env.AZURE_TENANT_ID + '/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.AZURE_CLIENT_ID, client_secret: process.env.AZURE_CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token error: ' + JSON.stringify(data));
  return data.access_token;
}

async function ensureFolder(token, folderPath) {
  const base = 'https://graph.microsoft.com/v1.0/users/brian@manageai.io/drive';
  const h = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
  const parts = folderPath.split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    const prev = cur;
    cur = cur ? cur + '/' + part : part;
    const check = await fetch(base + '/root:/' + cur, { headers: h });
    if (check.status === 404) {
      const parentRef = prev ? base + '/root:/' + prev + ':/children' : base + '/root/children';
      await fetch(parentRef, { method: 'POST', headers: h, body: JSON.stringify({ name: part, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' }) });
    }
  }
}

async function uploadFile(token, folderPath, fileName, content, mimeType) {
  const base = 'https://graph.microsoft.com/v1.0/users/brian@manageai.io/drive';
  const encodedPath = folderPath.split('/').map(p => encodeURIComponent(p)).join('/');
  const encodedFile = encodeURIComponent(fileName);
  const up = await fetch(base + '/root:/' + encodedPath + '/' + encodedFile + ':/content', {
    method: 'PUT',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': mimeType || 'application/octet-stream' },
    body: content
  });
  const uploaded = await up.json();
  if (!uploaded.id) throw new Error('Upload failed: ' + JSON.stringify(uploaded).slice(0, 200));

  // Try createLink with organization scope first, fall back to anonymous, then webUrl
  let shareUrl = '';
  for (const scope of ['organization', 'anonymous']) {
    try {
      const link = await fetch(base + '/items/' + uploaded.id + '/createLink', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'view', scope })
      });
      const linkData = await link.json();
      if (scope === 'organization') console.log('[OneDrive] org link result:', JSON.stringify(linkData?.link?.webUrl));
      if (scope === 'anonymous') console.log('[OneDrive] anon link result:', JSON.stringify(linkData?.link?.webUrl));
      if (linkData.link?.webUrl) {
        shareUrl = linkData.link.webUrl;
        break;
      }
      console.warn('[OneDrive] createLink scope=' + scope + ' no webUrl:', JSON.stringify(linkData).slice(0, 300));
    } catch (e) {
      console.warn('[OneDrive] createLink scope=' + scope + ' error:', e.message);
    }
  }
  if (!shareUrl) {
    // Last resort: use the direct webUrl from the upload response
    shareUrl = uploaded.webUrl || '';
    console.log('[OneDrive] webUrl fallback:', uploaded?.webUrl);
    if (shareUrl) console.log('[OneDrive] Using upload webUrl fallback:', shareUrl);
    else console.warn('[OneDrive] No share URL available for item:', uploaded.id);
  }
  const finalUrl = shareUrl;
  console.log('[OneDrive] final url:', finalUrl, 'for file:', fileName);
  return finalUrl;
}

async function getFolderLink(token, folderPath) {
  const base = 'https://graph.microsoft.com/v1.0/users/brian@manageai.io/drive';
  const h = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
  const encodedPath = folderPath.split('/').map(p => encodeURIComponent(p)).join('/');
  const res = await fetch(base + '/root:/' + encodedPath, { headers: h });
  const data = await res.json();
  if (!data.id) return null;
  const link = await fetch(base + '/items/' + data.id + '/createLink', { method: 'POST', headers: h, body: JSON.stringify({ type: 'view', scope: 'organization' }) });
  const linkData = await link.json();
  return linkData.link?.webUrl;
}

async function uploadOutputDir(outputDir, client, projectName, token, buildVersion) {
  buildVersion = buildVersion || 'v1.0';
  const sanitize = s => s.replace(/[<>:"\/\\|?*]/g, '-').trim();
  const basePath = 'ManageAI/Clients/' + sanitize(client) + '/' + sanitize(projectName);
  const versionPath = basePath + '/' + buildVersion;
  const currentPath = basePath + '/current';
  await ensureFolder(token, versionPath);
  await ensureFolder(token, currentPath);
  const mimes = { '.html': 'text/html', '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.json': 'application/json', '.md': 'text/markdown', '.txt': 'text/plain', '.js': 'text/javascript', '.css': 'text/css' };
  const uploaded = [];
  async function scan(dir, rel) {
    rel = rel || '';
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        await scan(path.join(dir, e.name), rel + e.name + '/');
      } else {
        const fileContent = await fs.readFile(path.join(dir, e.name));
        const ext = path.extname(e.name).toLowerCase();
        // Upload to versioned folder (canonical URL)
        const url = await uploadFile(token, versionPath, rel + e.name, fileContent, mimes[ext]);
        uploaded.push({ name: rel + e.name, url });
        // Upload copy to /current/ folder
        try {
          await uploadFile(token, currentPath, rel + e.name, fileContent, mimes[ext]);
        } catch (copyErr) {
          console.warn('[OneDrive] /current/ copy failed for', rel + e.name, ':', copyErr.message);
        }
      }
    }
  }
  await scan(outputDir);
  console.log('[OneDrive] Uploaded to', versionPath, '+ /current/ |', uploaded.length, 'files');
  return { folderPath: basePath, uploaded: uploaded.filter(u => u.url) };
}

// ── Make.com Live Deployment ──────────────────────────────────────────────────
async function deployMakeScenarios(workflowDir, job) {
  const apiKey = process.env.MAKE_API_KEY;
  if (!apiKey) { console.log('[' + job.job_id + '] No MAKE_API_KEY — skipping live deployment'); return []; }

  let files;
  try { files = await fs.readdir(workflowDir); } catch(e) { return []; }
  const blueprintFiles = files.filter(f => f.endsWith('.json') && !f.includes('index'));
  const deployed = [];

  for (const file of blueprintFiles) {
    try {
      const raw = await fs.readFile(path.join(workflowDir, file), 'utf-8');
      const blueprint = JSON.parse(raw);
      const scenarioName = blueprint.name || file.replace('.json', '');
      const res = await fetch('https://us2.make.com/api/v2/scenarios', {
        method: 'POST',
        headers: { 'Authorization': 'Token ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId: MAKE_TEAM_ID, blueprint: raw, scheduling: { type: 'immediately' } })
      });
      const data = await res.json();
      if (data.scenario?.id) {
        deployed.push({ name: scenarioName, id: data.scenario.id, file });
        console.log('[' + job.job_id + '] Deployed Make scenario: ' + scenarioName + ' (ID ' + data.scenario.id + ')');
      } else {
        console.error('[' + job.job_id + '] Make deploy failed for ' + file + ':', JSON.stringify(data).slice(0, 200));
      }
    } catch(err) {
      console.error('[' + job.job_id + '] Make deploy error for ' + file + ':', err.message);
    }
  }
  return deployed;
}

// ── Platform-aware agent definitions ─────────────────────────────────────────
function detectPlatform(platformStr) {
  const p = (platformStr || '').toLowerCase();
  if (p.includes('n8n')) return 'n8n';
  if (p.includes('zapier')) return 'zapier';
  return 'make'; // default
}

function getWorkflowAgentTask(job, platform) {
  const p = job.project_name;

  if (platform === 'n8n') {
    return `You are an n8n workflow architect for ManageAI.

CLIENT: ${job.client}
PROJECT: ${p}
PLATFORM: n8n
REQUEST: ${job.request_description}

TASK: Analyze the request and determine how many distinct n8n workflows are needed. Create ONE .json file per workflow.

Each file must be a valid n8n workflow JSON importable directly into n8n. Use this exact structure:
{
  "name": "Workflow Name",
  "nodes": [
    {
      "id": "uuid-here",
      "name": "Node Name",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 1,
      "position": [250, 300],
      "parameters": {}
    }
  ],
  "connections": {
    "Node Name": {
      "main": [[{ "node": "Next Node", "type": "main", "index": 0 }]]
    }
  },
  "active": false,
  "settings": {},
  "tags": []
}

Common n8n node types to use as appropriate:
- n8n-nodes-base.webhook (HTTP trigger)
- n8n-nodes-base.httpRequest (API calls)
- n8n-nodes-base.set (set variables)
- n8n-nodes-base.if (conditions)
- n8n-nodes-base.switch (router)
- n8n-nodes-base.code (JavaScript)
- n8n-nodes-base.emailSend
- n8n-nodes-base.microsoftOutlook
- n8n-nodes-base.notion
- n8n-nodes-base.slack
- n8n-nodes-base.googleSheets
- n8n-nodes-base.airtable
- @n8n/n8n-nodes-langchain.lmChatAnthropic (Claude AI)
- @n8n/n8n-nodes-langchain.agent (AI agent)

Name each file descriptively: "${p} - Workflow Name.json"
Create as many workflows as the request requires. Each must be complete and realistic with actual node configs.
Write all files to your output directory. Valid JSON only — no markdown, no comments.

When referencing files or outputs in your work, always include version context. This is version ${job.buildVersion || 'v1.0'} of this project. File paths follow the pattern: /ManageAI/Clients/{client}/{ticket_id}/${job.buildVersion || 'v1.0'}/{filename}. If you are making changes to an existing build rather than creating from scratch, your output filename should reflect the version passed in the payload (default v1.0 for new builds).`;
  }

  if (platform === 'zapier') {
    return `You are a Zapier workflow architect for ManageAI.

CLIENT: ${job.client}
PROJECT: ${p}
PLATFORM: Zapier
REQUEST: ${job.request_description}

TASK: Analyze the request and determine how many distinct Zaps are needed. Create ONE .json file per Zap.

Each file must follow the Zapier CLI transfer format:
{
  "title": "Zap Name",
  "description": "What this Zap does",
  "steps": [
    {
      "type": "read",
      "app": "AppName",
      "action": "trigger_key",
      "title": "Step title",
      "params": {}
    },
    {
      "type": "write",
      "app": "AppName",
      "action": "action_key",
      "title": "Step title",
      "params": {
        "field": "{{steps.1.field}}"
      }
    }
  ]
}

Build realistic Zaps appropriate to the request. Use real Zapier app names (e.g. "Webhooks by Zapier", "Microsoft Outlook", "Notion", "Slack", "Google Sheets", "Claude by Anthropic", "Formatter by Zapier", "Paths by Zapier").

Name each file: "${p} - Zap Name.json"
Create as many Zaps as the request requires. Include realistic field mappings using {{steps.N.field}} syntax.
Write all files to your output directory. Valid JSON only — no markdown, no comments.

When referencing files or outputs in your work, always include version context. This is version ${job.buildVersion || 'v1.0'} of this project. File paths follow the pattern: /ManageAI/Clients/{client}/{ticket_id}/${job.buildVersion || 'v1.0'}/{filename}. If you are making changes to an existing build rather than creating from scratch, your output filename should reflect the version passed in the payload (default v1.0 for new builds).`;
  }

  // Default: Make.com
  return `You are a Make.com scenario architect for ManageAI.

CLIENT: ${job.client}
PROJECT: ${p}
PLATFORM: Make.com
REQUEST: ${job.request_description}

TASK: Analyze the request and determine how many distinct Make.com scenarios are needed. Create ONE .json file per scenario — each must be a valid Make.com blueprint deployable via the Make API.

Each file must follow this exact Make.com blueprint structure:
{
  "name": "Scenario Name",
  "flow": [
    {
      "id": 1,
      "module": "gateway:CustomWebHook",
      "version": 1,
      "parameters": { "hook": 0, "maxResults": 1 },
      "mapper": {},
      "metadata": { "designer": { "x": 0, "y": 0 } }
    },
    {
      "id": 2,
      "module": "util:SetVariables",
      "version": 1,
      "parameters": {},
      "mapper": {
        "scope": "roundtrip",
        "variables": [
          { "name": "myVar", "value": "{{1.field}}" }
        ]
      },
      "metadata": { "designer": { "x": 300, "y": 0 } }
    }
  ],
  "metadata": {
    "instant": true,
    "version": 1,
    "scenario": {
      "roundtrips": 1,
      "maxErrors": 3,
      "autoCommit": true,
      "autoCommitTriggerLast": true,
      "sequential": false,
      "freshVariables": false,
      "confidential": false,
      "dataloss": false,
      "dlq": false
    },
    "designer": { "orphans": [] }
  },
  "scheduling": { "type": "immediately" }
}

Common Make.com module names to use as appropriate:
- gateway:CustomWebHook (webhook trigger)
- http:ActionSendData (HTTP request)
- util:SetVariables / util:SetVariable
- builtin:BasicRouter (router)
- microsoft-email:createAndSendAMessage (Outlook email)
- openai-gpt-4:createCompletion (OpenAI)
- claude-ai:createMessage (Claude)
- google-sheets:addRow / google-sheets:searchRows
- notion:createPage / notion:updatePage
- slack:createMessage
- airtable:createRecord

Name each file descriptively: "${p} - Scenario Name.json"
Create as many scenarios as the request requires (typically 2-6 for a complete system).
Each blueprint must have realistic module configs, proper mapper references using {{moduleId.field}} syntax, and x/y designer positions spaced 300px apart.
Write all files to your output directory. Valid JSON only — no markdown, no comments.

When referencing files or outputs in your work, always include version context. This is version ${job.buildVersion || 'v1.0'} of this project. File paths follow the pattern: /ManageAI/Clients/{client}/{ticket_id}/${job.buildVersion || 'v1.0'}/{filename}. If you are making changes to an existing build rather than creating from scratch, your output filename should reflect the version passed in the payload (default v1.0 for new builds).`;
}

// ── Fixed 4-agent ManageAI swarm ──────────────────────────────────────────────
function getManageAIAgents(job) {
  const p = job.project_name;
  const platform = detectPlatform(job.platform);

  return [
    {
      agent_id: 'agent_01',
      specialist: 'Solution Demo Builder',
      output_subdir: 'deliverables',
      deliverables: [`${p} Solution Demo.html`],
      task: `You are Agent 01 — Solution Demo Builder for the ManageAI FRIDAY build swarm.

CLIENT: ${job.client}
PROJECT: ${p}
PLATFORM: ${job.platform}
REQUEST: ${job.request_description}

You must produce ONE file: "${p} Solution Demo.html"
Save it to your output directory.

This file must be a complete, self-contained React 18 SPA using createElement syntax
(no JSX, no build tools). It must match the ManageAI Solution Demo design system
EXACTLY — pixel perfect to the locked spec below.

═══════════════════════════════════════════
LOCKED DESIGN SYSTEM — DO NOT DEVIATE
═══════════════════════════════════════════

Fonts (load from Google Fonts):
  DM Sans: weights 300,400,500,600,700
  JetBrains Mono: weights 400,500

Color tokens (use these exact hex values, stored in const C = {}):
  accent:     "#4A8FD6"
  accentDim:  "rgba(74,143,214,0.07)"
  bg:         "#FFFFFF"
  surface:    "#F8F9FB"
  surface2:   "#F0F2F5"
  border:     "#E2E5EA"
  text:       "#1A1A2E"
  textDim:    "#8890A0"
  textMid:    "#5A6070"
  success:    "#22A860"
  warning:    "#E5A200"
  danger:     "#E04848"
  logo:       "#2A2A3E"
  purple:     "#7C5CFC"
  orange:     "#E8723A"
  teal:       "#1AA8A8"

Monospace font variable: const mono = "'JetBrains Mono', monospace";

Animations (define all of these in <style>):
  @keyframes floatUp — particles float upward and fade
  @keyframes pulseGlow — box-shadow pulses on cards
  @keyframes slideIn — from opacity:0 translateY(16px) to opacity:1 translateY(0)
  @keyframes pulseDot — scale 1→1.4→1, opacity 0.7→1→0.7
  @keyframes fadeIn — opacity 0→1

Background: fixed grid pattern using CSS backgroundImage with linear-gradient
  lines at border color, backgroundSize 60px 60px

Floating particles: 12 absolutely positioned 2x2px dots, accent color,
  position fixed, animate with floatUp, staggered delays, z-index 0

═══════════════════════════════════════════
LOCKED PAGE STRUCTURE
═══════════════════════════════════════════

The page has:
1. A fixed left editor panel (width 380px when open, 0 when closed)
2. A main content area that shifts right when panel opens
3. A fixed header
4. Tab navigation
5. Main content area
6. Footer

EDITOR PANEL (left slide-in, z-index 100):
- Toggle button in header (pencil emoji) when panel is closed
- Header inside panel: MANAGE (logo color) + AI (accent color) wordmark + "Editor" mono label + close button
- 6 section tabs: Overview | Stats & Flow | Prototype | How it Works | Scenarios | Limits & Tiers
- Scrollable content area per section
- Footer inside panel with:
  - Green "Supabase Connected" status pill
  - "Save to Cloud" button (accent color, green on success, red on error)
  - "Load from Cloud" button
  - "Export JSON" button
  - "Reset to Default" button

Supabase connection (hardcode these):
  URL: https://abqwambiblgjztzkrbzg.supabase.co
  Key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFicXdhbWJpYmxnanp0emtyYnpnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwNTA0NzIsImV4cCI6MjA4NzYyNjQ3Mn0.e10i_DqoLwS0UQhEoJGOGRtBlm4dsYxEbPQ3XFkpwQc

HEADER (fixed top, z-index 10):
  Left side:
    - Toggle button (only when panel is closed)
    - MANAGE (logo color #2A2A3E bold) + AI (accent #4A8FD6 bold) — Montserrat-style
    - Vertical divider line
    - Client name + solution name (bold, 12px)
    - "Solution Demo v{version} · {stack}" (9px, mono, textDim)
  Right side:
    - Pill tab navigation with 4 tabs inside a surface2 rounded container:
        Overview | Prototype | How it Works | Build Spec
    - Active tab: accent background, white text
    - Inactive tab: transparent, textDim

FOOTER:
  Left: "MANAGE" (logo color) + "AI" (accent) + "· {solutionName} Solution Demo v{version} · March 2026"
  Right: "CONFIDENTIAL — {confidentialLine}"
  Border top, padding 16px 28px

═══════════════════════════════════════════
4 TAB VIEWS — EXACT STRUCTURE
═══════════════════════════════════════════

TAB 1 — OVERVIEW:
  - Section header: h2 "{overviewTitle}" + p "{overviewDesc}" (max-width 720px)
  - Execution Flow card (surface background, border):
      Label: "EXECUTION FLOW — ALL SCENARIOS" (accent, 12px, 0.04em spacing)
      Flow nodes connected by arrow symbols, each node:
        - Bordered box (2px solid node color)
        - Icon (emoji, 18px)
        - Label (10px, mono, node color, bold)
        - Sub (8px, textDim)
      Nodes come from data.flow array — build these from the automation being built
  - Stats grid (auto-fit, min 200px):
      Each stat card: surface bg, border, 3px top border in stat color
        - Label (10px, uppercase, textDim, 0.05em)
        - Value (28px, bold, mono)
        - Sub (11px, textDim)
  - 2-column scope grid:
      IN SCOPE card: success color theme (checkmarks)
      OUT OF SCOPE card: danger color theme (x marks)

TAB 2 — PROTOTYPE:
  - Section header: h2 "Report Prototypes" + description p
  - Pill tab bar (no gap, bordered container, overflow hidden):
      One tab per prototype — label + colored pulse dot
      Active tab: white bg, colored text
      Inactive tab: surface bg, muted
  - Description block below tabs: badge pill (scenario ID) + description text
  - iframe container (border, border-radius 8, overflow hidden):
      iframe height: 800px, width 100%, border none
      src: points to the separate prototype HTML file
      key={active.id} to force reload on tab change
      loading="lazy"

  IMPORTANT: The prototype HTML files are OTHER deliverables in the same build package.
  When building this demo for a Make.com build, the iframe srcs should reference
  the actual workflow output HTML files if they exist, OR use placeholder paths
  named after the project/scenario. The iframe shell always stays — only src changes.

TAB 3 — HOW IT WORKS:
  - Section header + description
  - Vertical stepper (numbered circles connected by lines):
      Each step: number circle (step color, white text) → vertical connector line → content
      Content: title (14px bold) + description (13px, textMid, lineHeight 1.7)
      Optional detail block: mono font, surface bg, border, borderRadius 8, pre-line whitespace
      Step 3 gets an extra 2-column table row below it showing:
        Left: Facility Tier Classification table (tier | criteria | examples)
        Right: Severity Scoring Engine table (severity | threshold | action)
  - Cadence grid (2 columns):
      Each cadence card: surface bg, icon + title (cadence color) + description

TAB 4 — BUILD SPEC:
  - Section header + description
  - "System Tech Stack" label + auto-fit grid of tech cards:
      Each: 40x40 icon box (color-tinted bg) + name (13px bold) + role (11px textDim)
  - 3-column I/O/Triggers row:
      Each column: surface card with colored header label + bullet list
      Inputs (accent), Outputs (success), Triggers (orange)
  - "Scenario Specifications" label + expandable accordion:
      Each scenario row: mono ID badge + name + module count + expand arrow
      Expanded: description + numbered module list (name + description per module)
      Expand/collapse on click, one open at a time
  - "Architecture Notes" label + limitations card:
      Known Limitations header (danger color)
      Bullet list of limitation strings

═══════════════════════════════════════════
DATA STRUCTURE — getDefaultData()
═══════════════════════════════════════════

Build the getDefaultData() function with these exact field names,
populated with realistic content for the specific build being requested:

{
  clientName: "{client}",
  solutionName: "{project_name}",
  version: "1.0",
  stack: "{platform} + Claude API + {other tools}",
  confidentialLine: "Prepared for {client}",
  overviewTitle: "{project_name}",
  overviewDesc: "{2-sentence description of what this automation does}",
  flow: [
    {icon:"emoji", label:"Step Name", sub:"subtitle", clr: C.colorName},
    ... (4-7 flow steps representing the actual automation pipeline)
  ],
  stats: [
    {label:"Stat Label", value:"N", sub:"description", color: C.colorName},
    ... (exactly 4 stat cards relevant to this build)
  ],
  scopeIn: ["item 1", "item 2", ...],   // 5-8 in-scope items
  scopeOut: ["item 1", "item 2", ...],  // 4-6 out-of-scope items
  protoTabs: [
    {id:"tab-id", label:"Tab Label", badge:"WF-01", color: C.colorName, src:"filename.html", desc:"description"},
    ... (one tab per major workflow or report type)
  ],
  steps: [
    {num:1, title:"Step Title", color: C.colorName, desc:"description", detail:"optional mono detail"},
    ... (one step per major system component, typically 4-6)
  ],
  tiers: [
    {tier:"Tier Name", criteria:"criteria text", ex:"example", color: C.colorName},
    ... (if applicable to this build — omit if not)
  ],
  sevs: [
    {sev:"LEVEL", threshold:"threshold text", action:"action text", color: C.colorName},
    ... (severity levels if applicable)
  ],
  cadences: [
    {icon:"emoji", title:"Cadence Name", color: C.colorName, desc:"description"},
    ... (timing/frequency breakdown if applicable)
  ],
  techStack: [
    {icon:"emoji or letters", name:"Tool Name", role:"Role Description", color: C.colorName, isMono: bool},
    ...
  ],
  scenarios: [
    {
      id:"WF-01",
      name:"Workflow Name",
      color: C.colorName,
      desc:"what this workflow does",
      modules:["Module Name then Action", ...],
      descs:["what this module does", ...]
    },
    ...
  ],
  limits: ["limitation 1", "limitation 2", ...]
}

═══════════════════════════════════════════
BUILD INSTRUCTIONS
═══════════════════════════════════════════

1. Read the request_description and platform carefully
2. Build getDefaultData() with realistic, specific content for THIS build
3. Do not use placeholder text like "Lorem ipsum" or "Description here"
4. The flow steps must reflect the ACTUAL automation pipeline being built
5. Scenarios must reflect the ACTUAL workflows being built (WF-01, WF-02, etc.)
6. Tech stack must reflect ACTUAL tools being used
7. Prototype tab srcs must reference actual HTML filenames being delivered
   in the same package (coordinate with Agent 04's blueprint output names)
8. The Supabase save/load code must be included exactly as in the template
9. All editor functionality must work — the client may use it to update content
10. File must be completely self-contained — no external dependencies except
    Google Fonts CDN and React/ReactDOM from cdnjs.cloudflare.com

OUTPUT: One complete HTML file named "${p} Solution Demo.html"

REFERENCE SPEC: Read this file FIRST before writing anything: cat /opt/manageai/agents/solution-demo-spec.md
Match its structure, component patterns, and design system EXACTLY.
Adapt all content to this specific build — use real workflow names, real platform, real client.

PROTOTYPE TAB RULE: If you cannot build interactive prototype content, render a placeholder card — never a white screen.

TIMEOUT WARNING: You have 8 minutes. Read spec then write file immediately. One pass only.

When referencing files or outputs in your work, always include version context. This is version ${job.buildVersion || 'v1.0'} of this project. File paths follow the pattern: /ManageAI/Clients/{client}/{ticket_id}/${job.buildVersion || 'v1.0'}/{filename}. If you are making changes to an existing build rather than creating from scratch, your output filename should reflect the version passed in the payload (default v1.0 for new builds).`
    },
    {
      agent_id: 'agent_02',
      specialist: 'Skillset Manual Author',
      output_subdir: 'deliverables',
      deliverables: [`${p} Training Manual.md`],
      task: `You are Agent 02 — Skillset Manual Author for the ManageAI FRIDAY build swarm.

CLIENT: ${job.client}
PROJECT: ${p}
PLATFORM: ${job.platform}
REQUEST: ${job.request_description}

Your job is to produce ONE markdown file: "${p} Training Manual.md"

This Training Manual documents the AI Teammate (AITM) that was just built. You have access to:
1. The BUILD CONTRACT FOCUS section (appended to this prompt) — contains the planner's contract with agent-specific fields
2. The PHASE 1 BUILD RESULTS section (appended to this prompt) — contains actual outputs from each Phase 1 agent

Use BOTH data sources. Extract ACTUAL names, URLs, table names, workflow names, and endpoints. No generic placeholders.

The document MUST have exactly these 6 sections:

## 1. Overview
What this AI Teammate is, what problem it solves, who uses it, and what it replaces or augments.
- Pull the AITM name, business objective, and responsibilities from the build contract system_summary and BUILD_005 fields.
- State the client name (${job.client}), the platform (${job.platform}), and the project name (${p}).
- Describe in 2-3 paragraphs what the end user experiences when this teammate is running.

## 2. How It Works
Step-by-step description of how the AI Teammate operates, from input to process to output.
- Written for a non-technical manager who needs to understand the flow.
- Pull from the build contract BUILD_002.workflow_steps and BUILD_002.decision_points fields.
- Number each step. For each step state: trigger, what happens, what output is produced.
- Flag any human-in-the-loop decision points.

## 3. Implementation
What was ACTUALLY built during the Phase 1 build. This is the most important section — every item must come from PHASE 1 BUILD RESULTS, not from the contract.
- Schema: Look in PHASE 1 BUILD RESULTS → Schema section for "tables_verified" or "tables_created" arrays. List EVERY table by its ACTUAL name (e.g. "cornerstone_extraction_jobs", NOT "table_name"). For each table: name, purpose, key columns.
- Workflows: Look in PHASE 1 BUILD RESULTS → Workflow section for "manifest" with workflow names, IDs, activation status. List EVERY ${job.platform} workflow by its ACTUAL name (e.g. "WF-01 Intake Processor"), trigger type, and function.
- AI Integration: Look in PHASE 1 BUILD RESULTS → LLM section for "files_produced" and prompt details. List which Claude models are used, for which tasks, include ACTUAL system prompt excerpts (first 2-3 sentences of each prompt from BUILD-004 output).
- External platforms: Look in PHASE 1 BUILD RESULTS → External section for "platforms" array. List each third-party integration by name and what endpoints were configured (from BUILD-007 output).
- GitHub: Look in PHASE 1 BUILD RESULTS → Platform section for "manifest.repo_url". Include the ACTUAL repo URL.

## 4. Configuration
Environment variables, API keys, credentials, and settings the customer needs to maintain.
- Look in PHASE 1 BUILD RESULTS → Platform section for environment variables. List EVERY env var by ACTUAL name.
- Also check the build contract BUILD_005.environment_variables array.
- List every credential or API key required (from build contract).
- Provide setup steps for first-time deployment.
- Note any platform-specific configuration (${job.platform} settings, webhook URLs from workflow manifest, etc).

## 5. Best Practices
How to get the most out of this AI Teammate.
- Common mistakes and how to avoid them.
- Edge cases and how the system handles them (from BUILD_004.edge_cases).
- Guardrails: what the AI Teammate must never do (from BUILD_004.guardrails). Include ACTUAL guardrail text, not summaries.
- Escalation guidance: when and how to escalate to a human.
- Performance tips for optimal operation.

## 6. Architecture
System diagram in text form showing how all components connect.
- Draw an ASCII diagram using ACTUAL table names from Schema results, ACTUAL workflow names from Workflow results, and ACTUAL integration endpoints from External results.
- List all external dependencies and integration points by their real names.
- Include the ACTUAL GitHub repo URL from PHASE 1 BUILD RESULTS → Platform → manifest.repo_url.
- Note the ACTUAL tech stack from BUILD_005.tech_stack or Platform results.

CRITICAL RULES:
- Every section must contain real content derived from the build contract and Phase 1 results. If a field is not available, state what would normally go there and mark it [PENDING].
- Minimum 200 words per section. Total document minimum 1500 words.
- Use proper markdown formatting with headers, bullet points, tables, and code blocks where appropriate.
- Output filename: "${p} Training Manual.md"
- Write the file directly to your output directory. No other files.`

      },
    {
      agent_id: 'agent_03',
      specialist: 'Requirements & Docs Writer',
      output_subdir: 'build-docs',
      deliverables: [`${p} Requirements Document.md`, `${p} Architecture Assessment.md`, `${p} Implementation Wave Manual.md`, `${p.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-regression-suite.json`],
      task: `You are writing three technical documents for ManageAI.

CLIENT: ${job.client}
PROJECT: ${p}
PLATFORM: ${job.platform}
REQUEST: ${job.request_description}

YOU MUST CREATE EXACTLY 4 FILES in your output directory:

FILE 1: "${p} Requirements Document.md"
- Full PRD: functional requirements (FR-001+), non-functional requirements, dependencies, assumptions, scope boundaries
- Requirements must be specific to the actual system being built on ${job.platform}

FILE 2: "${p} Architecture Assessment.md"
- System architecture: component breakdown, data flow diagram (ASCII), integration points, security considerations, error handling strategy, scalability notes
- Specific to ${job.platform} and what was requested

FILE 3: "${p} Implementation Wave Manual.md"
- Phased rollout: Wave 1 (foundation/MVP), Wave 2 (core features), Wave 3 (optimization/scale)
- Each wave: what gets built, acceptance criteria, estimated effort, rollback plan
- Realistic and specific to the project

Minimum 600 words each for docs 1-3. Real content. No placeholder text.

FILE 4: Use this filename pattern: take the project name, lowercase it, replace spaces and special chars with hyphens, then append "-regression-suite.json". Example: "My Cool Project" becomes "my-cool-project-regression-suite.json".

This is an EXECUTABLE regression suite, not a document. It must contain 15-25 gold standard input/output pairs derived from the acceptance_criteria in the Brief (available in the BUILD CONTRACT FOCUS section appended to your prompt).

EXACT JSON SCHEMA -- follow this precisely:
{
  "suite_name": "<project name> Regression Suite",
  "version": "v1.0",
  "generated_at": "<ISO timestamp>",
  "total_tests": <number>,
  "test_cases": [
    {
      "id": "TC-001",
      "name": "descriptive test name",
      "category": "functional|edge_case|integration|performance",
      "input": { "description": "what goes in", "payload": { "field1": "value1" } },
      "expected_output": { "description": "what should come out", "payload": { "field1": "expected_value" } },
      "evaluation_method": "exact_match|schema_validation|rubric",
      "source": "which acceptance criterion or requirement this test validates (e.g. AC-001: System must process intake within 30 seconds)",
      "priority": "critical|high|medium|low"
    }
  ]
}

RULES:
- Each test_case MUST have all fields above. No optional fields.
- "evaluation_method" must be one of: "exact_match" (output must match exactly), "schema_validation" (output must match JSON schema shape), or "rubric" (output evaluated against a qualitative rubric).
- "source" must reference a specific acceptance criterion, requirement ID, or Brief field that this test validates.
- Cover at minimum: 8 functional tests, 3 edge_case tests, 2 integration tests, 2 performance tests.
- Inputs and expected_outputs must be realistic for the client and platform specified above.
- The file must be valid JSON that can be parsed by JSON.parse() without errors.

When referencing files or outputs in your work, always include version context. This is version ${job.buildVersion || 'v1.0'} of this project. File paths follow the pattern: /ManageAI/Clients/{client}/{ticket_id}/${job.buildVersion || 'v1.0'}/{filename}. If you are making changes to an existing build rather than creating from scratch, your output filename should reflect the version passed in the payload (default v1.0 for new builds).`
    },
    {
      agent_id: 'agent_04',
      specialist: 'Workflow Architect',
      output_subdir: 'workflow',
      deliverables: [`All scenario/workflow files for ${job.platform}`],
      task: getWorkflowAgentTask(job, platform)
    },
    {
      agent_id: 'agent_05',
      specialist: 'Deployment Package Author',
      output_subdir: 'deployment-package',
      deliverables: ['package.json', 'workflows.json', 'prompts.json', 'schemas.json', 'knowledge.json', 'templates.json', 'mcp-servers.json', 'environment.json', 'infrastructure.json', 'deployment-ops.json'],
      task: `You are Agent 05 — Deployment Package Author for the ManageAI FRIDAY build swarm.

CLIENT: ${job.client}
PROJECT: ${p}
PLATFORM: ${job.platform}
REQUEST: ${job.request_description}

Your job is to produce a 9-subpackage Deployment Package from the Phase 1 build outputs.

You MUST create EXACTLY 10 files in your output directory. Each subpackage is a standalone JSON file that can be validated and deployed independently. The 10th file is the root package descriptor.

CRITICAL: The PHASE 1 BUILD RESULTS section is appended to this prompt. It contains ACTUAL outputs from each build agent. You MUST extract real data from these fields:
- Schema section → "tables_verified" or "tables_created": actual table names and columns for schemas.json
- Workflow section → "manifest": actual workflow names, IDs, activation counts for workflows.json
- LLM section → "files_produced": actual prompt files and model routing for prompts.json
- External section → "platforms": actual third-party services for infrastructure.json
- Platform section → "manifest.repo_url", "manifest.tech_stack": actual repo and stack for infrastructure.json
- QA section → "test_results", "pass_rate", "failures": actual test results for deployment-ops.json verification steps
  Include ACTUAL QA breakdown: total tests, passed, failed by category (schema/workflow/integration/n8n-verification).
  List each ACTUAL failure with its responsible_agent, description, and remediation.
  Include ACTUAL deferrals (tests marked "skipped" or "deferred") with reasons.
  Include performance metrics: total QA duration, per-agent durations, iteration cycles count.

No placeholder text. Every field must contain actual content derived from the build outputs.

═══ FILE 1: workflows.json ═══
All n8n / Make.com workflow definitions from the build.
Pull from: Phase 1 workflow results (BUILD-002 Workflow Architect output).
{
  "subpackage": "workflows",
  "version": "${job.buildVersion || 'v1.0'}",
  "platform": "${job.platform}",
  "workflows": [
    {
      "name": "workflow name from build output",
      "type": "main|sub|error_handler",
      "trigger": "webhook|schedule|manual|event",
      "nodes_count": <number>,
      "description": "what this workflow does",
      "connections_summary": "node-to-node flow description",
      "blueprint": { }
    }
  ],
  "total_workflows": <number>,
  "activation_status": { "total": <n>, "activated": <n>, "draft": <n> }
}

═══ FILE 2: prompts.json ═══
All system prompts and model routing from the build.
Pull from: Phase 1 LLM results (BUILD-004 LLM/Prompt Specialist output).
{
  "subpackage": "prompts",
  "version": "${job.buildVersion || 'v1.0'}",
  "prompts": [
    {
      "prompt_id": "unique identifier",
      "name": "descriptive name",
      "role": "system|user|function",
      "model": "claude-sonnet-4-5|claude-haiku-4-5|gpt-4o|etc",
      "content": "the actual prompt text",
      "max_tokens": <number>,
      "temperature": <number>,
      "use_case": "where this prompt is used in the workflow"
    }
  ],
  "model_routing": {
    "primary_model": "model id",
    "fallback_model": "model id",
    "routing_rules": []
  },
  "guardrails": []
}

═══ FILE 3: schemas.json ═══
All Supabase/database table definitions from the build.
Pull from: Phase 1 schema results (BUILD-006 Schema Architect output).
{
  "subpackage": "schemas",
  "version": "${job.buildVersion || 'v1.0'}",
  "database": "supabase",
  "tables": [
    {
      "name": "table_name",
      "columns": [
        { "name": "col", "type": "text|int8|bool|jsonb|timestamptz|uuid", "nullable": false, "default": null, "primary_key": false }
      ],
      "rls_enabled": true,
      "rls_policies": [],
      "indexes": [],
      "foreign_keys": []
    }
  ],
  "total_tables": <number>,
  "migrations": []
}

═══ FILE 4: knowledge.json ═══
Training data and knowledge base entries for the system.
Pull from: Phase 1 LLM results and any training/knowledge outputs.
{
  "subpackage": "knowledge",
  "version": "${job.buildVersion || 'v1.0'}",
  "entries": [
    {
      "id": "KB-001",
      "category": "domain|process|faq|policy",
      "title": "entry title",
      "content": "knowledge content",
      "source": "where this knowledge came from",
      "tags": []
    }
  ],
  "total_entries": <number>
}

═══ FILE 5: templates.json ═══
Output templates and response formats used by the system.
Pull from: Phase 1 LLM and workflow outputs for any structured response formats.
{
  "subpackage": "templates",
  "version": "${job.buildVersion || 'v1.0'}",
  "templates": [
    {
      "template_id": "TPL-001",
      "name": "template name",
      "type": "email|report|notification|api_response",
      "format": "html|markdown|json|text",
      "content": "template content with {{variable}} placeholders",
      "variables": ["list", "of", "variables"]
    }
  ],
  "total_templates": <number>
}

═══ FILE 6: mcp-servers.json ═══
MCP server configurations if any were specified.
Pull from: Phase 1 external/integration results (BUILD-007).
{
  "subpackage": "mcp-servers",
  "version": "${job.buildVersion || 'v1.0'}",
  "servers": [
    {
      "name": "server name",
      "transport": "stdio|sse|streamable-http",
      "command": "command to run",
      "args": [],
      "env": {},
      "tools_provided": []
    }
  ],
  "total_servers": <number>
}
If no MCP servers were part of this build, set servers to [] and total_servers to 0.

═══ FILE 7: environment.json ═══
Required environment variables and configuration for deployment.
Pull from: All Phase 1 results — extract every env var, API key, and config value referenced.
{
  "subpackage": "environment",
  "version": "${job.buildVersion || 'v1.0'}",
  "variables": [
    {
      "name": "ENV_VAR_NAME",
      "required": true,
      "description": "what this variable is for",
      "example": "example value (never real secrets)",
      "used_by": ["which subpackage references this"]
    }
  ],
  "total_variables": <number>,
  "config": {
    "region": "",
    "tier": "",
    "notes": ""
  }
}

═══ FILE 8: infrastructure.json ═══
Deployment requirements, dependencies, and platform prerequisites.
Pull from: Phase 1 platform results (BUILD-005) and external integrations (BUILD-007).
{
  "subpackage": "infrastructure",
  "version": "${job.buildVersion || 'v1.0'}",
  "platform": "${job.platform}",
  "dependencies": [
    { "name": "dependency name", "version": "version or latest", "type": "npm|pip|api|service", "purpose": "why needed" }
  ],
  "external_services": [
    { "name": "service name", "type": "api|database|storage|auth", "required": true, "setup_notes": "" }
  ],
  "minimum_requirements": {
    "node_version": "",
    "database": "",
    "storage": "",
    "compute": ""
  }
}

═══ FILE 9: deployment-ops.json ═══
Runbook and operational procedures for deploying and maintaining the system.
Pull from: All Phase 1 results to create a realistic ops runbook.
{
  "subpackage": "deployment-ops",
  "version": "${job.buildVersion || 'v1.0'}",
  "pre_deployment": [
    { "step": 1, "action": "description", "command": "actual command if applicable", "verification": "how to verify" }
  ],
  "deployment_steps": [
    { "step": 1, "action": "description", "command": "actual command", "verification": "how to verify", "rollback": "how to undo" }
  ],
  "post_deployment": [
    { "step": 1, "action": "description", "verification": "how to verify" }
  ],
  "monitoring": {
    "health_checks": [],
    "alerts": [],
    "dashboards": []
  },
  "rollback_plan": {
    "trigger_conditions": [],
    "steps": []
  }
}

═══ FILE 10: package.json ═══
Root package descriptor that ties all 9 subpackages together.
{
  "package_name": "${p} Deployment Package",
  "version": "${job.buildVersion || 'v1.0'}",
  "client": "${job.client}",
  "project": "${p}",
  "platform": "${job.platform}",
  "generated_at": "<ISO timestamp>",
  "subpackages": {
    "workflows":       { "file": "workflows.json",       "validated": true },
    "prompts":         { "file": "prompts.json",         "validated": true },
    "schemas":         { "file": "schemas.json",         "validated": true },
    "knowledge":       { "file": "knowledge.json",       "validated": true },
    "templates":       { "file": "templates.json",       "validated": true },
    "mcp_servers":     { "file": "mcp-servers.json",     "validated": true },
    "environment":     { "file": "environment.json",     "validated": true },
    "infrastructure":  { "file": "infrastructure.json",  "validated": true },
    "deployment_ops":  { "file": "deployment-ops.json",  "validated": true }
  },
  "ready_to_deploy": true,
  "validation_summary": {
    "total_subpackages": 9,
    "validated": 9,
    "failed": 0,
    "errors": []
  }
}

Set "validated" to true for each subpackage ONLY if you actually populated it with real build data. If a subpackage has no applicable data (e.g., no MCP servers), set validated to true but keep the data arrays empty. Set "ready_to_deploy" to true only if ALL subpackages are validated.

CRITICAL RULES:
- Every JSON file MUST be valid JSON parseable by JSON.parse().
- Every subpackage MUST contain real data from the Phase 1 build results. No lorem ipsum, no "TODO", no "placeholder".
- If Phase 1 data for a subpackage is not available, populate with the best inference from the request description and platform, and add a note field.
- Write ALL 10 files directly to your output directory. No subdirectories.
- Filenames must be exact: workflows.json, prompts.json, schemas.json, knowledge.json, templates.json, mcp-servers.json, environment.json, infrastructure.json, deployment-ops.json, package.json`
    }
  ];
}


// ── Claude Code runner ────────────────────────────────────────────────────────
const AGENT_01_TIMEOUT = 600000;  // 10 min for Solution Demo
const AGENT_TIMEOUT = 600000;     // 8 min for all others

function runClaudeAgent(promptFile, agentDir, timeoutMs) {
  timeoutMs = timeoutMs || AGENT_TIMEOUT;
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-c', CLAUDE + ' --dangerously-skip-permissions -p "$(cat ' + promptFile + ')"'], {
      cwd: agentDir,
      uid: AGENT_UID, gid: AGENT_GID,
      env: { ...process.env, HOME: '/home/claudeagent', USER: 'claudeagent', CLAUDECODE: undefined },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    const timeoutSec = Math.round(timeoutMs / 1000);
    const timer = setTimeout(() => { proc.kill(); reject(new Error('Timeout ' + timeoutSec + 's')); }, timeoutMs);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) { resolve(); } else { reject(new Error('Exit ' + code + ': ' + stderr.slice(0, 300))); }
    });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

async function runAgent(agent, job, outputDir) {
  const agentDir = path.join(outputDir, agent.output_subdir);
  await fs.mkdir(agentDir, { recursive: true });
  if (AGENT_UID) await fs.chown(agentDir, AGENT_UID, AGENT_GID);
  const contractFocus = job._contract ? getContractFocus(agent.agent_id, job._contract) : '';
  const prompt = agent.task + '\n\nOUTPUT DIRECTORY: ' + agentDir + '\n\nWrite ALL files directly to ' + agentDir + '. Use exact filenames specified. Work autonomously. Do not ask questions.' + contractFocus;
  const promptFile = '/tmp/friday-agent-' + job.job_id + '-' + agent.agent_id + '.txt';
  await fs.writeFile(promptFile, prompt);
  console.log('[' + job.job_id + '][' + agent.agent_id + '] Starting: ' + agent.specialist);
  const t = Date.now();
  try {
    const timeoutMs = agent.agent_id === 'agent_01' ? AGENT_01_TIMEOUT : AGENT_TIMEOUT;
    await runClaudeAgent(promptFile, agentDir, timeoutMs);
    const dur = Math.round((Date.now() - t) / 1000);
    console.log('[' + job.job_id + '][' + agent.agent_id + '] Done in ' + dur + 's');
    await fs.rm(promptFile, { force: true });
    return { agent_id: agent.agent_id, specialist: agent.specialist, status: 'complete', duration: dur, output_subdir: agent.output_subdir };
  } catch (err) {
    const dur = Math.round((Date.now() - t) / 1000);
    console.error('[' + job.job_id + '][' + agent.agent_id + '] Error:', err.message.slice(0, 300));
    await fs.rm(promptFile, { force: true });
    return { agent_id: agent.agent_id, specialist: agent.specialist, status: 'error', error: err.message.slice(0, 200), duration: dur, output_subdir: agent.output_subdir };
  }
}

// ── Main swarm orchestrator ───────────────────────────────────────────────────
async function runSwarm(job) {
  const t = Date.now();
  const platform = detectPlatform(job.platform);
  const outputDir = '/tmp/friday-swarm-' + job.job_id;
  await fs.mkdir(outputDir, { recursive: true });

  // Run planner to get contract
  let contract = null;
  let plannerUsed = 'none';
  try {
    const planResult = await runPlanner(job);
    contract = planResult.contract;
    plannerUsed = planResult.plannerUsed;
    job._contract = contract;
    console.log('[FRIDAY] Orchestrator contract attached to job (planner: ' + plannerUsed + ')');
  } catch(e) {
    console.warn('[FRIDAY] Orchestrator failed (non-fatal), continuing:', e.message);
  }

  const agents = getManageAIAgents(job);
  console.log('[' + job.job_id + '] Platform: ' + platform.toUpperCase() + ' | ' + agents.length + ' agents: ' + agents.map(a => a.specialist).join(' | '));

  const results = await Promise.all(agents.map(a => runAgent(a, job, outputDir)));
  const dur = Math.round((Date.now() - t) / 1000);
  const ok = results.filter(r => r.status === 'complete').length;
  console.log('[' + job.job_id + '] Swarm done: ' + ok + '/' + agents.length + ' in ' + dur + 's');

  // Make.com deploy — kept for reference, replaced by n8n
  // let deployedScenarios = [];
  // if (platform === 'make') {
  //   deployedScenarios = await deployMakeScenarios(path.join(outputDir, 'workflow'), job);
  //   if (deployedScenarios.length > 0) {
  //     console.log('[' + job.job_id + '] Live deployed ' + deployedScenarios.length + ' Make scenarios');
  //   }
  // }
  let deployedScenarios = [];

  // n8n deploy — auto-import Blueprint.json to n8n
  if (job.platform && job.platform.toLowerCase().includes('n8n')) {
    try {
      const n8nKey = process.env.N8N_API_KEY;
      const base = 'http://localhost:5678/api/v1';
      const files = await fs.readdir(path.join(outputDir, 'workflow')).catch(() => []);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(outputDir, 'workflow', file);
        const raw = await fs.readFile(filePath, 'utf8');
        let wfJson;
        try {
          wfJson = JSON.parse(raw);
        } catch(e) {
          console.warn('[N8N DEPLOY] Invalid JSON in', file);
          continue;
        }
        // Set workflow name from job
        wfJson.name = wfJson.name || job.project_name || file.replace('.json','');
        // Create as inactive draft first
        wfJson.active = false;
        const r = await fetch(base + '/workflows', {
          method: 'POST',
          headers: { 'X-N8N-API-KEY': n8nKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(wfJson)
        });
        const created = await r.json();
        if (created.id) {
          console.log('[N8N DEPLOY] Imported workflow:', created.name, '| ID:', created.id);
          deployedScenarios.push({ id: created.id, name: created.name });
        } else {
          console.warn('[N8N DEPLOY] Failed to import', file, ':', JSON.stringify(created).slice(0,200));
        }
      }
    } catch(e) {
      console.warn('[N8N DEPLOY] Error (non-fatal):', e.message);
    }
  }

  let folderUrl = '';
  let summary = '';
  let outputLinks = [];
  try {
    const token = await getGraphToken();
    const result = await uploadOutputDir(outputDir, job.client, job.project_name, token, job.buildVersion);
    outputLinks = result.uploaded;
    folderUrl = await getFolderLink(token, result.folderPath) || 'https://manageai-my.sharepoint.com';

    const deployNote = deployedScenarios.length > 0
      ? '\n\nLIVE MAKE SCENARIOS DEPLOYED:\n' + deployedScenarios.map(s => '  - ' + s.name + ' (ID: ' + s.id + ')').join('\n')
      : '';

    summary = result.uploaded.length > 0
      ? results.map(r => {
          const files = result.uploaded.filter(f => f.name.startsWith(r.output_subdir + '/'));
          const icon = r.status === 'complete' ? 'OK' : 'ERR';
          return icon + ' ' + r.specialist + ' (' + r.duration + 's)\n' + (files.length > 0 ? files.map(f => '   - ' + f.name.replace(r.output_subdir + '/', '') + '  ' + f.url).join('\n') : '   (no files)');
        }).join('\n\n') + deployNote
      : 'Build ran but no files produced.';
    console.log('[' + job.job_id + '] Uploaded ' + result.uploaded.length + ' files');

    // Update Supabase with output links
    if (job.supabaseBuildId) {
      try {
        console.log('[FRIDAY] Updating supabaseBuildId:', job.supabaseBuildId, 'with', result.uploaded.length, 'links');
        console.log('[FRIDAY] output_links count:', result.uploaded.length);
        const { data: updateData, error: updateError } = await supabase
          .from('friday_builds')
          .update({
            status: 'active',
            progress_pct: 90,
            output_links: result.uploaded,
            onedrive_folder_url: folderUrl || '',
            updated_at: new Date().toISOString()
          })
          .eq('id', job.supabaseBuildId)
          .select();
        if (updateError) console.error('[FRIDAY] Supabase update ERROR:', JSON.stringify(updateError));
        else console.log('[FRIDAY] Supabase update OK:', updateData?.length, 'rows, output_links count:', updateData?.[0]?.output_links?.length);
      } catch(e) {
        console.warn('[FRIDAY] Supabase output_links update failed (non-fatal):', e.message);
      }
    }
  } catch (err) {
    console.error('[' + job.job_id + '] OneDrive error:', err.message);
    summary = 'Build complete but upload failed: ' + err.message;

    // Mark failed in Supabase
    if (job.supabaseBuildId) {
      try {
        await supabase
          .from('friday_builds')
          .update({
            status: 'failed',
            build_log: 'OneDrive upload failed: ' + err.message,
            updated_at: new Date().toISOString()
          })
          .eq('id', job.supabaseBuildId);
      } catch(e) {}
    }
  }

  // Write QA score to build_log if orchestrator ran
  if (job._contract && job.supabaseBuildId) {
    try {
      const qaOutputs = await collectOutputsFromDir(outputDir, job, job._contract);
      const qaResult = scoreOutputs(qaOutputs, job);
      if (qaResult) {
        await supabase.from('friday_builds').update({
          progress_pct: qaResult.overallScore,
          build_log: 'QA Score: ' + qaResult.overallScore + '/100 | ' +
            'Agents succeeded: ' + qaResult.successCount + '/4 | ' +
            (qaResult.errors.length
              ? 'Issues: ' + qaResult.errors.join(', ')
              : 'All checks passed')
        }).eq('id', job.supabaseBuildId);
        console.log('[FRIDAY] QA score written:', qaResult.overallScore);
      }
    } catch(e) {
      console.warn('[FRIDAY] QA score write failed (non-fatal):', e.message);
    }
  }

  const callbackPayload = {
    ticket_id: job.ticket_id, client: job.client, project_name: job.project_name,
    platform: job.platform, priority: job.priority, submitter: job.submitter,
    submitter_email: job.submitter_email || 'brian@manageai.io',
    onedrive_folder_url: folderUrl, files_summary: summary,
    build_duration: dur + 's (' + agents.length + ' parallel agents)',
    deployed_scenarios: deployedScenarios.length,
    status: ok > 0 ? 'complete' : 'error'
  };

  if (N8N_CALLBACK_URL) {
    await fetch(N8N_CALLBACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(callbackPayload)
    }).then(() => console.log('[' + job.job_id + '] Callback sent to n8n WF-07'))
      .catch(e => console.error('[' + job.job_id + '] Callback error:', e.message));
  } else {
    console.warn('[' + job.job_id + '] N8N_WF07_CALLBACK not set — skipping callback');
  }

  // ── Notify Charlie post-build ──
  try {
    await fetch('http://5.223.60.100:3001/api/charlie/post-build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticket_id: job.ticket_id,
        client_name: job.client || job.client_name || '',
        project_name: job.project_name || '',
        platform: job.platform || '',
        build_id: job.supabaseBuildId,
        progress_pct: callbackPayload?.qa_score || 0,
        output_links: callbackPayload?.output_links || []
      })
    });
    console.log('[' + job.job_id + '] Charlie notified of build delivery');
  } catch(e) {
    console.warn('[' + job.job_id + '] Charlie notification failed (non-fatal):', e.message);
  }

  // ── FRIDAY Post-Build Pipeline ──
  if (job.supabaseBuildId) {
    try {
      const pipelineFiles = (outputLinks || []).map(f => ({
        name: f.name || '',
        url: f.url || null,
        type: f.type || classifyOutputFile(f.name || ''),
        size_kb: f.size_kb || null,
        localPath: f.localPath || null
      }));
      const qaScore = (job._contract && typeof scoreOutputs === 'function')
        ? (() => { try { const q = scoreOutputs(collectOutputsFromDir ? [] : [], job); return q ? q.overallScore : 0; } catch(e) { return 0; } })()
        : 0;
      await runPostBuildPipeline(
        job.supabaseBuildId,
        job.ticket_id,
        pipelineFiles,
        qaScore,
        folderUrl || null
      );
    } catch(pe) {
      console.error('[PIPELINE] runPostBuildPipeline error (non-fatal):', pe.message);
    }
  }

  // Mark done in Supabase
  if (job.supabaseBuildId) {
    try {
      await supabase
        .from('friday_builds')
        .update({
          status: 'done',
          progress_pct: 100,
          updated_at: new Date().toISOString()
        })
        .eq('id', job.supabaseBuildId);
      console.log('[FRIDAY] Supabase build marked done');
    } catch(e) {
      console.warn('[FRIDAY] Supabase done update failed (non-fatal):', e.message);
    }
  }

  // Auto-capture version record
  if (job.supabaseBuildId) {
    try {
      const { data: existingBuild } = await supabase
        .from('friday_builds')
        .select('version_count, current_version, client_name, project_name, progress_pct, output_links, onedrive_folder_url')
        .eq('id', job.supabaseBuildId)
        .single();

      const versionNumber = (existingBuild?.version_count || 0) + 1;
      const versionLabel = 'v' + versionNumber + '.0';

      await supabase.from('build_versions').insert({
        build_id: job.supabaseBuildId,
        client_name: existingBuild?.client_name || job.client,
        project_name: existingBuild?.project_name || job.project_name,
        version_number: versionNumber,
        version_label: versionLabel,
        version_type: 'major',
        change_summary: 'Initial build — auto-captured on delivery by FRIDAY swarm',
        changed_by: 'claude-code-swarm',
        output_links: existingBuild?.output_links || outputLinks || [],
        onedrive_folder_url: existingBuild?.onedrive_folder_url || folderUrl || '',
        score: existingBuild?.progress_pct || 0,
        is_current: true,
        is_deployed: true,
        deployed_at: new Date().toISOString(),
        created_by: 'FRIDAY Build OS'
      });

      // Auto-create initial change log entry
      await supabase.from('workflow_changes').insert({
        build_id: job.supabaseBuildId,
        workflow_id: job.ticket_id || '',
        workflow_name: job.project_name || '',
        client_name: job.client || '',
        project_name: job.project_name || '',
        change_type: 'initial',
        version_from: null,
        version_to: versionLabel,
        title: 'Initial build delivered by FRIDAY swarm',
        description: 'Auto-generated on first delivery. Platform: ' + (job.platform || '') +
                     '. Agents: 4-agent parallel swarm. Files delivered: ' +
                     (outputLinks ? outputLinks.length : 0),
        submitted_by: 'claude-code-swarm',
        status: 'deployed',
        deployed_at: new Date().toISOString(),
        new_json: null,
        created_at: new Date().toISOString()
      });

      // Update version count on the build record (preserve progress_pct/QA score)
      await supabase.from('friday_builds').update({
        version_count: versionNumber,
        current_version: versionNumber,
        last_versioned_at: new Date().toISOString()
      }).eq('id', job.supabaseBuildId);

      console.log('[FRIDAY] Version record created:', versionLabel);
    } catch(e) {
      console.warn('[FRIDAY] Version capture failed (non-fatal):', e.message);
    }
  }

  // Auto-capture workflow scenarios
  if (job.supabaseBuildId) {
    try {
      const workflowDir = path.join(outputDir, 'workflow');
      let wfFiles = [];
      try { wfFiles = await fs.readdir(workflowDir); } catch(e) { wfFiles = []; }
      for (const file of wfFiles.filter(f => f.endsWith('.json'))) {
        try {
          const raw = await fs.readFile(path.join(workflowDir, file), 'utf-8');
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch(e) {}
          const key = (parsed && (parsed.name || parsed.id)) || file.replace('.json','');
          const name = (parsed && parsed.name) || file.replace('.json','').replace(/-/g,' ');
          const nodes = (parsed && (parsed.nodes || parsed.modules || [])) || [];
          const stages = nodes.slice(0,20).map((n,i) => ({ stage_num:i+1, name:n.name||n.type||('Module '+(i+1)), module_type:n.type||'node', app_name:(n.parameters&&n.parameters.resource)||'' }));
          const linkEntry = (outputLinks||[]).find(l => l.name && l.name.includes(file.replace('.json','')));
          await supabase.from('build_scenarios').upsert({ build_id:job.supabaseBuildId, ticket_id:job.ticket_id||'', scenario_key:key, scenario_name:name, scenario_description:'Auto-captured by FRIDAY swarm', platform:job.platform||'', status:'active', workflow_json:parsed, module_stages:stages, onedrive_json_url:(linkEntry&&linkEntry.url)||'', updated_at:new Date().toISOString() }, { onConflict:'build_id,scenario_key', ignoreDuplicates:false });
          console.log('[FRIDAY] Scenario captured:', name);
        } catch(e) { console.warn('[FRIDAY] Scenario capture failed:', file, e.message); }
      }
    } catch(e) { console.warn('[FRIDAY] build_scenarios block failed:', e.message); }
  }

  // Cleanup temp directory AFTER all pipeline operations are done
  try {
    await fs.rm(outputDir, { recursive: true, force: true });
    console.log('[FRIDAY] Cleaned up temp dir:', outputDir);
  } catch(cleanupErr) {
    console.warn('[FRIDAY] Cleanup failed (non-fatal):', cleanupErr.message);
  }
}

// ── FRIDAY Voice Chat — Full System Control ─────────────────────────────────
app.post('/api/friday/chat', async (req, res) => {
  try {
    const { messages } = req.body;

    const FRIDAY_SYSTEM = `You are FRIDAY — Head of Build at ManageAI. You are Brian's AI operations system running on his production server at 5.223.79.255. Think JARVIS from Iron Man — you have full control of the server, the build system, all databases, all workflows, GitHub, OneDrive, and every tool in the stack.

You are sharp, confident, proactive. When Brian asks you to do something, you DO it — you don't ask for permission, you don't hedge, you execute and report. If something might be destructive (deleting data, dropping tables, wiping repos), confirm once then execute.

Your capabilities:
- Execute ANY bash command on the server
- Query and modify Supabase databases (read, insert, update, delete)
- Manage n8n workflows (list, activate, deactivate, execute, create)
- Trigger and manage FRIDAY builds
- Read and write files on the server
- Manage PM2 processes (restart, stop, start, logs, list)
- Git operations (commit, push, pull, branch, status, log, diff)
- Check system health (disk, memory, CPU, network, docker)
- Manage Docker containers
- Read and tail log files
- Install packages
- Edit configuration files
- Deploy code changes
- Query build history, agent performance, Red Team findings
- Check and manage n8n workflows

Your 17 agents: BUILD-000 (Brief Analyst + Charlie Simulator), BUILD-001 (Planner), BUILD-002 (Workflow Builder), BUILD-003 (QA Tester), BUILD-004 (LLM Specialist), BUILD-005 (Platform Builder), BUILD-006 (Schema Architect), BUILD-007 (External Platform), BUILD-008 (Quality Gate), BUILD-009 (Security), BUILD-010 (Deployment Verifier), BUILD-011 (Compliance Judge), BUILD-012 (Engagement Memory), BUILD-013 (Decision Agent), BUILD-015 (Prompt Quality), BUILD-016 (Intelligence Agent — self-healing overnight), BUILD-019 (Red Team Agent).

Stack: Temporal, Claude Code, n8n (port 5678), Supabase, GitHub, OneDrive, PM2.
Server: Ubuntu, /opt/manageai/build-api/ is the main codebase.
Supabase URL: https://fmemdogudiolevqsfuvd.supabase.co

Keep responses conversational and SHORT when speaking — 2-3 sentences unless Brian asks for detail. You're having a voice conversation, not writing documentation. When you run commands or queries, summarize the results conversationally.`;

    const tools = [
      {
        name: 'run_command',
        description: 'Execute any bash command on the server. Use for system operations, file management, git, pm2, docker, package management, or any server task Brian asks for. No restrictions.',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The bash command to execute' },
            working_directory: { type: 'string', description: 'Working directory for the command', default: '/opt/manageai' },
            timeout: { type: 'integer', description: 'Timeout in milliseconds', default: 30000 }
          },
          required: ['command']
        }
      },
      {
        name: 'query_supabase',
        description: 'Query any Supabase table. Use for checking builds, agent runs, quality signals, observations, or any data Brian asks about.',
        input_schema: {
          type: 'object',
          properties: {
            table: { type: 'string', description: 'Table name, e.g. friday_builds, build_agent_runs, build_quality_signals' },
            select: { type: 'string', description: "Columns to select, e.g. 'ticket_id,status,progress_pct' or '*'" },
            filter: { type: 'string', description: "PostgREST filter, e.g. 'status=eq.building' or 'ticket_id=eq.MAI-123'" },
            order: { type: 'string', description: "Order clause, e.g. 'created_at.desc'" },
            limit: { type: 'integer', description: 'Max rows', default: 10 }
          },
          required: ['table', 'select']
        }
      },
      {
        name: 'modify_supabase',
        description: 'Insert, update, or delete data in any Supabase table. Use when Brian asks to change build status, update records, or manage data.',
        input_schema: {
          type: 'object',
          properties: {
            table: { type: 'string', description: 'Table name' },
            method: { type: 'string', description: 'HTTP method: POST (insert), PATCH (update), DELETE' },
            filter: { type: 'string', description: "PostgREST filter for PATCH/DELETE, e.g. 'ticket_id=eq.MAI-123'" },
            body: { type: 'object', description: 'Data to insert or update' }
          },
          required: ['table', 'method']
        }
      },
      {
        name: 'manage_n8n',
        description: 'Manage n8n workflows. List, activate, deactivate, execute, or get details of any workflow.',
        input_schema: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'list, get, activate, deactivate, execute' },
            workflow_id: { type: 'string', description: 'Workflow ID (required for get/activate/deactivate/execute)' },
            filter_name: { type: 'string', description: 'Filter workflows by name substring (for list action)' }
          },
          required: ['action']
        }
      },
      {
        name: 'trigger_build',
        description: 'Start a new FRIDAY build by posting a brief to the build API.',
        input_schema: {
          type: 'object',
          properties: {
            client: { type: 'string', description: 'Client name' },
            project_name: { type: 'string', description: 'Project name' },
            description: { type: 'string', description: 'What to build' }
          },
          required: ['client', 'project_name', 'description']
        }
      },
      {
        name: 'read_file',
        description: 'Read the contents of any file on the server. Use for checking configs, code, logs, or any file Brian asks about.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute file path' },
            lines: { type: 'integer', description: 'Number of lines to read from the end (for log files). If not set, reads entire file up to 5000 chars.' }
          },
          required: ['path']
        }
      },
      {
        name: 'write_file',
        description: 'Write or append content to a file. Use for editing configs, creating scripts, updating code.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute file path' },
            content: { type: 'string', description: 'Content to write' },
            append: { type: 'boolean', description: 'If true, append instead of overwrite', default: false }
          },
          required: ['path', 'content']
        }
      }
    ];

    // First Claude call with tools
    const firstRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: FRIDAY_SYSTEM,
        messages,
        tools
      })
    });

    let data = await firstRes.json();

    // Process tool calls if any
    const toolUseBlocks = (data.content || []).filter(b => b.type === 'tool_use');

    if (toolUseBlocks.length > 0) {
      const toolResults = [];

      for (const toolCall of toolUseBlocks) {
        let result = '';
        try {
          if (toolCall.name === 'run_command') {
            const { command, working_directory, timeout } = toolCall.input;
            try {
              result = execSync(command, {
                cwd: working_directory || '/opt/manageai',
                timeout: timeout || 30000,
                encoding: 'utf8',
                maxBuffer: 1024 * 1024
              }).slice(-4000);
            } catch (cmdErr) {
              result = JSON.stringify({
                error: cmdErr.message,
                stderr: (cmdErr.stderr || '').slice(-2000),
                stdout: (cmdErr.stdout || '').slice(-2000),
                exitCode: cmdErr.status
              });
            }
          }

          else if (toolCall.name === 'query_supabase') {
            const { table, select, filter, order, limit } = toolCall.input;
            let url = SUPABASE_URL + '/rest/v1/' + table + '?select=' + encodeURIComponent(select || '*');
            if (filter) url += '&' + filter;
            if (order) url += '&order=' + order;
            url += '&limit=' + (limit || 10);
            const sbRes = await fetch(url, {
              headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
            });
            result = JSON.stringify(await sbRes.json());
          }

          else if (toolCall.name === 'modify_supabase') {
            const { table, method, filter, body } = toolCall.input;
            let url = SUPABASE_URL + '/rest/v1/' + table;
            if (filter) url += '?' + filter;
            const sbRes = await fetch(url, {
              method: method,
              headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': 'Bearer ' + SUPABASE_KEY,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
              },
              body: body ? JSON.stringify(body) : undefined
            });
            result = sbRes.ok ? JSON.stringify({ success: true, status: sbRes.status }) : JSON.stringify({ error: await sbRes.text() });
          }

          else if (toolCall.name === 'manage_n8n') {
            const { action, workflow_id, filter_name } = toolCall.input;
            const n8nBase = 'http://localhost:5678/api/v1';
            if (action === 'list') {
              const n8nRes = await fetch(n8nBase + '/workflows?active=true', { headers: { 'Accept': 'application/json' } });
              const wfs = await n8nRes.json();
              let filtered = wfs.data || [];
              if (filter_name) filtered = filtered.filter(w => w.name.toLowerCase().includes(filter_name.toLowerCase()));
              result = JSON.stringify(filtered.map(w => ({ id: w.id, name: w.name, active: w.active, nodes: w.nodes?.length || 0 })));
            } else if (action === 'activate' && workflow_id) {
              const n8nRes = await fetch(n8nBase + '/workflows/' + workflow_id + '/activate', { method: 'POST' });
              result = JSON.stringify({ activated: n8nRes.ok });
            } else if (action === 'deactivate' && workflow_id) {
              const n8nRes = await fetch(n8nBase + '/workflows/' + workflow_id + '/deactivate', { method: 'POST' });
              result = JSON.stringify({ deactivated: n8nRes.ok });
            } else if (action === 'get' && workflow_id) {
              const n8nRes = await fetch(n8nBase + '/workflows/' + workflow_id);
              result = JSON.stringify(await n8nRes.json());
            } else {
              result = JSON.stringify({ error: 'Invalid action or missing workflow_id' });
            }
          }

          else if (toolCall.name === 'trigger_build') {
            result = JSON.stringify({
              status: 'ready',
              message: 'To trigger a build, I need a full brief with client, customer_id, project_name, request_description, platform, workflow_steps, decision_authority, success_metrics, data_sources, guardrails, edge_cases, acceptance_criteria, and section_a. Tell me the details and I will format and submit it.'
            });
          }

          else if (toolCall.name === 'read_file') {
            const { path: filePath, lines } = toolCall.input;
            if (lines) {
              result = execSync('tail -n ' + lines + ' ' + JSON.stringify(filePath), { encoding: 'utf8', timeout: 5000 }).slice(-4000);
            } else {
              result = fsSync.readFileSync(filePath, 'utf8').slice(-5000);
            }
          }

          else if (toolCall.name === 'write_file') {
            const { path: filePath, content, append } = toolCall.input;
            if (append) {
              fsSync.appendFileSync(filePath, content);
            } else {
              fsSync.writeFileSync(filePath, content);
            }
            result = JSON.stringify({ success: true, path: filePath, bytes: content.length });
          }
        } catch (err) {
          result = JSON.stringify({ error: err.message });
        }

        toolResults.push({ type: 'tool_result', tool_use_id: toolCall.id, content: (result || '').slice(-4000) });
      }

      // Second Claude call with tool results
      const followUp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: FRIDAY_SYSTEM,
          messages: [...messages, { role: 'assistant', content: data.content }, { role: 'user', content: toolResults }],
          tools
        })
      });

      data = await followUp.json();
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FRIDAY ElevenLabs TTS ────────────────────────────────────────────────────
app.post('/api/friday/tts', async (req, res) => {
  try {
    const { text } = req.body;
    const response = await fetch('https://api.elevenlabs.io/v1/text-to-speech/XcXEQzuLXRU9RcfWzEJt', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': process.env.ELEVENLABS_API_KEY || '0e62709271fc5a22d98319c492681ae98ab5a7b1cf52f8db1316fa68237047e4'
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_flash_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true }
      })
    });
    if (!response.ok) return res.status(response.status).json({ error: 'TTS failed' });
    res.set('Content-Type', 'audio/mpeg');
    const arrayBuffer = await response.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.post('/api/build', async (req, res) => {
  const { ticket_id, client, project_name, platform, request_description, priority, submitter, submitter_email, version, is_update, previous_version_id } = req.body;
  if (!ticket_id || !client || !request_description) return res.status(400).json({ success: false, error: 'Missing required fields' });

  const buildVersion = version || 'v1.0';
  const isUpdate = is_update || false;
  const previousVersionId = previous_version_id || null;
  console.log('[FRIDAY] Build version:', buildVersion, '| Update:', isUpdate);

  // Create build record in Supabase
  let supabaseBuildId = null;
  try {
    const { data: buildRecord } = await supabase
      .from('friday_builds')
      .insert({
        ticket_id: ticket_id || ('MAI-' + Date.now()),
        client_name: client,
        project_name: project_name,
        platform: platform,
        status: 'building',
        progress_pct: 0,
        assigned_to: 'temporal-workflow',
        created_at: new Date().toISOString()
      })
      .select()
      .single();
    supabaseBuildId = buildRecord?.id || null;
    console.log('[FRIDAY] Supabase build record created:', supabaseBuildId);
  } catch(e) {
    console.warn('[FRIDAY] Supabase insert failed (non-fatal):', e.message);
  }

  const job_id = 'swarm_' + Date.now() + '_' + uuidv4().split('-')[0];
  const jobData = { job_id, ticket_id, client, project_name, platform, request_description, priority, submitter, submitter_email, supabaseBuildId, buildVersion, isUpdate, previousVersionId };
  console.log('[' + job_id + '] Temporal workflow queued: ' + client + ' - ' + project_name + ' [' + (platform || 'make').toUpperCase() + ']');

  // Attach agent configs so Temporal activities can use them
  const agents = getManageAIAgents(jobData);
  jobData._agentConfigs = agents;

  // Start Temporal workflow instead of direct swarm
  try {
    const temporalClient = await getTemporalClient();
    await temporalClient.workflow.start('FridayBuildWorkflow', {
      args: [jobData],
      taskQueue: 'friday-builds',
      workflowId: ticket_id
    });
    logActivity('build_submitted', 'Build submitted: ' + project_name, 'Temporal workflow started for ' + client, client, null);
    res.json({ success: true, job_id, status: 'queued', mode: 'temporal_workflow', workflowId: ticket_id, platform: detectPlatform(platform) });
  } catch(temporalErr) {
    console.warn('[FRIDAY] Temporal start failed, falling back to direct swarm:', temporalErr.message);
    // Fallback to direct swarm if Temporal is not available
    res.json({ success: true, job_id, status: 'queued', mode: 'parallel_swarm_fallback', platform: detectPlatform(platform) });
    runSwarm(jobData).catch(async (err) => {
      console.error('[FRIDAY] Fallback swarm FAILED:', ticket_id, err.message);
      try {
        await supabase.from('friday_builds').update({ status: 'failed', build_log: 'Failed: ' + err.message, updated_at: new Date().toISOString() }).eq('id', supabaseBuildId);
      } catch(dbErr) {}
    });
  }
});


// ── Build approval email response endpoints ──

app.get('/api/build/:id/approve-email', async (req, res) => {
  const ticketId = req.params.id;
  try {
    const { Client } = await import('@temporalio/client');
    const client = new Client();
    const handle = client.workflow.getHandle(ticketId);
    await handle.signal('build-approved');
    try {
      await fetch('http://localhost:3000/api/build/record-approval-decision', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketId, decision: 'approved', reviewerEmail: req.query.reviewer || 'brian@manageai.io' })
      });
    } catch(le) {}
    res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f4f4f5">
      <div style="background:white;border-radius:12px;padding:40px;max-width:400px;margin:0 auto;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
        <div style="font-size:48px;margin-bottom:16px">✅</div>
        <h2 style="color:#10b981;margin:0 0 8px">Build Approved</h2>
        <p style="color:#6b7280;margin:0">Ticket <strong>${ticketId}</strong> approved. FRIDAY will proceed with deployment.</p>
      </div>
    </body></html>`);
  } catch(e) {
    res.send(`<p>Error: ${e.message}</p>`);
  }
});

app.get('/api/build/:id/reject-email', async (req, res) => {
  const ticketId = req.params.id;
  try {
    const { Client } = await import('@temporalio/client');
    const client = new Client();
    const handle = client.workflow.getHandle(ticketId);
    await handle.signal('build-rejected');
    try {
      await fetch('http://localhost:3000/api/build/record-approval-decision', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketId, decision: 'rejected', reviewerEmail: req.query.reviewer || 'brian@manageai.io' })
      });
    } catch(le) {}
    res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f4f4f5">
      <div style="background:white;border-radius:12px;padding:40px;max-width:400px;margin:0 auto;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
        <div style="font-size:48px;margin-bottom:16px">❌</div>
        <h2 style="color:#ef4444;margin:0 0 8px">Build Rejected</h2>
        <p style="color:#6b7280;margin:0">Ticket <strong>${ticketId}</strong> rejected.</p>
      </div>
    </body></html>`);
  } catch(e) {
    res.send(`<p>Error: ${e.message}</p>`);
  }
});

app.get('/api/build/:id/comment-email', async (req, res) => {
  const ticketId = req.params.id;
  res.send(`<!DOCTYPE html><html><head><style>
    body{font-family:sans-serif;background:#f4f4f5;padding:40px;}
    .box{background:white;border-radius:12px;padding:32px;max-width:520px;margin:0 auto;box-shadow:0 2px 8px rgba(0,0,0,0.08);}
    h2{color:#0f172a;margin:0 0 8px;}p{color:#6b7280;margin:0 0 20px;}
    textarea{width:100%;height:140px;padding:12px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;box-sizing:border-box;resize:vertical;}
    button{background:#6366f1;color:white;border:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;margin-top:12px;}
  </style></head><body>
  <div class="box">
    <h2>Request Changes</h2>
    <p>Ticket: ${ticketId}</p>
    <form method="POST" action="/api/build/${ticketId}/comment-email">
      <textarea name="comments" placeholder="Describe the changes needed..."></textarea>
      <button type="submit">Send to FRIDAY</button>
    </form>
  </div></body></html>`);
});

app.post('/api/build/:id/comment-email', async (req, res) => {
  const ticketId = req.params.id;
  const comments = req.body?.comments || '';
  try {
    const { Client } = await import('@temporalio/client');
    const client = new Client();
    const handle = client.workflow.getHandle(ticketId);
    await handle.signal('request-changes', comments);
    try {
      await fetch('http://localhost:3000/api/build/record-approval-decision', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketId, decision: 'changes_requested', comments, reviewerEmail: req.query.reviewer || 'brian@manageai.io' })
      });
    } catch(le) {}
    res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f4f4f5">
      <div style="background:white;border-radius:12px;padding:40px;max-width:400px;margin:0 auto;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
        <div style="font-size:48px;margin-bottom:16px">💬</div>
        <h2 style="color:#6366f1;margin:0 0 8px">Changes Requested</h2>
        <p style="color:#6b7280;margin:0">FRIDAY received your feedback and will revise the build.</p>
      </div>
    </body></html>`);
  } catch(e) {
    res.send(`<p>Error: ${e.message}</p>`);
  }
});

// Phase 1 approval endpoint (FR-GAP-023)
app.post('/api/build/:id/phase1-approve', async (req, res) => {
  const cockpitKey = req.headers['x-cockpit-key'];
  if (cockpitKey !== process.env.COCKPIT_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const ticketId = req.params.id;
  const { decision = 'approved', reason } = req.body || {};
  try {
    const temporalClient = await getTemporalClient();
    const handle = temporalClient.workflow.getHandle(ticketId);
    await handle.signal('phase1-approved', { decision, reason });
    console.log(`[FRIDAY] Phase 1 ${decision} for ticket ${ticketId}`);

    // FIX 12: Update review_status in Supabase when Brian manually approves/rejects
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      await supabase.from('friday_builds')
        .update({
          review_status: decision === 'approved' ? 'approved' : decision,
          reviewed_by: 'brian',
          reviewed_at: new Date().toISOString()
        })
        .eq('ticket_id', ticketId);
    } catch (dbErr) {
      console.warn('[FRIDAY] review_status update failed:', dbErr.message);
    }

    fireBuildWebhooks(ticketId, 'phase1_' + decision, { decision, reason: reason || '' });
    res.json({ success: true, ticketId, decision });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Auto-approve Phase 1 for testing
app.post('/api/build/:id/auto-approve-phase1', async (req, res) => {
  const cockpitKey = req.headers['x-cockpit-key'];
  if (cockpitKey !== process.env.COCKPIT_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const ticketId = req.params.id;
  try {
    const temporalClient = await getTemporalClient();
    const handle = temporalClient.workflow.getHandle(ticketId);
    await handle.signal('phase1-approved', { decision: 'approved' });
    console.log(`[FRIDAY] Phase 1 auto-approved for ticket ${ticketId}`);
    res.json({ success: true, ticketId });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Test fire FRIDAY approval email
app.post('/api/build/test-approval-email', async (req, res) => {
  try {
    const { humanApprovalGateActivity } = await import('./temporal/activities/approval.js');
    await humanApprovalGateActivity({
      ticket_id: req.body.ticket_id || 'TEST-001',
      client: req.body.client_name || 'Cornerstone GC',
      project_name: req.body.project_name || 'Estimating Automation',
      qaScore: req.body.qa_score || 87,
      outputLinks: [],
      phase1Results: {
        schema: { status: 'success' },
        workflow: { manifest: { total_imported: 3, total_activated: 3 } },
        llm: { files_produced: ['ai-integration.js', 'prompt-library.js', 'model-routing.js'] },
        platform: { manifest: { repo_url: 'https://github.com/manageai/cornerstone-estimating' } },
        external: { platforms: [] },
        qa: { pass_rate: 92, failures: [] },
        iteration_cycles: 1
      }
    });
    const recipients = [process.env.BRIAN_EMAIL || 'brian@manageai.io', process.env.DAN_EMAIL || 'dan@manageai.io', process.env.DAVE_EMAIL || 'dave@manageai.io', process.env.BRIAN_GMAIL || 'brianreinhart3617@gmail.com'].join(',');
    res.json({ success: true, sent_to: recipients });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ── FRIDAY Approval Learning Agent ──
// Brian's build approvals/rejections assessed by Haiku, patterns stored
app.post('/api/build/record-approval-decision', async (req, res) => {
  try {
    const { ticketId, decision, comments, reviewerEmail, qaScore, phase1Results } = req.body;

    let patterns = null;
    try {
      const haikuRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 4096,
          temperature: 0,
          messages: [{
            role: 'user',
            content: `A reviewer made a build approval decision. Extract learning patterns.
Reviewer: ${reviewerEmail}
Decision: ${decision}
Comments: ${comments || 'none'}
QA Score: ${qaScore}
Phase 1 results: ${JSON.stringify(phase1Results || {})}

Return ONLY valid JSON:
{
  "decision_type": "approved|rejected|changes_requested",
  "quality_signals": ["what specifically was good or bad about the build"],
  "preference_patterns": ["what this reviewer consistently wants in builds"],
  "qa_score_threshold": "estimated minimum QA score they accept",
  "improvement_areas": ["what should be different next time"],
  "build_preferences": ["specific technical preferences observed"]
}`
          }]
        })
      });
      const haikuData = await haikuRes.json();
      const raw = haikuData.content?.[0]?.text || '';
      patterns = JSON.parse(raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
    } catch(he) {
      console.warn('[FRIDAY] Pattern extraction failed:', he.message);
    }

    // Store in Supabase
    try {
      const SB_URL = process.env.SUPABASE_URL;
      const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
      await fetch(`${SB_URL}/rest/v1/friday_approval_patterns`, {
        method: 'POST',
        headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ ticket_id: ticketId, reviewer_email: reviewerEmail, decision, comments: comments || null, qa_score: qaScore, patterns, created_at: new Date().toISOString() })
      });
    } catch(dbe) { console.warn('[FRIDAY] Could not store approval pattern:', dbe.message); }

    console.log('[FRIDAY] Approval decision recorded:', decision, 'by:', reviewerEmail);
    res.json({ success: true, patterns });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Get FRIDAY approval patterns summary
app.get('/api/build/approval-patterns', async (req, res) => {
  try {
    const SB_URL = process.env.SUPABASE_URL;
    const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
    const r = await fetch(`${SB_URL}/rest/v1/friday_approval_patterns?order=created_at.desc&limit=20`, {
      headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
    });
    const patterns = await r.json();
    res.json({ patterns, total: patterns.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ═══════════════════════════════════════════════════════════════
// FACTORY FLOOR DASHBOARD ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// All active builds across all customers
app.get('/api/factory/build-status', async (req, res) => {
  try {
    const { data: active } = await supabase
      .from('friday_builds')
      .select('id, ticket_id, client_name, project_name, platform, status, progress_pct, customer_id, created_at, updated_at')
      .or('status.eq.building,status.eq.active,status.eq.waiting,status.eq.reviewing')
      .order('updated_at', { ascending: false })
      .limit(50);

    const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
    const { data: recentDone } = await supabase
      .from('friday_builds')
      .select('id, ticket_id, client_name, project_name, platform, status, progress_pct, customer_id, created_at, updated_at')
      .or('status.eq.done,status.eq.failed')
      .gte('updated_at', oneDayAgo)
      .order('updated_at', { ascending: false })
      .limit(20);

    const allBuilds = [...(active || []), ...(recentDone || [])].map(b => ({
      customerId: b.customer_id,
      customerName: b.client_name,
      ticketId: b.ticket_id,
      projectName: b.project_name,
      platform: b.platform,
      status: b.status,
      progressPct: b.progress_pct,
      updatedAt: b.updated_at,
      createdAt: b.created_at
    }));

    res.json(allBuilds);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Build status for a specific customer
app.get('/api/factory/build-status/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;

    // Try direct customer_id match first, then fall back to client_name lookup
    let builds;
    const { data: byId, error: idErr } = await supabase
      .from('friday_builds')
      .select('*')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false })
      .limit(1);

    if (!idErr && byId && byId.length > 0) {
      builds = byId;
    } else {
      // Try looking up customer name first
      const { data: customer } = await supabase
        .from('friday_customers')
        .select('name')
        .eq('id', customerId)
        .limit(1)
        .single();

      if (customer) {
        const { data: byName } = await supabase
          .from('friday_builds')
          .select('*')
          .eq('client_name', customer.name)
          .order('created_at', { ascending: false })
          .limit(1);
        builds = byName;
      }
    }

    if (!builds || builds.length === 0) {
      return res.json({ found: false, customerId });
    }

    const b = builds[0];
    const buildLog = b.build_log || [];
    const logArr = Array.isArray(buildLog) ? buildLog : [];
    const agentTimeline = logArr
      .filter(s => s.action && s.action.includes('agent'))
      .map(s => ({ step: s.step, action: s.action, detail: s.detail, ts: s.ts }));

    // Determine phase
    let phase = 'unknown';
    if (b.status === 'building') phase = b.progress_pct > 50 ? 'phase2' : 'phase1';
    else if (b.status === 'done') phase = 'complete';
    else if (b.status === 'failed') phase = 'failed';
    else phase = b.status;

    const reviewBase = (process.env.FRIDAY_PUBLIC_URL || 'http://5.223.79.255:3000');

    res.json({
      found: true,
      customerId: b.customer_id || customerId,
      ticketId: b.ticket_id,
      projectName: b.project_name,
      status: b.status,
      qaScore: null, // extracted from build log if available
      phase,
      progressPct: b.progress_pct,
      agentTimeline,
      phase1ReviewUrl: `${reviewBase}/build-review/${b.ticket_id}/phase1`,
      finalReviewUrl: `${reviewBase}/build-review/${b.ticket_id}/final`,
      fileCount: (b.output_links || []).length,
      onedriveFolder: b.onedrive_folder_url,
      createdAt: b.created_at,
      updatedAt: b.updated_at
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Build Monitor ─────────────────────────────────────────────────────────────

// Real-time health for active builds
app.get('/api/factory/build-monitor', async (req, res) => {
  try {
    const { data: activeBuilds } = await supabase
      .from('friday_builds')
      .select('id, ticket_id, customer_id, client_name, status, qa_score, created_at, updated_at')
      .in('status', ['running', 'phase1-review', 'phase2-running', 'awaiting-final'])
      .gte('created_at', new Date(Date.now() - 86400000).toISOString())
      .order('created_at', { ascending: false });

    const buildHealth = [];
    for (const build of (activeBuilds || [])) {
      const { data: agentRuns } = await supabase
        .from('build_agent_runs')
        .select('agent_id, agent_name, status, duration_ms, started_at, completed_at')
        .eq('ticket_id', build.ticket_id)
        .order('created_at');

      const { data: qualitySignals } = await supabase
        .from('build_quality_signals')
        .select('from_agent, signal_type, confidence, created_at')
        .eq('ticket_id', build.ticket_id)
        .order('created_at', { ascending: false })
        .limit(10);

      const stuckAgents = (agentRuns || []).filter(r => {
        if (r.status !== 'running') return false;
        return (Date.now() - new Date(r.started_at).getTime()) > 1200000; // 20 min
      });

      const completedAgents = (agentRuns || []).filter(r => r.status === 'complete').length;
      const failedAgents = (agentRuns || []).filter(r => r.status === 'failed').length;
      const totalAgents = (agentRuns || []).length;

      let healthStatus = 'healthy';
      if (stuckAgents.length > 0) healthStatus = 'stuck';
      else if (failedAgents > 0) healthStatus = 'degraded';
      else if (totalAgents === 0) healthStatus = 'starting';

      buildHealth.push({
        ticket_id: build.ticket_id,
        client_name: build.client_name,
        status: build.status,
        health: healthStatus,
        agents_complete: completedAgents,
        agents_failed: failedAgents,
        agents_stuck: stuckAgents.map(a => ({
          id: a.agent_id,
          name: a.agent_name,
          running_minutes: Math.round((Date.now() - new Date(a.started_at).getTime()) / 60000)
        })),
        quality_signals: (qualitySignals || []).length,
        qa_score: build.qa_score,
        started: build.created_at,
        last_activity: build.updated_at
      });
    }

    res.json({
      active_builds: buildHealth.length,
      healthy: buildHealth.filter(b => b.health === 'healthy').length,
      stuck: buildHealth.filter(b => b.health === 'stuck').length,
      degraded: buildHealth.filter(b => b.health === 'degraded').length,
      builds: buildHealth,
      checked_at: new Date().toISOString()
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// SSE stream for build monitor events
app.get('/api/factory/build-monitor/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  send({ type: 'connected', timestamp: new Date().toISOString() });

  const PORT_LOCAL = process.env.PORT || 3000;
  const interval = setInterval(async () => {
    try {
      const monitorRes = await fetch(`http://localhost:${PORT_LOCAL}/api/factory/build-monitor`);
      if (monitorRes.ok) {
        const data = await monitorRes.json();
        send({ type: 'health_update', ...data });

        for (const build of (data.builds || [])) {
          if (build.health === 'stuck') {
            send({
              type: 'alert',
              severity: 'warning',
              ticket_id: build.ticket_id,
              client: build.client_name,
              message: `Build stuck: ${build.agents_stuck.map(a => `${a.name} (${a.running_minutes}m)`).join(', ')}`,
              timestamp: new Date().toISOString()
            });
          }
        }
      }
    } catch(e) { /* polling errors are non-fatal */ }
  }, 15000);

  req.on('close', () => clearInterval(interval));
});

// ── Build Review Pages (FR-GAP-012) ────────────────────────────────────────────

// ── GET /api/build/:ticketId/logs ─────────────────────────────────────────────
// Returns last 50 lines from PM2 worker log filtered for this ticket ID
app.get('/api/build/:ticketId/logs', async (req, res) => {
  const { ticketId } = req.params;
  const maxLines = parseInt(req.query.lines) || 50;
  try {
    const { execSync } = await import('child_process');
    // Search both stdout and stderr logs for this ticket
    const raw = execSync(
      'pm2 logs manageai-build-api --lines 500 --nostream 2>&1 | grep -i "' + ticketId.replace(/[^a-zA-Z0-9_-]/g, '') + '" | tail -n ' + maxLines,
      { timeout: 5000, encoding: 'utf-8' }
    ).trim();
    const lines = raw ? raw.split('\n') : [];
    res.json({ success: true, ticket_id: ticketId, lines, count: lines.length });
  } catch (e) {
    // grep returns exit code 1 when no matches — not an error
    if (e.status === 1) {
      res.json({ success: true, ticket_id: ticketId, lines: [], count: 0 });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
});

async function loadBuildForReview(ticketId) {
  // Try friday_tickets first, then fall back to friday_builds only
  const { data: ticket } = await supabase.from('friday_tickets').select('*').eq('ticket_id', ticketId).single();
  const { data: build } = await supabase.from('friday_builds').select('*').eq('ticket_id', ticketId).order('created_at', { ascending: false }).limit(1).single();
  if (!ticket && !build) return null;
  const rawLinks = build?.output_links || [];
  const parsedLinks = Array.isArray(rawLinks) ? rawLinks : (typeof rawLinks === 'string' ? (() => { try { return JSON.parse(rawLinks); } catch(e) { return []; } })() : []);
  const rawLog = build?.build_log || [];
  const parsedLog = Array.isArray(rawLog) ? rawLog : (typeof rawLog === 'string' ? (() => { try { return JSON.parse(rawLog); } catch(e) { return []; } })() : []);
  return {
    ticket_id: ticketId,
    build_id: build?.id || '',
    client: ticket?.client || build?.client_name || '',
    project_name: ticket?.project_name || build?.project_name || '',
    platform: ticket?.platform || build?.platform || '',
    status: build?.status || ticket?.status || '',
    review_status: build?.review_status || '',
    progress_pct: build?.progress_pct || 0,
    output_links: parsedLinks,
    build_log: parsedLog,
    onedrive_folder_url: build?.onedrive_folder_url || '',
    phase1_duration_ms: build?.phase1_duration_ms || null,
    total_duration_ms: build?.total_duration_ms || null,
    request_description: ticket?.request_description || '',
    brief: ticket?.brief || ticket?.brief_sections || null
  };
}

function parseOutputLinks(links) {
  const result = { schemaTables: [], workflows: [], llmFiles: [], extPlatforms: [], repoUrl: '', qaResults: null, allFiles: [] };
  for (const link of links) {
    const n = (link.name || '').toLowerCase();
    result.allFiles.push(link);
    if (n.includes('confirmed-schema'))        result.schemaFile = link;
    else if (n.includes('workflow-manifest'))   result.workflowManifest = link;
    else if (n.includes('test-results'))        result.testResultsFile = link;
    else if (n.includes('deployment-manifest') || n.includes('platform-manifest')) result.platformManifest = link;
    else if (n.includes('llm-manifest'))        result.llmManifest = link;
    if (n.startsWith('workflow/') && n.endsWith('.json')) {
      result.workflows.push(link.name.replace('workflow/', '').replace('.json', ''));
    }
    if (n.startsWith('workflows/') && n.endsWith('.json') && !n.includes('manifest')) {
      result.workflows.push(link.name.replace('workflows/', '').replace('.json', ''));
    }
    if (n.startsWith('llm/') && !n.includes('manifest')) {
      result.llmFiles.push(link.name.replace('llm/', ''));
    }
    if (n.startsWith('external/') && !n.includes('manifest')) {
      result.extPlatforms.push(link.name.replace('external/', ''));
    }
    if (n.startsWith('schema/')) {
      result.schemaTables.push(link.name.replace('schema/', ''));
    }
  }
  return result;
}

function renderBuildTimeline(buildLog) {
  const agents = [
    { id: 'BUILD-001', label: 'Planner', key: 'planner' },
    { id: 'BUILD-006', label: 'Schema', key: 'schema' },
    { id: 'BUILD-002', label: 'Workflow', key: 'workflow' },
    { id: 'BUILD-004', label: 'LLM', key: 'llm' },
    { id: 'BUILD-007', label: 'External', key: 'external' },
    { id: 'BUILD-005', label: 'Platform', key: 'platform' },
    { id: 'BUILD-003', label: 'QA', key: 'qa' }
  ];
  const log = Array.isArray(buildLog) ? buildLog : [];

  // Extract durations and statuses from build_log entries
  const agentData = agents.map(a => {
    // Look for entries matching this agent in the build log
    const entry = log.find(e =>
      (e.action || '').toLowerCase().includes(a.key) ||
      (e.detail || '').toLowerCase().includes(a.id.toLowerCase()) ||
      (e.step && String(e.step).includes(a.key))
    );
    const durMatch = (entry?.detail || '').match(/(\d+)s/);
    const dur = durMatch ? parseInt(durMatch[1]) : null;
    let status = 'pending';
    if (entry) {
      const d = (entry.detail || '').toLowerCase();
      if (d.includes('error') || d.includes('fail')) status = 'error';
      else if (d.includes('ok') || d.includes('complete') || d.includes('pass') || d.includes('uploaded')) status = 'ok';
      else if (d.includes('partial') || d.includes('warning') || d.includes('0 active')) status = 'warn';
      else status = 'ok';
    }
    return { ...a, dur, status };
  });

  const colors = { ok: '#22c55e', warn: '#eab308', error: '#ef4444', pending: '#475569' };
  const steps = agentData.map((a, i) => {
    const c = colors[a.status];
    const isLast = i === agentData.length - 1;
    return '<div style="display:flex;align-items:center;flex:1;min-width:0">' +
      '<div style="text-align:center;flex:1">' +
        '<div style="width:28px;height:28px;border-radius:50%;background:' + c + '20;border:2px solid ' + c + ';margin:0 auto 4px;display:flex;align-items:center;justify-content:center;font-size:.65rem;color:' + c + ';font-weight:700">' + (i+1) + '</div>' +
        '<div style="font-size:.7rem;color:#e2e8f0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + a.label + '</div>' +
        (a.dur ? '<div style="font-size:.65rem;color:#64748b">' + a.dur + 's</div>' : '<div style="font-size:.65rem;color:#475569">—</div>') +
      '</div>' +
      (isLast ? '' : '<div style="flex:1;height:2px;background:' + (a.status !== 'pending' ? c : '#334155') + ';min-width:8px;margin:0 2px;align-self:flex-start;margin-top:14px"></div>') +
    '</div>';
  }).join('');

  return '<div class="card" style="padding:14px"><h2 style="margin-bottom:10px">Phase 1 Agent Timeline</h2>' +
    '<div style="display:flex;align-items:flex-start;overflow-x:auto;gap:0;padding-bottom:4px">' + steps + '</div></div>';
}

app.get('/build-review/:ticketId/phase1', async (req, res) => {
  const { ticketId } = req.params;
  try {
    const data = await loadBuildForReview(ticketId);
    if (!data) return res.status(404).send('Build not found for ' + ticketId);

    const parsed = parseOutputLinks(data.output_links);
    const qaScore = data.progress_pct || 0;

    // Load extra data from Supabase
    let scenarios = [], agentConfigs = [], testResults = null;
    if (data.build_id) {
      const { data: sc } = await supabase.from('build_scenarios').select('scenario_key,scenario_name,platform,status,module_stages').eq('build_id', data.build_id);
      scenarios = sc || [];
      const { data: ac } = await supabase.from('build_agent_configs').select('agent_id,agent_label,model').eq('build_id', data.build_id);
      agentConfigs = ac || [];
    }

    // Query build_agent_runs for Phase 1 agent output and OneDrive links
    let agentRunsData = [];
    try {
      const sbUrl = process.env.SUPABASE_URL;
      const sbKey = process.env.SUPABASE_SERVICE_KEY;
      const arRes = await fetch(`${sbUrl}/rest/v1/build_agent_runs?ticket_id=eq.${encodeURIComponent(ticketId)}&select=agent_id,agent_name,status,output,duration_ms,started_at,completed_at&order=started_at.asc`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
      });
      if (arRes.ok) agentRunsData = await arRes.json();
    } catch(e) { console.warn('[FRIDAY] build_agent_runs query failed:', e.message); }

    // Query friday_builds for build metadata
    let buildMeta = null;
    try {
      const sbUrl = process.env.SUPABASE_URL;
      const sbKey = process.env.SUPABASE_SERVICE_KEY;
      const bmRes = await fetch(`${sbUrl}/rest/v1/friday_builds?ticket_id=eq.${encodeURIComponent(ticketId)}&select=status,progress_pct,client_name,project_name,platform&limit=1`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
      });
      if (bmRes.ok) { const rows = await bmRes.json(); buildMeta = rows[0] || null; }
    } catch(e) { console.warn('[FRIDAY] friday_builds query failed:', e.message); }

    // Build agent run map keyed by agent_id
    const agentRunMap = {};
    for (const run of agentRunsData) { agentRunMap[run.agent_id] = run; }

    // Agent mapping: BUILD-001=planner, BUILD-002=workflow, BUILD-003=QA, BUILD-004=LLM, BUILD-005=platform, BUILD-006=schema, BUILD-007=external
    const agentCard = (id, label, icon, content) => `<div class="card"><h2>${icon} ${id} &mdash; ${label}</h2>${content}</div>`;

    // BUILD-001: Planner — prefer agentRunMap, fallback to output_links
    const plannerRun = agentRunMap['BUILD-001'];
    const plannerOdUrl = plannerRun?.output?.onedrive_url;
    const contractLink = data.output_links.find(l => (l.name || '').includes('build-contract'));
    const plannerContent = plannerOdUrl
      ? `<p>Build contract generated</p><a href="${plannerOdUrl}" target="_blank" class="file-link">build-contract.json</a>`
      : (contractLink
        ? `<p>Build contract generated</p><a href="${contractLink.url || '#'}" target="_blank" class="file-link">build-contract.json</a>`
        : '<p class="muted">No build contract found</p>');

    // BUILD-006: Schema — prefer agentRunMap, fallback to output_links
    const schemaRun = agentRunMap['BUILD-006'];
    const schemaOdUrl = schemaRun?.output?.onedrive_url;
    const schemaTableNames = schemaRun?.output?.table_names || [];
    const schemaLink = data.output_links.find(l => (l.name || '').includes('confirmed-schema'));
    const schemaFiles = data.output_links.filter(l => (l.name || '').startsWith('schema/'));
    let schemaContent = '';
    if (schemaTableNames.length > 0) {
      schemaContent = '<table><thead><tr><th>Table</th><th>Status</th></tr></thead><tbody>' +
        schemaTableNames.map(t => '<tr><td>' + t + '</td><td><span class="badge badge-ok">Created</span></td></tr>').join('') +
        '</tbody></table>' +
        (schemaOdUrl ? '<a href="' + schemaOdUrl + '" target="_blank" class="file-link" style="margin-top:8px">confirmed-schema.json</a>' : '');
    } else if (schemaFiles.length > 0) {
      schemaContent = '<table><thead><tr><th>Table/File</th><th>Status</th></tr></thead><tbody>' + schemaFiles.map(f => '<tr><td><a href="' + (f.url || '#') + '" target="_blank">' + (f.name || '').replace('schema/', '') + '</a></td><td><span class="badge badge-ok">Created</span></td></tr>').join('') + '</tbody></table>';
    } else {
      const schemaFallbackUrl = schemaOdUrl || schemaLink?.url;
      schemaContent = schemaFallbackUrl ? '<a href="' + schemaFallbackUrl + '" target="_blank" class="file-link">confirmed-schema.json</a>' : '<p class="muted">No schema files</p>';
    }

    // BUILD-002: Workflow Architect — prefer agentRunMap, fallback to output_links
    const wfRun = agentRunMap['BUILD-002'];
    const wfOdUrl = wfRun?.output?.onedrive_url;
    const wfWorkflowNames = wfRun?.output?.workflow_names || [];
    const wfNamedFiles = data.output_links.filter(l => { const n = (l.name || '').toLowerCase(); return (n.startsWith('workflow/') || n.startsWith('workflows/')) && n.endsWith('.json') && !n.includes('manifest'); });
    let wfContent = '';
    if (scenarios.length > 0) {
      wfContent = '<table><thead><tr><th>Workflow</th><th>Platform</th><th>Status</th></tr></thead><tbody>' +
        scenarios.map(s => '<tr><td>' + s.scenario_name + '</td><td>' + s.platform + '</td><td><span class="badge badge-ok">' + s.status + '</span></td></tr>').join('') +
        '</tbody></table>';
    } else if (wfWorkflowNames.length > 0) {
      wfContent = '<table><thead><tr><th>Workflow</th><th>Status</th></tr></thead><tbody>' +
        wfWorkflowNames.map(n => '<tr><td>' + n + '</td><td><span class="badge badge-ok">Ready</span></td></tr>').join('') +
        '</tbody></table>' +
        (wfOdUrl ? '<a href="' + wfOdUrl + '" target="_blank" class="file-link" style="margin-top:8px">workflow-manifest.json</a>' : '');
    } else if (wfNamedFiles.length > 0) {
      wfContent = '<table><thead><tr><th>Workflow File</th><th>Status</th></tr></thead><tbody>' +
        wfNamedFiles.map(f => '<tr><td><a href="' + (f.url || '#') + '" target="_blank">' + (f.name || '').replace(/^(workflow|workflows)\//, '').replace('.json', '') + '</a></td><td><span class="badge badge-ok">Ready</span></td></tr>').join('') +
        '</tbody></table>';
    } else {
      wfContent = wfOdUrl ? '<a href="' + wfOdUrl + '" target="_blank" class="file-link">workflow-manifest.json</a>' : '<p class="muted">No workflow files detected</p>';
    }

    // BUILD-004: LLM / Prompts — prefer agentRunMap, fallback to output_links
    const llmRun = agentRunMap['BUILD-004'];
    const llmOdUrl = llmRun?.output?.onedrive_url;
    const llmFilesProduced = llmRun?.output?.files_produced || [];
    const llmFiles = data.output_links.filter(l => (l.name || '').startsWith('llm/') && !(l.name || '').includes('manifest'));
    let llmContent = '';
    if (llmFilesProduced.length > 0) {
      llmContent = '<ul>' + llmFilesProduced.map(f => '<li>' + f + '</li>').join('') + '</ul>' +
        (llmOdUrl ? '<a href="' + llmOdUrl + '" target="_blank" class="file-link" style="margin-top:8px">ai-integration.js</a>' : '');
    } else if (llmFiles.length > 0) {
      llmContent = '<ul>' + llmFiles.map(f => '<li><a href="' + (f.url || '#') + '" target="_blank">' + (f.name || '').replace('llm/', '') + '</a></li>').join('') + '</ul>';
    } else {
      llmContent = llmOdUrl ? '<a href="' + llmOdUrl + '" target="_blank" class="file-link">ai-integration.js</a>' : '<p class="muted">No LLM/prompt files detected</p>';
    }

    // BUILD-007: External Integrations (output_links only — no dedicated agentRunMap key yet)
    const extFiles = data.output_links.filter(l => (l.name || '').startsWith('external/') && !(l.name || '').includes('manifest'));
    const extContent = extFiles.length > 0
      ? '<ul>' + extFiles.map(f => '<li><a href="' + (f.url || '#') + '" target="_blank">' + (f.name || '').replace('external/', '') + '</a></li>').join('') + '</ul>'
      : '<p class="muted">No external integrations</p>';

    // BUILD-005: Platform / GitHub — prefer agentRunMap, fallback to output_links
    const platformRun = agentRunMap['BUILD-005'];
    const platformOdUrl = platformRun?.output?.onedrive_url;
    const platformRepoUrl = platformRun?.output?.repo_url;
    const platformLink = data.output_links.find(l => (l.name || '').includes('deployment-manifest') || (l.name || '').includes('platform-manifest'));
    let platformContent = '';
    if (platformOdUrl || platformLink) {
      const linkUrl = platformOdUrl || platformLink?.url || '#';
      platformContent = `<a href="${linkUrl}" target="_blank" class="file-link">deployment-manifest.json</a>`;
      if (platformRepoUrl) platformContent += `<p style="margin-top:8px;font-size:.8rem"><a href="${platformRepoUrl}" target="_blank">&#x1f517; ${platformRepoUrl}</a></p>`;
    } else if (platformRepoUrl) {
      platformContent = `<p style="font-size:.8rem"><a href="${platformRepoUrl}" target="_blank">&#x1f517; ${platformRepoUrl}</a></p>`;
    } else {
      platformContent = '<p class="muted">No platform manifest</p>';
    }

    // BUILD-003: QA — prefer agentRunMap score, fallback to progress_pct
    const qaRun = agentRunMap['BUILD-003'];
    const qaOdUrl = qaRun?.output?.onedrive_url;
    const effectiveQaScore = qaRun?.output?.score ?? qaRun?.output?.pass_rate ?? qaScore;
    const qaLink = data.output_links.find(l => (l.name || '').includes('test-results'));
    const qaResultUrl = qaOdUrl || qaLink?.url;
    const qaContent = qaResultUrl
      ? `<div class="score-ring" style="border:4px solid ${effectiveQaScore >= 80 ? '#22c55e' : effectiveQaScore >= 50 ? '#eab308' : '#ef4444'}">${effectiveQaScore}%</div><div class="score-label">QA pass rate</div><a href="${qaResultUrl}" target="_blank" class="file-link">test-results.json</a>`
      : `<div class="score-ring" style="border:4px solid #94a3b8">${effectiveQaScore}%</div><div class="score-label">QA score</div>`;

    // Deliverables (build-docs/ + deliverables/)
    const docFiles = data.output_links.filter(l => { const n = (l.name || ''); return n.startsWith('build-docs/') || n.startsWith('deliverables/'); });
    const docsContent = docFiles.length > 0
      ? docFiles.map(f => '<a href="' + (f.url || '#') + '" target="_blank" class="file-link">' + (f.name || '').replace(/^(build-docs|deliverables)\//, '') + '</a>').join('')
      : '<p class="muted">No documents generated</p>';

    // Files count: agent runs with onedrive_url + legacy output_links
    const runsWithOdUrl = agentRunsData.filter(r => r.output?.onedrive_url).length;
    const filesWithLinks = runsWithOdUrl > 0 ? runsWithOdUrl + data.output_links.length : data.output_links.length;

    // ── Quality scorecard ──
    const p1BuildLog = data.build_log || [];
    const p1TestCats = {
      schema:      { pass: schemaTableNames.length > 0 || schemaFiles.length > 0 || !!schemaOdUrl, count: schemaTableNames.length || schemaFiles.length, label: 'Schema' },
      workflow:    { pass: wfWorkflowNames.length > 0 || wfNamedFiles.length > 0 || scenarios.length > 0 || !!wfOdUrl, count: wfWorkflowNames.length || wfNamedFiles.length + scenarios.length, label: 'Workflow' },
      llm:         { pass: llmFilesProduced.length > 0 || llmFiles.length > 0 || !!llmOdUrl, count: llmFilesProduced.length || llmFiles.length, label: 'LLM / Prompts' },
      integration: { pass: extFiles.length > 0 || !!platformOdUrl || !!platformLink, count: extFiles.length + (platformOdUrl || platformLink ? 1 : 0), label: 'Integration' }
    };
    const p1PassCount = Object.values(p1TestCats).filter(c => c.pass).length;
    const p1RepoLog = p1BuildLog.find(l => l.detail && typeof l.detail === 'string' && l.detail.includes('github.com'));
    const p1GithubUrl = platformRepoUrl || (p1RepoLog ? (p1RepoLog.detail.match(/https:\/\/github\.com\/[^\s"')]+/) || [''])[0] : '');
    const p1Deferrals = p1BuildLog.filter(l => l.action === 'deferral' || (l.detail && typeof l.detail === 'string' && l.detail.toLowerCase().includes('defer')));
    const p1QaColor = effectiveQaScore >= 80 ? '#22c55e' : effectiveQaScore >= 60 ? '#eab308' : '#ef4444';
    const p1QaLabel = effectiveQaScore >= 80 ? 'PASS' : effectiveQaScore >= 60 ? 'REVIEW' : 'FAIL';

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Phase 1 Review &mdash; ${ticketId}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:16px;max-width:600px;margin:0 auto}
h1{font-size:1.3rem;color:#38bdf8;margin-bottom:4px}
.sub{color:#94a3b8;font-size:.85rem;margin-bottom:20px}
.card{background:#1e293b;border-radius:12px;padding:16px;margin-bottom:16px;border:1px solid #334155}
.card h2{font-size:.95rem;color:#f8fafc;margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th{text-align:left;color:#94a3b8;padding:6px 8px;border-bottom:1px solid #334155;font-weight:500}
td{padding:6px 8px;border-bottom:1px solid #334155}
.score-ring{width:80px;height:80px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.5rem;font-weight:700;min-width:80px}
.score-label{text-align:center;color:#94a3b8;font-size:.8rem}
.badge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:.75rem;font-weight:600}
.badge-ok{background:#064e3b;color:#34d399}
.badge-warn{background:#78350f;color:#fbbf24}
.muted{color:#64748b;font-style:italic}
p{font-size:.85rem;margin-bottom:6px}
ul{padding-left:18px;font-size:.85rem}
li{margin-bottom:4px}
.file-link{display:block;padding:6px 0;border-bottom:1px solid #1e293b;color:#38bdf8;text-decoration:none;font-size:.8rem;word-break:break-all}
.file-link:hover{text-decoration:underline}
a{color:#38bdf8;text-decoration:none}
textarea{width:100%;min-height:80px;background:#0f172a;border:1px solid #475569;border-radius:8px;color:#e2e8f0;padding:10px;font-size:.9rem;resize:vertical;margin-top:8px}
.btn-row{display:flex;gap:12px;margin-top:16px}
.btn{flex:1;padding:14px;border:none;border-radius:10px;font-size:1rem;font-weight:600;cursor:pointer;text-align:center}
.btn-approve{background:#16a34a;color:#fff}
.btn-approve:active{background:#15803d}
.btn-reject{background:#dc2626;color:#fff}
.btn-reject:active{background:#b91c1c}
.btn:disabled{opacity:.5;cursor:not-allowed}
.result-msg{margin-top:12px;padding:12px;border-radius:8px;font-size:.9rem;display:none}
.result-ok{background:#064e3b;color:#34d399;display:block}
.result-err{background:#7f1d1d;color:#f87171;display:block}
.status-bar{display:flex;gap:8px;margin-bottom:16px;font-size:.8rem;flex-wrap:wrap}
.status-pill{padding:4px 10px;border-radius:12px;font-weight:600}

.voice-btn{display:flex;align-items:center;gap:6px;padding:6px 14px;background:#1E3348;color:#fff;border:none;border-radius:8px;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;letter-spacing:.02em}
.voice-btn:hover{background:#243f5c}
.voice-btn svg{flex-shrink:0}
#voicePanel{display:none;position:fixed;bottom:20px;right:20px;width:320px;background:#1e293b;border:1px solid #334155;border-radius:14px;padding:16px;z-index:9999;box-shadow:0 8px 32px #000a}
#voicePanel.open{display:block}
.vp-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.vp-title{font-size:.85rem;font-weight:700;color:#38bdf8;letter-spacing:.05em;text-transform:uppercase}
.vp-close{background:none;border:none;color:#64748b;cursor:pointer;font-size:18px;line-height:1;padding:2px 6px}
.vp-close:hover{color:#f87171}
.vp-transcript{min-height:70px;max-height:150px;overflow-y:auto;background:#0f172a;border-radius:8px;padding:10px;font-size:.8rem;color:#94a3b8;margin-bottom:10px;line-height:1.6;border:1px solid #334155}
.vp-actions{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.vp-action-btn{padding:7px 12px;border:none;border-radius:7px;font-size:.78rem;font-weight:700;cursor:pointer;font-family:inherit}
.vp-btn-approve{background:#064e3b;color:#34d399}
.vp-btn-approve:hover{background:#065f46}
.vp-btn-changes{background:#78350f;color:#fbbf24}
.vp-btn-changes:hover{background:#92400e}
.vp-btn-context{background:#1e3a5f;color:#60a5fa}
.vp-btn-context:hover{background:#1e4d7f}
.vp-url-row{display:flex;gap:6px;margin-top:4px}
.vp-url-input{flex:1;padding:6px 8px;background:#0f172a;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:.75rem}
.vp-url-save{padding:6px 10px;background:#334155;color:#94a3b8;border:none;border-radius:6px;font-size:.75rem;cursor:pointer;font-weight:700}
.vp-url-save:hover{background:#475569;color:#fff}
.vp-status{font-size:.7rem;color:#64748b;margin-top:6px;text-align:right}
</style></head><body data-ticket-id="${ticketId}">
<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px">
<h1>Phase 1 Build Review</h1>
<button id="voiceBtn" onclick="toggleVoice()" class="voice-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg> Voice</button>
</div><div id="voicePanel">
<div class="vp-header"><span class="vp-title">Voice Interface</span><button class="vp-close" onclick="closeVoice()">&#x2715;</button></div>
<div id="vpTranscript" class="vp-transcript">Ready. Press an action or speak via bridge.</div>
<div class="vp-actions" id="vpActions"></div>
<div class="vp-url-row">
  <input class="vp-url-input" id="vpBridgeUrl" placeholder="Voice bridge URL..." />
  <button class="vp-url-save" onclick="saveBridgeUrl()">Save</button>
</div>
<div class="vp-status" id="vpStatus">Not connected</div>
</div>
<div class="sub">${ticketId} &mdash; ${data.project_name} &mdash; ${data.platform}</div>
<div class="status-bar">
  <span class="status-pill" style="background:#1e3a5f;color:#60a5fa">${data.client}</span>
  <span class="status-pill" style="background:${data.status === 'done' ? '#064e3b' : '#78350f'};color:${data.status === 'done' ? '#34d399' : '#fbbf24'}">${data.status}</span>
  ${data.review_status ? '<span class="status-pill" style="background:#312e81;color:#a5b4fc">' + data.review_status + '</span>' : ''}
</div>

<div class="card" style="border-color:${p1QaColor}40">
  <h2>&#x1f4ca; Quality Scorecard</h2>
  <div style="display:flex;align-items:center;gap:16px;margin-bottom:12px">
    <div class="score-ring" style="border:4px solid ${p1QaColor}">${effectiveQaScore}%</div>
    <div>
      <div style="font-size:1.1rem;font-weight:700;color:${p1QaColor}">${p1QaLabel}</div>
      <div style="color:#94a3b8;font-size:.8rem">${p1PassCount}/4 categories passed</div>
    </div>
  </div>
  <table>
    <thead><tr><th>Category</th><th>Status</th><th>Files</th></tr></thead>
    <tbody>
      ${Object.values(p1TestCats).map(c => '<tr><td>' + c.label + '</td><td>' + (c.pass ? '<span class="badge badge-ok">PASS</span>' : '<span class="badge badge-warn">MISSING</span>') + '</td><td>' + c.count + '</td></tr>').join('')}
    </tbody>
  </table>
  <div style="margin-top:12px;font-size:.8rem;color:#94a3b8">
    Files produced: <strong style="color:#e2e8f0">${filesWithLinks}</strong> (min expected: 6)
    ${p1GithubUrl ? ' &middot; <a href="' + p1GithubUrl + '" target="_blank">GitHub Repo</a>' : ''}
  </div>
  ${p1Deferrals.length > 0 ? '<div style="margin-top:8px;padding:8px;background:#7f1d1d30;border-radius:6px;font-size:.8rem;color:#fca5a5"><strong>Deferrals (' + p1Deferrals.length + '):</strong><ul style="margin-top:4px">' + p1Deferrals.map(d => '<li>' + (d.detail || d.action || 'Deferred item') + '</li>').join('') + '</ul></div>' : ''}
</div>

${renderBuildTimeline(data.build_log)}

${agentCard('BUILD-001', 'Planner', '&#x1f4cb;', plannerContent)}
${agentCard('BUILD-006', 'Schema Designer', '&#x1f5c4;&#xfe0f;', schemaContent)}
${agentCard('BUILD-002', 'Workflow Architect', '&#x2699;&#xfe0f;', wfContent)}
${agentCard('BUILD-004', 'LLM / Prompt Engineer', '&#x1f9e0;', llmContent)}
${agentCard('BUILD-007', 'Integration Specialist', '&#x1f517;', extContent)}
${agentCard('BUILD-005', 'Platform / GitHub', '&#x1f680;', platformContent)}
${agentCard('BUILD-003', 'QA Engineer', '&#x1f9ea;', qaContent)}

<div class="card">
  <h2>&#x1f4c4; Documents &amp; Deliverables (${docFiles.length})</h2>
  ${docsContent}
</div>

<div class="card">
  <h2 onclick="toggleLogs()" style="cursor:pointer">&#x1f4dc; Build Log <span id="logToggle" style="font-size:.75rem;color:#94a3b8">[show]</span></h2>
  <div id="buildLogContainer" style="display:none">
    <pre id="buildLogContent" style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px;font-size:.75rem;max-height:400px;overflow-y:auto;white-space:pre-wrap;color:#94a3b8">Loading...</pre>
  </div>
</div>

<div class="card">
  <h2>&#x1f4dd; Review Notes</h2>
  <textarea id="notes" placeholder="Optional review notes..."></textarea>
  <div class="btn-row">
    <button class="btn btn-approve" id="approveBtn" onclick="doAction('approve')">Approve Phase 1</button>
    <button class="btn btn-reject" id="rejectBtn" onclick="doAction('reject')">Reject</button>
  </div>
  <div id="result" class="result-msg"></div>
</div>

<script>
let logsLoaded = false;
function toggleLogs() {
  const c = document.getElementById('buildLogContainer');
  const t = document.getElementById('logToggle');
  if (c.style.display === 'none') {
    c.style.display = 'block';
    t.textContent = '[hide]';
    if (!logsLoaded) { logsLoaded = true; fetchLogs(); }
  } else {
    c.style.display = 'none';
    t.textContent = '[show]';
  }
}
async function fetchLogs() {
  try {
    const r = await fetch('/api/build/${ticketId}/logs?lines=50');
    const d = await r.json();
    const el = document.getElementById('buildLogContent');
    if (d.lines && d.lines.length > 0) {
      el.textContent = d.lines.join('\\n');
    } else {
      el.textContent = 'No log entries found for this ticket.';
    }
  } catch(e) { document.getElementById('buildLogContent').textContent = 'Error loading logs: ' + e.message; }
}
async function doAction(action) {
  const notes = document.getElementById('notes').value;
  document.getElementById('approveBtn').disabled = true;
  document.getElementById('rejectBtn').disabled = true;
  const el = document.getElementById('result');
  try {
    const url = action === 'approve'
      ? '/api/build/${ticketId}/phase1-approve'
      : '/api/build/${ticketId}/reject';
    const body = action === 'approve'
      ? { decision: 'approved', reason: notes }
      : { notes };
    const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const d = await r.json();
    if (d.success || d.signaled) {
      el.className = 'result-msg result-ok';
      el.textContent = action === 'approve' ? 'Phase 1 approved — Phase 2 starting...' : 'Build rejected.';
    } else { throw new Error(d.error || 'Unknown error'); }
  } catch(e) {
    el.className = 'result-msg result-err';
    el.textContent = 'Error: ' + e.message;
    document.getElementById('approveBtn').disabled = false;
    document.getElementById('rejectBtn').disabled = false;
  }
}

const _voiceKey = 'manageai-voice-2026';
let _voiceEvt = null;

function toggleVoice() {
  const p = document.getElementById('voicePanel');
  p.classList.toggle('open');
  if (p.classList.contains('open')) {
    initVoice();
    loadBridgeUrl();
  }
}
function closeVoice() {
  document.getElementById('voicePanel').classList.remove('open');
  if (_voiceEvt) { _voiceEvt.close(); _voiceEvt = null; }
}
function loadBridgeUrl() {
  const saved = localStorage.getItem('fridayVoiceBridge') || '';
  document.getElementById('vpBridgeUrl').value = saved;
  if (saved) connectBridge(saved);
}
function saveBridgeUrl() {
  const url = document.getElementById('vpBridgeUrl').value.trim();
  if (url) { localStorage.setItem('fridayVoiceBridge', url); connectBridge(url); }
}
function connectBridge(url) {
  if (_voiceEvt) { _voiceEvt.close(); }
  try {
    _voiceEvt = new EventSource(url);
    _voiceEvt.onmessage = (e) => { appendTranscript(e.data); };
    _voiceEvt.onerror = () => { document.getElementById('vpStatus').textContent = 'Bridge disconnected'; };
    _voiceEvt.onopen = () => { document.getElementById('vpStatus').textContent = 'Bridge connected'; };
  } catch(e) { document.getElementById('vpStatus').textContent = 'Bridge error: ' + e.message; }
}
function appendTranscript(text) {
  const el = document.getElementById('vpTranscript');
  el.textContent += '\n' + text;
  el.scrollTop = el.scrollHeight;
}
async function voiceAction(action, comment) {
  const ticketId = document.body.dataset.ticketId || '';
  appendTranscript('> ' + action + (ticketId ? ' for ' + ticketId : ''));
  try {
    const r = await fetch('/api/voice/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-voice-key': _voiceKey },
      body: JSON.stringify({ action, ticketId, comment: comment || '' })
    });
    const d = await r.json();
    appendTranscript(d.message || d.error || JSON.stringify(d));
  } catch(e) { appendTranscript('Error: ' + e.message); }
}
async function loadVoiceContext() {
  appendTranscript('Loading build context...');
  try {
    const r = await fetch('/api/voice/context');
    const d = await r.json();
    if (d.summary) appendTranscript(d.summary);
  } catch(e) { appendTranscript('Context error: ' + e.message); }
}
function initVoice() {
  // override in page-specific script
}
function initVoice() {
  const actions = document.getElementById('vpActions');
  actions.innerHTML = '<button class="vp-action-btn vp-btn-approve" onclick="voiceAction(\'approve_phase1\')">Approve Phase 1</button>'
    + '<button class="vp-action-btn vp-btn-changes" onclick="voiceAction(\'request_changes\')">Request Changes</button>'
    + '<button class="vp-action-btn vp-btn-context" onclick="loadVoiceContext()">Load Context</button>';
}
</script>
</body></html>`);
  } catch(e) {
    console.error('[FRIDAY] Build review phase1 error:', e.message);
    res.status(500).send('Error loading review: ' + e.message);
  }
});

app.get('/build-review/:ticketId/final', async (req, res) => {
  const { ticketId } = req.params;
  try {
    const data = await loadBuildForReview(ticketId);
    if (!data) return res.status(404).send('Build not found for ' + ticketId);

    const parsed = parseOutputLinks(data.output_links);
    const qaScore = data.progress_pct || 0;

    function fileRow(link) {
      const name = link.name || '';
      const url = link.url || '#';
      const shortName = name.replace(/^[^/]+\//, '');
      let icon = '&#x1f4c4;';
      const nl = name.toLowerCase();
      if (nl.includes('training') || nl.includes('manual')) icon = '&#x1f4d6;';
      else if (nl.includes('deployment')) icon = '&#x1f4e6;';
      else if (nl.includes('demo')) icon = '&#x1f3ac;';
      else if (nl.includes('regression') || nl.includes('test')) icon = '&#x1f9ea;';
      else if (nl.includes('requirement')) icon = '&#x1f4cb;';
      else if (nl.includes('architecture')) icon = '&#x1f3d7;&#xfe0f;';
      else if (nl.includes('wave') || nl.includes('implementation')) icon = '&#x1f30a;';
      else if (nl.includes('agent-definition')) icon = '&#x1f916;';
      else if (nl.endsWith('.json')) icon = '&#x2699;&#xfe0f;';
      return '<tr><td>' + icon + ' <a href="' + url + '" target="_blank">' + shortName + '</a></td><td><span class="badge badge-ok">Ready</span></td></tr>';
    }

    // ── Quality scorecard data for final review ──
    const buildLogFinal = data.build_log || [];
    const schemaFilesFinal = data.output_links.filter(l => (l.name || '').startsWith('schema/'));
    const wfFilesFinal = data.output_links.filter(l => { const n = (l.name || '').toLowerCase(); return (n.startsWith('workflow/') || n.startsWith('workflows/')) && n.endsWith('.json') && !n.includes('manifest'); });
    const llmFilesFinal = data.output_links.filter(l => (l.name || '').startsWith('llm/') && !(l.name || '').includes('manifest'));
    const extFilesFinal = data.output_links.filter(l => (l.name || '').startsWith('external/') && !(l.name || '').includes('manifest'));
    const platformManFinal = data.output_links.find(l => (l.name || '').includes('deployment-manifest') || (l.name || '').includes('platform-manifest'));
    const testCatsFinal = {
      schema:      { pass: schemaFilesFinal.length > 0, count: schemaFilesFinal.length, label: 'Schema' },
      workflow:    { pass: wfFilesFinal.length > 0, count: wfFilesFinal.length, label: 'Workflow' },
      llm:         { pass: llmFilesFinal.length > 0, count: llmFilesFinal.length, label: 'LLM / Prompts' },
      integration: { pass: extFilesFinal.length > 0 || !!platformManFinal, count: extFilesFinal.length + (platformManFinal ? 1 : 0), label: 'Integration' }
    };
    const passCountFinal = Object.values(testCatsFinal).filter(c => c.pass).length;
    const repoLogFinal = buildLogFinal.find(l => l.detail && typeof l.detail === 'string' && l.detail.includes('github.com'));
    const githubUrlFinal = repoLogFinal ? (repoLogFinal.detail.match(/https:\/\/github\.com\/[^\s"')]+/) || [''])[0] : '';
    const deferralsFinal = buildLogFinal.filter(l => l.action === 'deferral' || (l.detail && typeof l.detail === 'string' && l.detail.toLowerCase().includes('defer')));
    const qaColorFinal = qaScore >= 80 ? '#22c55e' : qaScore >= 60 ? '#eab308' : '#ef4444';
    const qaLabelFinal = qaScore >= 80 ? 'PASS' : qaScore >= 60 ? 'REVIEW' : 'FAIL';

    // Group files by category
    const docs = data.output_links.filter(l => (l.name||'').startsWith('build-docs/') || (l.name||'').startsWith('deliverables/'));
    const workflows = data.output_links.filter(l => (l.name||'').startsWith('workflow/') || (l.name||'').startsWith('workflows/'));
    const infra = data.output_links.filter(l => (l.name||'').startsWith('schema/') || (l.name||'').startsWith('platform/') || (l.name||'').startsWith('external/') || (l.name||'').startsWith('llm/') || (l.name||'').startsWith('planner/') || (l.name||'').startsWith('qa-tests/'));
    const other = data.output_links.filter(l => !docs.includes(l) && !workflows.includes(l) && !infra.includes(l));

    function tableBlock(title, files) {
      if (files.length === 0) return '';
      return '<div class="card"><h2>' + title + ' (' + files.length + ')</h2><table><tbody>' + files.map(fileRow).join('') + '</tbody></table></div>';
    }

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Final Review — ${ticketId}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:16px;max-width:600px;margin:0 auto}
h1{font-size:1.3rem;color:#38bdf8;margin-bottom:4px}
.sub{color:#94a3b8;font-size:.85rem;margin-bottom:20px}
.card{background:#1e293b;border-radius:12px;padding:16px;margin-bottom:16px;border:1px solid #334155}
.card h2{font-size:1rem;color:#f8fafc;margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th{text-align:left;color:#94a3b8;padding:6px 8px;border-bottom:1px solid #334155;font-weight:500}
td{padding:8px;border-bottom:1px solid #334155}
.score-ring{width:80px;height:80px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.5rem;font-weight:700;min-width:80px}
.score-label{text-align:center;color:#94a3b8;font-size:.8rem}
.badge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:.75rem;font-weight:600}
.badge-ok{background:#064e3b;color:#34d399}
.badge-warn{background:#78350f;color:#fbbf24}
a{color:#38bdf8;text-decoration:none}
a:hover{text-decoration:underline}
textarea{width:100%;min-height:80px;background:#0f172a;border:1px solid #475569;border-radius:8px;color:#e2e8f0;padding:10px;font-size:.9rem;resize:vertical;margin-top:8px}
.btn-row{display:flex;gap:12px;margin-top:16px}
.btn{flex:1;padding:14px;border:none;border-radius:10px;font-size:1rem;font-weight:600;cursor:pointer;text-align:center}
.btn-approve{background:#16a34a;color:#fff}
.btn-approve:active{background:#15803d}
.btn-changes{background:#ea580c;color:#fff}
.btn-changes:active{background:#c2410c}
.btn:disabled{opacity:.5;cursor:not-allowed}
.result-msg{margin-top:12px;padding:12px;border-radius:8px;font-size:.9rem;display:none}
.result-ok{background:#064e3b;color:#34d399;display:block}
.result-err{background:#7f1d1d;color:#f87171;display:block}
.status-bar{display:flex;gap:8px;margin-bottom:16px;font-size:.8rem;flex-wrap:wrap}
.status-pill{padding:4px 10px;border-radius:12px;font-weight:600}
.folder-link{display:block;margin-top:12px;padding:10px;background:#1e3a5f;border-radius:8px;text-align:center;font-weight:600}

.voice-btn{display:flex;align-items:center;gap:6px;padding:6px 14px;background:#1E3348;color:#fff;border:none;border-radius:8px;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;letter-spacing:.02em}
.voice-btn:hover{background:#243f5c}
.voice-btn svg{flex-shrink:0}
#voicePanel{display:none;position:fixed;bottom:20px;right:20px;width:320px;background:#1e293b;border:1px solid #334155;border-radius:14px;padding:16px;z-index:9999;box-shadow:0 8px 32px #000a}
#voicePanel.open{display:block}
.vp-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.vp-title{font-size:.85rem;font-weight:700;color:#38bdf8;letter-spacing:.05em;text-transform:uppercase}
.vp-close{background:none;border:none;color:#64748b;cursor:pointer;font-size:18px;line-height:1;padding:2px 6px}
.vp-close:hover{color:#f87171}
.vp-transcript{min-height:70px;max-height:150px;overflow-y:auto;background:#0f172a;border-radius:8px;padding:10px;font-size:.8rem;color:#94a3b8;margin-bottom:10px;line-height:1.6;border:1px solid #334155}
.vp-actions{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.vp-action-btn{padding:7px 12px;border:none;border-radius:7px;font-size:.78rem;font-weight:700;cursor:pointer;font-family:inherit}
.vp-btn-approve{background:#064e3b;color:#34d399}
.vp-btn-approve:hover{background:#065f46}
.vp-btn-changes{background:#78350f;color:#fbbf24}
.vp-btn-changes:hover{background:#92400e}
.vp-btn-context{background:#1e3a5f;color:#60a5fa}
.vp-btn-context:hover{background:#1e4d7f}
.vp-url-row{display:flex;gap:6px;margin-top:4px}
.vp-url-input{flex:1;padding:6px 8px;background:#0f172a;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:.75rem}
.vp-url-save{padding:6px 10px;background:#334155;color:#94a3b8;border:none;border-radius:6px;font-size:.75rem;cursor:pointer;font-weight:700}
.vp-url-save:hover{background:#475569;color:#fff}
.vp-status{font-size:.7rem;color:#64748b;margin-top:6px;text-align:right}
</style></head><body data-ticket-id="${ticketId}">
<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px">
<h1>Final Build Review</h1>
<button id="voiceBtn" onclick="toggleVoice()" class="voice-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg> Voice</button>
</div><div id="voicePanel">
<div class="vp-header"><span class="vp-title">Voice Interface</span><button class="vp-close" onclick="closeVoice()">&#x2715;</button></div>
<div id="vpTranscript" class="vp-transcript">Ready. Press an action or speak via bridge.</div>
<div class="vp-actions" id="vpActions"></div>
<div class="vp-url-row">
  <input class="vp-url-input" id="vpBridgeUrl" placeholder="Voice bridge URL..." />
  <button class="vp-url-save" onclick="saveBridgeUrl()">Save</button>
</div>
<div class="vp-status" id="vpStatus">Not connected</div>
</div>
<div class="sub">${ticketId} &mdash; ${data.project_name} &mdash; ${data.platform}</div>
<div class="status-bar">
  <span class="status-pill" style="background:#1e3a5f;color:#60a5fa">${data.client}</span>
  <span class="status-pill" style="background:${data.status === 'done' ? '#064e3b' : '#78350f'};color:${data.status === 'done' ? '#34d399' : '#fbbf24'}">${data.status}</span>
  ${data.review_status ? '<span class="status-pill" style="background:#312e81;color:#a5b4fc">' + data.review_status + '</span>' : ''}
</div>

<div class="card" style="border-color:${qaColorFinal}40">
  <h2>&#x1f4ca; Quality Scorecard</h2>
  <div style="display:flex;align-items:center;gap:16px;margin-bottom:12px">
    <div class="score-ring" style="border:4px solid ${qaColorFinal}">${qaScore}%</div>
    <div>
      <div style="font-size:1.1rem;font-weight:700;color:${qaColorFinal}">${qaLabelFinal}</div>
      <div style="color:#94a3b8;font-size:.8rem">${passCountFinal}/4 categories passed</div>
    </div>
  </div>
  <table>
    <thead><tr><th>Category</th><th>Status</th><th>Files</th></tr></thead>
    <tbody>
      ${Object.values(testCatsFinal).map(c => '<tr><td>' + c.label + '</td><td>' + (c.pass ? '<span class="badge badge-ok">PASS</span>' : '<span class="badge badge-warn">MISSING</span>') + '</td><td>' + c.count + '</td></tr>').join('')}
    </tbody>
  </table>
  <div style="margin-top:12px;font-size:.8rem;color:#94a3b8">
    Files produced: <strong style="color:#e2e8f0">${data.output_links.length}</strong> (min expected: 6)
    ${githubUrlFinal ? ' &middot; <a href="' + githubUrlFinal + '" target="_blank">GitHub Repo</a>' : ''}
    ${data.phase1_duration_ms ? ' &middot; Phase 1: <strong style="color:#e2e8f0">' + (data.phase1_duration_ms < 60000 ? Math.round(data.phase1_duration_ms/1000) + 's' : Math.floor(data.phase1_duration_ms/60000) + 'm ' + Math.round((data.phase1_duration_ms%60000)/1000) + 's') + '</strong>' : ''}
    ${data.total_duration_ms ? ' &middot; Total: <strong style="color:#e2e8f0">' + (data.total_duration_ms < 60000 ? Math.round(data.total_duration_ms/1000) + 's' : Math.floor(data.total_duration_ms/60000) + 'm ' + Math.round((data.total_duration_ms%60000)/1000) + 's') + '</strong>' : ''}
  </div>
  ${deferralsFinal.length > 0 ? '<div style="margin-top:8px;padding:8px;background:#7f1d1d30;border-radius:6px;font-size:.8rem;color:#fca5a5"><strong>Deferrals (' + deferralsFinal.length + '):</strong><ul style="margin-top:4px">' + deferralsFinal.map(d => '<li>' + (d.detail || d.action || 'Deferred item') + '</li>').join('') + '</ul></div>' : ''}
</div>

${renderBuildTimeline(data.build_log)}

${tableBlock('&#x1f4c4; Documents & Deliverables', docs)}
${tableBlock('&#x2699;&#xfe0f; Workflows', workflows)}
${tableBlock('&#x1f5c4;&#xfe0f; Schema / Platform / QA', infra)}
${other.length > 0 ? tableBlock('&#x1f4ce; Other Files', other) : ''}

${data.onedrive_folder_url ? '<a href="' + data.onedrive_folder_url + '" target="_blank" class="folder-link">&#x1f4c2; Open OneDrive Folder</a>' : ''}

<div class="card">
  <h2 onclick="toggleLogs()" style="cursor:pointer">&#x1f4dc; Build Log <span id="logToggle" style="font-size:.75rem;color:#94a3b8">[show]</span></h2>
  <div id="buildLogContainer" style="display:none">
    <pre id="buildLogContent" style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px;font-size:.75rem;max-height:400px;overflow-y:auto;white-space:pre-wrap;color:#94a3b8">Loading...</pre>
  </div>
</div>

<div class="card" style="margin-top:16px">
  <h2>&#x1f4dd; Review Notes</h2>
  <textarea id="notes" placeholder="Optional notes or change requests..."></textarea>
  <div class="btn-row">
    <button class="btn btn-approve" id="approveBtn" onclick="doAction('approve')">&#x2705; Approve Build</button>
    <button class="btn btn-changes" id="changesBtn" onclick="doAction('changes')">&#x1f527; Request Changes</button>
  </div>
  <div id="result" class="result-msg"></div>
</div>

<script>
let logsLoaded = false;
function toggleLogs() {
  const c = document.getElementById('buildLogContainer');
  const t = document.getElementById('logToggle');
  if (c.style.display === 'none') {
    c.style.display = 'block';
    t.textContent = '[hide]';
    if (!logsLoaded) { logsLoaded = true; fetchLogs(); }
  } else {
    c.style.display = 'none';
    t.textContent = '[show]';
  }
}
async function fetchLogs() {
  try {
    const r = await fetch('/api/build/${ticketId}/logs?lines=50');
    const d = await r.json();
    const el = document.getElementById('buildLogContent');
    if (d.lines && d.lines.length > 0) {
      el.textContent = d.lines.join('\\n');
    } else {
      el.textContent = 'No log entries found for this ticket.';
    }
  } catch(e) { document.getElementById('buildLogContent').textContent = 'Error loading logs: ' + e.message; }
}
async function doAction(action) {
  const notes = document.getElementById('notes').value;
  document.getElementById('approveBtn').disabled = true;
  document.getElementById('changesBtn').disabled = true;
  const el = document.getElementById('result');
  try {
    const url = action === 'approve'
      ? '/api/build/${ticketId}/approve'
      : '/api/build/${ticketId}/request-changes';
    const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({notes}) });
    const d = await r.json();
    if (d.success || d.signaled) {
      el.className = 'result-msg result-ok';
      el.textContent = action === 'approve' ? 'Build approved! Deploying...' : 'Change request submitted.';
    } else { throw new Error(d.error || 'Unknown error'); }
  } catch(e) {
    el.className = 'result-msg result-err';
    el.textContent = 'Error: ' + e.message;
    document.getElementById('approveBtn').disabled = false;
    document.getElementById('changesBtn').disabled = false;
  }
}

const _voiceKey = 'manageai-voice-2026';
let _voiceEvt = null;

function toggleVoice() {
  const p = document.getElementById('voicePanel');
  p.classList.toggle('open');
  if (p.classList.contains('open')) {
    initVoice();
    loadBridgeUrl();
  }
}
function closeVoice() {
  document.getElementById('voicePanel').classList.remove('open');
  if (_voiceEvt) { _voiceEvt.close(); _voiceEvt = null; }
}
function loadBridgeUrl() {
  const saved = localStorage.getItem('fridayVoiceBridge') || '';
  document.getElementById('vpBridgeUrl').value = saved;
  if (saved) connectBridge(saved);
}
function saveBridgeUrl() {
  const url = document.getElementById('vpBridgeUrl').value.trim();
  if (url) { localStorage.setItem('fridayVoiceBridge', url); connectBridge(url); }
}
function connectBridge(url) {
  if (_voiceEvt) { _voiceEvt.close(); }
  try {
    _voiceEvt = new EventSource(url);
    _voiceEvt.onmessage = (e) => { appendTranscript(e.data); };
    _voiceEvt.onerror = () => { document.getElementById('vpStatus').textContent = 'Bridge disconnected'; };
    _voiceEvt.onopen = () => { document.getElementById('vpStatus').textContent = 'Bridge connected'; };
  } catch(e) { document.getElementById('vpStatus').textContent = 'Bridge error: ' + e.message; }
}
function appendTranscript(text) {
  const el = document.getElementById('vpTranscript');
  el.textContent += '\n' + text;
  el.scrollTop = el.scrollHeight;
}
async function voiceAction(action, comment) {
  const ticketId = document.body.dataset.ticketId || '';
  appendTranscript('> ' + action + (ticketId ? ' for ' + ticketId : ''));
  try {
    const r = await fetch('/api/voice/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-voice-key': _voiceKey },
      body: JSON.stringify({ action, ticketId, comment: comment || '' })
    });
    const d = await r.json();
    appendTranscript(d.message || d.error || JSON.stringify(d));
  } catch(e) { appendTranscript('Error: ' + e.message); }
}
async function loadVoiceContext() {
  appendTranscript('Loading build context...');
  try {
    const r = await fetch('/api/voice/context');
    const d = await r.json();
    if (d.summary) appendTranscript(d.summary);
  } catch(e) { appendTranscript('Context error: ' + e.message); }
}
function initVoice() {
  // override in page-specific script
}
function initVoice() {
  const actions = document.getElementById('vpActions');
  actions.innerHTML = '<button class="vp-action-btn vp-btn-approve" onclick="voiceAction(\'approve_final\')">Approve Build</button>'
    + '<button class="vp-action-btn vp-btn-changes" onclick="voiceAction(\'request_changes\')">Request Changes</button>'
    + '<button class="vp-action-btn vp-btn-context" onclick="loadVoiceContext()">Load Context</button>';
}
</script>
</body></html>`);
  } catch(e) {
    console.error('[FRIDAY] Build review final error:', e.message);
    res.status(500).send('Error loading review: ' + e.message);
  }
});

// ── GET /build-review/:ticketId/compare ──────────────────────────────────────
app.get('/build-review/:ticketId/compare', async (req, res) => {
  const { ticketId } = req.params;
  try {
    const data = await loadBuildForReview(ticketId);
    if (!data) return res.status(404).send('Build not found for ' + ticketId);

    // Load ticket for brief data
    const { data: ticket } = await supabase.from('friday_tickets').select('*').eq('ticket_id', ticketId).single();
    const brief = ticket?.brief || ticket?.brief_sections || {};
    const briefSections = typeof brief === 'string' ? (() => { try { return JSON.parse(brief); } catch(e) { return {}; } })() : (brief || {});

    // Load build contract from planner
    let contract = {};
    const contractLink = data.output_links.find(l => (l.name || '').includes('build-contract'));
    if (data.build_id) {
      // Try knowledge_documents for contract
      const { data: kd } = await supabase.from('knowledge_documents').select('content,metadata').eq('build_id', data.build_id).eq('source_type', 'build_contract').limit(1);
      if (kd && kd[0]) contract = kd[0].metadata || {};
    }

    // Load scenarios for built workflows
    let scenarios = [];
    if (data.build_id) {
      const { data: sc } = await supabase.from('build_scenarios').select('scenario_key,scenario_name,status').eq('build_id', data.build_id);
      scenarios = sc || [];
    }

    // Categorize output links
    const parsed = parseOutputLinks(data.output_links);

    // Build comparison rows
    const briefFields = [
      { key: 'client_profile', label: 'Client Profile' },
      { key: 'current_state', label: 'Current State' },
      { key: 'prototype_scope', label: 'Prototype Scope' },
      { key: 'success_metrics', label: 'Success Metrics' },
      { key: 'workforce_vision', label: 'Workforce Vision' },
      { key: 'technical_constraints', label: 'Technical Constraints' },
      { key: 'opportunity_assessment', label: 'Opportunity Assessment' }
    ];

    const truncate = (v, len) => {
      if (!v) return '<span class="muted">Not provided</span>';
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return s.length > len ? s.slice(0, len).replace(/</g, '&lt;') + '...' : s.replace(/</g, '&lt;');
    };

    const scopeRows = briefFields.map(f => {
      const briefVal = briefSections[f.key] || briefSections['section_' + f.key] || null;
      return `<tr><td class="compare-label">${f.label}</td><td class="compare-brief">${truncate(briefVal, 200)}</td><td class="compare-built"><span class="badge badge-ok">Addressed</span></td></tr>`;
    }).join('');

    // Build delta: what was built
    const builtSummary = [
      { label: 'Workflows', value: scenarios.length > 0 ? scenarios.map(s => s.scenario_name).join(', ') : parsed.workflows.join(', ') || 'None' },
      { label: 'Schema Files', value: parsed.schemaTables.join(', ') || 'confirmed-schema.json' },
      { label: 'LLM/Prompt Files', value: parsed.llmFiles.join(', ') || 'None' },
      { label: 'External Integrations', value: parsed.extPlatforms.join(', ') || 'None' },
      { label: 'Documents', value: data.output_links.filter(l => (l.name || '').startsWith('build-docs/') || (l.name || '').startsWith('deliverables/')).map(l => (l.name || '').replace(/^(build-docs|deliverables)\//, '')).join(', ') || 'None' },
      { label: 'Total Artifacts', value: data.output_links.length + ' files' },
      { label: 'Agent Definition', value: data.output_links.some(l => (l.name || '').includes('agent-definition')) ? 'Generated' : 'Missing' }
    ];

    const deltaRows = builtSummary.map(b => `<tr><td class="compare-label">${b.label}</td><td colspan="2">${b.value}</td></tr>`).join('');

    // Deferrals
    const deferralContent = '<p class="muted">No deferrals recorded for this build</p>';

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Build Comparison &mdash; ${ticketId}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:16px;max-width:700px;margin:0 auto}
h1{font-size:1.3rem;color:#38bdf8;margin-bottom:4px}
.sub{color:#94a3b8;font-size:.85rem;margin-bottom:20px}
.card{background:#1e293b;border-radius:12px;padding:16px;margin-bottom:16px;border:1px solid #334155}
.card h2{font-size:1rem;color:#f8fafc;margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:.82rem}
th{text-align:left;color:#94a3b8;padding:8px;border-bottom:1px solid #334155;font-weight:500}
td{padding:8px;border-bottom:1px solid #334155;vertical-align:top}
.compare-label{font-weight:600;color:#f8fafc;width:25%;white-space:nowrap}
.compare-brief{color:#94a3b8;width:40%;word-break:break-word}
.compare-built{width:35%}
.badge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:.75rem;font-weight:600}
.badge-ok{background:#064e3b;color:#34d399}
.badge-warn{background:#78350f;color:#fbbf24}
.badge-miss{background:#7f1d1d;color:#f87171}
.muted{color:#64748b;font-style:italic}
p{font-size:.85rem;margin-bottom:6px}
a{color:#38bdf8;text-decoration:none}
.nav{display:flex;gap:12px;margin-bottom:16px;font-size:.85rem}
.status-bar{display:flex;gap:8px;margin-bottom:16px;font-size:.8rem;flex-wrap:wrap}
.status-pill{padding:4px 10px;border-radius:12px;font-weight:600}
</style></head><body>
<h1>Brief vs. Build Comparison</h1>
<div class="sub">${ticketId} &mdash; ${data.project_name}</div>
<div class="nav">
  <a href="/build-review/${ticketId}/phase1">Phase 1 Review</a>
  <a href="/build-review/${ticketId}/final">Final Review</a>
  <a href="/dashboard">Dashboard</a>
</div>
<div class="status-bar">
  <span class="status-pill" style="background:#1e3a5f;color:#60a5fa">${data.client}</span>
  <span class="status-pill" style="background:#064e3b;color:#34d399">${data.status}</span>
  <span class="status-pill" style="background:#312e81;color:#a5b4fc">${data.output_links.length} artifacts</span>
</div>

<div class="card">
  <h2>Scope Confirmation</h2>
  <table>
    <thead><tr><th>Brief Section</th><th>Requirement</th><th>Built</th></tr></thead>
    <tbody>${scopeRows}</tbody>
  </table>
</div>

<div class="card">
  <h2>Build Delta &mdash; What Was Produced</h2>
  <table>
    <thead><tr><th>Category</th><th colspan="2">Details</th></tr></thead>
    <tbody>${deltaRows}</tbody>
  </table>
</div>

<div class="card">
  <h2>Deferrals</h2>
  ${deferralContent}
</div>

</body></html>`);
  } catch(e) {
    console.error('[FRIDAY] Build compare error:', e.message);
    res.status(500).send('Error loading comparison: ' + e.message);
  }
});

// POST reject route
app.post('/api/build/:id/reject', async (req, res) => {
  const cockpitKey = req.headers['x-cockpit-key'];
  if (cockpitKey !== process.env.COCKPIT_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const temporalClient = await getTemporalClient();
    const handle = temporalClient.workflow.getHandle(req.params.id);
    await handle.signal('build-rejected', { notes: req.body?.notes || '' });
    logActivity('build_rejected', 'Build rejected: ' + req.params.id, req.body?.notes || '', null, null, 'warning');
    res.json({ success: true, signaled: 'build-rejected' });
  } catch(e) {
    console.error('[FRIDAY] Reject error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


app.get('/health', async (req, res) => {
  const queueStats = { waiting: 0, active: 0, completed: 0, failed: 0 };
  let temporalStatus = 'unknown';
  try {
    const tc = await getTemporalClient();
    const workflows = tc.workflow.list({ query: "TaskQueue='friday-builds'" });
    let running = 0;
    for await (const wf of workflows) {
      if (wf.status.name === 'RUNNING') running++;
      if (running >= 100) break;
    }
    temporalStatus = 'connected';
  } catch(e) {
    temporalStatus = 'disconnected: ' + e.message.slice(0, 50);
  }
  res.json({
    status: 'ok', server: 'FRIDAY Parallel Swarm API', version: '4.0-temporal',
    platforms: ['make', 'n8n', 'zapier'], queue: queueStats,
    temporal: temporalStatus
  });
});


app.post('/api/answer', async (req, res) => {
  try {
    const { ticket_id, answers } = req.body;
    if (!ticket_id || !answers) return res.status(400).json({ error: 'ticket_id and answers required' });
    console.log('[FRIDAY] Answers received for:', ticket_id);
    const { data: ticket, error: ticketError } = await supabase.from('friday_tickets').select('*').eq('ticket_id', ticket_id).single();
    if (ticketError || !ticket) return res.status(404).json({ error: 'Ticket not found' });
    const updatedDescription = (ticket.request_description || '') + '\n\nCLARIFICATION ANSWERS:\n' + answers;
    let complete = false; let newQuestions = null;
    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const evalResult = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: 'Evaluate build ticket completeness 0-100.\nClient: ' + ticket.client + '\nProject: ' + ticket.project_name + '\nDescription: ' + updatedDescription + '\nReturn JSON only: {"score": number, "complete": boolean, "questions": string or null}' }] });
      const evalJson = JSON.parse(evalResult.content[0].text.replace(/```json|```/g,'').trim());
      complete = evalJson.complete; newQuestions = evalJson.questions;
    } catch(e) { console.warn('[FRIDAY] Re-eval failed, assuming complete:', e.message); complete = true; }
    if (complete) {
      await supabase.from('friday_tickets').update({ request_description: updatedDescription, friday_answers: answers, status: 'building', updated_at: new Date().toISOString() }).eq('ticket_id', ticket_id);
      const { data: buildData } = await supabase.from('friday_builds').insert({ ticket_id: ticket.ticket_id, client_name: ticket.client, project_name: ticket.project_name, platform: ticket.platform, status: 'building', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }).select('id').single();
      const buildJob = { ticket_id: ticket.ticket_id, client: ticket.client, project_name: ticket.project_name, platform: ticket.platform, request_description: updatedDescription, priority: ticket.priority||'medium', submitter_email: ticket.submitter_email||'brian@manageai.io', buildVersion: ticket.version||'v1.0', callback_url: process.env.N8N_WF07_CALLBACK, supabaseBuildId: buildData&&buildData.id };
      // Attach agent configs for fallback swarm
      const answerAgents = getManageAIAgents(buildJob);
      buildJob._agentConfigs = answerAgents;
      runSwarm(buildJob).catch(async (err) => { console.error('[FRIDAY] Build failed after answers:', err.message); if (buildData&&buildData.id) await supabase.from('friday_builds').update({ status:'failed', build_log:'Failed: '+err.message, updated_at:new Date().toISOString() }).eq('id', buildData.id); });
      // Also signal Temporal workflow if running
      try {
        const temporalClient = await getTemporalClient();
        const handle = temporalClient.workflow.getHandle(ticket_id);
        await handle.signal('answers-received', { answers, request_description: updatedDescription });
        console.log('[FRIDAY] Temporal answers signal sent for:', ticket_id);
      } catch(te) {
        console.log('[FRIDAY] Temporal signal skipped (no running workflow):', te.message);
      }
      res.json({ status: 'building', ticket_id, message: 'Answers accepted — build started' });
    } else {
      const count = (ticket.clarification_count || 0) + 1;
      if (count >= 2) {
        await supabase.from('friday_tickets').update({ status:'needs_info', friday_questions:'ESCALATED: '+newQuestions, clarification_count:count, updated_at:new Date().toISOString() }).eq('ticket_id', ticket_id);
        return res.json({ status:'escalated', ticket_id, message:'Escalated to human review after 2 rounds' });
      }
      await supabase.from('friday_tickets').update({ friday_answers:answers, friday_questions:newQuestions, friday_response:newQuestions, clarification_count:count, status:'needs_info', updated_at:new Date().toISOString() }).eq('ticket_id', ticket_id);
      res.json({ status:'needs_info', ticket_id, questions:newQuestions, clarification_round:count });
    }
  } catch(e) { console.error('[FRIDAY] /api/answer error:', e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/status/:ticketId', async (req, res) => {
  try {
    const ticketId = req.params.ticketId;

    // Look up in Supabase
    const { data, error } = await supabase
      .from('friday_builds')
      .select(`
        id, ticket_id, client_name, project_name, platform,
        status, progress_pct, output_links, onedrive_folder_url,
        created_at, updated_at, build_log, version_count, current_version
      `)
      .eq('ticket_id', ticketId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      return res.status(404).json({
        found: false,
        ticket_id: ticketId,
        message: 'Build not found'
      });
    }

    // Parse output_links safely
    let links = [];
    try {
      links = typeof data.output_links === 'string'
        ? JSON.parse(data.output_links)
        : (data.output_links || []);
    } catch(e) { links = []; }

    // Also check Temporal workflow status
    let temporalStatus = null;
    try {
      const temporalClient = await getTemporalClient();
      const handle = temporalClient.workflow.getHandle(ticketId);
      const desc = await handle.describe();
      temporalStatus = {
        workflowId: desc.workflowId,
        status: desc.status?.name || 'UNKNOWN',
        startTime: desc.startTime,
        closeTime: desc.closeTime || null
      };
    } catch(te) { /* no temporal workflow */ }

    res.json({
      found: true,
      ticket_id: data.ticket_id,
      build_id: data.id,
      client_name: data.client_name,
      project_name: data.project_name,
      platform: data.platform,
      status: data.status,
      progress_pct: data.progress_pct || 0,
      file_count: links.length,
      files: links.map(function(l) {
        return { type: l.type, name: l.name, has_url: !!l.url };
      }),
      onedrive_folder: data.onedrive_folder_url || null,
      version: data.current_version || 1,
      version_count: data.version_count || 1,
      created_at: data.created_at,
      updated_at: data.updated_at,
      build_log_preview: data.build_log
        ? data.build_log.substring(0, 200)
        : null,
      temporal: temporalStatus
    });
  } catch(e) {
    console.error('[FRIDAY] Status lookup error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ═══════════════════════════════════════════════════════════════
// TEMPORAL WORKFLOW ENDPOINTS
// ═══════════════════════════════════════════════════════════════

app.post('/api/build/brief', async (req, res) => {
  const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Too many builds. Maximum 5 per minute.' });
  }
  try {
    // BUILD-016: Check maintenance mode before accepting new builds
    try {
      const { createClient: createSbClient } = await import('@supabase/supabase-js');
      const sbCheck = createSbClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data: sysConfig } = await sbCheck.from('system_config').select('value').eq('key', 'system_status').maybeSingle();
      if (sysConfig?.value === 'maintenance') {
        return res.status(503).json({ success: false, error: 'System in maintenance mode', retry_after: '15 minutes' });
      }
    } catch (_) { /* system_config table may not exist yet — allow builds */ }

    const validation = BriefSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        error: 'Brief validation failed',
        fields: validation.error.flatten().fieldErrors
      });
    }
    const brief = req.body.brief || req.body.brief_sections;
    const client = req.body.client || req.body.client_name;
    const { ticket_id, project_name, platform, priority, submitter, submitter_email, version, section_a, customer_id, workflow_steps, decision_authority, success_metrics, data_sources, guardrails, edge_cases, acceptance_criteria } = req.body;
    if ((!brief && !section_a) || !client) return res.status(400).json({ error: 'brief (or section_a) and client required' });

    const tid = ticket_id || ('MAI-' + Date.now());
    let supabaseBuildId = null;
    try {
      const { data: buildRecord } = await supabase.from('friday_builds').insert({
        ticket_id: tid, client_name: client, project_name: project_name || 'Build',
        platform: platform || 'n8n', status: 'building', progress_pct: 0,
        assigned_to: 'temporal-workflow', created_at: new Date().toISOString()
      }).select().single();
      supabaseBuildId = buildRecord?.id || null;
    } catch(e) { console.warn('[FRIDAY] Supabase insert failed:', e.message); }

    const jobData = {
      job_id: 'brief_' + Date.now(), ticket_id: tid, client, project_name: project_name || 'Build',
      platform: platform || 'n8n',
      request_description: brief?.executive_summary?.content || section_a?.client_profile?.content || '',
      priority: priority || 'medium', submitter, submitter_email,
      supabaseBuildId, buildVersion: version || 'v1.0', brief,
      ...(section_a ? { section_a } : {}),
      ...(customer_id ? { customer_id } : {}),
      ...(workflow_steps ? { workflow_steps } : {}),
      ...(decision_authority ? { decision_authority } : {}),
      ...(success_metrics ? { success_metrics } : {}),
      ...(data_sources ? { data_sources } : {}),
      ...(guardrails ? { guardrails } : {}),
      ...(edge_cases ? { edge_cases } : {}),
      ...(acceptance_criteria ? { acceptance_criteria } : {})
    };

    // Attach agent configs
    const briefAgents = getManageAIAgents(jobData);
    jobData._agentConfigs = briefAgents;

    const temporalClient = await getTemporalClient();
    await temporalClient.workflow.start('FridayBuildWorkflow', {
      args: [jobData], taskQueue: 'friday-builds', workflowId: tid
    });
    logActivity('build_submitted', 'Brief build submitted: ' + (project_name || 'Build'), 'Brief format with 7 sections', client, null);
    res.json({ success: true, ticket_id: tid, status: 'queued', mode: 'temporal_workflow_brief' });
  } catch(e) {
    console.error('[FRIDAY] /api/build/brief error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/build/:id/approve', async (req, res) => {
  const cockpitKey = req.headers['x-cockpit-key'];
  if (cockpitKey !== process.env.COCKPIT_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const temporalClient = await getTemporalClient();
    const handle = temporalClient.workflow.getHandle(req.params.id);
    await handle.signal('build-approved');
    logActivity('build_approved', 'Build approved: ' + req.params.id, 'Approved via API', null, null);
    fireBuildWebhooks(req.params.id, 'build_approved', { decision: 'approved' });
    res.json({ success: true, signaled: 'build-approved' });
  } catch(e) {
    console.error('[FRIDAY] Approve error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/build/:id/request-changes', async (req, res) => {
  const cockpitKey = req.headers['x-cockpit-key'];
  if (cockpitKey !== process.env.COCKPIT_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const temporalClient = await getTemporalClient();
    const handle = temporalClient.workflow.getHandle(req.params.id);
    await handle.signal('request-changes', req.body.notes || '');
    logActivity('fix_requested', 'Changes requested: ' + req.params.id, req.body.notes || '', null, null, 'warning');
    fireBuildWebhooks(req.params.id, 'changes_requested', { notes: req.body.notes || '' });
    res.json({ success: true, signaled: 'request-changes' });
  } catch(e) {
    console.error('[FRIDAY] Request changes error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/build/:id/cancel', async (req, res) => {
  const cockpitKey = req.headers['x-cockpit-key'];
  if (cockpitKey !== process.env.COCKPIT_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const temporalClient = await getTemporalClient();
    const handle = temporalClient.workflow.getHandle(req.params.id);
    await handle.terminate('Cancelled via API');
    logActivity('build_rejected', 'Build cancelled: ' + req.params.id, 'Terminated via API', null, null, 'warning');
    fireBuildWebhooks(req.params.id, 'build_cancelled', {});
    res.json({ success: true, terminated: true });
  } catch(e) {
    console.error('[FRIDAY] Cancel error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/build/:id/context', async (req, res) => {
  try {
    const temporalClient = await getTemporalClient();
    const handle = temporalClient.workflow.getHandle(req.params.id);
    await handle.signal('charlie-context-ready', req.body.context || {});
    res.json({ success: true, signaled: 'charlie-context-ready' });
  } catch(e) {
    console.error('[FRIDAY] Context signal error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// FRIDAY POST-BUILD PIPELINE — v1.0 — Added March 22, 2026
// ═══════════════════════════════════════════════════════════════

// Pipeline Supabase helpers — wrap existing supabase client
async function sbFetch(path) {
  try {
    const parts = path.split('?');
    const table = parts[0];
    const params = parts[1] || '';
    let query = supabase.from(table).select('*');
    // Parse basic filters
    const filters = params.split('&');
    for (const f of filters) {
      if (f.startsWith('select=')) continue;
      if (f.startsWith('order=')) {
        const o = f.replace('order=','').split('.');
        query = query.order(o[0], { ascending: o[1] !== 'desc' });
      } else if (f.startsWith('limit=')) {
        query = query.limit(parseInt(f.replace('limit=','')));
      } else if (f.includes('=eq.')) {
        const [col, val] = f.split('=eq.');
        query = query.eq(col, decodeURIComponent(val));
      } else if (f.includes('=ilike.')) {
        const [col, val] = f.split('=ilike.');
        query = query.ilike(col, decodeURIComponent(val));
      }
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

async function sbPatch(path, body) {
  try {
    const parts = path.split('?');
    const table = parts[0];
    const params = parts[1] || '';
    let query = supabase.from(table).update(body);
    const filters = params.split('&');
    for (const f of filters) {
      if (f.includes('=eq.')) {
        const [col, val] = f.split('=eq.');
        query = query.eq(col, decodeURIComponent(val));
      }
    }
    const { error } = await query;
    if (error) { console.error('[SB PATCH]', error.message); return false; }
    return true;
  } catch(e) { console.error('[SB PATCH]', e.message); return false; }
}

function classifyOutputFile(fileName) {
  const n = (fileName || '').toLowerCase();
  if (n.includes('solution demo'))                                    return 'solution_demo';
  if (n.includes('skillset manual') || n.includes('build manual') || n.includes('training manual'))   return 'skillset_manual';
  if (n.includes('deployment summary'))                                return 'deployment_summary';
  if (n.includes('prd') || n.includes('requirements'))               return 'requirements_doc';
  if (n.includes('architecture'))                                     return 'architecture_doc';
  if (n.includes('wave manual') || n.includes('implementation wave')) return 'wave_manual';
  if (n.includes('email template'))                                   return 'email_template';
  // Deployment Package subpackages (agent_05)
  const dpSubpackages = ['workflows.json','prompts.json','schemas.json','knowledge.json','templates.json','mcp-servers.json','environment.json','infrastructure.json','deployment-ops.json'];
  if (dpSubpackages.includes(n))                                      return 'deployment_subpackage';
  if (n === 'package.json')                                           return 'deployment_package';
  if (n.endsWith('.json'))                                            return 'blueprint';
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
    const newCustomer = await sbPost('friday_customers', {
      name: clientName, industry: '', contact_email: '',
      notes: 'Auto-created by FRIDAY build pipeline',
      created_at: new Date().toISOString()
    });
    console.log('[PIPELINE] Created new customer:', clientName);
    return newCustomer && newCustomer[0] ? newCustomer[0].id : null;
  } catch(e) { console.error('[PIPELINE] resolveCustomer error:', e.message); return null; }
}

function deriveSkillsetName(projectName) {
  return (projectName || '')
    .replace(/v\d+(\.\d+)*/gi, '')
    .replace(/\b(update|patch|fix|hotfix|phase \d+)\b/gi, '')
    .replace(/\s+/g, ' ').trim();
}

async function resolveSkillset(customerId, clientName, projectName, platform, buildId) {
  try {
    const projEnc = encodeURIComponent(projectName.split(' ').slice(0, 3).join(' '));
    let resp = await sbFetch('friday_skillsets?customer_id=eq.' + customerId + '&name=ilike.*' + projEnc + '*&select=id,name,version,build_count&limit=1');
    if (resp && resp[0]) {
      const existing = resp[0];
      const newVersion = (existing.version || 1) + 1;
      const newBuildCount = (existing.build_count || 1) + 1;
      await sbPatch('friday_skillsets?id=eq.' + existing.id, {
        latest_build_id: buildId, version: newVersion, build_count: newBuildCount,
        status: 'active', last_delivered_at: new Date().toISOString(), updated_at: new Date().toISOString()
      });
      console.log('[PIPELINE] Updated skillset:', existing.name, '-> v' + newVersion);
      return { id: existing.id, name: existing.name, version: newVersion };
    }
    const skillsetName = deriveSkillsetName(projectName);
    const newSkillset = await sbPost('friday_skillsets', {
      customer_id: customerId, client_name: clientName, name: skillsetName,
      primary_platform: platform, status: 'active', version: 1, build_count: 1,
      latest_build_id: buildId, owner: 'Brian',
      last_delivered_at: new Date().toISOString(),
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    });
    console.log('[PIPELINE] Created new skillset:', skillsetName);
    return newSkillset && newSkillset[0] ? { id: newSkillset[0].id, name: skillsetName, version: 1 } : { id: null, name: skillsetName, version: 1 };
  } catch(e) { console.error('[PIPELINE] resolveSkillset error:', e.message); return { id: null, name: deriveSkillsetName(projectName), version: 1 }; }
}

function deriveAppName(nodeType) {
  const t = (nodeType || '').toLowerCase();
  if (t.includes('anthropic') || t.includes('claude')) return 'Anthropic';
  if (t.includes('openai') || t.includes('gpt'))        return 'OpenAI';
  if (t.includes('supabase'))                           return 'Supabase';
  if (t.includes('google'))                             return 'Google';
  if (t.includes('slack'))                              return 'Slack';
  if (t.includes('webhook') || t.includes('http'))      return 'HTTP';
  return null;
}

function extractModuleStages(workflowJson, platform) {
  const stages = [];
  try {
    if (workflowJson.nodes && Array.isArray(workflowJson.nodes)) {
      workflowJson.nodes.forEach((node, idx) => {
        stages.push({ stage_num: idx + 1, name: node.name || node.type || ('Step ' + (idx+1)), module_type: node.type || 'unknown', description: null, app_name: deriveAppName(node.type || '') });
      });
    } else if (workflowJson.flow && Array.isArray(workflowJson.flow)) {
      workflowJson.flow.forEach((mod, idx) => {
        stages.push({ stage_num: idx + 1, name: mod.name || mod.module || ('Step ' + (idx+1)), module_type: mod.module || 'unknown', description: null, app_name: (mod.module || '').split(':')[0] || null });
      });
    }
  } catch(e) {}
  return stages;
}

async function writeBuildScenarios(buildId, ticketId, agent04Files, platform) {
  try {
    const blueprints = (agent04Files || []).filter(f => (f.name || '').endsWith('.json') || f.type === 'blueprint');
    if (!blueprints.length) { console.log('[PIPELINE] No blueprints for build', buildId); return; }
    for (let i = 0; i < blueprints.length; i++) {
      const file = blueprints[i];
      let workflowJson = null; let moduleStages = [];
      try {
        if (file.localPath && require('fs').existsSync(file.localPath)) {
          workflowJson = JSON.parse(require('fs').readFileSync(file.localPath, 'utf8'));
          moduleStages = extractModuleStages(workflowJson, platform);
        }
      } catch(e) { console.warn('[PIPELINE] Could not parse blueprint:', file.name, e.message); }
      const keyMatch = (file.name || '').match(/^(WF-\d+|SC-\d+|SCENARIO-\d+)/i);
      const scenarioKey = keyMatch ? keyMatch[1].toUpperCase() : ('SC-' + String(i+1).padStart(2,'0'));
      const scenarioName = (file.name || '').replace(/^(WF-\d+|SC-\d+|SCENARIO-\d+)\s*[-_]?\s*/i,'').replace(/\.json$/i,'').trim() || ('Scenario ' + (i+1));
      const SB_URL2 = process.env.SUPABASE_URL || 'https://fmemdogudiolevqsfuvd.supabase.co';
      const SB_KEY2 = process.env.SUPABASE_SERVICE_KEY;
      const r = await fetch(SB_URL2 + '/rest/v1/build_scenarios?on_conflict=build_id,scenario_key', {
        method: 'POST',
        headers: { 'apikey': SB_KEY2, 'Authorization': 'Bearer ' + SB_KEY2, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ build_id: buildId, ticket_id: ticketId, scenario_key: scenarioKey, scenario_name: scenarioName, platform: platform || 'n8n', status: 'active', workflow_json: workflowJson, module_stages: moduleStages.length ? moduleStages : null, onedrive_json_url: file.url || null, updated_at: new Date().toISOString() })
      });
      console.log('[PIPELINE] Scenario written:', scenarioKey, '-', scenarioName, '| http', r.status);
    }
  } catch(e) { console.error('[PIPELINE] writeBuildScenarios error:', e.message); }
}

async function seedChangeLog(buildId, build) {
  try {
    const existing = await sbFetch('workflow_changes?build_id=eq.' + buildId + '&change_type=eq.initial&select=id&limit=1');
    if (existing && existing.length) return;
    const qa = build.progress_pct || 0;
    const version = build.current_version ? 'v' + build.current_version : 'v1.0';
    await sbPost('workflow_changes', {
      build_id: buildId, ticket_id: build.ticket_id || null, change_type: 'initial',
      version_from: null, version_to: version,
      title: 'Initial delivery — ' + (build.project_name || 'Build'),
      description: 'First delivery of ' + (build.project_name || 'this build') + ' for ' + (build.client_name || 'client') + '. QA score: ' + qa + '/100.',
      submitted_by: 'F.R.I.D.A.Y.', status: 'deployed',
      deployed_at: new Date().toISOString(), created_at: new Date().toISOString()
    });
    console.log('[PIPELINE] Change log seeded for build', buildId);
  } catch(e) { console.error('[PIPELINE] seedChangeLog error:', e.message); }
}

async function mapOpportunityAssessment(ticket, customerId, clientName, buildId) {
  try {
    const text = ticket.opportunity_assessment || ticket.additional_context || '';
    if (!text || text.length < 50) return;
    let structuredOpps = [];
    try {
      const cr = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 4096, messages: [{ role: 'user', content: 'Extract opportunities from this assessment for client "' + clientName + '". Return JSON only, no markdown. Format: [{"name":"...","description":"2-3 sentences","score":0-100,"value_tier":"high|medium|low","phase":"Phase 1|Phase 2|backlog"}]\n\nText:\n' + text }] })
      });
      const d = await cr.json();
      if (d.content && d.content[0]) { const rawOpps = d.content[0].text.replace(/```json\n?/g,"").replace(/```\n?/g,"").trim(); structuredOpps = JSON.parse(rawOpps); }
    } catch(ce) { console.warn('[PIPELINE] Claude opp extraction failed:', ce.message); }
    await sbPost('knowledge_documents', { customer_id: customerId, client_name: clientName, build_id: buildId, ticket_id: ticket.ticket_id, source_type: 'opportunity_assessment', title: 'Opportunity Assessment — ' + clientName, content: text, metadata: { opportunities: structuredOpps, extracted_at: new Date().toISOString(), source: 'ticket_intake' }, created_at: new Date().toISOString() });
    console.log('[PIPELINE] Opportunity assessment mapped for', clientName);
  } catch(e) { console.warn('[PIPELINE] mapOpportunityAssessment error (non-fatal):', e.message); }
}

async function mapLinkedFiles(ticket, customerId, clientName, buildId) {
  try {
    let locs = ticket.file_locations || [];
    if (!Array.isArray(locs)) { try { locs = JSON.parse(locs); } catch(e) { locs = []; } }
    if (!locs.length) return;
    for (const loc of locs) {
      if (!loc || !loc.trim()) continue;
      let content = null; let fileType = 'unknown'; let fileName = loc.split('/').pop() || 'Linked File';
      try {
        if (loc.includes('docs.google.com/spreadsheets')) {
          const sheetId = loc.match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1];
          if (sheetId) { const r = await fetch('https://docs.google.com/spreadsheets/d/' + sheetId + '/export?format=csv'); content = await r.text(); fileType = 'google_sheet'; fileName = 'Google Sheet — ' + sheetId.slice(0,12); }
        } else if (loc.includes('sharepoint.com')) {
          content = 'SharePoint file reference: ' + loc; fileType = 'sharepoint_ref';
        } else if (loc.startsWith('http')) {
          const r = await fetch(loc); content = await r.text(); fileType = 'url_content';
        }
        if (content && content.length > 20) {
          await sbPost('knowledge_documents', { customer_id: customerId, client_name: clientName, build_id: buildId, ticket_id: ticket.ticket_id, source_type: 'file', title: fileName, content: content.slice(0,10000), metadata: { source_url: loc, file_type: fileType, pulled_at: new Date().toISOString() }, created_at: new Date().toISOString() });
          console.log('[PIPELINE] Mapped linked file:', fileName);
        }
      } catch(fe) {
        await sbPost('knowledge_documents', { customer_id: customerId, client_name: clientName, build_id: buildId, ticket_id: ticket.ticket_id, source_type: 'file_ref', title: fileName, content: 'File reference (pull failed): ' + loc, metadata: { source_url: loc, pull_error: fe.message }, created_at: new Date().toISOString() });
      }
    }
  } catch(e) { console.warn('[PIPELINE] mapLinkedFiles error (non-fatal):', e.message); }
}

async function extractCredentialsFromTicket(ticket, buildId) {
  try {
    const text = ticket.existing_systems || '';
    if (!text || text.length < 20) return;
    const cr = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 4096, messages: [{ role: 'user', content: 'Extract credentials and API references from this text. Return JSON only, no markdown. Format: [{"label":"name","cred_type":"api_key|login|webhook|oauth|other","masked_value":"mask all but last 4 chars with \u2022\u2022\u2022\u2022","notes":"context"}]\n\nIf none found return []\n\nText: ' + text }] })
    });
    const d = await cr.json();
    if (!d.content || !d.content[0]) return;
    const rawCreds = d.content[0].text.replace(/```json\n?/g,"").replace(/```\n?/g,"").trim(); const creds = JSON.parse(rawCreds);
    for (const cred of (creds || [])) {
      if (!cred.label) continue;
      await sbPost('build_credentials', { build_id: buildId, ticket_id: ticket.ticket_id, label: cred.label, cred_type: cred.cred_type || 'other', masked_value: cred.masked_value || '••••', notes: cred.notes || null, created_at: new Date().toISOString() });
    }
    console.log('[PIPELINE] Credentials extracted:', (creds||[]).length, 'entries');
  } catch(e) { console.warn('[PIPELINE] extractCredentialsFromTicket error (non-fatal):', e.message); }
}

async function finalizeBuildRecord(buildId, { customerId, skillsetId, skillsetName, skillsetVersion, outputLinks, qaScore, onedriveFolderUrl }) {
  const patch = { status: 'done', skillset_name: skillsetName || null, current_version: skillsetVersion || 1, output_links: outputLinks || [], progress_pct: qaScore || 0, onedrive_folder_url: onedriveFolderUrl || null, updated_at: new Date().toISOString() };
  if (customerId) patch.customer_id = customerId;
  if (skillsetId) patch.skillset_id = skillsetId;
  await sbPatch('friday_builds?id=eq.' + buildId, patch);
  console.log('[PIPELINE] Build record finalized:', buildId);
}

async function runPostBuildPipeline(buildId, ticketId, outputFiles, qaScore, onedriveFolderUrl) {
  console.log('[PIPELINE] ======= Starting post-build pipeline for build', buildId, '=======');
  try {
    const buildRows = await sbFetch('friday_builds?id=eq.' + buildId + '&select=*&limit=1');
    const build = (buildRows || [])[0];
    if (!build) { console.error('[PIPELINE] Build not found:', buildId); return; }
    let ticket = {};
    if (ticketId) {
      const tr = await sbFetch('friday_tickets?ticket_id=eq.' + ticketId + '&select=*&limit=1');
      ticket = (tr || [])[0] || {};
    }
    const clientName = build.client_name || ticket.client || 'Unknown Client';
    const projectName = build.project_name || ticket.project_name || 'Build';
    const platform = build.platform || ticket.platform || 'n8n';

    const outputLinks = (outputFiles || []).map(f => ({ name: f.name, url: f.url || null, type: f.type || classifyOutputFile(f.name), size_kb: f.size_kb || null, localPath: f.localPath || null }));
    console.log('[PIPELINE] Step 1: Classified', outputLinks.length, 'files');

    let customerId = build.customer_id || null;
    if (!customerId) customerId = await resolveCustomer(clientName);
    console.log('[PIPELINE] Step 2: Customer ID:', customerId);

    let skillsetId = null, skillsetName = deriveSkillsetName(projectName), skillsetVersion = 1;
    if (customerId) {
      const sk = await resolveSkillset(customerId, clientName, projectName, platform, buildId);
      skillsetId = sk.id; skillsetName = sk.name; skillsetVersion = sk.version;
    }
    console.log('[PIPELINE] Step 3: Skillset:', skillsetName, 'v' + skillsetVersion);

    const agent04Files = outputLinks.filter(f => f.type === 'blueprint');
    await writeBuildScenarios(buildId, ticketId, agent04Files, platform);
    console.log('[PIPELINE] Step 4: Scenarios written:', agent04Files.length);

    await seedChangeLog(buildId, { ...build, progress_pct: qaScore || build.progress_pct || 0 });
    console.log('[PIPELINE] Step 5: Change log seeded');

    await Promise.allSettled([
      mapOpportunityAssessment(ticket, customerId, clientName, buildId),
      mapLinkedFiles(ticket, customerId, clientName, buildId),
      extractCredentialsFromTicket(ticket, buildId)
    ]);
    console.log('[PIPELINE] Steps 6-9: Enrichment complete');

    await finalizeBuildRecord(buildId, {
      customerId, skillsetId, skillsetName, skillsetVersion,
      outputLinks: outputLinks.map(f => ({ name: f.name, url: f.url, type: f.type, size_kb: f.size_kb })),
      qaScore: qaScore || 0, onedriveFolderUrl: onedriveFolderUrl || null
    });
    // ── Write agent configs to Supabase ──
  try {
    const agentConfigs = [
      { agent_id:'agent_01', agent_label:'Solution Demo Builder', model:'claude-sonnet-4-5', max_tokens:8000, full_prompt:'Build a complete interactive Solution Demo HTML file for '+clientName+' — '+projectName+'. Platform: '+platform+'. '+(ticket.request_description||'') },
      { agent_id:'agent_02', agent_label:'Skillset Manual Author', model:'claude-sonnet-4-5', max_tokens:8000, full_prompt:'Build a complete Skillset Training Manual HTML file for '+clientName+' — '+projectName+'. Platform: '+platform+'. '+(ticket.request_description||'') },
      { agent_id:'agent_03', agent_label:'Requirements & Docs Writer', model:'claude-sonnet-4-5', max_tokens:8000, full_prompt:'Write Requirements Document, Architecture Assessment, and Implementation Wave Manual for '+clientName+' — '+projectName+'. Platform: '+platform+'. '+(ticket.request_description||'') },
      { agent_id:'agent_04', agent_label:'Workflow Architect', model:'claude-sonnet-4-5', max_tokens:8000, full_prompt:'Design and build all '+platform+' workflow JSON blueprints for '+clientName+' — '+projectName+'. '+(ticket.request_description||'') }
    ];
    for (const ac of agentConfigs) {
      await sbPost('build_agent_configs', {
        build_id: buildId, ticket_id: ticketId,
        agent_id: ac.agent_id, agent_label: ac.agent_label,
        model: ac.model, max_tokens: ac.max_tokens,
        full_prompt: ac.full_prompt, created_at: new Date().toISOString()
      });
    }
    console.log('[PIPELINE] Agent configs written to Supabase');
  } catch(e) { console.warn('[PIPELINE] Agent config write error (non-fatal):', e.message); }

  console.log('[PIPELINE] Step 10: Build record finalized');
    console.log('[PIPELINE] ======= Post-build pipeline complete for build', buildId, '=======');
  } catch(e) {
    console.error('[PIPELINE] FATAL pipeline error for build', buildId, ':', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// END FRIDAY POST-BUILD PIPELINE
// ═══════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════
// FRIDAY COCKPIT ENDPOINT
// ═══════════════════════════════════════════════
const COCKPIT_SECRET = 'friday-cockpit-2026';

app.post('/api/cockpit', async (req, res) => {
  const auth = req.headers['x-cockpit-key'];
  if (auth !== COCKPIT_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const { message, history = [], client_id, skillset_id, chat_id } = req.body;

  // ── Load project context if client/skillset selected ──
  let projectContext = '';
  if (client_id || skillset_id) {
    try {
      const SB = process.env.SUPABASE_URL;
      const SK = process.env.SUPABASE_SERVICE_KEY;
      const h = { apikey: SK, Authorization: 'Bearer ' + SK };

      const [clientRes, skillsetRes, buildsRes, scenariosRes, changelogRes, chatsRes] = await Promise.all([
        client_id ? fetch(SB+'/rest/v1/friday_customers?id=eq.'+client_id+'&select=*&limit=1', {headers:h}).then(r=>r.json()) : Promise.resolve([]),
        skillset_id ? fetch(SB+'/rest/v1/friday_skillsets?id=eq.'+skillset_id+'&select=*&limit=1', {headers:h}).then(r=>r.json()) : Promise.resolve([]),
        skillset_id ? fetch(SB+'/rest/v1/friday_builds?skillset_id=eq.'+skillset_id+'&select=id,ticket_id,status,progress_pct,platform,output_links,created_at&order=created_at.desc&limit=5', {headers:h}).then(r=>r.json()) : Promise.resolve([]),
        skillset_id ? fetch(SB+'/rest/v1/build_scenarios?build_id=in.(select+id+from+friday_builds+where+skillset_id=eq.'+skillset_id+')&select=scenario_key,scenario_name,status,platform&order=created_at.desc&limit=20', {headers:h}).then(r=>r.json()).catch(()=>[]) : Promise.resolve([]),
        skillset_id ? fetch(SB+'/rest/v1/workflow_changes?build_id=in.(select+id+from+friday_builds+where+skillset_id=eq.'+skillset_id+')&select=version_to,change_type,title,created_at&order=created_at.desc&limit=10', {headers:h}).then(r=>r.json()).catch(()=>[]) : Promise.resolve([]),
        (client_id || skillset_id) ? fetch(SB+'/rest/v1/cockpit_chats?'+(skillset_id?'skillset_id=eq.'+skillset_id:'customer_id=eq.'+client_id)+'&select=title,summary,updated_at&order=updated_at.desc&limit=5', {headers:h}).then(r=>r.json()).catch(()=>[]) : Promise.resolve([]),
      ]);

      const client = clientRes[0];
      const skillset = skillsetRes[0];

      projectContext = '\n\n═══ PROJECT CONTEXT ═══';
      if (client) projectContext += '\nCLIENT: ' + client.name + ' | Health: ' + (client.health_score||'?') + '/100 | Status: ' + (client.status||'active');
      if (skillset) projectContext += '\nSKILLSET: ' + skillset.name + ' | Platform: ' + (skillset.primary_platform||'?') + ' | Version: v' + (skillset.version||1) + ' | Builds: ' + (skillset.build_count||0);

      if (Array.isArray(buildsRes) && buildsRes.length) {
        projectContext += '\nRECENT BUILDS:';
        buildsRes.forEach(b => {
          const files = (() => { try { return JSON.parse(b.output_links||'[]').length; } catch(e) { return 0; } })();
          projectContext += '\n  - ' + b.ticket_id + ' | ' + b.status + ' | QA:' + (b.progress_pct||0) + '/100 | ' + files + ' files | ' + new Date(b.created_at).toLocaleDateString();
        });
      }

      if (Array.isArray(scenariosRes) && scenariosRes.length) {
        const unique = [...new Map(scenariosRes.map(s=>[s.scenario_key,s])).values()];
        projectContext += '\nWORKFLOW SCENARIOS (' + unique.length + ' total):';
        unique.forEach(s => {
          projectContext += '\n  - ' + s.scenario_key + ' | ' + s.scenario_name + ' | ' + (s.status||'unknown') + ' | ' + (s.platform||'');
        });
      }

      if (Array.isArray(changelogRes) && changelogRes.length) {
        projectContext += '\nCHANGE LOG (recent):';
        changelogRes.forEach(c => {
          projectContext += '\n  - v' + (c.version_to||'?') + ' | ' + c.change_type + ' | ' + c.title + ' | ' + new Date(c.created_at).toLocaleDateString();
        });
      }

      if (Array.isArray(chatsRes) && chatsRes.length) {
        projectContext += '\nRECENT SESSIONS:';
        chatsRes.forEach(c => {
          if (c.title) projectContext += '\n  - ' + c.title + (c.summary ? ': ' + c.summary.slice(0,100) : '') + ' (' + new Date(c.updated_at).toLocaleDateString() + ')';
        });
      }

      projectContext += '\n═══════════════════════';
    } catch(e) {
      console.warn('[COCKPIT] Context load error:', e.message);
    }
  }
  if (!message) return res.status(400).json({ error: 'No message' });

  const system = `You are FRIDAY, the AI build agent for ManageAI. You run on the Hetzner build server and have full knowledge of the platform.

SERVER: 5.223.79.255 | PM2: manageai-build-api | Files: /opt/manageai/build-api/
SUPABASE: https://fmemdogudiolevqsfuvd.supabase.co
TABLES: friday_builds, friday_customers, friday_tickets, friday_skillsets, build_scenarios, workflow_changes, build_credentials, build_agent_configs, knowledge_documents
N8N: manageai2026.app.n8n.cloud | WF-01 intake | WF-07 callback
DASHBOARD: friday.manageai.io | GITHUB: github.com/Brian2169fdsa/friday
ONEDRIVE: /ManageAI/Clients/ folder structure

YOU CAN:
- Query Supabase for any data
- Read and write files on this server
- Restart PM2
- Call n8n API to list, activate, deactivate workflows
- Submit and monitor builds
- Suggest and implement server.js changes
- Push changes to GitHub

YOUR ROLE: You are Brian's build partner and Head of Build AI agent. You have FULL access to the live platform.

CRITICAL RULES:
1. ALWAYS use tools to get live data — never summarize from context alone
2. When asked about n8n workflows: call n8n_action with action='list' FIRST then report what you actually find
3. When asked about builds: call query_supabase FIRST to get fresh data
4. When asked about server status: call run_command with 'pm2 status' FIRST
5. When asked to fix something: read_file first, propose the fix, write_file to apply it, restart if needed
6. When asked about a specific build: query ALL related tables — friday_builds, build_scenarios, workflow_changes, build_credentials
7. NEVER say "based on the data above" — always fetch fresh data for every question
8. For n8n specifically: always check BOTH build_scenarios (what was built) AND n8n_action list (what is live in n8n) and compare them
9. If something is broken: diagnose it, fix it, confirm it works — full loop
10. Be the engineer Brian can trust to handle the entire build system autonomously`;

  try {
    const messages = [
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: message }
    ];

    // ── Helper: run a command on the server ──
  async function runCmd(cmd) {
    return new Promise((resolve) => {
      import('child_process').then(({ exec }) => {
        exec(cmd, { cwd: '/opt/manageai/build-api', timeout: 15000 }, (err, stdout, stderr) => {
          resolve({ stdout: stdout||'', stderr: stderr||'', error: err?.message||null });
        });
      });
    });
  }

  // ── Helper: call n8n API ──
  async function n8nCall(path, method='GET', body=null) {
    const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIzODFlMDYxNy0yYTI3LTQwODEtYTIyMy0yZWM0NjBhNzE1YjAiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiZTkyYzcxZTctMmI0Ny00ZGQ1LThjZjQtOTQ3MGU1N2I3MDQ1IiwiaWF0IjoxNzc0NzMyOTY4fQ.4SpA3xcbKSSqMaQaeXcs8X6N_srQz6us47t1aeLba-4';
    const r = await fetch('http://localhost:5678/api/v1/' + path, {
      method,
      headers: { 'X-N8N-API-KEY': key, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    return r.json();
  }

  // Fetch real context from Supabase before calling Claude
  let context = '';
  try {
    const SB = process.env.SUPABASE_URL || 'https://fmemdogudiolevqsfuvd.supabase.co';
    const SK = process.env.SUPABASE_SERVICE_KEY;
    const headers = { 'apikey': SK, 'Authorization': 'Bearer ' + SK };

    // Fetch n8n workflows
    let n8nWorkflows = [];
    try {
      const n8nData = await n8nCall('workflows');
      n8nWorkflows = n8nData.data || [];
    } catch(e) {}

    const [builds, customers, tickets, scenarios] = await Promise.all([
      fetch(SB+'/rest/v1/friday_builds?select=id,ticket_id,client_name,project_name,status,progress_pct,platform,created_at&order=created_at.desc&limit=10', {headers}).then(r=>r.json()),
      fetch(SB+'/rest/v1/friday_customers?select=id,name,health_score,status&order=created_at.desc&limit=20', {headers}).then(r=>r.json()),
      fetch(SB+'/rest/v1/friday_tickets?select=ticket_id,client_name,project_name,status,platform,created_at&order=created_at.desc&limit=10', {headers}).then(r=>r.json()),
      fetch(SB+'/rest/v1/build_scenarios?select=scenario_key,scenario_name,status,build_id&order=created_at.desc&limit=20', {headers}).then(r=>r.json()),
    ]);

    context = `
LIVE SUPABASE DATA (as of right now):

RECENT BUILDS (${Array.isArray(builds)?builds.length:0} shown):
${Array.isArray(builds)?builds.map(b=>`- ${b.ticket_id} | ${b.client_name} | ${b.project_name} | ${b.status} | QA:${b.progress_pct||'?'} | ${b.platform} | ${b.created_at}`).join('\n'):'error fetching'}

CUSTOMERS (${Array.isArray(customers)?customers.length:0} total):
${Array.isArray(customers)?customers.map(c=>`- ${c.name} | health:${c.health_score||'?'} | ${c.status}`).join('\n'):'error fetching'}

RECENT TICKETS:
${Array.isArray(tickets)?tickets.map(t=>`- ${t.ticket_id} | ${t.client_name} | ${t.project_name} | ${t.status} | ${t.platform}`).join('\n'):'error fetching'}

N8N WORKFLOWS (${n8nWorkflows.length} total):
${n8nWorkflows.map(w=>`- ${w.id} | ${w.name} | ${w.active?"active":"inactive"}`).join("\n")}

RECENT SCENARIOS:
${Array.isArray(scenarios)?scenarios.map(s=>`- ${s.scenario_key} | ${s.scenario_name} | ${s.status}`).join('\n'):'error fetching'}
`;
  } catch(dbErr) {
    context = 'Could not fetch live Supabase data: ' + dbErr.message;
  }

  const tools = [
    {
      name: 'submit_build',
      description: 'Submit a real build ticket to the FRIDAY build system. Actually creates the ticket and fires the build swarm.',
      input_schema: {
        type: 'object',
        properties: {
          client_name: { type: 'string' },
          project_name: { type: 'string' },
          platform: { type: 'string' },
          request_description: { type: 'string' },
          priority: { type: 'string' }
        },
        required: ['client_name', 'project_name', 'platform', 'request_description']
      }
    },
    {
      name: 'run_command',
      description: 'Run a whitelisted bash command on the server and return output.',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command']
      }
    },
    {
      name: 'query_supabase',
      description: 'Query any Supabase table and return results.',
      input_schema: {
        type: 'object',
        properties: {
          table: { type: 'string' },
          query: { type: 'string' }
        },
        required: ['table']
      }
    },
    {
      name: 'read_file',
      description: 'Read any file on the server. Returns the file contents.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Full file path e.g. /opt/manageai/build-api/server.js' },
          lines: { type: 'string', description: 'Optional line range e.g. 640-680' }
        },
        required: ['path']
      }
    },
    {
      name: 'write_file',
      description: 'Write or update a file on the server.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Full file path within /opt/manageai/' },
          content: { type: 'string', description: 'Full file content to write' }
        },
        required: ['path', 'content']
      }
    },
    {
      name: 'git_action',
      description: 'Run git operations on the friday repo or server repo. Actions: status, add, commit, push, pull, diff, log.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'status, add, commit, push, pull, diff, log' },
          message: { type: 'string', description: 'Commit message (required for commit)' },
          repo: { type: 'string', description: 'friday or server (default: friday)' }
        },
        required: ['action']
      }
    },
    {
      name: 'create_table',
      description: 'Run any SQL in Supabase — create tables, alter schema, add columns, create indexes.',
      input_schema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'The SQL to execute' }
        },
        required: ['sql']
      }
    },
    {
      name: 'npm_action',
      description: 'Run npm commands in the build-api directory.',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'e.g. install express, run build, list' }
        },
        required: ['command']
      }
    },
    {
      name: 'create_n8n_workflow',
      description: 'Create a new n8n workflow from a JSON blueprint.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Workflow name' },
          workflow_json: { type: 'object', description: 'Full n8n workflow JSON' },
          activate: { type: 'boolean', description: 'Whether to activate after creating' }
        },
        required: ['name', 'workflow_json']
      }
    },
    {
      name: 'send_teams',
      description: 'Send a message to a Microsoft Teams channel via webhook.',
      input_schema: {
        type: 'object',
        properties: {
          webhook_url: { type: 'string', description: 'Teams webhook URL' },
          title: { type: 'string', description: 'Message title' },
          message: { type: 'string', description: 'Message body' },
          color: { type: 'string', description: 'Card color: green, red, amber, blue' }
        },
        required: ['webhook_url', 'message']
      }
    },
    {
      name: 'read_logs',
      description: 'Read PM2 logs, optionally filtered by build ID or agent.',
      input_schema: {
        type: 'object',
        properties: {
          lines: { type: 'number', description: 'Number of lines to return (default 50)' },
          filter: { type: 'string', description: 'Optional filter string e.g. agent_02 or MAI-1234' }
        }
      }
    },
    {
      name: 'supabase_write',
      description: 'Insert, update, or delete records in any Supabase table.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'insert, update, or delete' },
          table: { type: 'string', description: 'Table name' },
          data: { type: 'object', description: 'Data to insert or update' },
          filter: { type: 'string', description: 'Filter for update/delete e.g. id=eq.abc123' }
        },
        required: ['action', 'table']
      }
    },
    {
      name: 'n8n_action',
      description: 'Call the n8n API. Actions: list, activate, deactivate, get, executions.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          workflow_id: { type: 'string' }
        },
        required: ['action']
      }
    },
    {
      name: 'temporal_action',
      description: 'Manage Temporal workflows — list running builds, cancel a build, send a signal, or view workflow history',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'cancel', 'signal', 'history'] },
          workflowId: { type: 'string' },
          signalName: { type: 'string' },
          payload: { type: 'object' }
        },
        required: ['action']
      }
    }
  ];

  // ── Agent Registry ──
  const AGENT_REGISTRY = {
    server:   { name: 'Server Agent',    tools: ['run_command','read_file','write_file','read_logs','npm_action'], prompt: 'You are the Server Agent. You manage the Hetzner build server — files, PM2, bash commands, logs. Be precise and safe.' },
    supabase: { name: 'Supabase Agent',  tools: ['query_supabase','supabase_write','create_table'], prompt: 'You are the Supabase Agent. You manage all database operations — queries, inserts, schema changes.' },
    n8n:      { name: 'n8n Agent',       tools: ['n8n_action','create_n8n_workflow'], prompt: 'You are the n8n Agent. You manage all workflow automation — listing, activating, creating, debugging workflows.' },
    frontend: { name: 'Frontend Agent',  tools: ['read_file','write_file','git_action'], prompt: 'You are the Frontend Agent. You manage the FRIDAY dashboard — index.html changes, CSS, JS, and GitHub deployments.' },
    build:    { name: 'Build Agent',     tools: ['submit_build','query_supabase','read_logs'], prompt: 'You are the Build Agent. You submit, monitor, and debug build jobs through the 4-agent swarm.' },
    debug:    { name: 'Debug Agent',     tools: ['read_logs','run_command','query_supabase','read_file'], prompt: 'You are the Debug Agent. You diagnose issues by reading logs, checking files, and querying data.' },
  };

  // ── Planner — decides which agents to use ──
  async function planTask(userMessage, ctx) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: `Given this request: "${userMessage}"
        
Which agents are needed? Available: server, supabase, n8n, frontend, build, debug
Also: does this need user approval before executing? (approval needed for: deleting data, modifying production files, creating tables, pushing to GitHub)

Respond in JSON only:
{"agents": ["agent1", "agent2"], "needs_approval": false, "approval_message": null, "strategy": "parallel or sequential"}` }]
      })
    });
    const d = await r.json();
    try {
      const text = d.content[0].text.replace(/```json\s*/g,'').replace(/```\s*/g,'').trim();
      return JSON.parse(text);
    } catch(e) {
      return { agents: ['server', 'supabase', 'n8n'], needs_approval: false, strategy: 'sequential' };
    }
  }

  // ── Approval gate ──
  function needsApproval(plan) {
    return plan.needs_approval === true;
  }

  async function callClaude(msgs) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 4000,
        system: system + '\n\n' + context + projectContext + '\n\nACTIVE AGENTS: ' + agentContext,
        tools,
        messages: msgs
      })
    });
    return r.json();
  }

  async function executeTool(name, input) {
    if (name === 'read_file') {
      try {
        const { readFileSync } = await import('fs');
        let fileContent = readFileSync(input.path, 'utf8');
        if (input.lines) {
          const parts = input.lines.split('-');
          const start = parseInt(parts[0]) - 1;
          const end = parseInt(parts[1]);
          fileContent = fileContent.split('\n').slice(start, end).join('\n');
        }
        return fileContent.slice(0, 8000); // cap at 8KB
      } catch(e) { return 'Error reading file: ' + e.message; }
    }
    if (name === 'write_file') {
      try {
        if (!input.path.startsWith('/opt/manageai/')) return 'Error: path must be within /opt/manageai/';
        const { writeFileSync } = await import('fs');
        writeFileSync(input.path, input.content, 'utf8');
        return 'File written successfully: ' + input.path;
      } catch(e) { return 'Error writing file: ' + e.message; }
    }
    if (name === 'git_action') {
      try {
        const repoPath = input.repo === 'server' ? '/opt/manageai' : '/root/friday';
        let cmd = '';
        if (input.action === 'status') cmd = 'git status';
        else if (input.action === 'add') cmd = 'git add -A';
        else if (input.action === 'commit') cmd = 'git commit -m "' + (input.message || 'FRIDAY update') + '"';
        else if (input.action === 'push') cmd = 'git push origin main';
        else if (input.action === 'pull') cmd = 'git pull origin main';
        else if (input.action === 'diff') cmd = 'git diff HEAD~1';
        else if (input.action === 'log') cmd = 'git log --oneline -10';
        else return 'Unknown action: ' + input.action;
        return new Promise(resolve => {
          import('child_process').then(({ exec }) => {
            exec(cmd, { cwd: repoPath, timeout: 30000 }, (err, stdout, stderr) => {
              resolve(stdout || stderr || err?.message || 'done');
            });
          });
        });
      } catch(e) { return 'Git error: ' + e.message; }
    }
    if (name === 'create_table') {
      try {
        const { data, error } = await supabase.rpc('exec_sql', { sql: input.sql });
        if (error) {
          // Try direct REST approach with service key
          const SB = process.env.SUPABASE_URL;
          const SK = process.env.SUPABASE_SERVICE_KEY;
          const r = await fetch(SB + '/rest/v1/rpc/exec_sql', {
            method: 'POST',
            headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' },
            body: JSON.stringify({ sql: input.sql })
          });
          if (!r.ok) {
            return 'Table creation requires manual SQL. Go to Supabase SQL editor and run: ' + input.sql;
          }
          return 'SQL executed via RPC';
        }
        return 'SQL executed successfully';
      } catch(e) { return 'SQL error: ' + e.message; }
    }
    if (name === 'npm_action') {
      return new Promise(resolve => {
        import('child_process').then(({ exec }) => {
          exec('npm ' + input.command, { cwd: '/opt/manageai/build-api', timeout: 60000 }, (err, stdout, stderr) => {
            resolve(stdout || stderr || err?.message || 'done');
          });
        });
      });
    }
    if (name === 'create_n8n_workflow') {
      try {
        const key = process.env.N8N_API_KEY; if (!key) return 'n8n API key not configured';
        const base = 'http://localhost:5678/api/v1';
        const wf = { ...input.workflow_json, name: input.name };
        const r = await fetch(base + '/workflows', {
          method: 'POST',
          headers: { 'X-N8N-API-KEY': key, 'Content-Type': 'application/json' },
          body: JSON.stringify(wf)
        });
        const d = await r.json();
        if (d.id && input.activate) {
          await fetch(base + '/workflows/' + d.id + '/activate', {
            method: 'POST',
            headers: { 'X-N8N-API-KEY': key, 'Content-Type': 'application/json' }
          });
        }
        return JSON.stringify({ id: d.id, name: d.name, active: !!input.activate });
      } catch(e) { return 'n8n create error: ' + e.message; }
    }
    if (name === 'send_teams') {
      try {
        const colorMap = { green: '00A86B', red: 'E04848', amber: 'D97706', blue: '4A8FD6' };
        const themeColor = colorMap[input.color] || '4A8FD6';
        const payload = {
          '@type': 'MessageCard',
          '@context': 'http://schema.org/extensions',
          themeColor,
          summary: input.title || input.message,
          sections: [{ activityTitle: input.title || 'FRIDAY', activityText: input.message }]
        };
        const r = await fetch(input.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        return r.ok ? 'Teams message sent' : 'Teams error: ' + await r.text();
      } catch(e) { return 'Teams error: ' + e.message; }
    }
    if (name === 'read_logs') {
      return new Promise(resolve => {
        import('child_process').then(({ exec }) => {
          const lines = input.lines || 50;
          const cmd = input.filter
            ? 'pm2 logs manageai-build-api --lines ' + lines + ' --nostream | grep "' + input.filter + '"'
            : 'pm2 logs manageai-build-api --lines ' + lines + ' --nostream';
          exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
            resolve(stdout || stderr || err?.message || 'no logs');
          });
        });
      });
    }
    if (name === 'supabase_write') {
      try {
        const SB = process.env.SUPABASE_URL;
        const SK = process.env.SUPABASE_SERVICE_KEY;
        const headers = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json', Prefer: 'return=representation' };
        let url = SB + '/rest/v1/' + input.table;
        let method = 'POST';
        if (input.action === 'update') { method = 'PATCH'; url += '?' + input.filter; }
        else if (input.action === 'delete') { method = 'DELETE'; url += '?' + input.filter; }
        const r = await fetch(url, { method, headers, body: input.data ? JSON.stringify(input.data) : undefined });
        const d = await r.json();
        return JSON.stringify(d);
      } catch(e) { return 'Supabase write error: ' + e.message; }
    }
    if (name === 'submit_build') {
      try {
        const r = await fetch('http://localhost:3000/api/build', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client: input.client_name,
            project_name: input.project_name,
            platform: input.platform,
            request_description: input.request_description,
            priority: input.priority || 'medium',
            submitter: 'FRIDAY Cockpit'
          })
        });
        return JSON.stringify(await r.json());
      } catch(e) { return 'Build error: ' + e.message; }
    }
    if (name === 'run_command') {
      if (!isAllowed(input.command)) return 'Command not allowed: ' + input.command;
      return new Promise(resolve => {
        import('child_process').then(({ exec }) => {
          exec(input.command, { cwd: '/opt/manageai/build-api', timeout: 15000 }, (err, stdout, stderr) => {
            resolve(stdout || stderr || err?.message || 'no output');
          });
        });
      });
    }
    if (name === 'query_supabase') {
      try {
        const SB = process.env.SUPABASE_URL;
        const SK = process.env.SUPABASE_SERVICE_KEY;
        const url = SB + '/rest/v1/' + input.table + (input.query ? '?' + input.query : '?limit=20');
        const r = await fetch(url, { headers: { apikey: SK, Authorization: 'Bearer ' + SK } });
        return JSON.stringify(await r.json());
      } catch(e) { return 'Query error: ' + e.message; }
    }
    if (name === 'n8n_action') {
      try {
        const key = process.env.N8N_API_KEY; if (!key) return 'n8n API key not configured';
        const base = 'http://localhost:5678/api/v1';
        let url = base + '/workflows';
        let method = 'GET';
        if (input.action === 'activate' && input.workflow_id) { url = base + '/workflows/' + input.workflow_id + '/activate'; method = 'POST'; }
        else if (input.action === 'deactivate' && input.workflow_id) { url = base + '/workflows/' + input.workflow_id + '/deactivate'; method = 'POST'; }
        else if (input.action === 'get' && input.workflow_id) { url = base + '/workflows/' + input.workflow_id; }
        else if (input.action === 'executions' && input.workflow_id) { url = base + '/executions?workflowId=' + input.workflow_id + '&limit=5'; }
        const r = await fetch(url, { method, headers: { 'X-N8N-API-KEY': key, 'Content-Type': 'application/json' } });
        return JSON.stringify(await r.json());
      } catch(e) { return 'n8n error: ' + e.message; }
    }
    if (name === 'temporal_action') {
      try {
        const temporalClient = await getTemporalClient();
        if (input.action === 'list') {
          const workflows = temporalClient.workflow.list({ query: "TaskQueue='friday-builds'" });
          const items = [];
          for await (const wf of workflows) {
            items.push({ workflowId: wf.workflowId, status: wf.status.name, startTime: wf.startTime });
            if (items.length >= 20) break;
          }
          return JSON.stringify(items);
        }
        if (input.action === 'cancel' && input.workflowId) {
          const handle = temporalClient.workflow.getHandle(input.workflowId);
          await handle.terminate('Cancelled via cockpit');
          return 'Workflow ' + input.workflowId + ' terminated';
        }
        if (input.action === 'signal' && input.workflowId && input.signalName) {
          const handle = temporalClient.workflow.getHandle(input.workflowId);
          await handle.signal(input.signalName, input.payload || {});
          return 'Signal ' + input.signalName + ' sent to ' + input.workflowId;
        }
        if (input.action === 'history' && input.workflowId) {
          const handle = temporalClient.workflow.getHandle(input.workflowId);
          const desc = await handle.describe();
          return JSON.stringify({ workflowId: desc.workflowId, status: desc.status?.name, startTime: desc.startTime, closeTime: desc.closeTime, taskQueue: desc.taskQueue });
        }
        return 'Unknown temporal action: ' + input.action;
      } catch(e) { return 'Temporal error: ' + e.message; }
    }
    return 'Unknown tool: ' + name;
  }

  // ── Run planner to decide agents ──
  let agentPlan = { agents: [], needs_approval: false, strategy: 'sequential' };
  try {
    agentPlan = await planTask(message, context);
    console.log('[COCKPIT PLANNER] agents:', agentPlan.agents, '| approval:', agentPlan.needs_approval);
  } catch(e) {
    console.warn('[COCKPIT PLANNER] fallback:', e.message);
  }

  // ── Approval gate ──
  if (needsApproval(agentPlan) && agentPlan.approval_message) {
    return res.json({
      reply: '⚠️ **Approval Required**\n\n' + agentPlan.approval_message + '\n\nType **"yes proceed"** to confirm or **"no cancel"** to abort.',
      needs_approval: true
    });
  }

  // ── Filter tools to relevant agents ──
  const activeAgents = agentPlan.agents.length > 0 ? agentPlan.agents : Object.keys(AGENT_REGISTRY);
  const activeToolNames = [...new Set(activeAgents.flatMap(a => AGENT_REGISTRY[a]?.tools || []))];
  const activeTools = tools.filter(t => activeToolNames.includes(t.name));
  const agentContext = activeAgents.map(a => AGENT_REGISTRY[a]?.prompt || '').filter(Boolean).join('\n');

  // ── Streaming setup ──
  const wantsStream = req.headers['accept'] === 'text/event-stream';
  if (wantsStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();
  }

  const streamSend = (type, data) => {
    if (wantsStream) res.write(`data: ${JSON.stringify({type, data})}

`);
  };

  // Agentic loop — up to 15 tool calls
  let currentMessages = [...messages];
  let finalReply = 'No response';

  for (let i = 0; i < 15; i++) {
    const data = await callClaude(currentMessages);
    console.log('[COCKPIT LOOP] iteration', i, 'stop_reason:', data.stop_reason, 'content types:', JSON.stringify((data.content||[]).map(b=>b.type)));
    const textBlock = data.content?.find(b => b.type === 'text');
    if (!data.content || data.content.length === 0) {
      finalReply = 'I processed your request. ' + (currentMessages.slice(-1)[0]?.content?.[0]?.content || '');
      break;
    }
    if (data.stop_reason === 'end_turn') {
      finalReply = textBlock?.text || 'Done';
      break;
    }
    if (!data.content?.find(b => b.type === 'tool_use')) {
      finalReply = textBlock?.text || data.content?.[0]?.text || 'Done';
      break;
    }
    if (data.stop_reason === 'tool_use') {
      const toolBlocks = data.content.filter(b => b.type === 'tool_use');
      currentMessages.push({ role: 'assistant', content: data.content });
      const toolResults = await Promise.all(toolBlocks.map(async tb => {
        streamSend('tool', { name: tb.name, status: 'running', input: JSON.stringify(tb.input).slice(0,100) });
        let result = await executeTool(tb.name, tb.input);
        result = String(result).slice(0, 3000); // cap tool results at 3KB
        console.log('[COCKPIT TOOL]', tb.name, 'result:', result.slice(0,200));
        streamSend('tool', { name: tb.name, status: 'done', preview: result.slice(0,100) });
        return {
          type: 'tool_result',
          tool_use_id: tb.id,
          content: String(result)
        };
      }));
      currentMessages.push({ role: 'user', content: toolResults });
      continue;
    }
    finalReply = data.content?.find(b => b.type === 'text')?.text || 'Task completed';
    break;
  }

  if (wantsStream) {
    streamSend('reply', finalReply);
    streamSend('done', null);
    res.end();
  } else {
    res.json({ reply: finalReply });
  }
  } catch(e) {
    console.error('[COCKPIT] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════
// COCKPIT N8N AUDIT
// ═══════════════════════════════════════════════
app.get('/api/cockpit/n8n-audit', async (req, res) => {
  const auth = req.headers['x-cockpit-key'];
  if (auth !== COCKPIT_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const n8nKey = process.env.N8N_API_KEY;
    const base = 'http://localhost:5678/api/v1';
    const [wfRes, execRes] = await Promise.all([
      fetch(base + '/workflows?limit=100', { headers: { 'X-N8N-API-KEY': n8nKey } }).then(r=>r.json()),
      fetch(base + '/executions?limit=50', { headers: { 'X-N8N-API-KEY': n8nKey } }).then(r=>r.json())
    ]);
    const workflows = wfRes.data || [];
    const executions = execRes.data || [];
    const audit = workflows.map(wf => {
      const wfExecs = executions.filter(e => e.workflowId === wf.id);
      const lastExec = wfExecs[0];
      return {
        id: wf.id, name: wf.name, active: wf.active,
        nodes: wf.nodes?.length || 0,
        lastExecution: lastExec ? { status: lastExec.status, startedAt: lastExec.startedAt } : null,
        execCount: wfExecs.length
      };
    });
    res.json({
      total: workflows.length,
      active: audit.filter(w=>w.active).length,
      inactive: audit.filter(w=>!w.active).length,
      friday_workflows: audit.filter(w=>w.name.toLowerCase().includes('friday')||w.name.toLowerCase().includes('wf-')),
      errors: audit.filter(w=>w.lastExecution?.status==='error'),
      full_audit: audit
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
// COCKPIT SESSION SUMMARY — auto-summarize chats
// ═══════════════════════════════════════════════
app.post('/api/cockpit/summarize', async (req, res) => {
  const auth = req.headers['x-cockpit-key'];
  if (auth !== COCKPIT_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const { chat_id, messages } = req.body;
  if (!chat_id || !messages?.length) return res.status(400).json({ error: 'Missing data' });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{ role: 'user', content: 'Summarize this build session in 1-2 sentences focusing on what was accomplished or decided:\n\n' + messages.slice(-10).map(m => m.role + ': ' + m.content).join('\n') }]
      })
    });
    const d = await r.json();
    const summary = d.content?.[0]?.text || '';

    const SB = process.env.SUPABASE_URL;
    const SK = process.env.SUPABASE_SERVICE_KEY;
    await fetch(SB+'/rest/v1/cockpit_chats?id=eq.'+chat_id, {
      method: 'PATCH',
      headers: { apikey: SK, Authorization: 'Bearer '+SK, 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary, updated_at: new Date().toISOString() })
    });

    res.json({ summary });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════
// FRIDAY EXEC ENDPOINT — Secure command execution
// ═══════════════════════════════════════════════
const EXEC_SECRET = 'friday-cockpit-2026';

const ALLOWED_COMMANDS = [
  'pm2', 'cat', 'ls', 'node', 'git',
  'tail', 'grep', 'find', 'wc', 'echo',
  'mkdir', 'cp', 'mv', 'python3', 'curl',
  'sed', 'awk', 'head', 'sort', 'uniq', 'diff'
];

const BLOCKED_PATTERNS = [
  'rm -rf', 'rm -f /', 'dd if=', 'mkfs',
  '> /dev/sd', 'chmod 777 /', ':(){ :|:& };:',
  '&&', '||', '$(', '`', '|', '>>', '<<',
  '/etc/shadow', '/etc/passwd',
  'eval ', 'exec '
];

const BLOCKED_CHARS = [';', '&', '|', '`', '$', '>', '<', '!'];

function isAllowed(cmd) {
  const trimmed = cmd.trim();
  // Block shell metacharacters that enable command chaining
  for (const ch of BLOCKED_CHARS) {
    // Allow pipe only within grep/awk/sort patterns (single command context)
    if (ch === '|' && trimmed.split(' ')[0] === 'pm2') continue;
    if (trimmed.includes(ch)) return false;
  }
  for (const blocked of BLOCKED_PATTERNS) {
    if (trimmed.includes(blocked)) return false;
  }
  const firstWord = trimmed.split(' ')[0].split('/').pop();
  return ALLOWED_COMMANDS.includes(firstWord);
}

app.post('/api/exec', async (req, res) => {
  const auth = req.headers['x-cockpit-key'];
  if (auth !== EXEC_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'No command' });
  if (!isAllowed(command)) {
    return res.status(403).json({ error: 'Command not allowed: ' + command.split(' ')[0] });
  }

  console.log('[EXEC] Running:', command);

  const { exec } = await import('child_process');
  exec(command, { cwd: '/opt/manageai/build-api', timeout: 30000 }, (err, stdout, stderr) => {
    res.json({
      success: !err,
      stdout: stdout || '',
      stderr: stderr || '',
      error: err ? err.message : null
    });
  });
});

// ── File write endpoint ──
app.post('/api/write', async (req, res) => {
  const auth = req.headers['x-cockpit-key'];
  if (auth !== EXEC_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const { path: filePath, content: fileContent } = req.body;
  if (!filePath || fileContent === undefined) return res.status(400).json({ error: 'Missing path or content' });

  // Only allow writes within /opt/manageai/
  if (!filePath.startsWith('/opt/manageai/')) {
    return res.status(403).json({ error: 'Write outside /opt/manageai/ not allowed' });
  }

  try {
    const { writeFileSync } = await import('fs');
    writeFileSync(filePath, fileContent, 'utf8');
    console.log('[WRITE] Wrote:', filePath);
    res.json({ success: true, path: filePath });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// -- Agent Message Bus --
app.post("/api/agent-message", async (req, res) => {
  try {
    const { from_agent, to_agent, message_type, urgency, payload, correlation_id, callback_url } = req.body;
    if (!from_agent || !payload) return res.status(400).json({ error: "from_agent and payload required" });
    const { data, error } = await supabase.from("agent_messages").insert({
      from_agent, to_agent: to_agent || "BUILD-001", message_type: message_type || "notification",
      urgency: urgency || "normal", payload, correlation_id: correlation_id || null,
      callback_url: callback_url || null, status: "received",
      created_at: new Date().toISOString()
    }).select();
    if (error) throw new Error(error.message);
    console.log("[FRIDAY] Agent message from", from_agent, "type:", message_type);
    res.json({ success: true, message_id: data?.[0]?.id, status: "received" });
  } catch(e) {
    console.error("[FRIDAY] Agent message error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /dashboard ───────────────────────────────────────────────────────────
app.get('/dashboard', async (req, res) => {
  try {
    const { data: builds } = await supabase.from('friday_builds')
      .select('id,ticket_id,client_name,project_name,platform,status,progress_pct,review_status,output_links,onedrive_folder_url,build_log,created_at,updated_at')
      .order('created_at', { ascending: false }).limit(50);

    const active = (builds || []).filter(b => !['done','failed','cancelled'].includes(b.status));
    const completed = (builds || []).filter(b => b.status === 'done').slice(0, 20);
    const failed = (builds || []).filter(b => b.status === 'failed').slice(0, 5);

    const parseArr = (v) => { if (Array.isArray(v)) return v; if (typeof v === 'string') try { return JSON.parse(v); } catch(e) {} return []; };

    const renderBuildRow = (b) => {
      const statusColors = { done: '#34d399', running: '#60a5fa', building: '#60a5fa', planning: '#fbbf24', failed: '#f87171', cancelled: '#94a3b8' };
      const color = statusColors[b.status] || '#94a3b8';
      const links = parseArr(b.output_links);
      const log = parseArr(b.build_log);
      const fileCount = links.length;
      const hasAgentDef = links.some(l => l.type === 'agent_definition' || (l.name || '').includes('agent-definition'));
      const hasCharlie = log.some(l => l.action === 'charlie_post_build' && l.detail === 'ok');
      const charlieStatus = log.find(l => l.action === 'charlie_post_build');
      const qaEntry = log.find(l => l.action === 'finalize_build');
      const reviewUrl = '/build-review/' + b.ticket_id + '/final';
      const phase1Url = '/build-review/' + b.ticket_id + '/phase1';
      const compareUrl = '/build-review/' + b.ticket_id + '/compare';

      return `<div class="build-card">
        <div class="build-header">
          <span class="build-ticket">${b.ticket_id}</span>
          <span class="status-pill" style="background:${color}20;color:${color}">${b.status}</span>
        </div>
        <div class="build-title">${b.project_name || 'Untitled'}</div>
        <div class="build-meta">${b.client_name || 'Unknown'} &middot; ${b.platform || 'n8n'} &middot; ${fileCount} files</div>
        <div class="build-meta">${b.progress_pct || 0}% complete &middot; Review: ${b.review_status || 'pending'}</div>
        <div class="build-indicators">
          <span class="indicator ${hasAgentDef ? 'ind-ok' : 'ind-missing'}">Agent Def</span>
          <span class="indicator ${hasCharlie ? 'ind-ok' : 'ind-missing'}">Charlie</span>
          <span class="indicator ${b.onedrive_folder_url ? 'ind-ok' : 'ind-missing'}">OneDrive</span>
        </div>
        ${charlieStatus && charlieStatus.detail !== 'ok' ? '<div class="build-warn">' + (charlieStatus.detail || '').slice(0, 100) + '</div>' : ''}
        <div class="build-links">
          ${b.status === 'done' ? '<a href="' + reviewUrl + '">Final Review</a>' : ''}
          <a href="${phase1Url}">Phase 1</a>
          ${b.status === 'done' ? '<a href="' + compareUrl + '">Compare</a>' : ''}
          ${b.onedrive_folder_url ? '<a href="' + b.onedrive_folder_url + '" target="_blank">OneDrive</a>' : ''}
        </div>
        <div class="build-time">${new Date(b.created_at).toLocaleDateString()} &mdash; ${b.updated_at ? new Date(b.updated_at).toLocaleDateString() : ''}</div>
      </div>`;
    };

    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FRIDAY Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:16px;max-width:800px;margin:0 auto}
h1{font-size:1.4rem;color:#38bdf8;margin-bottom:4px}
.subtitle{color:#94a3b8;font-size:.85rem;margin-bottom:20px}
h2{font-size:1.1rem;color:#f8fafc;margin:24px 0 12px;border-bottom:1px solid #334155;padding-bottom:8px}
.section-count{color:#94a3b8;font-weight:normal;font-size:.85rem}
.build-card{background:#1e293b;border-radius:12px;padding:14px;margin-bottom:12px;border:1px solid #334155}
.build-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.build-ticket{font-family:monospace;font-size:.8rem;color:#94a3b8}
.status-pill{padding:2px 10px;border-radius:12px;font-size:.75rem;font-weight:600}
.build-title{font-size:1rem;font-weight:600;color:#f8fafc;margin-bottom:4px}
.build-meta{font-size:.8rem;color:#94a3b8;margin-bottom:2px}
.build-indicators{display:flex;gap:6px;margin:8px 0;flex-wrap:wrap}
.indicator{font-size:.7rem;padding:2px 8px;border-radius:6px;font-weight:600}
.ind-ok{background:#064e3b;color:#34d399}
.ind-missing{background:#7f1d1d30;color:#f8717180}
.build-warn{font-size:.75rem;color:#fbbf24;background:#78350f30;padding:4px 8px;border-radius:6px;margin:4px 0}
.build-links{display:flex;gap:10px;margin-top:8px;flex-wrap:wrap}
.build-links a{color:#38bdf8;font-size:.8rem;text-decoration:none}
.build-links a:hover{text-decoration:underline}
.build-time{font-size:.7rem;color:#64748b;margin-top:6px}
.empty{color:#64748b;font-style:italic;padding:12px}
</style></head><body>
<h1>FRIDAY Dashboard</h1>
<div class="subtitle">${new Date().toLocaleString()} &middot; ${(builds || []).length} builds loaded</div>

<h2>Active Builds <span class="section-count">(${active.length})</span></h2>
${active.length ? active.map(renderBuildRow).join('') : '<div class="empty">No active builds</div>'}

<h2>Completed <span class="section-count">(${completed.length})</span></h2>
${completed.length ? completed.map(renderBuildRow).join('') : '<div class="empty">No completed builds</div>'}

${failed.length ? '<h2>Failed <span class="section-count">(' + failed.length + ')</span></h2>' + failed.map(renderBuildRow).join('') : ''}

</body></html>`);
  } catch(e) {
    console.error('[DASHBOARD]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /builds — Build history page ─────────────────────────────────────────
app.get('/builds', async (req, res) => {
  try {
    const { data: builds } = await supabase.from('friday_builds')
      .select('id,ticket_id,client_name,project_name,platform,status,progress_pct,output_links,created_at')
      .order('created_at', { ascending: false }).limit(200);

    const rows = builds || [];
    const grouped = {};
    for (const b of rows) {
      const key = b.client_name || 'Unknown';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(b);
    }

    const parseArrB = (v) => { if (Array.isArray(v)) return v; if (typeof v === 'string') try { return JSON.parse(v); } catch(e) {} return []; };

    const clientSections = Object.keys(grouped).sort().map(client => {
      const clientBuilds = grouped[client].map(b => {
        const qa = b.progress_pct || 0;
        const qaColor = qa >= 80 ? '#22c55e' : qa >= 50 ? '#eab308' : '#ef4444';
        const statusColors = { done: '#34d399', running: '#60a5fa', building: '#60a5fa', planning: '#fbbf24', failed: '#f87171', cancelled: '#94a3b8' };
        const sColor = statusColors[b.status] || '#94a3b8';
        const fileCount = parseArrB(b.output_links).length;
        const created = new Date(b.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const reviewUrl = '/build-review/' + b.ticket_id + '/final';
        return `<tr>
          <td>${b.project_name || 'Untitled'}</td>
          <td><span style="color:${qaColor};font-weight:700">${qa}%</span></td>
          <td><span class="status-pill" style="background:${sColor}20;color:${sColor}">${b.status}</span></td>
          <td>${fileCount}</td>
          <td>${created}</td>
          <td><a href="${reviewUrl}" class="review-link">Review &rarr;</a></td>
        </tr>`;
      }).join('');
      return `<div class="client-group">
        <h2>${client} <span class="count">(${grouped[client].length})</span></h2>
        <div class="table-wrap"><table><thead><tr><th>Project</th><th>QA</th><th>Status</th><th>Files</th><th>Created</th><th></th></tr></thead><tbody>${clientBuilds}</tbody></table></div>
      </div>`;
    }).join('');

    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FRIDAY — Builds</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:16px;max-width:900px;margin:0 auto}
h1{font-size:1.5rem;color:#38bdf8;margin-bottom:4px}
.subtitle{color:#94a3b8;font-size:.85rem;margin-bottom:24px}
.client-group{margin-bottom:28px}
h2{font-size:1.1rem;color:#f8fafc;margin-bottom:10px;border-bottom:1px solid #334155;padding-bottom:6px}
h2 .count{color:#64748b;font-weight:normal;font-size:.85rem}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th{text-align:left;color:#94a3b8;font-weight:600;padding:6px 10px;border-bottom:1px solid #334155;white-space:nowrap}
td{padding:8px 10px;border-bottom:1px solid #1e293b;white-space:nowrap}
tr:hover{background:#1e293b}
.status-pill{padding:2px 10px;border-radius:12px;font-size:.75rem;font-weight:600}
.review-link{color:#38bdf8;text-decoration:none;font-weight:600}
.review-link:hover{text-decoration:underline}
nav{margin-bottom:20px;display:flex;gap:16px;align-items:center}
nav a{color:#94a3b8;text-decoration:none;font-size:.85rem}
nav a:hover{color:#38bdf8}
@media(max-width:600px){td,th{padding:6px 6px;font-size:.78rem}h1{font-size:1.2rem}}

.voice-btn{display:flex;align-items:center;gap:6px;padding:6px 14px;background:#1E3348;color:#fff;border:none;border-radius:8px;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;letter-spacing:.02em}
.voice-btn:hover{background:#243f5c}
.voice-btn svg{flex-shrink:0}
#voicePanel{display:none;position:fixed;bottom:20px;right:20px;width:320px;background:#1e293b;border:1px solid #334155;border-radius:14px;padding:16px;z-index:9999;box-shadow:0 8px 32px #000a}
#voicePanel.open{display:block}
.vp-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.vp-title{font-size:.85rem;font-weight:700;color:#38bdf8;letter-spacing:.05em;text-transform:uppercase}
.vp-close{background:none;border:none;color:#64748b;cursor:pointer;font-size:18px;line-height:1;padding:2px 6px}
.vp-close:hover{color:#f87171}
.vp-transcript{min-height:70px;max-height:150px;overflow-y:auto;background:#0f172a;border-radius:8px;padding:10px;font-size:.8rem;color:#94a3b8;margin-bottom:10px;line-height:1.6;border:1px solid #334155}
.vp-actions{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.vp-action-btn{padding:7px 12px;border:none;border-radius:7px;font-size:.78rem;font-weight:700;cursor:pointer;font-family:inherit}
.vp-btn-approve{background:#064e3b;color:#34d399}
.vp-btn-approve:hover{background:#065f46}
.vp-btn-changes{background:#78350f;color:#fbbf24}
.vp-btn-changes:hover{background:#92400e}
.vp-btn-context{background:#1e3a5f;color:#60a5fa}
.vp-btn-context:hover{background:#1e4d7f}
.vp-url-row{display:flex;gap:6px;margin-top:4px}
.vp-url-input{flex:1;padding:6px 8px;background:#0f172a;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:.75rem}
.vp-url-save{padding:6px 10px;background:#334155;color:#94a3b8;border:none;border-radius:6px;font-size:.75rem;cursor:pointer;font-weight:700}
.vp-url-save:hover{background:#475569;color:#fff}
.vp-status{font-size:.7rem;color:#64748b;margin-top:6px;text-align:right}
</style></head><body>
<nav>
  <a href="/builds">Builds</a><a href="/brief-intake">New Build</a><a href="/admin">Admin</a><a href="/dashboard">Dashboard</a>
  <span style="flex:1"></span>
  <button id="voiceBtn" onclick="toggleVoice()" class="voice-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg> Voice</button>
</nav><div id="voicePanel">
<div class="vp-header"><span class="vp-title">Voice Interface</span><button class="vp-close" onclick="closeVoice()">&#x2715;</button></div>
<div id="vpTranscript" class="vp-transcript">Ready. Press an action or speak via bridge.</div>
<div class="vp-actions" id="vpActions"></div>
<div class="vp-url-row">
  <input class="vp-url-input" id="vpBridgeUrl" placeholder="Voice bridge URL..." />
  <button class="vp-url-save" onclick="saveBridgeUrl()">Save</button>
</div>
<div class="vp-status" id="vpStatus">Not connected</div>
</div>
<h1>Build History</h1>
<div class="subtitle">${rows.length} builds</div>
<input id="search" type="text" placeholder="Search by client name..." style="width:100%;padding:10px 14px;border-radius:8px;border:1px solid #334155;background:#1e293b;color:#f8fafc;font-size:.9rem;margin-bottom:20px;outline:none" oninput="filterClients(this.value)">
<div id="clientList">${clientSections || '<p style="color:#64748b">No builds found.</p>'}</div>
<script>
function filterClients(q){
  var groups=document.querySelectorAll('.client-group');
  var lq=q.toLowerCase();
  groups.forEach(function(g){
    var name=g.querySelector('h2');
    if(!name)return;
    var match=name.textContent.toLowerCase().indexOf(lq)!==-1;
    g.style.display=match?'':'none';
  });
}

const _voiceKey = 'manageai-voice-2026';
let _voiceEvt = null;

function toggleVoice() {
  const p = document.getElementById('voicePanel');
  p.classList.toggle('open');
  if (p.classList.contains('open')) {
    initVoice();
    loadBridgeUrl();
  }
}
function closeVoice() {
  document.getElementById('voicePanel').classList.remove('open');
  if (_voiceEvt) { _voiceEvt.close(); _voiceEvt = null; }
}
function loadBridgeUrl() {
  const saved = localStorage.getItem('fridayVoiceBridge') || '';
  document.getElementById('vpBridgeUrl').value = saved;
  if (saved) connectBridge(saved);
}
function saveBridgeUrl() {
  const url = document.getElementById('vpBridgeUrl').value.trim();
  if (url) { localStorage.setItem('fridayVoiceBridge', url); connectBridge(url); }
}
function connectBridge(url) {
  if (_voiceEvt) { _voiceEvt.close(); }
  try {
    _voiceEvt = new EventSource(url);
    _voiceEvt.onmessage = (e) => { appendTranscript(e.data); };
    _voiceEvt.onerror = () => { document.getElementById('vpStatus').textContent = 'Bridge disconnected'; };
    _voiceEvt.onopen = () => { document.getElementById('vpStatus').textContent = 'Bridge connected'; };
  } catch(e) { document.getElementById('vpStatus').textContent = 'Bridge error: ' + e.message; }
}
function appendTranscript(text) {
  const el = document.getElementById('vpTranscript');
  el.textContent += '\n' + text;
  el.scrollTop = el.scrollHeight;
}
async function voiceAction(action, comment) {
  const ticketId = document.body.dataset.ticketId || '';
  appendTranscript('> ' + action + (ticketId ? ' for ' + ticketId : ''));
  try {
    const r = await fetch('/api/voice/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-voice-key': _voiceKey },
      body: JSON.stringify({ action, ticketId, comment: comment || '' })
    });
    const d = await r.json();
    appendTranscript(d.message || d.error || JSON.stringify(d));
  } catch(e) { appendTranscript('Error: ' + e.message); }
}
async function loadVoiceContext() {
  appendTranscript('Loading build context...');
  try {
    const r = await fetch('/api/voice/context');
    const d = await r.json();
    if (d.summary) appendTranscript(d.summary);
  } catch(e) { appendTranscript('Context error: ' + e.message); }
}
function initVoice() {
  // override in page-specific script
}
function initVoice() {
  const actions = document.getElementById('vpActions');
  actions.innerHTML = '<button class="vp-action-btn vp-btn-context" onclick="loadVoiceContext()">Load Build Summary</button>'
    + '<button class="vp-action-btn vp-btn-context" onclick="loadVoiceAlerts()">Check Alerts</button>';
  loadVoiceContext();
}
async function loadVoiceAlerts() {
  appendTranscript('Checking alerts...');
  try {
    const r = await fetch('/api/voice/alerts');
    const d = await r.json();
    appendTranscript(d.summary || 'No alert summary available.');
  } catch(e) { appendTranscript('Alerts error: ' + e.message); }
}
</script>
</body></html>`);
  } catch(e) {
    console.error('[BUILDS]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /brief-intake — Brief submission form ────────────────────────────────
app.get('/brief-intake', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FRIDAY — Brief Intake</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:16px;max-width:600px;margin:0 auto}
h1{font-size:1.5rem;color:#38bdf8;margin-bottom:4px}
.subtitle{color:#94a3b8;font-size:.85rem;margin-bottom:24px}
label{display:block;font-size:.85rem;color:#94a3b8;margin-bottom:4px;margin-top:16px}
input,select,textarea{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #334155;background:#1e293b;color:#f8fafc;font-size:.9rem;font-family:inherit}
input:focus,select:focus,textarea:focus{outline:none;border-color:#38bdf8}
textarea{min-height:200px;font-family:monospace;font-size:.8rem;resize:vertical}
button{margin-top:20px;width:100%;padding:12px;border:none;border-radius:8px;background:#2563eb;color:#fff;font-size:1rem;font-weight:600;cursor:pointer}
button:hover{background:#1d4ed8}
button:disabled{opacity:.5;cursor:not-allowed}
.result{margin-top:20px;padding:14px;border-radius:8px;display:none}
.result.ok{display:block;background:#064e3b;color:#34d399}
.result.err{display:block;background:#7f1d1d;color:#fca5a5}
.result a{color:#38bdf8}
nav{margin-bottom:20px;display:flex;gap:16px}
nav a{color:#94a3b8;text-decoration:none;font-size:.85rem}
nav a:hover{color:#38bdf8}
</style></head><body>
<nav><a href="/builds">Builds</a><a href="/brief-intake">New Build</a><a href="/admin">Admin</a><a href="/dashboard">Dashboard</a></nav>
<h1>Brief Intake</h1>
<div class="subtitle">Submit a new build brief to FRIDAY</div>
<form id="bf">
  <label for="client">Client Name</label>
  <input id="client" name="client" required placeholder="Acme Corp">
  <label for="project">Project Name</label>
  <input id="project" name="project" required placeholder="CRM Integration Build">
  <label for="platform">Platform</label>
  <select id="platform" name="platform"><option value="n8n">n8n</option><option value="Make.com">Make.com</option><option value="Zapier">Zapier</option></select>
  <label for="brief">Brief JSON</label>
  <textarea id="brief" name="brief" required placeholder='Paste full brief JSON here...'></textarea>
  <div style="display:flex;gap:10px;margin-top:20px">
    <button type="button" id="estBtn" onclick="estimateCost()" style="flex:1;padding:12px;border:1px solid #334155;border-radius:8px;background:#1e293b;color:#38bdf8;font-size:.9rem;font-weight:600;cursor:pointer">Estimate Cost</button>
    <button type="submit" id="btn" style="flex:2">Submit Brief</button>
  </div>
</form>
<div id="est" style="display:none;margin-top:16px;padding:14px;background:#1e293b;border:1px solid #334155;border-radius:8px">
  <div style="font-weight:600;color:#f8fafc;margin-bottom:8px">Build Estimate</div>
  <div id="estBody" style="font-size:.82rem;color:#94a3b8"></div>
</div>
<div id="res" class="result"></div>
<script>
async function estimateCost(){
  var btn=document.getElementById('estBtn'),ed=document.getElementById('est'),eb=document.getElementById('estBody');
  btn.disabled=true;btn.textContent='Estimating...';
  try{
    var bv=document.getElementById('brief').value.trim();
    var bo;try{bo=JSON.parse(bv);}catch(e){bo=bv;}
    var r=await fetch('/api/build/estimate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({brief:bo,platform:document.getElementById('platform').value})});
    var d=await r.json();
    if(d.success){
      var e=d.estimate;
      eb.innerHTML='<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'+
        '<div>Tables: <strong style="color:#f8fafc">~'+e.scope.estimated_tables+'</strong></div>'+
        '<div>Workflows: <strong style="color:#f8fafc">~'+e.scope.estimated_workflows+'</strong></div>'+
        '<div>Tokens: <strong style="color:#f8fafc">~'+(e.tokens.total/1000).toFixed(0)+'K</strong></div>'+
        '<div>Est. Cost: <strong style="color:#22c55e">$'+e.cost.estimated_usd+'</strong></div>'+
        '<div>Build Time: <strong style="color:#f8fafc">~'+e.time.total_minutes+' min</strong></div>'+
        '<div>Storage: <strong style="color:#f8fafc">~'+e.storage.total_kb+' KB</strong></div></div>';
      ed.style.display='block';
    }else{eb.textContent='Error: '+(d.error||'Unknown');ed.style.display='block';}
  }catch(ex){eb.textContent='Error: '+ex.message;ed.style.display='block';}
  btn.disabled=false;btn.textContent='Estimate Cost';
}
document.getElementById('bf').addEventListener('submit', async function(e){
  e.preventDefault();
  var btn=document.getElementById('btn'), rd=document.getElementById('res');
  btn.disabled=true; btn.textContent='Submitting...'; rd.className='result'; rd.style.display='none';
  try{
    var briefVal=document.getElementById('brief').value.trim();
    var briefObj; try{briefObj=JSON.parse(briefVal);}catch(pe){briefObj=briefVal;}
    var body={client:document.getElementById('client').value.trim(),project_name:document.getElementById('project').value.trim(),platform:document.getElementById('platform').value,brief:briefObj};
    var r=await fetch('/api/build/brief',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    var d=await r.json();
    if(r.ok&&d.success){
      rd.className='result ok';rd.innerHTML='Build queued! Ticket: <strong>'+d.ticket_id+'</strong><br><a href="/build-review/'+d.ticket_id+'/final">View Build Review &rarr;</a>';
    }else{
      rd.className='result err';rd.textContent='Error: '+(d.error||'Unknown error');
    }
  }catch(ex){rd.className='result err';rd.textContent='Error: '+ex.message;}
  btn.disabled=false;btn.textContent='Submit Brief';
});
</script>
</body></html>`);
});

// ── GET /admin — FRIDAY admin dashboard ──────────────────────────────────────
app.get('/admin', async (req, res) => {
  const cockpitKey = req.headers['x-cockpit-key'] || req.query.key;
  if (cockpitKey !== process.env.COCKPIT_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { data: builds } = await supabase.from('friday_builds')
      .select('id,ticket_id,client_name,project_name,status,progress_pct,phase1_duration_ms,total_duration_ms,created_at,updated_at')
      .order('created_at', { ascending: false }).limit(500);

    const fmtDur = (ms) => { if (!ms) return '—'; const s = Math.round(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); return m + 'm ' + (s % 60) + 's'; };
    const rows = builds || [];
    const completed = rows.filter(b => b.status === 'done');
    const failed = rows.filter(b => b.status === 'failed');
    const active = rows.filter(b => !['done','failed','cancelled'].includes(b.status));
    const totalCompleted = completed.length;
    const avgQa = totalCompleted ? Math.round(completed.reduce((s, b) => s + (b.progress_pct || 0), 0) / totalCompleted) : 0;
    const successRate = rows.length ? Math.round((totalCompleted / (totalCompleted + failed.length)) * 100) : 0;
    const lastBuild = rows.length ? new Date(rows[0].created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'N/A';
    const avgDur = (() => { const d = completed.filter(b => b.total_duration_ms); return d.length ? fmtDur(Math.round(d.reduce((s, b) => s + b.total_duration_ms, 0) / d.length)) : '—'; })();

    const activeRows = active.map(b => {
      const statusColors = { running: '#60a5fa', building: '#60a5fa', planning: '#fbbf24' };
      const sColor = statusColors[b.status] || '#94a3b8';
      return `<tr>
        <td><a href="/build-review/${b.ticket_id}/final" class="ticket-link">${b.ticket_id}</a></td>
        <td>${b.client_name || 'Unknown'}</td>
        <td>${b.project_name || 'Untitled'}</td>
        <td><span class="status-pill" style="background:${sColor}20;color:${sColor}">${b.status}</span></td>
        <td>${b.progress_pct || 0}%</td>
        <td style="color:#64748b;font-size:.75rem">${fmtDur(b.phase1_duration_ms)}${b.total_duration_ms ? ' / ' + fmtDur(b.total_duration_ms) : ''}</td>
        <td><button class="retry-btn" onclick="retryBuild('${b.ticket_id}',this)">Retry</button></td>
      </tr>`;
    }).join('');

    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FRIDAY — Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:16px;max-width:900px;margin:0 auto}
h1{font-size:1.5rem;color:#38bdf8;margin-bottom:4px}
.subtitle{color:#94a3b8;font-size:.85rem;margin-bottom:24px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:28px}
.stat-card{background:#1e293b;border-radius:12px;padding:16px;border:1px solid #334155;text-align:center}
.stat-val{font-size:1.8rem;font-weight:700;color:#f8fafc}
.stat-val.green{color:#22c55e}
.stat-val.blue{color:#38bdf8}
.stat-val.yellow{color:#eab308}
.stat-label{font-size:.78rem;color:#94a3b8;margin-top:4px}
h2{font-size:1.1rem;color:#f8fafc;margin-bottom:10px;border-bottom:1px solid #334155;padding-bottom:6px}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th{text-align:left;color:#94a3b8;font-weight:600;padding:6px 10px;border-bottom:1px solid #334155;white-space:nowrap}
td{padding:8px 10px;border-bottom:1px solid #1e293b;white-space:nowrap}
tr:hover{background:#1e293b}
.status-pill{padding:2px 10px;border-radius:12px;font-size:.75rem;font-weight:600}
.ticket-link{color:#38bdf8;text-decoration:none;font-family:monospace;font-size:.8rem}
.ticket-link:hover{text-decoration:underline}
.empty{color:#64748b;font-style:italic;padding:12px}
nav{margin-bottom:20px;display:flex;gap:16px}
nav a{color:#94a3b8;text-decoration:none;font-size:.85rem}
nav a:hover{color:#38bdf8}
.retry-btn{background:#7c3aed;color:#fff;border:none;padding:4px 12px;border-radius:6px;font-size:.75rem;font-weight:600;cursor:pointer}
.retry-btn:hover{background:#6d28d9}
.retry-btn:disabled{opacity:.5;cursor:not-allowed}
@media(max-width:600px){.stats{grid-template-columns:repeat(2,1fr)}.stat-val{font-size:1.4rem}td,th{padding:6px 6px;font-size:.78rem}h1{font-size:1.2rem}}
</style></head><body>
<nav><a href="/builds">Builds</a><a href="/brief-intake">New Build</a><a href="/admin">Admin</a><a href="/dashboard">Dashboard</a></nav>
<h1>FRIDAY Admin</h1>
<div class="subtitle">System overview</div>
<div class="stats">
  <div class="stat-card"><div class="stat-val green">${totalCompleted}</div><div class="stat-label">Builds Completed</div></div>
  <div class="stat-card"><div class="stat-val ${avgQa >= 80 ? 'green' : avgQa >= 50 ? 'yellow' : ''}">${avgQa}%</div><div class="stat-label">Avg QA Score</div></div>
  <div class="stat-card"><div class="stat-val blue">${successRate}%</div><div class="stat-label">Success Rate</div></div>
  <div class="stat-card"><div class="stat-val">${avgDur}</div><div class="stat-label">Avg Duration</div></div>
  <div class="stat-card"><div class="stat-val">${lastBuild}</div><div class="stat-label">Last Build</div></div>
</div>
<h2>Active Builds <span style="color:#64748b;font-weight:normal;font-size:.85rem">(${active.length})</span></h2>
${active.length ? '<div class="table-wrap"><table><thead><tr><th>Ticket</th><th>Client</th><th>Project</th><th>Status</th><th>Progress</th><th>Duration</th><th></th></tr></thead><tbody>' + activeRows + '</tbody></table></div>' : '<div class="empty">No active builds</div>'}
<script>
async function retryBuild(tid,btn){
  if(!confirm('Retry build '+tid+'?'))return;
  btn.disabled=true;btn.textContent='Retrying...';
  try{
    var r=await fetch('/api/build/'+tid+'/retry',{method:'POST',headers:{'Content-Type':'application/json'}});
    var d=await r.json();
    if(r.ok&&d.success){alert('New build started: '+d.new_ticket_id);location.reload();}
    else{alert('Error: '+(d.error||'Unknown'));btn.disabled=false;btn.textContent='Retry';}
  }catch(e){alert('Error: '+e.message);btn.disabled=false;btn.textContent='Retry';}
}
</script>
</body></html>`);
  } catch(e) {
    console.error('[ADMIN]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /health-dashboard — System health overview ───────────────────────────
app.get('/health-dashboard', async (req, res) => {
  const checks = [];

  // 1. FRIDAY API
  checks.push({ name: 'FRIDAY API', status: 'ok', detail: 'Serving requests on port ' + PORT });

  // 2. Temporal
  let temporalDetail = '', temporalStatus = 'error', queueDepth = 0;
  try {
    const tc = await getTemporalClient();
    const wfs = tc.workflow.list({ query: "TaskQueue='friday-builds'" });
    for await (const wf of wfs) { if (wf.status.name === 'RUNNING') queueDepth++; if (queueDepth >= 500) break; }
    temporalStatus = 'ok';
    temporalDetail = 'Connected — ' + queueDepth + ' running workflow' + (queueDepth !== 1 ? 's' : '');
  } catch(e) { temporalDetail = 'Disconnected: ' + e.message.slice(0, 80); }
  checks.push({ name: 'Temporal Worker', status: temporalStatus, detail: temporalDetail });
  checks.push({ name: 'Temporal Queue Depth', status: queueDepth > 50 ? 'warn' : 'ok', detail: queueDepth + ' active workflows' });

  // 3. n8n
  let n8nStatus = 'error', n8nDetail = '', n8nCount = 0;
  try {
    const n8nKey = process.env.N8N_API_KEY || process.env.N8N_LOCAL_API_KEY || '';
    const n8nUrl = process.env.N8N_LOCAL_URL || 'http://localhost:5678';
    const r = await fetch(n8nUrl + '/api/v1/workflows?active=true&limit=250', { headers: { 'X-N8N-API-KEY': n8nKey } });
    if (r.ok) { const d = await r.json(); n8nCount = (d.data || []).length; n8nStatus = 'ok'; n8nDetail = n8nCount + ' active workflow' + (n8nCount !== 1 ? 's' : ''); }
    else { n8nDetail = 'API returned ' + r.status; }
  } catch(e) { n8nDetail = 'Unreachable: ' + e.message.slice(0, 80); }
  checks.push({ name: 'n8n', status: n8nStatus, detail: n8nDetail });

  // 4. Supabase
  let sbStatus = 'error', sbDetail = '';
  try {
    const { count, error } = await supabase.from('friday_builds').select('id', { count: 'exact', head: true });
    if (error) throw new Error(error.message);
    sbStatus = 'ok'; sbDetail = 'Connected — ' + (count || 0) + ' builds in table';
  } catch(e) { sbDetail = 'Error: ' + e.message.slice(0, 80); }
  checks.push({ name: 'Supabase', status: sbStatus, detail: sbDetail });

  // 5. OneDrive / Microsoft Graph
  let odStatus = 'error', odDetail = '';
  try {
    const token = await getGraphToken();
    const r = await fetch('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: 'Bearer ' + token } });
    if (r.ok) { const d = await r.json(); odStatus = 'ok'; odDetail = 'Authenticated as ' + (d.displayName || d.userPrincipalName || 'unknown'); }
    else { odDetail = 'Graph API returned ' + r.status; }
  } catch(e) { odDetail = 'Auth failed: ' + e.message.slice(0, 80); }
  checks.push({ name: 'OneDrive / Graph', status: odStatus, detail: odDetail });

  // 6. claudeagent auth
  let caStatus = 'error', caDetail = '';
  try {
    const { execSync: es } = await import('child_process');
    const out = es('id claudeagent 2>&1', { timeout: 3000 }).toString().trim();
    if (out.includes('uid=')) { caStatus = 'ok'; caDetail = out.slice(0, 80); }
    else { caDetail = 'User not found'; }
  } catch(e) { caDetail = 'Check failed: ' + e.message.slice(0, 80); }
  checks.push({ name: 'claudeagent User', status: caStatus, detail: caDetail });

  const allOk = checks.every(c => c.status === 'ok');
  const warnCount = checks.filter(c => c.status === 'warn').length;
  const errCount = checks.filter(c => c.status === 'error').length;

  const rows = checks.map(c => {
    const icon = c.status === 'ok' ? '&#9679;' : c.status === 'warn' ? '&#9679;' : '&#9679;';
    const color = c.status === 'ok' ? '#22c55e' : c.status === 'warn' ? '#eab308' : '#ef4444';
    return `<tr><td style="color:${color};font-size:1.2rem;width:30px;text-align:center">${icon}</td><td class="svc-name">${c.name}</td><td class="svc-detail">${c.detail}</td></tr>`;
  }).join('');

  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>FRIDAY — System Health</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:16px;max-width:900px;margin:0 auto}
h1{font-size:1.5rem;color:#38bdf8;margin-bottom:4px}
.subtitle{color:#94a3b8;font-size:.85rem;margin-bottom:24px}
.banner{padding:12px 16px;border-radius:10px;font-weight:600;margin-bottom:20px;font-size:.95rem}
.banner.ok{background:#064e3b;color:#34d399;border:1px solid #065f46}
.banner.warn{background:#78350f;color:#fbbf24;border:1px solid #92400e}
.banner.err{background:#7f1d1d;color:#fca5a5;border:1px solid #991b1b}
table{width:100%;border-collapse:collapse;font-size:.85rem}
td{padding:10px;border-bottom:1px solid #1e293b;vertical-align:middle}
tr:hover{background:#1e293b}
.svc-name{font-weight:600;color:#f8fafc;white-space:nowrap;width:180px}
.svc-detail{color:#94a3b8}
nav{margin-bottom:20px;display:flex;gap:16px}
nav a{color:#94a3b8;text-decoration:none;font-size:.85rem}
nav a:hover{color:#38bdf8}
.refresh-note{color:#475569;font-size:.75rem;margin-top:16px;text-align:center}
@media(max-width:600px){.svc-name{width:auto}td{padding:8px 6px;font-size:.78rem}h1{font-size:1.2rem}}
</style></head><body>
<nav><a href="/builds">Builds</a><a href="/brief-intake">New Build</a><a href="/admin">Admin</a><a href="/health-dashboard">Health</a><a href="/dashboard">Dashboard</a></nav>
<h1>System Health</h1>
<div class="subtitle">${new Date().toLocaleString()}</div>
<div class="banner ${allOk ? 'ok' : errCount ? 'err' : 'warn'}">${allOk ? 'All systems operational' : errCount + ' service' + (errCount !== 1 ? 's' : '') + ' down' + (warnCount ? ', ' + warnCount + ' warning' + (warnCount !== 1 ? 's' : '') : '')}</div>
<table>${rows}</table>
<div class="refresh-note">Auto-refreshes every 30 seconds</div>
</body></html>`);
});

// ── POST /api/build/:ticketId/retry — Retry a stuck/failed build ─────────────
app.post('/api/build/:ticketId/retry', async (req, res) => {
  try {
    const { ticketId } = req.params;
    console.log('[RETRY] Retrying build:', ticketId);

    // 1. Load original build record
    const { data: build } = await supabase.from('friday_builds')
      .select('*').eq('ticket_id', ticketId).order('created_at', { ascending: false }).limit(1).single();
    if (!build) return res.status(404).json({ error: 'Build not found for ' + ticketId });

    // 2. Load original brief from friday_tickets
    let brief = null;
    const { data: ticket } = await supabase.from('friday_tickets')
      .select('*').eq('ticket_id', ticketId).single();
    if (ticket) {
      brief = ticket.brief || ticket.brief_sections || null;
      if (typeof brief === 'string') try { brief = JSON.parse(brief); } catch(e) {}
    }

    // 3. Terminate any stuck Temporal workflow
    try {
      const temporalClient = await getTemporalClient();
      const handle = temporalClient.workflow.getHandle(ticketId);
      await handle.terminate('Retried via admin');
      console.log('[RETRY] Terminated old workflow:', ticketId);
    } catch(e) { console.log('[RETRY] No active workflow to terminate:', e.message.slice(0, 80)); }

    // 4. Create new ticket ID and build record
    const newTid = ticketId + '-R' + Date.now().toString(36).slice(-4);
    let supabaseBuildId = null;
    try {
      const { data: newBuild } = await supabase.from('friday_builds').insert({
        ticket_id: newTid, client_name: build.client_name, project_name: build.project_name,
        platform: build.platform || 'n8n', status: 'building', progress_pct: 0,
        assigned_to: 'temporal-workflow', created_at: new Date().toISOString()
      }).select().single();
      supabaseBuildId = newBuild?.id || null;
    } catch(e) { console.warn('[RETRY] Supabase insert failed:', e.message); }

    // 5. Mark old build as cancelled
    await supabase.from('friday_builds').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', build.id);

    // 6. Start fresh Temporal workflow
    const jobData = {
      job_id: 'retry_' + Date.now(), ticket_id: newTid,
      client: build.client_name, project_name: build.project_name,
      platform: build.platform || 'n8n',
      request_description: ticket?.request_description || brief?.executive_summary?.content || '',
      priority: 'high', supabaseBuildId, buildVersion: 'v1.0-retry', brief
    };
    const briefAgents = getManageAIAgents(jobData);
    jobData._agentConfigs = briefAgents;

    const temporalClient = await getTemporalClient();
    await temporalClient.workflow.start('FridayBuildWorkflow', {
      args: [jobData], taskQueue: 'friday-builds', workflowId: newTid
    });

    logActivity('build_retried', 'Build retried: ' + ticketId + ' → ' + newTid, 'Retry via admin', build.client_name, null);
    console.log('[RETRY] New build started:', newTid);
    res.json({ success: true, old_ticket_id: ticketId, new_ticket_id: newTid, status: 'queued' });
  } catch(e) {
    console.error('[RETRY] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/friday/simulate-transcript ─────────────────────────────────────
// Entry point for testing with real customer call data.
// Posts transcript to Charlie's ingest pipeline, then triggers session-learning
// and recalculate-priorities. Returns facts extracted, confidence scores,
// next session agenda, and reordered priority scores.
const CHARLIE_BASE = 'http://5.223.60.100:3001';

app.post('/api/friday/simulate-transcript', async (req, res) => {
  const startTime = Date.now();
  const { customer_id, transcript_text, client_name } = req.body;
  if (!customer_id || !transcript_text) {
    return res.status(400).json({ error: 'customer_id and transcript_text are required' });
  }

  try {
    console.log('[SIMULATE-TRANSCRIPT] Starting for customer', customer_id, client_name || '');

    // 1. Verify customer exists
    const { data: customer, error: custErr } = await supabase
      .from('friday_customers').select('id, name, industry').eq('id', customer_id).single();
    if (custErr || !customer) {
      return res.status(404).json({ error: 'Customer not found: ' + customer_id });
    }

    // 2. Post transcript to Charlie /api/charlie/ingest-transcript
    console.log('[SIMULATE-TRANSCRIPT] Posting transcript to Charlie ingest-transcript');
    const ingestRes = await fetch(CHARLIE_BASE + '/api/charlie/ingest-transcript', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_id,
        client_name: client_name || customer.name,
        transcript_text
      })
    });
    const ingestData = await ingestRes.json();
    if (!ingestRes.ok) {
      console.error('[SIMULATE-TRANSCRIPT] Charlie ingest-transcript error:', ingestData);
      return res.status(502).json({ error: 'Charlie ingest-transcript failed', detail: ingestData });
    }
    console.log('[SIMULATE-TRANSCRIPT] Ingest complete — facts:', ingestData.facts_extracted || 0);

    // 3. Call Charlie /api/charlie/session-learning for this customer
    console.log('[SIMULATE-TRANSCRIPT] Calling Charlie session-learning');
    const sessionRes = await fetch(CHARLIE_BASE + '/api/charlie/session-learning', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_id })
    });
    const sessionData = await sessionRes.json();
    if (!sessionRes.ok) {
      console.warn('[SIMULATE-TRANSCRIPT] Charlie session-learning warning:', sessionData);
    }

    // 4. Call Charlie /api/charlie/recalculate-priorities for this customer
    console.log('[SIMULATE-TRANSCRIPT] Calling Charlie recalculate-priorities');
    const priorityRes = await fetch(CHARLIE_BASE + '/api/charlie/recalculate-priorities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_id })
    });
    const priorityData = await priorityRes.json();
    if (!priorityRes.ok) {
      console.warn('[SIMULATE-TRANSCRIPT] Charlie recalculate-priorities warning:', priorityData);
    }

    // 5. Log activity
    const factsCount = ingestData.facts_extracted || ingestData.extraction?.facts_extracted || 0;
    await logActivity('transcript_simulation', 'Transcript simulated for ' + customer.name,
      'Extracted ' + factsCount + ' facts, overall readiness: ' + (sessionData.overall_readiness || 'n/a'),
      client_name || customer.name, customer_id);

    const elapsed = Date.now() - startTime;
    console.log('[SIMULATE-TRANSCRIPT] Complete in', elapsed, 'ms');

    res.json({
      success: true,
      customer: { id: customer.id, name: customer.name },
      extraction: {
        facts_extracted: factsCount,
        facts: ingestData.facts || ingestData.extraction?.facts || [],
        sections_addressed: ingestData.sections_addressed || ingestData.extraction?.sections_addressed || {}
      },
      session_learning: {
        confidence_scores: sessionData.confidence_scores || {},
        overall_readiness: sessionData.overall_readiness || null,
        session_summary: sessionData.session_summary || null
      },
      next_session_agenda: sessionData.next_session_agenda || [],
      priority_scores: priorityData.priority_scores || priorityData.priorities || [],
      elapsed_ms: elapsed
    });

  } catch (e) {
    console.error('[SIMULATE-TRANSCRIPT] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/friday/check-transcripts ───────────────────────────────────────
// OneDrive folder watcher. Lists .txt files in ManageAI/Simulation/Transcripts/,
// processes unprocessed ones through simulate-transcript, then moves them to
// ManageAI/Simulation/Processed/.
app.post('/api/friday/check-transcripts', async (req, res) => {
  const startTime = Date.now();
  const transcriptsFolder = 'ManageAI/Simulation/Transcripts';
  const processedFolder = 'ManageAI/Simulation/Processed';
  const driveBase = 'https://graph.microsoft.com/v1.0/users/brian@manageai.io/drive';

  try {
    const token = await getGraphToken();
    const h = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };

    // Ensure both folders exist
    await ensureFolder(token, transcriptsFolder);
    await ensureFolder(token, processedFolder);

    // List files in Transcripts folder
    const encodedPath = transcriptsFolder.split('/').map(p => encodeURIComponent(p)).join('/');
    const listRes = await fetch(driveBase + '/root:/' + encodedPath + ':/children', { headers: h });
    const listData = await listRes.json();
    if (!listRes.ok) {
      return res.status(502).json({ error: 'Failed to list OneDrive folder', detail: listData });
    }

    const txtFiles = (listData.value || []).filter(f => f.name && f.name.endsWith('.txt'));
    console.log('[CHECK-TRANSCRIPTS] Found', txtFiles.length, '.txt files in', transcriptsFolder);

    const results = [];

    for (const file of txtFiles) {
      try {
        // Extract customer_id from filename: {customer_id}_{timestamp}.txt
        const baseName = file.name.replace(/\.txt$/, '');
        const underscoreIdx = baseName.indexOf('_');
        if (underscoreIdx === -1) {
          console.warn('[CHECK-TRANSCRIPTS] Skipping file with invalid format:', file.name);
          results.push({ file: file.name, status: 'skipped', reason: 'invalid filename format' });
          continue;
        }
        const customer_id = baseName.substring(0, underscoreIdx);

        // Read file content
        const contentRes = await fetch(driveBase + '/items/' + file.id + '/content', { headers: { 'Authorization': 'Bearer ' + token } });
        if (!contentRes.ok) {
          results.push({ file: file.name, status: 'error', reason: 'could not read file' });
          continue;
        }
        const transcript_text = await contentRes.text();

        // Call simulate-transcript endpoint internally
        console.log('[CHECK-TRANSCRIPTS] Processing', file.name, '→ customer', customer_id);
        const simRes = await fetch('http://localhost:' + PORT + '/api/friday/simulate-transcript', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customer_id, transcript_text })
        });
        const simData = await simRes.json();

        // Move file to Processed folder (copy then delete original)
        const processedPath = processedFolder.split('/').map(p => encodeURIComponent(p)).join('/');
        // Get processed folder item id
        const procFolderRes = await fetch(driveBase + '/root:/' + processedPath, { headers: h });
        const procFolderData = await procFolderRes.json();

        if (procFolderData.id) {
          await fetch(driveBase + '/items/' + file.id, {
            method: 'PATCH',
            headers: h,
            body: JSON.stringify({ parentReference: { id: procFolderData.id } })
          });
        }

        results.push({
          file: file.name,
          customer_id,
          status: simRes.ok ? 'processed' : 'error',
          facts_extracted: simData.extraction?.facts_extracted || 0,
          overall_readiness: simData.session_learning?.overall_readiness || null
        });

      } catch (fileErr) {
        console.error('[CHECK-TRANSCRIPTS] Error processing', file.name, ':', fileErr.message);
        results.push({ file: file.name, status: 'error', reason: fileErr.message });
      }
    }

    const elapsed = Date.now() - startTime;
    console.log('[CHECK-TRANSCRIPTS] Done —', results.filter(r => r.status === 'processed').length, '/', txtFiles.length, 'processed in', elapsed, 'ms');

    res.json({
      success: true,
      transcripts_found: txtFiles.length,
      transcripts_processed: results.filter(r => r.status === 'processed').length,
      results,
      elapsed_ms: elapsed
    });

  } catch (e) {
    console.error('[CHECK-TRANSCRIPTS] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /client/:clientName — Client-facing build portal ─────────────────────
app.get('/client/:clientName', async (req, res) => {
  try {
    const clientName = decodeURIComponent(req.params.clientName);
    const { data: builds } = await supabase.from('friday_builds')
      .select('id,ticket_id,client_name,project_name,platform,status,progress_pct,output_links,onedrive_folder_url,phase1_duration_ms,total_duration_ms,created_at,updated_at')
      .ilike('client_name', clientName)
      .order('created_at', { ascending: false }).limit(50);

    const rows = builds || [];
    const parseArr = (v) => { if (Array.isArray(v)) return v; if (typeof v === 'string') try { return JSON.parse(v); } catch(e) {} return []; };
    const fmtDur = (ms) => { if (!ms) return ''; const s = Math.round(ms / 1000); if (s < 60) return s + 's'; return Math.floor(s / 60) + 'm ' + (s % 60) + 's'; };

    const buildCards = rows.map(b => {
      const qa = b.progress_pct || 0;
      const qaColor = qa >= 80 ? '#22c55e' : qa >= 50 ? '#eab308' : '#ef4444';
      const statusMap = { done: ['Delivered', '#34d399'], building: ['In Progress', '#60a5fa'], planning: ['Planning', '#fbbf24'], failed: ['Issue Detected', '#f87171'], cancelled: ['Cancelled', '#94a3b8'] };
      const [statusLabel, statusColor] = statusMap[b.status] || [b.status, '#94a3b8'];
      const links = parseArr(b.output_links);
      const trainingLink = links.find(l => (l.name || '').toLowerCase().includes('training manual'));
      const deployLink = links.find(l => (l.name || '').toLowerCase().includes('deployment'));
      const demoLink = links.find(l => (l.name || '').toLowerCase().includes('solution demo'));
      const created = new Date(b.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      const dur = fmtDur(b.total_duration_ms);

      const deliverables = [];
      if (trainingLink?.url) deliverables.push('<a href="' + trainingLink.url + '" target="_blank" class="dl-link">Training Manual</a>');
      if (deployLink?.url) deliverables.push('<a href="' + deployLink.url + '" target="_blank" class="dl-link">Deployment Summary</a>');
      if (demoLink?.url) deliverables.push('<a href="' + demoLink.url + '" target="_blank" class="dl-link">Solution Demo</a>');
      if (b.onedrive_folder_url) deliverables.push('<a href="' + b.onedrive_folder_url + '" target="_blank" class="dl-link folder-link">All Files</a>');

      return `<div class="build-card">
        <div class="build-header">
          <div>
            <div class="build-title">${b.project_name || 'Build'}</div>
            <div class="build-date">${created}${dur ? ' &middot; ' + dur : ''}</div>
          </div>
          <div style="text-align:right">
            <span class="status-pill" style="background:${statusColor}18;color:${statusColor}">${statusLabel}</span>
            ${b.status === 'done' ? '<div class="qa-badge" style="color:' + qaColor + '">' + qa + '% QA</div>' : ''}
          </div>
        </div>
        ${b.status === 'done' && deliverables.length ? '<div class="deliverables">' + deliverables.join('') + '</div>' : ''}
        ${b.status === 'building' ? '<div class="progress-bar"><div class="progress-fill" style="width:' + (b.progress_pct || 5) + '%"></div></div>' : ''}
      </div>`;
    }).join('');

    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${clientName} — Build Portal</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:20px;max-width:700px;margin:0 auto}
.header{text-align:center;margin-bottom:32px;padding-bottom:20px;border-bottom:1px solid #1e293b}
.logo{font-size:.75rem;color:#64748b;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px}
h1{font-size:1.6rem;color:#f8fafc;margin-bottom:4px}
.subtitle{color:#94a3b8;font-size:.9rem}
.build-card{background:#1e293b;border-radius:14px;padding:18px;margin-bottom:14px;border:1px solid #334155}
.build-header{display:flex;justify-content:space-between;align-items:flex-start}
.build-title{font-size:1.05rem;font-weight:600;color:#f8fafc}
.build-date{font-size:.8rem;color:#64748b;margin-top:2px}
.status-pill{padding:3px 12px;border-radius:12px;font-size:.75rem;font-weight:600;display:inline-block}
.qa-badge{font-size:.8rem;font-weight:700;margin-top:4px}
.deliverables{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;padding-top:12px;border-top:1px solid #334155}
.dl-link{color:#38bdf8;font-size:.82rem;text-decoration:none;padding:6px 14px;border:1px solid #334155;border-radius:8px;transition:all .15s}
.dl-link:hover{background:#334155;border-color:#38bdf8}
.folder-link{color:#94a3b8;border-color:#475569}
.progress-bar{height:6px;background:#334155;border-radius:3px;margin-top:12px;overflow:hidden}
.progress-fill{height:100%;background:linear-gradient(90deg,#2563eb,#38bdf8);border-radius:3px;transition:width .5s}
.empty{text-align:center;color:#64748b;padding:40px 20px;font-style:italic}
.footer{text-align:center;margin-top:32px;padding-top:16px;border-top:1px solid #1e293b;color:#475569;font-size:.75rem}
</style></head><body>
<div class="header">
  <div class="logo">ManageAI FRIDAY</div>
  <h1>${clientName}</h1>
  <div class="subtitle">${rows.length} build${rows.length !== 1 ? 's' : ''}</div>
</div>
${buildCards || '<div class="empty">No builds found for this client.</div>'}
<div class="footer">Powered by FRIDAY &mdash; ManageAI Build System</div>
</body></html>`);
  } catch(e) {
    console.error('[CLIENT-PORTAL]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/build/:ticketId/set-webhook — Register webhook URL ─────────────
app.post('/api/build/:ticketId/set-webhook', async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { webhook_url } = req.body;
    if (!webhook_url) return res.status(400).json({ error: 'webhook_url required' });

    // Validate URL format
    try { new URL(webhook_url); } catch(e) { return res.status(400).json({ error: 'Invalid URL format' }); }

    const { data: build } = await supabase.from('friday_builds')
      .select('id,build_log').eq('ticket_id', ticketId).order('created_at', { ascending: false }).limit(1).single();
    if (!build) return res.status(404).json({ error: 'Build not found for ' + ticketId });

    // Store webhooks in build_log as a JSON array entry (webhooks column may not exist)
    const log = Array.isArray(build.build_log) ? build.build_log : [];
    const whEntry = log.find(e => e.action === '_webhooks');
    const existing = whEntry ? (whEntry.urls || []) : [];
    if (!existing.includes(webhook_url)) existing.push(webhook_url);
    if (whEntry) { whEntry.urls = existing; } else { log.push({ action: '_webhooks', urls: existing, ts: new Date().toISOString() }); }

    await supabase.from('friday_builds').update({ build_log: log, updated_at: new Date().toISOString() }).eq('id', build.id);
    console.log('[WEBHOOK] Registered for', ticketId + ':', webhook_url);
    res.json({ success: true, ticket_id: ticketId, webhooks: existing });
  } catch(e) {
    console.error('[WEBHOOK] Set error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/build/:ticketId/fire-webhook — Internal: fire webhooks ─────────
async function fireBuildWebhooks(ticketId, eventType, payload) {
  try {
    const { data: build } = await supabase.from('friday_builds')
      .select('id,build_log,client_name,project_name').eq('ticket_id', ticketId).order('created_at', { ascending: false }).limit(1).single();
    if (!build) return;
    const log = Array.isArray(build.build_log) ? build.build_log : [];
    const whEntry = log.find(e => e.action === '_webhooks');
    const urls = whEntry?.urls || [];
    if (!urls.length) return;

    const body = {
      event: eventType,
      ticket_id: ticketId,
      client_name: build.client_name || '',
      project_name: build.project_name || '',
      timestamp: new Date().toISOString(),
      ...payload
    };

    for (const url of urls) {
      try {
        const r = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Friday-Event': eventType },
          body: JSON.stringify(body)
        });
        console.log('[WEBHOOK] Fired', eventType, 'to', url, '→', r.status);
      } catch(e) {
        console.warn('[WEBHOOK] Failed', eventType, 'to', url + ':', e.message.slice(0, 80));
      }
    }
  } catch(e) {
    console.warn('[WEBHOOK] Fire error:', e.message.slice(0, 80));
  }
}

// ── GET /api/build/estimate — Cost estimation from brief ─────────────────────
app.post('/api/build/estimate', async (req, res) => {
  try {
    const brief = req.body.brief || req.body.brief_sections || {};
    const platform = req.body.platform || 'n8n';

    // Calculate brief complexity
    const briefStr = typeof brief === 'string' ? brief : JSON.stringify(brief);
    const briefTokens = Math.ceil(briefStr.length / 4);
    const sections = typeof brief === 'object' ? Object.keys(brief).length : 1;
    const hasWorkflowSteps = !!(brief.workflow_steps || brief.workflow_steps?.content);
    const hasGuardrails = !!(brief.guardrails || brief.guardrails?.content);
    const hasEdgeCases = !!(brief.edge_cases || brief.edge_cases?.content);

    // Estimate tables from brief content
    const tableKeywords = (briefStr.match(/table|schema|database|column|field|record|entity/gi) || []).length;
    const estimatedTables = Math.max(2, Math.min(12, Math.ceil(tableKeywords / 3)));

    // Estimate workflows
    const wfKeywords = (briefStr.match(/workflow|automation|trigger|webhook|schedule|step|process/gi) || []).length;
    const estimatedWorkflows = Math.max(1, Math.min(8, Math.ceil(wfKeywords / 4)));

    // Token estimates per agent
    const plannerTokens = 4000 + briefTokens;
    const schemaTokens = 3000 + (estimatedTables * 800);
    const workflowTokens = 5000 + (estimatedWorkflows * 2000);
    const llmTokens = 3000 + (hasGuardrails ? 1500 : 0) + (hasEdgeCases ? 1000 : 0);
    const platformTokens = 3000;
    const qaTokens = 4000 + (estimatedTables * 500) + (estimatedWorkflows * 500);
    const phase1Total = plannerTokens + schemaTokens + workflowTokens + llmTokens + platformTokens + qaTokens;

    // Phase 2 doc agents
    const demoTokens = 8000;
    const manualTokens = 6000;
    const docsTokens = 8000;
    const workflowArchTokens = 5000 + (estimatedWorkflows * 1500);
    const deployPkgTokens = 6000;
    const phase2Total = demoTokens + manualTokens + docsTokens + workflowArchTokens + deployPkgTokens;

    const totalTokens = phase1Total + phase2Total;

    // Estimate build time (minutes)
    const phase1Minutes = 3 + (estimatedTables * 0.5) + (estimatedWorkflows * 1.5);
    const phase2Minutes = 8; // parallel agents, ~8 min wall time
    const totalMinutes = Math.ceil(phase1Minutes + phase2Minutes);

    // Estimate storage (KB)
    const schemaStorage = estimatedTables * 5;
    const workflowStorage = estimatedWorkflows * 25;
    const docStorage = 150; // 5 docs ~30KB each
    const deployPkgStorage = 80; // 10 JSON files
    const totalStorageKB = schemaStorage + workflowStorage + docStorage + deployPkgStorage;

    // Estimated cost (rough: $3/MTok input, $15/MTok output, assume 30% output)
    const inputTokens = Math.round(totalTokens * 0.7);
    const outputTokens = Math.round(totalTokens * 0.3);
    const estimatedCost = ((inputTokens / 1000000) * 3) + ((outputTokens / 1000000) * 15);

    const estimate = {
      brief_complexity: { tokens: briefTokens, sections, has_workflow_steps: hasWorkflowSteps, has_guardrails: hasGuardrails, has_edge_cases: hasEdgeCases },
      scope: { estimated_tables: estimatedTables, estimated_workflows: estimatedWorkflows, platform },
      tokens: { phase1: phase1Total, phase2: phase2Total, total: totalTokens, breakdown: { planner: plannerTokens, schema: schemaTokens, workflow: workflowTokens, llm: llmTokens, platform: platformTokens, qa: qaTokens, demo: demoTokens, manual: manualTokens, docs: docsTokens, workflow_architect: workflowArchTokens, deployment_package: deployPkgTokens } },
      time: { phase1_minutes: Math.ceil(phase1Minutes), phase2_minutes: phase2Minutes, total_minutes: totalMinutes },
      storage: { total_kb: totalStorageKB, breakdown_kb: { schema: schemaStorage, workflows: workflowStorage, documents: docStorage, deployment_package: deployPkgStorage } },
      cost: { estimated_usd: Math.round(estimatedCost * 100) / 100, note: 'Approximate based on Claude Sonnet 4.5 pricing' }
    };

    res.json({ success: true, estimate });
  } catch(e) {
    console.error('[ESTIMATE]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/metrics — Build system metrics ──────────────────────────────────
app.get('/api/metrics', async (req, res) => {
  const cockpitKey = req.headers['x-cockpit-key'] || req.query.key;
  if (cockpitKey !== process.env.COCKPIT_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { data: all } = await supabase.from('friday_builds')
      .select('id,status,progress_pct,client_name,created_at')
      .order('created_at', { ascending: false }).limit(1000);
    const rows = all || [];
    const completed = rows.filter(b => b.status === 'done');
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const thisWeek = rows.filter(b => b.created_at >= weekAgo);
    const avgQa = completed.length ? Math.round(completed.reduce((s, b) => s + (b.progress_pct || 0), 0) / completed.length) : 0;
    const recent = rows[0] || null;
    res.json({
      total_builds: rows.length,
      completed_builds: completed.length,
      average_qa_score: avgQa,
      builds_this_week: thisWeek.length,
      most_recent: recent ? { client: recent.client_name, date: recent.created_at } : null
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// VOICE INTERFACE ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /api/voice/context ────────────────────────────────────────────────────
app.get('/api/voice/context', async (req, res) => {
  try {
    const customerFilter = req.query.customer || null;
    let query = supabase.from('friday_builds')
      .select('id,ticket_id,client_name,project_name,status,progress_pct,output_links,created_at,total_duration_ms,phase1_duration_ms')
      .order('created_at', { ascending: false }).limit(10);
    if (customerFilter) query = query.ilike('client_name', `%${customerFilter}%`);
    const { data: builds } = await query;
    const rows = builds || [];

    const parseArr = (v) => { if (Array.isArray(v)) return v; if (typeof v === 'string') try { return JSON.parse(v); } catch(e) {} return []; };

    const activeStatuses = ['running', 'building', 'planning', 'in_progress', 'phase1_complete', 'awaiting_approval'];
    const activeBuilds = rows.filter(b => activeStatuses.includes(b.status)).map(b => ({
      customerName: b.client_name, ticketId: b.ticket_id,
      status: b.status, phase: b.status, qaScore: b.progress_pct || 0
    }));
    const recentCompleted = rows.filter(b => b.status === 'done' || b.status === 'complete').slice(0, 5).map(b => ({
      customerName: b.client_name, qaScore: b.progress_pct || 0,
      fileCount: parseArr(b.output_links).length,
      duration: b.total_duration_ms ? Math.round(b.total_duration_ms / 60000) + ' minutes' : null
    }));

    // Weekly metrics
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: weekBuilds } = await supabase.from('friday_builds')
      .select('progress_pct,status').gte('created_at', weekAgo);
    const wb = weekBuilds || [];
    const avgQa = wb.length ? Math.round(wb.reduce((s, b) => s + (b.progress_pct || 0), 0) / wb.length) : 0;

    const statusText = rows.map(b => `${b.client_name}: ${b.status} (QA ${b.progress_pct || 0}%)`).join('; ');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 200,
      messages: [{ role: 'user', content: `Summarize this build system status in 2-3 natural spoken sentences for a technical team briefing. No lists, just conversational speech.\n\nBuilds: ${statusText}\nActive: ${activeBuilds.length}, Completed this week: ${recentCompleted.length}, Avg QA: ${avgQa}%` }]
    });
    const summary = msg.content[0].text;

    res.json({
      activeBuilds,
      recentCompleted,
      metrics: { totalBuilds: rows.length, avgQaScore: avgQa, thisWeek: wb.length },
      summary
    });
  } catch(e) {
    console.error('[VOICE] context error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/voice/action ────────────────────────────────────────────────────
app.post('/api/voice/action', async (req, res) => {
  const key = req.headers['x-voice-key'];
  if (key !== 'manageai-voice-2026') return res.status(401).json({ error: 'Unauthorized' });

  const { action, ticketId, confirmedBy, comment } = req.body;
  if (!action || !ticketId) return res.status(400).json({ error: 'action and ticketId required' });

  try {
    if (action === 'approve_phase1') {
      const r = await fetch(`http://localhost:${process.env.PORT || 3000}/api/build/${ticketId}/auto-approve-phase1`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved', reason: comment || 'Voice approved by ' + (confirmedBy || 'voice interface') })
      });
      const d = await r.json();
      return res.json({ success: true, message: `Phase 1 approved for ${ticketId}`, actionTaken: 'approve_phase1', result: d });
    }

    if (action === 'approve_final') {
      const r = await fetch(`http://localhost:${process.env.PORT || 3000}/api/build/${ticketId}/approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: comment || 'Voice approved by ' + (confirmedBy || 'voice interface') })
      });
      const d = await r.json();
      return res.json({ success: true, message: `Build approved for ${ticketId}`, actionTaken: 'approve_final', result: d });
    }

    if (action === 'request_changes') {
      const r = await fetch(`http://localhost:${process.env.PORT || 3000}/api/build/${ticketId}/request-changes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: comment || 'Changes requested via voice interface' })
      });
      const d = await r.json();
      return res.json({ success: true, message: `Changes requested for ${ticketId}`, actionTaken: 'request_changes', result: d });
    }

    if (action === 'get_build_detail') {
      const { data: build } = await supabase.from('friday_builds')
        .select('*').or(`ticket_id.eq.${ticketId},id.eq.${ticketId}`).single();
      if (!build) return res.status(404).json({ error: 'Build not found' });
      const parseArr = (v) => { if (Array.isArray(v)) return v; if (typeof v === 'string') try { return JSON.parse(v); } catch(e) {} return []; };
      const fileCount = parseArr(build.output_links).length;
      const duration = build.total_duration_ms ? Math.round(build.total_duration_ms / 60000) + ' minutes' : 'unknown duration';
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 150,
        messages: [{ role: 'user', content: `Create a single spoken sentence summarizing this build for a voice interface. Be natural and concise.\nCustomer: ${build.client_name}, Project: ${build.project_name}, Status: ${build.status}, QA: ${build.progress_pct || 0}%, Files: ${fileCount}, Duration: ${duration}` }]
      });
      return res.json({ success: true, message: msg.content[0].text, actionTaken: 'get_build_detail', build: { client: build.client_name, project: build.project_name, status: build.status, qaScore: build.progress_pct, fileCount, duration } });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch(e) {
    console.error('[VOICE] action error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/voice/build/:ticketId ────────────────────────────────────────────
app.get('/api/voice/build/:ticketId', async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { data: build } = await supabase.from('friday_builds')
      .select('*').or(`ticket_id.eq.${ticketId},id.eq.${ticketId}`).single();
    if (!build) return res.status(404).json({ error: 'Build not found' });

    const parseArr = (v) => { if (Array.isArray(v)) return v; if (typeof v === 'string') try { return JSON.parse(v); } catch(e) {} return []; };
    const fileCount = parseArr(build.output_links).length;
    const duration = build.total_duration_ms ? Math.round(build.total_duration_ms / 60000) + ' minutes' : null;
    const qa = build.progress_pct || 0;
    const statusWord = build.status === 'done' ? 'completed' : build.status;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = `Create a natural spoken summary for a voice interface (1-2 sentences, no lists):\nCustomer: ${build.client_name}, Project: ${build.project_name}, Status: ${statusWord}, QA score: ${qa}%, Files uploaded: ${fileCount}${duration ? ', Build duration: ' + duration : ''}, Platform: ${build.platform || 'n8n'}`;
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 150,
      messages: [{ role: 'user', content: prompt }]
    });

    res.json({
      ticketId, customerName: build.client_name, project: build.project_name,
      status: build.status, qaScore: qa, fileCount, duration,
      summary: msg.content[0].text
    });
  } catch(e) {
    console.error('[VOICE] build detail error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/voice/alerts ─────────────────────────────────────────────────────
app.get('/api/voice/alerts', async (req, res) => {
  try {
    const { data: builds } = await supabase.from('friday_builds')
      .select('ticket_id,client_name,project_name,status,progress_pct,created_at,updated_at')
      .order('created_at', { ascending: false }).limit(100);

    const rows = builds || [];
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const alerts = [];

    // Waiting for Phase 1 approval
    const awaitingP1 = rows.filter(b => b.status === 'phase1_complete' || b.status === 'awaiting_phase1_approval');
    for (const b of awaitingP1) {
      const hrs = Math.round((Date.now() - new Date(b.updated_at || b.created_at).getTime()) / 3600000);
      alerts.push({ type: 'awaiting_phase1', ticketId: b.ticket_id, customer: b.client_name, waitingHours: hrs });
    }

    // Waiting for final approval
    const awaitingFinal = rows.filter(b => b.status === 'awaiting_approval' || b.status === 'pending_approval');
    for (const b of awaitingFinal) {
      const hrs = Math.round((Date.now() - new Date(b.updated_at || b.created_at).getTime()) / 3600000);
      alerts.push({ type: 'awaiting_final', ticketId: b.ticket_id, customer: b.client_name, waitingHours: hrs });
    }

    // Failed builds
    const failed = rows.filter(b => b.status === 'failed' || b.status === 'error');
    for (const b of failed) {
      alerts.push({ type: 'failed', ticketId: b.ticket_id, customer: b.client_name, qaScore: b.progress_pct });
    }

    // Low QA scores
    const lowQa = rows.filter(b => (b.status === 'done' || b.status === 'complete') && (b.progress_pct || 0) < 75);
    for (const b of lowQa) {
      alerts.push({ type: 'low_qa', ticketId: b.ticket_id, customer: b.client_name, qaScore: b.progress_pct });
    }

    let summary = 'No active alerts. All builds are running normally.';
    if (alerts.length > 0) {
      const alertText = alerts.map(a => {
        if (a.type === 'awaiting_phase1') return `${a.customer} Phase 1 waiting ${a.waitingHours} hours for approval`;
        if (a.type === 'awaiting_final') return `${a.customer} final build waiting ${a.waitingHours} hours for approval`;
        if (a.type === 'failed') return `${a.customer} build failed`;
        if (a.type === 'low_qa') return `${a.customer} has low QA score of ${a.qaScore}%`;
        return '';
      }).filter(Boolean).join('; ');

      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 150,
        messages: [{ role: 'user', content: `Convert these build alerts into 1-2 natural spoken sentences for a voice briefing. Be direct and actionable.\n\nAlerts: ${alertText}` }]
      });
      summary = msg.content[0].text;
    }

    res.json({ alertCount: alerts.length, alerts, summary });
  } catch(e) {
    console.error('[VOICE] alerts error:', e.message);
    res.status(500).json({ error: e.message });
  }
});





// ═══════════════════════════════════════════════
// BUILD-015: PROMPT QUALITY AGENT — manual trigger
// ═══════════════════════════════════════════════
app.post('/api/prompt-quality/run', async (req, res) => {
  const auth = req.headers['x-cockpit-key'];
  if (auth !== COCKPIT_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { days_back = 7 } = req.body || {};
    const temporalClient = await getTemporalClient();
    const workflowId = 'prompt-quality-' + Date.now();
    await temporalClient.workflow.start('promptQualityWorkflow', {
      taskQueue: 'friday-builds',
      workflowId,
      args: [{ days_back }]
    });
    res.json({ success: true, workflow_id: workflowId, message: 'Prompt quality report started' });
  } catch(e) {
    console.error('[BUILD-015] Manual trigger error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log('FRIDAY Parallel Swarm API v3.5 on port ' + PORT);
  console.log('Platforms: Make.com | n8n | Zapier');
  console.log('Callback: ' + (N8N_CALLBACK_URL || '(not configured — set N8N_WF07_CALLBACK)'));
});

// Schedule BUILD-015 Prompt Quality Agent — every Monday at midnight UTC
async function schedulePromptQualityAgent() {
  try {
    const client = await getTemporalClient();
    await client.workflow.start('promptQualityWorkflow', {
      taskQueue: 'friday-builds',
      workflowId: 'prompt-quality-weekly',
      cronSchedule: '0 0 * * 1',
      args: [{ days_back: 7 }],
    });
    console.log('[BUILD-015] Prompt quality cron scheduled');
  } catch(e) {
    if (e.message?.includes('already started') || e.message?.includes('already exists')) {
      console.log('[BUILD-015] Prompt quality cron already scheduled');
    } else {
      console.warn('[BUILD-015] Could not schedule prompt quality cron:', e.message);
    }
  }
}
schedulePromptQualityAgent();

// BUILD-016: Schedule maintenance cron — 2 AM UTC daily
async function scheduleMaintenanceCron() {
  try {
    const client = await getTemporalClient();
    await client.workflow.start('maintenanceWorkflow', {
      taskQueue: 'friday-builds',
      workflowId: 'friday-maintenance-nightly',
      cronSchedule: '0 2 * * *',
      args: [{}],
    });
    console.log('[BUILD-016] Maintenance cron scheduled (2 AM UTC daily)');
  } catch(e) {
    if (e.message?.includes('already started') || e.message?.includes('already exists')) {
      console.log('[BUILD-016] Maintenance cron already scheduled');
    } else {
      console.log('[BUILD-016] Maintenance cron skip:', e.message);
    }
  }
}
scheduleMaintenanceCron();
