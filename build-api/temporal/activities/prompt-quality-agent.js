import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';
import { getGraphToken, uploadFile } from './onedrive.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fmemdogudiolevqsfuvd.supabase.co';
const GRAPH_USER = process.env.ONEDRIVE_USER_EMAIL || 'brian@manageai.io';

const AGENT_FILES = {
  'BUILD-000': '/opt/manageai/build-api/temporal/activities/brief-analyst.js',
  'BUILD-001': '/opt/manageai/build-api/temporal/activities/planner.js',
  'BUILD-006': '/opt/manageai/build-api/temporal/activities/schema-architect.js',
  'BUILD-002': '/opt/manageai/build-api/temporal/activities/workflow-builder.js',
  'BUILD-004': '/opt/manageai/build-api/temporal/activities/llm-specialist.js',
  'BUILD-005': '/opt/manageai/build-api/temporal/activities/platform-builder.js',
  'BUILD-003': '/opt/manageai/build-api/temporal/activities/qa-tester.js',
  'BUILD-008': '/opt/manageai/build-api/temporal/activities/quality-gate.js',
  'BUILD-011': '/opt/manageai/build-api/temporal/activities/compliance-judge.js',
  'BUILD-013': '/opt/manageai/build-api/temporal/activities/decision-agent.js',
};

async function sbFetch(path, options = {}) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

function extractPromptText(source) {
  const patterns = [
    /system:\s*`([^`]{100,})`/,
    /system:\s*"([^"]{100,})"/,
    /content:\s*`(You are[^`]{100,})`/,
    /`(You are[^`]{200,})`/,
    /(You are BUILD-\d+[^\n]{0,200}(?:\n[^\n]{0,200}){0,20})/,
  ];
  for (const re of patterns) {
    const m = source.match(re);
    if (m) return m[1].slice(0, 2000);
  }
  return source.slice(0, 1000);
}

export async function promptQualityAssessmentActivity(options = {}) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const daysBack = options.days_back || 7;
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
  const weekStart = new Date();
  weekStart.setUTCHours(0, 0, 0, 0);
  weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay() + 1);
  const weekStartStr = weekStart.toISOString().slice(0, 10);
  const reportDate = new Date().toISOString().slice(0, 10);

  console.log(`[BUILD-015] Starting Prompt Quality Assessment | week: ${weekStartStr}`);

  // 1. GATHER DATA
  let agentRuns = [], qualitySignals = [], builds = [];
  try {
    agentRuns = await sbFetch(`/build_agent_runs?created_at=gte.${since}&select=agent_id,agent_name,status,output,duration_ms,created_at&order=created_at.desc&limit=500`);
  } catch(e) { console.warn('[BUILD-015] Could not fetch agent runs:', e.message); }
  try {
    qualitySignals = await sbFetch(`/build_quality_signals?created_at=gte.${since}&select=signal_type,from_agent,confidence,created_at&order=created_at.desc&limit=500`);
  } catch(e) { console.warn('[BUILD-015] Could not fetch quality signals:', e.message); }
  try {
    builds = await sbFetch(`/friday_builds?created_at=gte.${since}&select=ticket_id,status,client_name,created_at&order=created_at.desc&limit=200`);
  } catch(e) { console.warn('[BUILD-015] Could not fetch builds:', e.message); }

  // 2. READ AGENT PROMPTS FROM DISK
  const agentSources = {};
  for (const [agentId, filePath] of Object.entries(AGENT_FILES)) {
    try {
      const source = await fs.readFile(filePath, 'utf8');
      agentSources[agentId] = extractPromptText(source);
    } catch(e) {
      agentSources[agentId] = `[Could not read: ${e.message.slice(0, 80)}]`;
    }
  }

  // 3. SCORE EACH AGENT with Haiku
  const agentScores = {};
  for (const [agentId, promptText] of Object.entries(agentSources)) {
    const agentRunsForAgent = agentRuns.filter(r => r.agent_id === agentId).slice(0, 5);
    const signalsForAgent = qualitySignals.filter(s => s.from_agent === agentId).slice(0, 5);

    try {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system: 'You are a prompt quality evaluator. Score this AI agent prompt against its actual output quality. Return JSON only: {"prompt_score": 0-100, "output_consistency": 0-1, "issues": [{"type": "string", "description": "string", "severity": "high|medium|low", "evidence": "string"}], "suggested_additions": ["string"], "recommendation": "PASSING|WATCH|NEEDS_IMPROVEMENT|URGENT"}',
        messages: [{
          role: 'user',
          content: `Agent: ${agentId}

