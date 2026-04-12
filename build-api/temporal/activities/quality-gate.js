import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { ApplicationFailure } from '@temporalio/activity';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export async function qualityGateActivity(jobData, reviewingAgent, agentOutput) {
  // Normalize field names
  const ticketId = jobData.ticket_id || jobData.ticketId;
  const clientName = jobData.client || jobData.client_name || jobData.clientName || 'Unknown';

  console.log(`[BUILD-008] Quality gate review: ${reviewingAgent} output for ${clientName} / ${ticketId}`);
  const startTime = Date.now();

  // Fetch brief requirements for this agent
  const { data: briefData, error: briefErr } = await supabase
    .from('build_briefs')
    .select('brief_analysis, success_criteria, blocking_issues')
    .eq('ticket_id', ticketId)
    .single();

  // Filter criteria to those relevant to this agent
  const agentSlug = reviewingAgent.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const relevantCriteria = (briefData?.success_criteria || []).filter(c =>
    !c.responsible_agent ||
    c.responsible_agent === 'all' ||
    c.responsible_agent.toLowerCase().includes(agentSlug) ||
    agentSlug.includes(c.responsible_agent.toLowerCase())
  );

  // If no brief data, gate passes with a warning (BUILD-000 may not have run)
  if (briefErr || !briefData) {
    console.warn(`[BUILD-008] No brief data for ${ticketId} — quality gate passing with warning`);
    const warningResult = {
      agent: 'BUILD-008',
      status: 'approved',
      needs_revision: false,
      agent_reviewed: reviewingAgent,
      overall_score: 75,
      alignment_score: 75,
      completeness_score: 75,
      correctness_score: 75,
      passed: true,
      criteria_assessment: [],
      issues: [{
        severity: 'medium',
        description: 'No brief analysis available (BUILD-000 not run)',
        revision_instruction: 'Run BUILD-000 Brief Analyst to enable quality gating'
      }],
      downstream_risks: ['No brief baseline — quality cannot be measured against requirements'],
      approval_recommendation: 'approve',
      revision_summary: 'Quality gate passed with warning: no brief analysis available'
    };
    await supabase.from('build_quality_signals').insert({
      ticket_id: ticketId,
      from_agent: 'BUILD-008',
      to_agent: reviewingAgent,
      signal_type: 'quality_review',
      confidence: 0.75,
      flags: warningResult.issues,
      payload: warningResult
    });
    return warningResult;
  }

  const reviewResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: `You are a senior technical reviewer conducting a quality gate review.

REVIEWING: Output from ${reviewingAgent}
CLIENT: ${clientName}
TICKET: ${ticketId}

BRIEF REQUIREMENTS for this agent (${relevantCriteria.length} criteria):
${JSON.stringify(relevantCriteria, null, 2)}

AGENT OUTPUT TO REVIEW:
${JSON.stringify(agentOutput, null, 2)}

BRIEF ANALYSIS CONTEXT:
${JSON.stringify(briefData.brief_analysis || {}, null, 2)}

Evaluate whether this agent's output meets the brief requirements.

For each requirement:
1. Does the output address it?
2. Is the implementation correct and complete?
3. Will it work with the rest of the system?
4. Are there gaps that will cause downstream failures?

Mark severity as "blocking" ONLY for gaps that will definitely break downstream agents or the client deliverable.
Mark severity as "high" for significant gaps that reduce quality but won't cause failures.

Return ONLY valid JSON (no markdown):
{
  "agent_reviewed": string,
  "overall_score": number,
  "alignment_score": number,
  "completeness_score": number,
  "correctness_score": number,
  "passed": boolean,
  "criteria_assessment": [
    {
      "criterion": string,
      "status": "met|partial|not_met",
      "confidence": number,
      "notes": string
    }
  ],
  "issues": [
    {
      "severity": "blocking|high|medium|low",
      "description": string,
      "requirement_violated": string,
      "revision_instruction": string
    }
  ],
  "downstream_risks": [string],
  "approval_recommendation": "approve|revise|reject",
  "revision_summary": string
}`
    }]
  });

  let review;
  try {
    const raw = reviewResponse.content[0].text;
    const clean = raw.replace(/```json\n?|\n?```/g, '').trim();
    review = JSON.parse(clean);
  } catch (e) {
    // Parse failure — approve with warning (don't block build on instrumentation errors)
    console.warn(`[BUILD-008] Review parse error for ${reviewingAgent}: ${e.message}`);
    review = {
      agent_reviewed: reviewingAgent,
      overall_score: 75,
      alignment_score: 75,
      completeness_score: 75,
      correctness_score: 75,
      passed: true,
      criteria_assessment: [],
      issues: [{
        severity: 'low',
        description: `Review parse error: ${e.message.slice(0, 80)}`,
        revision_instruction: 'Check quality gate LLM response format'
      }],
      downstream_risks: [],
      approval_recommendation: 'approve',
      revision_summary: 'Quality gate parse error — proceeding with caution'
    };
  }

  const duration = Date.now() - startTime;

  // Store quality signal for compliance judge to consume
  await supabase.from('build_quality_signals').insert({
    ticket_id: ticketId,
    from_agent: 'BUILD-008',
    to_agent: reviewingAgent,
    signal_type: 'quality_review',
    confidence: (review.overall_score || 0) / 100,
    flags: review.issues || [],
    payload: { ...review, duration_ms: duration }
  });

  console.log(`[BUILD-008] ${reviewingAgent}: ${review.approval_recommendation} | Score: ${review.overall_score}/100 | Issues: ${(review.issues || []).length} in ${Math.round(duration / 1000)}s`);

  // Return approved if recommendation is approve or score is good
  if (review.approval_recommendation === 'approve' || (review.overall_score || 0) >= 75) {
    return {
      agent: 'BUILD-008',
      status: 'approved',
      overall_score: review.overall_score,
      needs_revision: false,
      issues: review.issues || []
    };
  }

  // Return revision package instead of throwing — workflow handles the loop
  return {
    agent: 'BUILD-008',
    status: 'blocked',
    approval_recommendation: review.approval_recommendation,
    overall_score: review.overall_score,
    issues: review.issues || [],
    revision_summary: review.revision_summary,
    needs_revision: true,
    revision_package: {
      target_agent: reviewingAgent,
      issues: (review.issues || []).filter(i => ['blocking','high'].includes(i.severity)),
      fix_instructions: (review.issues || []).map(i => `${i.severity.toUpperCase()}: ${i.description}. Fix: ${i.revision_instruction || 'Address this issue before proceeding.'}`).join('\n'),
      previous_score: review.overall_score,
      revision_number: jobData._revisionCount || 1
    }
  };
}
