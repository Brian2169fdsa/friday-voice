import Anthropic from '@anthropic-ai/sdk';

export async function orchestrationDecisionActivity(jobData) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const startTime = Date.now();
  const ticketId = jobData.ticket_id || jobData.ticketId;

  console.log('[BUILD-013] Starting Orchestration Decision for:', ticketId);

  try {
    const contractStr = JSON.stringify(jobData.buildContract || jobData._contract || {}).slice(0, 3000);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      system: `You are an orchestration architect for AI automation systems. Your job is to analyze a build contract and decide whether each automation requirement should use n8n, Temporal, or both.

Decision rules:
- Simple event triggers, webhook-in/webhook-out, linear automations under 60 seconds → n8n
- Long-running processes (hours or days), human-in-the-loop with wait periods, complex retry logic, multi-agent coordination → Temporal
- Mix of both → both

You must return valid JSON only. No explanation. No markdown.`,
      messages: [{
        role: 'user',
        content: `Analyze this build contract and decide the orchestration technology needed.

Build Contract: ${contractStr}
Workflow Steps: ${jobData.workflow_steps || 'Not specified'}
Success Metrics: ${jobData.success_metrics || 'Not specified'}
Guardrails: ${jobData.guardrails || 'Not specified'}

Return this exact JSON structure:
{
  "type": "n8n | temporal | both",
  "decision_rationale": "plain english explanation",
  "n8n_workflows": [{"name": "string", "trigger": "string", "rationale": "string"}],
  "temporal_workflows": [{"name": "string", "rationale": "string", "signals": [], "estimated_duration": "string", "retry_policy": "string"}],
  "temporal_namespace": "client-slug-purpose",
  "temporal_task_queue": "client-tasks"
}`
      }]
    });

    const raw = response.content[0].text;
    const clean = raw.replace(/```json\n?|\n?```/g, '').trim();
    const decision = JSON.parse(clean);

    const durationMs = Date.now() - startTime;
    console.log('[BUILD-013] Decision:', decision.type, '—', (decision.decision_rationale || '').slice(0, 100));

    try {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/build_agent_runs`, {
        method: 'POST',
        headers: {
          'apikey': process.env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          ticket_id: ticketId,
          agent_id: 'BUILD-013',
          agent_name: 'Orchestration Decision Agent',
          status: 'complete',
          output: decision,
          duration_ms: durationMs,
          started_at: new Date(startTime).toISOString(),
          completed_at: new Date().toISOString()
        })
      });
    } catch(dbErr) { console.warn('[BUILD-013] DB write failed (non-blocking):', dbErr.message); }

    return { decision, agent_id: 'BUILD-013' };

  } catch(e) {
    console.warn('[BUILD-013] Error, defaulting to n8n:', e.message.slice(0, 200));
    const decision = { type: 'n8n' };

    try {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/build_agent_runs`, {
        method: 'POST',
        headers: {
          'apikey': process.env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          ticket_id: ticketId,
          agent_id: 'BUILD-013',
          agent_name: 'Orchestration Decision Agent',
          status: 'error',
          output: { type: 'n8n', error: e.message.slice(0, 200) },
          duration_ms: Date.now() - startTime,
          started_at: new Date(startTime).toISOString(),
          completed_at: new Date().toISOString()
        })
      });
    } catch(dbErr) { console.warn('[BUILD-013] DB write failed (non-blocking):', dbErr.message); }

    return { decision, agent_id: 'BUILD-013' };
  }
}