Prompt excerpt (first 2000 chars):
${promptText}

Recent run statuses (last 5):
${JSON.stringify(agentRunsForAgent.map(r => ({ status: r.status, duration_ms: r.duration_ms, output_keys: Object.keys(r.output || {}) })))}

Quality signal confidence scores (last 5):
${JSON.stringify(signalsForAgent.map(s => ({ confidence: s.confidence, type: s.signal_type })))}`
        }]
      });
      const raw = response.content[0].text.replace(/```json\n?|\n?```/g, '').trim();
      agentScores[agentId] = JSON.parse(raw);
    } catch(e) {
      console.warn(`[BUILD-015] Could not score ${agentId}:`, e.message.slice(0, 100));
      agentScores[agentId] = { prompt_score: 70, output_consistency: 0.7, issues: [], suggested_additions: [], recommendation: 'WATCH' };
    }
  }

  // 4. BUILD REPORT
  const scores = Object.values(agentScores).map(s => s.prompt_score || 70);
  const overallScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const passing = Object.values(agentScores).filter(s => s.recommendation === 'PASSING').length;
  const watching = Object.values(agentScores).filter(s => s.recommendation === 'WATCH').length;
  const needsImprovement = Object.values(agentScores).filter(s => s.recommendation === 'NEEDS_IMPROVEMENT').length;
  const urgent = Object.values(agentScores).filter(s => s.recommendation === 'URGENT').length;

  const allIssues = Object.entries(agentScores).flatMap(([agentId, score]) =>
    (score.issues || []).map(i => ({ ...i, agent: agentId }))
  ).sort((a, b) => (a.severity === 'high' ? -1 : b.severity === 'high' ? 1 : 0));

  const scorecardRows = Object.entries(agentScores).map(([agentId, score]) =>
    `| ${agentId} | ${score.prompt_score}/100 | ${score.recommendation} | ${((score.issues || [])[0]?.description || 'None').slice(0, 60)} |`
  ).join('\n');

  const improvements = Object.entries(agentScores)
    .filter(([_, s]) => s.recommendation === 'NEEDS_IMPROVEMENT' || s.recommendation === 'URGENT')
    .map(([agentId, score]) =>
      `### ${agentId}\n**Issues:** ${(score.issues || []).map(i => i.description).join('; ') || 'None'}\n**Suggested additions:** ${(score.suggested_additions || []).join(', ') || 'None'}`
    ).join('\n\n');

  const report = `# FRIDAY Prompt Quality Report
## Week of ${weekStartStr}

### Executive Summary
- ${passing} of ${Object.keys(agentScores).length} agents passing
- ${watching} agents on watch
- ${needsImprovement} agents need improvement
- ${urgent} agents urgent
- Overall score: ${overallScore}/100

### Agent Scorecards
| Agent | Score | Recommendation | Top Issue |
|-------|-------|----------------|-----------|
${scorecardRows}

### Top Issues This Week
${allIssues.slice(0, 5).map((i, n) => `${n + 1}. **[${i.agent}]** ${i.description} (${i.severity})`).join('\n') || 'No significant issues found.'}

### Suggested Prompt Improvements
${improvements || 'All agents performing within acceptable thresholds.'}

---
*Generated by BUILD-015 Prompt Quality Agent on ${new Date().toUTCString()}*
*Data window: last ${daysBack} days | Builds reviewed: ${builds.length} | Agent runs: ${agentRuns.length}*
`;

  // 5. UPLOAD REPORT to OneDrive
  let reportUrl = null;
  try {
    const token = await getGraphToken();
    reportUrl = await uploadFile(
      token,
      'ManageAI/Intelligence/Prompt-Quality',
      `${reportDate}-prompt-quality-report.md`,
      report,
      'text/markdown'
    );
    console.log('[BUILD-015] Report uploaded to OneDrive:', reportUrl);
  } catch(e) { console.warn('[BUILD-015] OneDrive upload failed (non-blocking):', e.message); }

  // 6. SEND EMAIL via Microsoft Graph
  let emailSent = false;
  try {
    const tokenRes = await fetch(`https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.AZURE_CLIENT_ID,
        client_secret: process.env.AZURE_CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials'
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('No access token: ' + JSON.stringify(tokenData).slice(0, 100));

    const emailBody = `<h2>FRIDAY Prompt Quality Report — Week of ${weekStartStr}</h2>
<p><b>Overall Score:</b> ${overallScore}/100 | <b>Passing:</b> ${passing}/${Object.keys(agentScores).length} agents</p>
<table border="1" cellpadding="4" style="border-collapse:collapse"><tr><th>Agent</th><th>Score</th><th>Status</th></tr>
${Object.entries(agentScores).map(([id, s]) => `<tr><td>${id}</td><td>${s.prompt_score}/100</td><td>${s.recommendation}</td></tr>`).join('')}
</table>
<h3>Top Issues</h3><ol>${allIssues.slice(0, 3).map(i => `<li><b>${i.agent}:</b> ${i.description}</li>`).join('')}</ol>
${reportUrl ? `<p><a href="${reportUrl}">View Full Report on OneDrive</a></p>` : ''}`;

    await fetch(`https://graph.microsoft.com/v1.0/users/${GRAPH_USER}/sendMail`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject: `FRIDAY Prompt Quality Report — Week of ${weekStartStr}`,
          body: { contentType: 'HTML', content: emailBody },
          toRecipients: [
            { emailAddress: { address: 'brian@manageai.io' } },
            { emailAddress: { address: 'dan@manageai.io' } }
          ]
        },
        saveToSentItems: false
      })
    });
    emailSent = true;
    console.log('[BUILD-015] Email sent to brian@manageai.io and dan@manageai.io');
  } catch(e) { console.warn('[BUILD-015] Email failed (non-blocking):', e.message.slice(0, 150)); }

  // 7. WRITE to Supabase prompt_quality_reports
  try {
    const key = process.env.SUPABASE_SERVICE_KEY;
    await fetch(`${SUPABASE_URL}/rest/v1/prompt_quality_reports`, {
      method: 'POST',
      headers: { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({
        week_start: weekStartStr,
        agent_scores: agentScores,
        overall_score: overallScore,
        agents_passing: passing,
        agents_watching: watching,
        agents_needing_improvement: needsImprovement,
        agents_urgent: urgent,
        top_issues: allIssues.slice(0, 5),
        suggested_improvements: Object.fromEntries(
          Object.entries(agentScores).map(([id, s]) => [id, s.suggested_additions || []])
        ),
        report_url: reportUrl,
        email_sent: emailSent
      })
    });
    console.log('[BUILD-015] Report written to Supabase');
  } catch(e) { console.warn('[BUILD-015] Supabase write failed (non-blocking):', e.message); }

  console.log(`[BUILD-015] Complete | Score: ${overallScore}/100 | Passing: ${passing}/${Object.keys(agentScores).length}`);

  return {
    week_start: weekStartStr,
    overall_score: overallScore,
    agents_passing: passing,
    agents_watching: watching,
    agents_needing_improvement: needsImprovement,
    agents_urgent: urgent,
    agent_scores: agentScores,
    top_issues: allIssues.slice(0, 5),
    report_url: reportUrl,
    email_sent: emailSent
  };
}
