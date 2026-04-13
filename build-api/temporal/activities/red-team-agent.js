import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { ApplicationFailure } from '@temporalio/activity';
import fs from 'fs/promises';
import path from 'path';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export async function redTeamAgentActivity(jobData) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  const ticketId = jobData.ticket_id || jobData.ticketId;
  const clientName = jobData.client || jobData.client_name || jobData.clientName || 'Unknown';
  const outputDir = '/tmp/friday-temporal-' + jobData.job_id;

  console.log(`[BUILD-019] Starting Red Team analysis for ${clientName} / ${ticketId}`);
  const startTime = Date.now();

  await supabase.from('build_agent_runs').upsert({
    ticket_id: ticketId,
    agent_id: 'BUILD-019',
    agent_name: 'Red Team Agent',
    status: 'running',
    started_at: new Date().toISOString()
  }, { onConflict: 'ticket_id,agent_id' });

  // Read build artifacts
  const artifacts = {};
  const artifactFiles = [
    { key: 'schema', path: 'schema/confirmed-schema.json' },
    { key: 'workflow_manifest', path: 'workflows/workflow-manifest.json' },
    { key: 'ai_integration', path: 'llm/ai-integration.js' },
    { key: 'deployment_manifest', path: 'platform/deployment-manifest.json' }
  ];

  for (const af of artifactFiles) {
    try {
      const content = await fs.readFile(path.join(outputDir, af.path), 'utf8');
      artifacts[af.key] = content.slice(0, 15000);
    } catch (e) {
      artifacts[af.key] = null;
    }
  }

  // Also read quality signals from Supabase
  const { data: qaSignals } = await supabase
    .from('build_quality_signals')
    .select('from_agent, signal_type, payload, confidence')
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: false })
    .limit(20);

  const artifactSummary = Object.entries(artifacts)
    .map(([k, v]) => v ? `### ${k}\n\`\`\`\n${v}\n\`\`\`` : `### ${k}\n(not found)`)
    .join('\n\n');

  const qaContext = (qaSignals || [])
    .map(s => `- ${s.from_agent} [${s.signal_type}] confidence=${s.confidence}`)
    .join('\n');

  let response;
  try {
    response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: `You are a hostile penetration tester and skeptical senior engineer reviewing a freshly built AI automation system. Your job is to find every way this system could break, be exploited, or fail in production. For each finding, return structured JSON with: id, severity (critical|warning|hardened), category (security|reliability|data_integrity|edge_case|performance), description, affected_agent (BUILD-XXX), recommended_fix, and auto_fixable (boolean). Be specific — reference actual table names, webhook paths, and code patterns from the artifacts. Do not flag theoretical concerns — only issues you can trace to specific artifacts.`,
      messages: [{
        role: 'user',
        content: `Review these build artifacts for ${clientName} (ticket: ${ticketId}):\n\n${artifactSummary}\n\nQA Signals:\n${qaContext}\n\nReturn ONLY a JSON array of findings (no markdown fences):`
      }]
    });
  } catch (apiErr) {
    await supabase.from('build_agent_runs').update({
      status: 'failed', completed_at: new Date().toISOString(),
      errors: [{ message: apiErr.message }]
    }).eq('ticket_id', ticketId).eq('agent_id', 'BUILD-019');
    throw apiErr;
  }

  let findings = [];
  try {
    const raw = response.content[0].text.replace(/```json\n?|\n?```/g, '').trim();
    findings = JSON.parse(raw);
    if (!Array.isArray(findings)) findings = [findings];
  } catch (e) {
    console.warn(`[BUILD-019] Failed to parse red team findings: ${e.message}`);
    findings = [];
  }

  const critical_count = findings.filter(f => f.severity === 'critical').length;
  const warning_count = findings.filter(f => f.severity === 'warning').length;
  const hardened_count = findings.filter(f => f.severity === 'hardened').length;

  // Write findings to Supabase
  for (const finding of findings) {
    await supabase.from('build_quality_signals').insert({
      ticket_id: ticketId,
      from_agent: 'BUILD-019',
      signal_type: 'red_team_finding',
      confidence: finding.severity === 'critical' ? 0 : finding.severity === 'warning' ? 0.5 : 1,
      payload: finding
    });
  }

  const duration = Date.now() - startTime;

  await supabase.from('build_agent_runs').update({
    status: critical_count > 0 ? 'failed' : 'complete',
    duration_ms: duration,
    output: {
      findings_count: findings.length,
      critical_count,
      warning_count,
      hardened_count
    },
    completed_at: new Date().toISOString()
  }).eq('ticket_id', ticketId).eq('agent_id', 'BUILD-019');

  console.log(`[BUILD-019] Red Team complete | ${findings.length} findings (${critical_count} critical, ${warning_count} warning, ${hardened_count} hardened) | ${Math.round(duration / 1000)}s`);

  const result = {
    agent: 'BUILD-019',
    status: critical_count > 0 ? 'critical_findings' : 'complete',
    findings_count: findings.length,
    critical_count,
    warning_count,
    hardened_count,
    findings,
    duration_ms: duration
  };

  if (critical_count > 0) {
    throw ApplicationFailure.create({
      message: `[BUILD-019] RED TEAM: ${critical_count} critical findings detected`,
      type: 'RedTeamCritical',
      nonRetryable: true,
      details: [result]
    });
  }

  return result;
}
