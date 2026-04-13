import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export async function engagementMemoryActivity(jobData) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  // Normalize field names
  const ticketId = jobData.ticket_id || jobData.ticketId;
  const customerId = jobData.customerId || jobData.customer_id;
  const clientName = jobData.client || jobData.client_name || jobData.clientName || 'Unknown';

  console.log(`[BUILD-012] Loading engagement memory for ${clientName} / ${ticketId}`);
  const startTime = Date.now();

  // Load prior builds for this customer (excluding current)
  const { data: priorBuilds } = await supabase
    .from('friday_builds')
    .select('id, ticket_id, qa_score, created_at, build_output, change_requests, approval_notes')
    .eq('customer_id', customerId)
    .neq('ticket_id', ticketId)
    .order('created_at', { ascending: false })
    .limit(5);

  // Load approval patterns (table may not exist yet — graceful: data will be null)
  const { data: approvalPatterns } = await supabase
    .from('friday_approval_patterns')
    .select('pattern_type, pattern_description, outcome, frequency, agent_affected')
    .eq('customer_id', customerId)
    .order('frequency', { ascending: false })
    .limit(20);

  // Load cross-build learnings
  const { data: learnings } = await supabase
    .from('cross_build_learnings')
    .select('pattern_type, pattern_description, agent_affected, frequency, improvement_applied')
    .eq('customer_id', customerId)
    .order('frequency', { ascending: false })
    .limit(10);

  // Load QA signals from prior builds
  const priorTicketIds = (priorBuilds || []).map(b => b.ticket_id);
  let priorQualitySignals = [];
  if (priorTicketIds.length > 0) {
    const { data: signals } = await supabase
      .from('build_quality_signals')
      .select('from_agent, signal_type, confidence, flags, payload')
      .in('ticket_id', priorTicketIds)
      .eq('signal_type', 'qa_results')
      .order('created_at', { ascending: false })
      .limit(10);
    priorQualitySignals = signals || [];
  }

  const hasPriorBuilds = (priorBuilds || []).length > 0;
  const hasPatterns = (approvalPatterns || []).length > 0 || (learnings || []).length > 0;

  // No history — first build for this client
  if (!hasPriorBuilds && !hasPatterns) {
    console.log(`[BUILD-012] No prior history for ${clientName} — first build`);
    return {
      agent: 'BUILD-012',
      status: 'complete',
      has_prior_history: false,
      context_injected: false,
      duration_ms: Date.now() - startTime
    };
  }

  // Synthesize engagement context with Haiku (fast, cost-efficient for context loading)
  const synthesisResponse = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `You are synthesizing build history for ${clientName} to inform the current build team.

PRIOR BUILDS (${(priorBuilds || []).length} found):
${JSON.stringify(priorBuilds || [], null, 2)}

APPROVAL PATTERNS (what Brian approved/rejected):
${JSON.stringify(approvalPatterns || [], null, 2)}

CROSS-BUILD LEARNINGS:
${JSON.stringify(learnings || [], null, 2)}

PRIOR QA SIGNALS:
${JSON.stringify(priorQualitySignals, null, 2)}

Produce a concise engagement context that tells each build agent what to do differently based on history.
Focus on: what failed QA before, what Brian requested changes on, what patterns to avoid, what worked well.

Return ONLY valid JSON (no markdown):
{
  "client_summary": string,
  "prior_build_count": number,
  "avg_qa_score": number,
  "agent_instructions": {
    "BUILD-006": string,
    "BUILD-002": string,
    "BUILD-004": string,
    "BUILD-005": string,
    "BUILD-003": string
  },
  "patterns_to_avoid": [string],
  "patterns_to_use": [string],
  "change_request_history": [string],
  "quality_flags": [string]
}`
    }]
  });

  let engagementContext;
  try {
    const raw = synthesisResponse.content[0].text;
    const clean = raw.replace(/```json\n?|\n?```/g, '').trim();
    engagementContext = JSON.parse(clean);
  } catch (e) {
    // Parse failure — return structured fallback, don't block build
    console.warn(`[BUILD-012] Context parse error (non-blocking): ${e.message}`);
    engagementContext = {
      client_summary: `${clientName} has ${(priorBuilds || []).length} prior builds`,
      prior_build_count: (priorBuilds || []).length,
      avg_qa_score: 0,
      agent_instructions: {},
      patterns_to_avoid: [],
      patterns_to_use: [],
      change_request_history: [],
      quality_flags: []
    };
  }

  // Store in build_quality_signals so all agents can read it
  await supabase.from('build_quality_signals').insert({
    ticket_id: ticketId,
    from_agent: 'BUILD-012',
    signal_type: 'engagement_context',
    confidence: 1,
    payload: {
      ...engagementContext,
      prior_builds: priorBuilds || [],
      approval_patterns: approvalPatterns || [],
      learnings: learnings || []
    }
  });

  jobData._engagementContext = engagementContext;

  const duration = Date.now() - startTime;
  const patternCount = (engagementContext.patterns_to_avoid || []).length + (engagementContext.patterns_to_use || []).length;
  console.log(`[BUILD-012] Context loaded for ${clientName} | Prior builds: ${(priorBuilds || []).length} | Patterns: ${patternCount} | ${duration}ms`);

  return {
    agent: 'BUILD-012',
    status: 'complete',
    has_prior_history: hasPriorBuilds,
    prior_build_count: (priorBuilds || []).length,
    avg_qa_score: engagementContext.avg_qa_score,
    patterns_found: patternCount,
    context_injected: true,
    duration_ms: duration
  };
}

