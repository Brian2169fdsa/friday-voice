/**
 * BUILD-013: Intelligence Report
 * Express module — generates weekly summary of build_intelligence findings,
 * sends email to leadership. Registered in server.js alongside weekly-intelligence.js.
 * Schedule: Monday 8:15 AM (after weekly-intel at 8:05 and cross-build at 8:10)
 */
import cron from 'node-cron';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import { getGraphToken } from './temporal/activities/onedrive.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', '3-email-base.html');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const GRAPH_USER_EMAIL = process.env.GRAPH_USER_EMAIL || 'brian@manageai.io';
const FRIDAY_BASE = process.env.FRIDAY_PUBLIC_URL || 'http://5.223.79.255:3000';

const RECIPIENTS = [
  'brian@manageai.io',
  process.env.DAN_EMAIL,
  process.env.DAVE_EMAIL
].filter(Boolean);

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(d) {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

async function buildEmailHtml(inject) {
  let html;
  try { html = await fs.readFile(TEMPLATE_PATH, 'utf8'); }
  catch(e) { html = '<html><body>{{content}}</body></html>'; }
  for (const [key, val] of Object.entries(inject)) {
    const re = new RegExp(`<!-- INJECT: ${key} -->`, 'g');
    html = html.replace(re, String(val || ''));
  }
  return html;
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

// ── Data collection ───────────────────────────────────────────────────────────

async function collectPendingIntelligence(supabase) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

  const { data: items } = await supabase
    .from('build_intelligence')
    .select('*')
    .in('status', ['pending', 'reviewed'])
    .gte('created_at', sevenDaysAgo)
    .order('relevance_score', { ascending: false });

  return items || [];
}

async function markItemsReviewed(supabase, ids) {
  if (ids.length === 0) return;
  await supabase
    .from('build_intelligence')
    .update({ status: 'reviewed' })
    .in('id', ids)
    .eq('status', 'pending');
}

// ── Claude analysis ───────────────────────────────────────────────────────────

async function generateIntelligenceSummary(items) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const grouped = {};
  for (const item of items) {
    if (!grouped[item.category]) grouped[item.category] = [];
    grouped[item.category].push(item);
  }

  const categoryText = Object.entries(grouped)
    .map(([cat, catItems]) => {
      const sorted = catItems.sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0));
      return `CATEGORY: ${cat} (${catItems.length} items)\n` +
        sorted.slice(0, 5).map(i =>
          `  [${i.risk_level?.toUpperCase() || 'LOW'}] ${i.title}\n  ${(i.description || '').slice(0, 150)}`
        ).join('\n');
    })
    .join('\n\n');

  const highRisk = items.filter(i => i.risk_level === 'high');
  const medRisk = items.filter(i => i.risk_level === 'medium');

  const prompt = `You are the ManageAI Build Intelligence System. Review this week's intelligence findings.

SUMMARY: ${items.length} findings — ${highRisk.length} high risk, ${medRisk.length} medium risk

${categoryText}

Produce a concise executive summary with:
1. Top 3 items requiring immediate attention (rank by risk + relevance)
2. Top 3 opportunities to improve build quality or capability
3. One sentence on overall system health trend

Max 400 words. Be direct. Address Brian (Head of Build), Dan (CCO), Dave (CEO).`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    system: 'You are the ManageAI Build Intelligence System. Produce concise, actionable executive summaries. No fluff.',
    messages: [{ role: 'user', content: prompt }]
  });

  return msg.content[0].text;
}

// ── HTML builders ─────────────────────────────────────────────────────────────

function riskColor(level) {
  if (level === 'high') return '#EF4444';
  if (level === 'medium') return '#E5A200';
  return '#22A860';
}

function riskBadge(level) {
  return (level || 'low').toUpperCase();
}

function buildIntelligenceRows(items) {
  return items.slice(0, 8).map(item =>
    `<tr><td style="padding:6px 0;">
      <table width="100%"><tr>
        <td width="70" style="padding:8px 12px;border-radius:4px 0 0 4px;background:${riskColor(item.risk_level)}15;border-left:3px solid ${riskColor(item.risk_level)};">
          <span style="font-family:Courier New,monospace;font-size:10px;font-weight:700;color:${riskColor(item.risk_level)};text-transform:uppercase;">${riskBadge(item.risk_level)}</span>
          <br><span style="font-size:9px;color:#888;">${item.source || 'watcher'}</span>
        </td>
        <td style="padding:8px 12px;background:#F8F9FB;border-radius:0 4px 4px 0;font-size:13px;color:#5A6070;line-height:1.5;">
          <strong>${item.title}</strong>
          ${item.affected_agent ? `<br><span style="font-size:11px;color:#888;">Affects: ${item.affected_agent}</span>` : ''}
          ${item.estimated_effort ? `<br><span style="font-size:11px;color:#888;">Effort: ${item.estimated_effort}</span>` : ''}
        </td>
      </tr></table>
    </td></tr>`
  ).join('\n');
}

