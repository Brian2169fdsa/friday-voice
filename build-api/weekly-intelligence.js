import cron from 'node-cron';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import { getGraphToken } from './temporal/activities/onedrive.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', '3-email-base.html');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const GRAPH_USER_EMAIL = process.env.GRAPH_USER_EMAIL || 'brian@manageai.io';
const N8N_LOCAL_URL = process.env.N8N_LOCAL_URL || 'http://localhost:5678';
const N8N_LOCAL_API_KEY = process.env.N8N_LOCAL_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const FRIDAY_BASE = process.env.FRIDAY_PUBLIC_URL || 'http://5.223.79.255:3000';

const RECIPIENTS = [
  'brian@manageai.io',
  process.env.DAN_EMAIL,
  process.env.DAVE_EMAIL
].filter(Boolean);

// ── Helpers ───────────────────────────────────────────────────────────────────

function getMondayDate(offset = 0) {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1) + offset * 7);
  return monday;
}

function formatDate(d) {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function isoWeekStart(d) {
  const copy = new Date(d);
  const day = copy.getDay();
  copy.setDate(copy.getDate() - (day === 0 ? 6 : day - 1));
  copy.setHours(0, 0, 0, 0);
  return copy.toISOString();
}

function buildEmailHtml(inject) {
  return (async () => {
    let html;
    try { html = await fs.readFile(TEMPLATE_PATH, 'utf8'); }
    catch(e) { html = '<html><body><!-- template missing --></body></html>'; }
    for (const [key, val] of Object.entries(inject)) {
      const re = new RegExp(`<!-- INJECT: ${key} -->`, 'g');
      html = html.replace(re, String(val || ''));
    }
    return html;
  })();
}

async function sendEmail(subject, htmlBody) {
  const token = await getGraphToken();
  const url = `https://graph.microsoft.com/v1.0/users/${GRAPH_USER_EMAIL}/sendMail`;
  const payload = {
    message: {
      subject,
      body: { contentType: 'HTML', content: htmlBody },
      toRecipients: RECIPIENTS.map(email => ({ emailAddress: { address: email } }))
    },
    saveToSentItems: false
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Graph sendMail failed (${res.status}): ${txt.slice(0, 300)}`);
  }
}

// ── Data collectors ───────────────────────────────────────────────────────────

async function collectBuildPerformance() {
  const supabase = createClient(SB_URL, SB_KEY);
  const thisMonday = isoWeekStart(new Date());
  const lastMonday = isoWeekStart(getMondayDate(-1));

  const { data: allBuilds } = await supabase
    .from('friday_builds')
    .select('id,status,qa_score,duration_ms,phase1_duration_ms,total_duration_ms,created_at,client_name')
    .order('created_at', { ascending: false })
    .limit(500);

  const builds = allBuilds || [];
  const thisWeek = builds.filter(b => b.created_at >= thisMonday);
  const lastWeek = builds.filter(b => b.created_at >= lastMonday && b.created_at < thisMonday);

  const avg = (arr, key) => arr.length
    ? Math.round(arr.reduce((s, b) => s + (b[key] || 0), 0) / arr.length)
    : 0;

  const failedThis = thisWeek.filter(b => b.status === 'failed' || b.status === 'error').length;
  const failedLast = lastWeek.filter(b => b.status === 'failed' || b.status === 'error').length;

  // Builds that hit iteration loop (qa_score < 70 initially — check phase1 vs final)
  const iterationBuilds = thisWeek.filter(b => b.qa_score !== null && b.qa_score < 70).length;

  return {
    thisWeek: {
      count: thisWeek.length,
      avgQaScore: avg(thisWeek.filter(b => b.qa_score), 'qa_score'),
      failed: failedThis,
      avgDurationMs: avg(thisWeek.filter(b => b.total_duration_ms), 'total_duration_ms'),
      iterationBuilds
    },
    lastWeek: {
      count: lastWeek.length,
      avgQaScore: avg(lastWeek.filter(b => b.qa_score), 'qa_score'),
      failed: failedLast
    }
  };
}

async function collectAgentPerformance() {
  const supabase = createClient(SB_URL, SB_KEY);
  const { data: logs } = await supabase
    .from('friday_activity_log')
    .select('event_type,title,detail,created_at,severity')
    .gte('created_at', isoWeekStart(getMondayDate(-1)))
    .order('created_at', { ascending: false })
    .limit(1000);

  const entries = logs || [];
  const agentErrors = entries.filter(e => e.severity === 'error' || e.event_type?.includes('error'));
  const agentMap = {};
  for (const e of agentErrors) {
    const agent = (e.event_type || '').split('-')[0] || 'unknown';
    agentMap[agent] = (agentMap[agent] || 0) + 1;
  }
  const mostFailedAgent = Object.entries(agentMap)
    .sort((a, b) => b[1] - a[1])[0];

  const n8nEntries = entries.filter(e => e.event_type?.includes('n8n') || e.title?.includes('n8n'));
  const n8nSuccess = n8nEntries.filter(e => e.severity !== 'error').length;
  const n8nRate = n8nEntries.length ? Math.round((n8nSuccess / n8nEntries.length) * 100) : 100;

  const schemaEntries = entries.filter(e => e.event_type?.includes('schema') || e.event_type?.includes('BUILD-006'));
  const schemaSuccess = schemaEntries.filter(e => e.severity !== 'error').length;
  const schemaRate = schemaEntries.length ? Math.round((schemaSuccess / schemaEntries.length) * 100) : 100;

  return {
    totalEvents: entries.length,
    errorCount: agentErrors.length,
    mostFailedAgent: mostFailedAgent ? `${mostFailedAgent[0]} (${mostFailedAgent[1]} errors)` : 'none',
    n8nImportSuccessRate: n8nRate,
    schemaDeploySuccessRate: schemaRate
  };
}

async function collectInfrastructureHealth() {
  const results = {};

  // Temporal health
  try {
    const r = await fetch(`${FRIDAY_BASE}/health`, { signal: AbortSignal.timeout(5000) });
    results.temporal = r.ok ? 'connected' : `HTTP ${r.status}`;
  } catch(e) { results.temporal = 'unreachable'; }

  // PM2 restart counts
  try {
    const pm2List = JSON.parse(execSync('pm2 jlist 2>/dev/null', { timeout: 5000 }).toString());
    results.pm2 = (pm2List || []).map(p => ({
      name: p.name,
      status: p.pm2_env?.status,
      restarts: p.pm2_env?.restart_time || 0
    }));
  } catch(e) { results.pm2 = []; }

  // n8n active workflow count
  try {
    const r = await fetch(`${N8N_LOCAL_URL}/api/v1/workflows?limit=250`, {
      headers: { 'X-N8N-API-KEY': N8N_LOCAL_API_KEY },
      signal: AbortSignal.timeout(5000)
    });
    if (r.ok) {
      const data = await r.json();
      const all = data.data || [];
      results.n8nWorkflows = { total: all.length, active: all.filter(w => w.active).length };
    } else { results.n8nWorkflows = { error: `HTTP ${r.status}` }; }
  } catch(e) { results.n8nWorkflows = { error: e.message }; }

  // Supabase row counts for key tables
  try {
    const supabase = createClient(SB_URL, SB_KEY);
    const counts = {};
    for (const table of ['friday_builds', 'friday_customers', 'friday_activity_log']) {
      const { count } = await supabase.from(table).select('*', { count: 'exact', head: true });
      counts[table] = count || 0;
    }
    results.supabase = counts;
  } catch(e) { results.supabase = { error: e.message }; }

  // GitHub API rate limit
  if (GITHUB_TOKEN) {
    try {
      const r = await fetch('https://api.github.com/rate_limit', {
        headers: { 'Authorization': 'Bearer ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github+json' },
        signal: AbortSignal.timeout(5000)
      });
      if (r.ok) {
        const data = await r.json();
        results.githubRateLimit = {
          remaining: data.rate?.remaining,
          limit: data.rate?.limit,
          resetAt: data.rate?.reset ? new Date(data.rate.reset * 1000).toISOString() : null
        };
      }
    } catch(e) { results.githubRateLimit = { error: e.message }; }
  }

  return results;
}

async function collectCustomerPipeline() {
  const supabase = createClient(SB_URL, SB_KEY);
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const { data: allBuilds } = await supabase
    .from('friday_builds')
    .select('id,status,client_name,ticket_id,created_at,updated_at')
    .order('created_at', { ascending: false })
    .limit(100);

  const builds = allBuilds || [];
  const completed = builds.filter(b => b.status === 'done' || b.status === 'complete');
  const inProgress = builds.filter(b => b.status === 'in_progress' || b.status === 'running');
  const stuck = inProgress.filter(b => b.updated_at && b.updated_at < twoHoursAgo);

  return {
    completedBuilds: completed.slice(0, 5).map(b => ({ client: b.client_name, ticket: b.ticket_id })),
    inProgressCount: inProgress.length,
    stuckBuilds: stuck.map(b => ({ client: b.client_name, ticket: b.ticket_id, since: b.updated_at }))
  };
}

async function collectVerificationResults() {
  const supabase = createClient(SB_URL, SB_KEY);
  const thisMonday = isoWeekStart(new Date());

  const { data: builds } = await supabase
    .from('friday_builds')
    .select('id,verification_result,client_name')
    .gte('created_at', thisMonday)
    .not('verification_result', 'is', null);

  const rows = builds || [];
  if (rows.length === 0) return { totalVerified: 0, allPassed: 0, failCounts: {} };

  let allPassed = 0;
  const failCounts = {};

  for (const b of rows) {
    const vr = typeof b.verification_result === 'string'
      ? JSON.parse(b.verification_result)
      : b.verification_result;
    if (vr?.verified) allPassed++;
    for (const fc of (vr?.failedChecks || [])) {
      failCounts[fc.check] = (failCounts[fc.check] || 0) + 1;
    }
  }

  const mostCommonFail = Object.entries(failCounts)
    .sort((a, b) => b[1] - a[1])[0];

  return {
    totalVerified: rows.length,
    allPassed,
    passRate: rows.length ? Math.round((allPassed / rows.length) * 100) : 100,
    mostCommonFail: mostCommonFail ? `${mostCommonFail[0]} (${mostCommonFail[1]}x)` : 'none',
    failCounts
  };
}

// ── Claude analysis ───────────────────────────────────────────────────────────

async function generateAnalysis(data) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `Weekly FRIDAY Build Intelligence Report — ${formatDate(getMondayDate())}

BUILD PERFORMANCE:
This week: ${data.builds.thisWeek.count} builds, avg QA ${data.builds.thisWeek.avgQaScore}/100, ${data.builds.thisWeek.failed} failed, ${data.builds.thisWeek.iterationBuilds} hit iteration loop
Last week: ${data.builds.lastWeek.count} builds, avg QA ${data.builds.lastWeek.avgQaScore}/100, ${data.builds.lastWeek.failed} failed
Avg build duration this week: ${Math.round((data.builds.thisWeek.avgDurationMs || 0) / 60000)} minutes

AGENT PERFORMANCE:
Total activity log events: ${data.agents.totalEvents}
Error events: ${data.agents.errorCount}
Most failed agent: ${data.agents.mostFailedAgent}
n8n import success rate: ${data.agents.n8nImportSuccessRate}%
Schema deploy success rate: ${data.agents.schemaDeploySuccessRate}%

INFRASTRUCTURE:
Temporal: ${data.infra.temporal}
n8n workflows: ${data.infra.n8nWorkflows?.active || 0} active / ${data.infra.n8nWorkflows?.total || 0} total
PM2 restarts: ${(data.infra.pm2 || []).map(p => `${p.name}:${p.restarts}`).join(', ') || 'unknown'}
GitHub rate limit: ${data.infra.githubRateLimit?.remaining || 'N/A'} remaining
Supabase friday_builds count: ${data.infra.supabase?.friday_builds || 'N/A'}

CUSTOMER PIPELINE:
Completed this week: ${data.pipeline.completedBuilds.length} customers
In progress: ${data.pipeline.inProgressCount} builds
Stuck (>2hr): ${data.pipeline.stuckBuilds.length} builds ${data.pipeline.stuckBuilds.map(s => s.client).join(', ')}

VERIFICATION RESULTS:
Verified builds: ${data.verification.totalVerified}, passed all checks: ${data.verification.allPassed}
Pass rate: ${data.verification.passRate}%
Most common failing check: ${data.verification.mostCommonFail}

Provide a concise analysis with 3-5 ranked actionable recommendations.`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 900,
    system: 'You are the ManageAI Build Intelligence System analyzing weekly FRIDAY build performance. Produce actionable recommendations for Brian Reinhart (Head of Build), Dan Ray (CCO), and Dave Albertson (CEO). Focus on: build quality trends, agent reliability, infrastructure stability, and 3-5 specific improvements ranked by impact. Be direct. Max 600 words.',
    messages: [{ role: 'user', content: prompt }]
  });

  return message.content[0].text;
}

// ── Email builder ─────────────────────────────────────────────────────────────

function buildSectionRows(items) {
  return items.map(item =>
    `<tr><td style="padding:6px 0;">
      <table width="100%"><tr>
        <td width="80" style="padding:8px 12px;border-radius:4px 0 0 4px;background:${item.color}15;border-left:3px solid ${item.color};">
          <span style="font-family:Courier New,monospace;font-size:10px;font-weight:700;color:${item.color};text-transform:uppercase;">${item.badge}</span></td>
        <td style="padding:8px 12px;background:#F8F9FB;border-radius:0 4px 4px 0;font-size:13px;color:#5A6070;line-height:1.5;">${item.text}</td>
      </tr></table></td></tr>`
  ).join('\n');
}

function buildBulletRows(bullets) {
  return bullets.map(text =>
    `<tr><td style="padding:4px 0;font-size:13px;color:#5A6070;line-height:1.6;">
      <span style="color:#4A8FD6;font-weight:700;margin-right:8px;">→</span>${text}</td></tr>`
  ).join('\n');
}

function msToMinutes(ms) {
  return Math.round((ms || 0) / 60000);
}

// ── Main runner ───────────────────────────────────────────────────────────────

async function runWeeklyIntelligence() {
  console.log('[WEEKLY-INTEL] Starting weekly intelligence email run...');

  const [builds, agents, infra, pipeline, verification] = await Promise.all([
    collectBuildPerformance().catch(e => { console.warn('[WEEKLY-INTEL] builds error:', e.message); return {}; }),
    collectAgentPerformance().catch(e => { console.warn('[WEEKLY-INTEL] agents error:', e.message); return {}; }),
    collectInfrastructureHealth().catch(e => { console.warn('[WEEKLY-INTEL] infra error:', e.message); return {}; }),
    collectCustomerPipeline().catch(e => { console.warn('[WEEKLY-INTEL] pipeline error:', e.message); return {}; }),
    collectVerificationResults().catch(e => { console.warn('[WEEKLY-INTEL] verification error:', e.message); return {}; })
  ]);

  const data = { builds, agents, infra, pipeline, verification };

  console.log('[WEEKLY-INTEL] Data collected. Running Claude analysis...');
  const analysis = await generateAnalysis(data);
  console.log('[WEEKLY-INTEL] Analysis complete. Building email...');

  const mondayDate = getMondayDate();
  const mondayStr = formatDate(mondayDate);

  const thisWeek = builds.thisWeek || {};
  const lastWeek = builds.lastWeek || {};
  const qaChange = (thisWeek.avgQaScore || 0) - (lastWeek.avgQaScore || 0);
  const qaChangeStr = qaChange >= 0 ? `+${qaChange}` : String(qaChange);
  const qaColor = qaChange >= 0 ? '#22A860' : '#EF4444';

  const section1Items = [
    {
      badge: 'BUILDS',
      color: '#4A8FD6',
      text: `This week: <strong>${thisWeek.count || 0}</strong> builds vs last week: <strong>${lastWeek.count || 0}</strong> — QA avg ${thisWeek.avgQaScore || 0}/100 (${qaChangeStr} vs last week)`
    },
    {
      badge: 'QUALITY',
      color: qaChange >= 0 ? '#22A860' : '#E5A200',
      text: `Failed builds: <strong>${thisWeek.failed || 0}</strong> this week — ${thisWeek.iterationBuilds || 0} builds triggered iteration loop (QA < 70)`
    },
    {
      badge: 'AGENTS',
      color: (agents.errorCount || 0) > 5 ? '#EF4444' : '#22A860',
      text: `Most failed agent: <strong>${agents.mostFailedAgent || 'none'}</strong> — n8n import: ${agents.n8nImportSuccessRate || 100}% — Schema deploy: ${agents.schemaDeploySuccessRate || 100}%`
    },
    {
      badge: 'PIPELINE',
      color: (pipeline.stuckBuilds?.length || 0) > 0 ? '#E5A200' : '#22A860',
      text: `${pipeline.inProgressCount || 0} builds in progress — ${pipeline.stuckBuilds?.length || 0} stuck >2hr — ${pipeline.completedBuilds?.length || 0} completed this week`
    },
    {
      badge: 'VERIFY',
      color: (verification.passRate || 100) >= 80 ? '#22A860' : '#E5A200',
      text: `Verification pass rate: <strong>${verification.passRate || 100}%</strong> (${verification.allPassed || 0}/${verification.totalVerified || 0}) — Most common fail: ${verification.mostCommonFail || 'none'}`
    }
  ];

  // Infrastructure section
  const pm2Restarts = (infra.pm2 || [])
    .filter(p => p.restarts > 0)
    .map(p => `${p.name}: ${p.restarts} restarts`);

  const section2Bullets = [
    `Temporal: <strong>${infra.temporal || 'unknown'}</strong>`,
    `n8n: <strong>${infra.n8nWorkflows?.active || 0} active</strong> / ${infra.n8nWorkflows?.total || 0} total workflows`,
    `GitHub rate limit: <strong>${infra.githubRateLimit?.remaining || 'N/A'}</strong> remaining`,
    `Avg build duration: <strong>${msToMinutes(thisWeek.avgDurationMs)} min</strong>`,
    ...(pm2Restarts.length > 0 ? [`PM2 restarts: ${pm2Restarts.join(', ')}`] : ['PM2: all processes stable']),
    `Supabase builds: <strong>${infra.supabase?.friday_builds || 'N/A'}</strong> total records`
  ];

  // Split Claude analysis into HTML bullet rows
  const analysisLines = analysis
    .split('\n')
    .filter(l => l.trim())
    .slice(0, 8)
    .map(l => l.replace(/^[#*\-•→\d.]+\s*/, '').trim())
    .filter(l => l.length > 10);

  const section1Content = buildSectionRows(section1Items);
  const section2Content = buildBulletRows(section2Bullets) +
    `<tr><td style="padding:8px 0;"><div style="height:1px;background:#E2E5EA;"></div></td></tr>` +
    `<tr><td style="padding:6px 0;font-size:12px;font-weight:700;color:#7C5CFC;text-transform:uppercase;letter-spacing:.08em;">AI Recommendations</td></tr>` +
    buildBulletRows(analysisLines);

  const subject = `ManageAI Build Intelligence — Week of ${mondayStr}`;

  const html = await buildEmailHtml({
    email_subject: subject,
    preheader_text: `${thisWeek.count || 0} builds this week · QA avg ${thisWeek.avgQaScore || 0}/100 · ${thisWeek.failed || 0} failed`,
    badge_text: 'BUILD INTELLIGENCE',
    badge_color: '#4A8FD6',
    report_date: mondayStr,
    headline: 'Weekly Build Intelligence',
    subheadline: `FRIDAY Autonomous Build System — Week of ${mondayStr}`,
    intro_paragraph: `${thisWeek.count || 0} builds processed this week (vs ${lastWeek.count || 0} last week). Average QA score: <strong>${thisWeek.avgQaScore || 0}/100</strong>. Verification pass rate: <strong>${verification.passRate || 100}%</strong>.`,
    stat_1_value: String(thisWeek.count || 0),
    stat_1_label: 'Builds This Week',
    stat_1_color: '#4A8FD6',
    stat_2_value: String(thisWeek.avgQaScore || 0),
    stat_2_label: 'Avg QA Score',
    stat_2_color: qaColor,
    stat_3_value: String(thisWeek.failed || 0),
    stat_3_label: 'Failed Builds',
    stat_3_color: (thisWeek.failed || 0) > 0 ? '#EF4444' : '#22A860',
    stat_4_value: `${verification.passRate || 100}%`,
    stat_4_label: 'Verify Pass Rate',
    stat_4_color: (verification.passRate || 100) >= 80 ? '#22A860' : '#E5A200',
    section_1_label: 'Build & Agent Performance',
    section_1_content: section1Content,
    section_2_label: 'Infrastructure & Recommendations',
    section_2_content: section2Content,
    cta_primary_url: `${FRIDAY_BASE}/dashboard`,
    cta_primary_label: 'Open Build Dashboard',
    cta_secondary_url: `${FRIDAY_BASE}/api/metrics`,
    cta_secondary_label: 'View Metrics',
    sender_name: 'F.R.I.D.A.Y.',
    sender_role: 'Autonomous Build Intelligence Engine',
    footer_client: 'ManageAI Internal'
  });

  await sendEmail(subject, html);
  console.log('[WEEKLY-INTEL] Email sent to:', RECIPIENTS.join(', '));

  return { sent: true, recipients: RECIPIENTS, subject, weekOf: mondayStr };
}

// ── Scheduler & route registration ───────────────────────────────────────────

export function scheduleWeeklyIntelligence(app) {
  // Cron: Every Monday at 8:05 AM (5-min offset from Charlie)
  cron.schedule('5 8 * * 1', () => {
    runWeeklyIntelligence().catch(err => {
      console.error('[WEEKLY-INTEL] Cron run failed:', err.message);
    });
  });
  console.log('[FRIDAY] Weekly Build Intelligence email scheduled: Monday 8:05 AM');

  // Manual trigger endpoint
  app.post('/api/build/weekly-intelligence/run', async (req, res) => {
    const key = req.headers['x-cockpit-key'];
    if (key !== 'friday-cockpit-2026') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const result = await runWeeklyIntelligence();
      res.json(result);
    } catch(e) {
      console.error('[WEEKLY-INTEL] Manual run failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });
}