export async function updateEngagementMemoryActivity(jobData, buildResult) {
  // Normalize field names
  const ticketId = jobData.ticket_id || jobData.ticketId;
  const customerId = jobData.customerId || jobData.customer_id;
  const clientName = jobData.client || jobData.client_name || jobData.clientName || 'Unknown';

  console.log(`[BUILD-012] Updating engagement memory for ${clientName} / ${ticketId}`);

  const qaSignal = buildResult?.qa_results || {};
  const complianceResult = buildResult?.compliance || {};
  const patterns = [];

  // Record QA failure patterns
  if (qaSignal.scores) {
    const scores = qaSignal.scores;
    if (scores.n8n_workflows < 80) {
      patterns.push({
        customer_id: customerId,
        pattern_type: 'qa_failure',
        pattern_description: `n8n workflow QA scored ${scores.n8n_workflows}% — review webhook trigger configuration`,
        agent_affected: 'BUILD-002',
        frequency: 1,
        last_seen_ticket: ticketId
      });
    }
    if (scores.database_schema < 80) {
      patterns.push({
        customer_id: customerId,
        pattern_type: 'qa_failure',
        pattern_description: `Database schema QA scored ${scores.database_schema}% — review table structure and constraints`,
        agent_affected: 'BUILD-006',
        frequency: 1,
        last_seen_ticket: ticketId
      });
    }
    if (scores.llm_accuracy < 80) {
      patterns.push({
        customer_id: customerId,
        pattern_type: 'qa_failure',
        pattern_description: `LLM accuracy scored ${scores.llm_accuracy}% — review system prompt specificity and test pairs`,
        agent_affected: 'BUILD-004',
        frequency: 1,
        last_seen_ticket: ticketId
      });
    }
  }

  // Record compliance revision packages as patterns
  for (const pkg of complianceResult.revision_packages || []) {
    patterns.push({
      customer_id: customerId,
      pattern_type: 'compliance_gap',
      pattern_description: `${pkg.agent} required revisions: ${(pkg.revisions || []).join('; ').slice(0, 200)}`,
      agent_affected: pkg.agent,
      frequency: 1,
      last_seen_ticket: ticketId
    });
  }

  // Upsert patterns — increment frequency if same pattern seen before
  for (const pattern of patterns) {
    const { data: existing } = await supabase
      .from('cross_build_learnings')
      .select('id, frequency')
      .eq('customer_id', customerId)
      .eq('pattern_type', pattern.pattern_type)
      .eq('agent_affected', pattern.agent_affected)
      .ilike('pattern_description', pattern.pattern_description.slice(0, 50) + '%')
      .maybeSingle();

    if (existing) {
      await supabase
        .from('cross_build_learnings')
        .update({
          frequency: existing.frequency + 1,
          last_seen_ticket: ticketId,
          updated_at: new Date().toISOString()
        })
        .eq('id', existing.id);
    } else {
      await supabase.from('cross_build_learnings').insert(pattern);
    }
  }

  console.log(`[BUILD-012] Memory updated for ${clientName} | Patterns recorded: ${patterns.length}`);
  return { patterns_recorded: patterns.length };
}