function buildAnalysisRows(analysisText) {
  return analysisText
    .split('\n')
    .filter(l => l.trim())
    .slice(0, 10)
    .map(l => l.replace(/^[#*\-•→\d.]+\s*/, '').trim())
    .filter(l => l.length > 10)
    .map(text =>
      `<tr><td style="padding:4px 0;font-size:13px;color:#5A6070;line-height:1.6;">
        <span style="color:#7C5CFC;font-weight:700;margin-right:8px;">→</span>${text}
      </td></tr>`
    ).join('\n');
}

// ── Main runner ───────────────────────────────────────────────────────────────

async function runIntelligenceReport() {
  console.log('[INTEL-REPORT] Starting BUILD-013 intelligence report...');

  const supabase = createClient(SB_URL, SB_KEY);
  const items = await collectPendingIntelligence(supabase);

  if (items.length === 0) {
    console.log('[INTEL-REPORT] No intelligence items this week — skipping email');
    return { sent: false, reason: 'no items', itemCount: 0 };
  }

  const highRisk = items.filter(i => i.risk_level === 'high');
  const medRisk = items.filter(i => i.risk_level === 'medium');
  const researchItems = items.filter(i => (i.source || '') === 'research');

  console.log(`[INTEL-REPORT] ${items.length} items: ${highRisk.length} high, ${medRisk.length} medium, ${researchItems.length} research`);

  const analysis = await generateIntelligenceSummary(items);

  const weekOf = formatDate(new Date());
  const subject = `ManageAI Build Intelligence — ${items.length} findings week of ${weekOf}`;

  // Section 1: Top findings by risk
  const topItems = items.sort((a, b) => {
    const riskOrder = { high: 3, medium: 2, low: 1 };
    const rDiff = (riskOrder[b.risk_level] || 0) - (riskOrder[a.risk_level] || 0);
    return rDiff !== 0 ? rDiff : (b.relevance_score || 0) - (a.relevance_score || 0);
  });

  const section1Content = buildIntelligenceRows(topItems);
  const section2Content = buildAnalysisRows(analysis);

  const html = await buildEmailHtml({
    email_subject: subject,
    preheader_text: `${items.length} intelligence findings · ${highRisk.length} high risk · ${researchItems.length} research updates`,
    badge_text: 'BUILD-013 INTELLIGENCE',
    badge_color: '#7C5CFC',
    report_date: weekOf,
    headline: 'Build Intelligence Report',
    subheadline: `Watcher · Diagnostic · Research — Week of ${weekOf}`,
    intro_paragraph: `${items.length} intelligence findings this week from automated monitoring. <strong>${highRisk.length} high-risk</strong> items require attention. ${researchItems.length} technology research updates included.`,
    stat_1_value: String(items.length),
    stat_1_label: 'Total Findings',
    stat_1_color: '#7C5CFC',
    stat_2_value: String(highRisk.length),
    stat_2_label: 'High Risk',
    stat_2_color: highRisk.length > 0 ? '#EF4444' : '#22A860',
    stat_3_value: String(medRisk.length),
    stat_3_label: 'Medium Risk',
    stat_3_color: '#E5A200',
    stat_4_value: String(researchItems.length),
    stat_4_label: 'Research Updates',
    stat_4_color: '#4A8FD6',
    section_1_label: 'Intelligence Findings (by priority)',
    section_1_content: section1Content,
    section_2_label: 'Executive Summary & Recommendations',
    section_2_content: section2Content,
    cta_primary_url: `${FRIDAY_BASE}/dashboard`,
    cta_primary_label: 'Open Build Dashboard',
    cta_secondary_url: `${FRIDAY_BASE}/api/build/intelligence`,
    cta_secondary_label: 'View All Intelligence',
    sender_name: 'F.R.I.D.A.Y. Intelligence',
    sender_role: 'BUILD-013 Automated Intelligence System',
    footer_client: 'ManageAI Internal'
  });

  await sendEmail(subject, html);

  // Mark pending items as reviewed
  const pendingIds = items.filter(i => i.status === 'pending').map(i => i.id);
  await markItemsReviewed(supabase, pendingIds);

  console.log(`[INTEL-REPORT] Email sent to ${RECIPIENTS.join(', ')} | ${pendingIds.length} items marked reviewed`);
  return { sent: true, recipients: RECIPIENTS, subject, itemCount: items.length, reviewedCount: pendingIds.length };
}

// ── Scheduler & route registration ───────────────────────────────────────────

export function scheduleIntelligenceReport(app) {
  // Monday 8:15 AM — 5 min after cross-build-learning
  cron.schedule('15 8 * * 1', () => {
    runIntelligenceReport().catch(err => {
      console.error('[INTEL-REPORT] Cron run failed:', err.message);
    });
  });
  console.log('[FRIDAY] BUILD-013 Intelligence Report scheduled: Monday 8:15 AM');

  // GET: list all intelligence items
  app.get('/api/build/intelligence', async (req, res) => {
    const key = req.headers['x-cockpit-key'];
    if (key !== 'friday-cockpit-2026') return res.status(401).json({ error: 'Unauthorized' });
    try {
      const supabase = createClient(SB_URL, SB_KEY);
      const { data, error } = await supabase
        .from('build_intelligence')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw new Error(error.message);
      res.json({ items: data, count: data.length });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST: manual trigger
  app.post('/api/build/intelligence/report', async (req, res) => {
    const key = req.headers['x-cockpit-key'];
    if (key !== 'friday-cockpit-2026') return res.status(401).json({ error: 'Unauthorized' });
    try {
      const result = await runIntelligenceReport();
      res.json(result);
    } catch(e) {
      console.error('[INTEL-REPORT] Manual run failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // PATCH: approve/reject an intelligence item
  app.patch('/api/build/intelligence/:id', async (req, res) => {
    const key = req.headers['x-cockpit-key'];
    if (key !== 'friday-cockpit-2026') return res.status(401).json({ error: 'Unauthorized' });
    try {
      const { status, approved_by } = req.body;
      if (!['approved', 'rejected', 'reviewed'].includes(status)) {
        return res.status(400).json({ error: 'status must be approved|rejected|reviewed' });
      }
      const supabase = createClient(SB_URL, SB_KEY);
      const update = { status, approved_by: approved_by || 'brian@manageai.io' };
      if (status === 'approved') update.approved_at = new Date().toISOString();
      const { error } = await supabase
        .from('build_intelligence')
        .update(update)
        .eq('id', req.params.id);
      if (error) throw new Error(error.message);
      res.json({ updated: true });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });
}
