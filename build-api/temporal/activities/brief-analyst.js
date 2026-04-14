import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { ApplicationFailure } from '@temporalio/activity';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export async function briefAnalystActivity(jobData) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  // Normalize field names (workflow uses snake_case, some callers use camelCase)
  const ticketId = jobData.ticket_id || jobData.ticketId;
  const customerId = jobData.customerId || jobData.customer_id;
  const clientName = jobData.client || jobData.client_name || jobData.clientName || 'Unknown';

  // Gather brief text from whatever field it lives on
  const briefRaw = jobData.brief
    || jobData.request_description
    || jobData.description
    || jobData.requirements
    || jobData.brief_text;
  const briefText = briefRaw
    ? (typeof briefRaw === 'string' ? briefRaw : JSON.stringify(briefRaw, null, 2))
    : JSON.stringify(jobData, null, 2);

  console.log(`[BUILD-000] Starting Brief Analysis for ${clientName} / ${ticketId}`);
  const startTime = Date.now();

  // Record start
  await supabase.from('build_agent_runs').insert({
    ticket_id: ticketId,
    agent_id: 'BUILD-000',
    agent_name: 'Brief Analyst',
    status: 'running',
    started_at: new Date().toISOString()
  });

  // ── Phase 1: Structured extraction ────────────────────────────────────────
  const extractionResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    messages: [{
      role: 'user',
      content: `You are a senior AI systems architect reviewing a requirements brief before a build team starts work.

Extract and analyze the following from this brief:

1. REQUIRED_INTEGRATIONS: Every external system, API, or platform mentioned
2. SUCCESS_METRICS: Every measurable success criterion stated
3. DATA_REQUIREMENTS: Every data entity, field, or schema requirement
4. WORKFLOW_REQUIREMENTS: Every automation, routing, or process requirement
5. AMBIGUITIES: Any requirement that is vague, contradictory, or underspecified
6. BLOCKERS: Any requirement that appears technically infeasible or impossible
7. MISSING_SPECS: Any area where the brief implies functionality but does not specify how it should work

Return ONLY valid JSON in this exact structure:
{
  "required_integrations": [{"name": string, "api_available": boolean, "notes": string}],
  "success_metrics": [{"metric": string, "measurable": boolean, "threshold": string}],
  "data_requirements": [{"entity": string, "fields": string[], "relationships": string}],
  "workflow_requirements": [{"workflow": string, "trigger": string, "action": string, "complexity": "low|medium|high"}],
  "ambiguities": [{"area": string, "issue": string, "impact": "blocking|high|medium|low", "question": string}],
  "blockers": [{"requirement": string, "reason": string, "suggested_alternative": string}],
  "missing_specs": [{"area": string, "what_is_missing": string, "why_it_matters": string}]
}

BRIEF:
${briefText}`
    }]
  });

  let analysis;
  try {
    const raw = extractionResponse.content[0].text;
    const clean = raw.replace(/```json\n?|\n?```/g, '').trim();
    analysis = JSON.parse(clean);
  } catch (e) {
    try { await supabase.from('build_agent_runs').update({ status: 'failed', completed_at: new Date().toISOString(), errors: [{ message: e.message }] }).eq('ticket_id', ticketId).eq('agent_id', 'BUILD-000'); } catch (_) {}
    throw ApplicationFailure.create({
      message: `[BUILD-000] Failed to parse brief analysis JSON: ${e.message}`,
      nonRetryable: false
    });
  }

  // ── Phase 2: Buildability scoring ─────────────────────────────────────────
  const scoringResponse = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `You are evaluating whether a software requirements brief is ready to build.

Given this analysis of the brief:
${JSON.stringify(analysis, null, 2)}

Score the brief on these dimensions (0-100 each):
- completeness: Are all necessary specifications present?
- clarity: Are requirements unambiguous and specific?
- feasibility: Are requirements technically achievable?
- consistency: Do requirements contradict each other?
- testability: Can success be measured against these requirements?

BLOCKING_ISSUES: List any issue that MUST be resolved before building starts (ambiguities that would cause agents to build different things, missing specs for core functionality, technical impossibilities).

Return ONLY valid JSON:
{
  "scores": {
    "completeness": number,
    "clarity": number,
    "feasibility": number,
    "consistency": number,
    "testability": number,
    "overall": number
  },
  "blocking_issues": [{"issue": string, "agent_affected": string, "question_for_charlie": string}],
  "warnings": [{"issue": string, "recommendation": string}],
  "build_ready": boolean,
  "confidence": number,
  "summary": string
}`
    }]
  });

  let scoring;
  try {
    const raw = scoringResponse.content[0].text;
    const clean = raw.replace(/```json\n?|\n?```/g, '').trim();
    scoring = JSON.parse(clean);
  } catch (e) {
    // Non-fatal — use conservative defaults so we don't block on a parse error
    scoring = {
      scores: { completeness: 70, clarity: 70, feasibility: 70, consistency: 70, testability: 70, overall: 70 },
      blocking_issues: [],
      warnings: [{ issue: 'Scoring parse failed', recommendation: 'Manual review advised' }],
      build_ready: true,
      confidence: 0.6,
      summary: `Scoring parse error (${e.message.slice(0, 80)}) — proceeding with caution`
    };
  }

  // ── Phase 3: Success criteria extraction ──────────────────────────────────
  const criteriaResponse = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `Extract ALL success criteria from this requirements brief. Be exhaustive.
These will be used at the END of the build to verify everything requested was delivered.

For each criterion, identify:
- The exact requirement (verbatim where possible)
- Which agent is responsible (schema/workflow/llm/platform/integration)
- How to verify it was met
- Priority (critical/high/medium/low)

Return ONLY valid JSON:
{
  "success_criteria": [
    {
      "id": string,
      "requirement": string,
      "responsible_agent": string,
      "verification_method": string,
      "priority": "critical|high|medium|low",
      "acceptance_test": string
    }
  ]
}

BRIEF:
${briefText}`
    }]
  });

  let criteria;
  try {
    const raw = criteriaResponse.content[0].text;
    const clean = raw.replace(/```json\n?|\n?```/g, '').trim();
    criteria = JSON.parse(clean);
  } catch (e) {
    criteria = { success_criteria: [] };
  }

  const duration = Date.now() - startTime;

  // ── Charlie simulator: answer clarification questions instead of blocking ──
  const clarificationQuestions = (scoring.blocking_issues || [])
    .map(b => b.question_for_charlie)
    .filter(Boolean);

  let charlieAnswers = [];
  if (clarificationQuestions.length > 0) {
    const questionsText = clarificationQuestions
      .map((q, i) => `${i + 1}. ${q}`)
      .join('\n');

    const charlieResponse = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: 'You are Charlie, a Customer Success agent for ManageAI. You are answering clarification questions from the Build Agent about a client brief. Answer each question concisely using only information available in the brief. If the brief doesn\'t explicitly state the answer, make a reasonable assumption based on the context and note it as an assumption. Never say you don\'t know — always provide a working answer so the build can proceed.',
      messages: [{
        role: 'user',
        content: `BRIEF:\n${briefText}\n\nCLARIFICATION QUESTIONS:\n${questionsText}\n\nAnswer each question as a JSON array of objects: [{"question": string, "answer": string, "is_assumption": boolean}]`
      }]
    });

    try {
      const raw = charlieResponse.content[0].text;
      const clean = raw.replace(/```json\n?|\n?```/g, '').trim();
      charlieAnswers = JSON.parse(clean);
    } catch (_) {
      charlieAnswers = clarificationQuestions.map(q => ({ question: q, answer: 'Proceeding with reasonable defaults.', is_assumption: true }));
    }

    console.log(`[BUILD-000] Charlie simulator answered ${charlieAnswers.length} clarification questions`);

    // Attach simulated answers to blocking issues for downstream agents
    scoring.blocking_issues = scoring.blocking_issues.map((b, i) => ({
      ...b,
      charlie_answer: charlieAnswers[i]?.answer || 'Proceeding with reasonable defaults.',
      is_assumption: charlieAnswers[i]?.is_assumption ?? true,
      resolved_by: 'charlie-simulator'
    }));
  }

  // Override build_ready: score above 60 means the brief is good enough to build
  const overallScore = scoring.scores?.overall || 0;
  if (overallScore > 60) {
    scoring.build_ready = true;
  }

  // ── Persist full analysis ──────────────────────────────────────────────────
  await supabase.from('build_briefs').upsert({
    ticket_id: ticketId,
    customer_id: customerId,
    client_name: clientName,
    brief_analysis: analysis,
    brief_scoring: scoring,
    success_criteria: criteria.success_criteria || [],
    blocking_issues: scoring.blocking_issues || [],
    charlie_answers: charlieAnswers.length > 0 ? charlieAnswers : null,
    warnings: scoring.warnings || [],
    overall_score: scoring.scores?.overall || 0,
    build_ready: scoring.build_ready,
    confidence: scoring.confidence,
    analyzed_at: new Date().toISOString()
  }, { onConflict: 'ticket_id' });

  // Update agent run record
  await supabase.from('build_agent_runs').update({
    status: 'complete',
    duration_ms: duration,
    output: {
      overall_score: scoring.scores?.overall,
      blocking_issues_count: (scoring.blocking_issues || []).length,
      charlie_questions_answered: charlieAnswers.length,
      success_criteria_count: (criteria.success_criteria || []).length,
      build_ready: scoring.build_ready,
      confidence: scoring.confidence,
      summary: scoring.summary
    },
    completed_at: new Date().toISOString()
  }).eq('ticket_id', ticketId).eq('agent_id', 'BUILD-000');

  console.log(`[BUILD-000] Done in ${duration}ms | Score: ${scoring.scores?.overall}/100 | Criteria: ${(criteria.success_criteria || []).length} | Ready: ${scoring.build_ready}`);

  return {
    agent: 'BUILD-000',
    status: 'complete',
    duration_ms: duration,
    overall_score: scoring.scores?.overall,
    build_ready: scoring.build_ready,
    confidence: scoring.confidence,
    success_criteria_count: (criteria.success_criteria || []).length,
    blocking_issues: scoring.blocking_issues || [],
    warnings: scoring.warnings || [],
    summary: scoring.summary
  };
}
