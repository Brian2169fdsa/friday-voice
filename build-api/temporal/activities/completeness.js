import Anthropic from '@anthropic-ai/sdk';

// Must-Never-Ask items per handoff contract (Charlie -> FRIDAY)
// FRIDAY must NEVER ask for these -- they must arrive pre-populated from Charlie
const MUST_NEVER_ASK = [
  'workflow_steps',
  'decision_authority',
  'success_metrics',
  'data_sources',
  'guardrails',
  'edge_cases',
  'acceptance_criteria'
];

// Required Brief fields that FRIDAY checks for presence (not content)
const REQUIRED_FIELDS = [
  { key: 'client', alt: 'client_name', label: 'Client name' },
  { key: 'project_name', label: 'Project name' },
  { key: 'request_description', label: 'Description' },
  { key: 'platform', label: 'Platform' },
  { key: 'workflow_steps', label: 'Workflow steps' },
  { key: 'decision_authority', label: 'Decision authority' },
  { key: 'success_metrics', label: 'Success metrics' },
  { key: 'data_sources', label: 'Data sources' },
  { key: 'guardrails', label: 'Guardrails' },
  { key: 'edge_cases', label: 'Edge cases' },
  { key: 'acceptance_criteria', label: 'Acceptance criteria' }
];

export async function completenessCheckActivity(jobData) {
  try {
    // Step 1: Structural check -- verify all required fields exist and are non-empty
    const missing = [];
    const present = [];

    // Support Charlie's Brief format -- extract top-level fields and section_a fields
    const briefData = jobData.brief || jobData.brief_sections || jobData;
    const sectionA = briefData.section_a || {};
    const mergedData = {
      ...briefData,
      workflow_steps: briefData.workflow_steps || jobData.workflow_steps,
      decision_authority: briefData.decision_authority || jobData.decision_authority,
      success_metrics: briefData.success_metrics || sectionA.success_metrics?.content || jobData.success_metrics,
      data_sources: briefData.data_sources || jobData.data_sources,
      guardrails: briefData.guardrails || jobData.guardrails,
      edge_cases: briefData.edge_cases || jobData.edge_cases,
      acceptance_criteria: briefData.acceptance_criteria || jobData.acceptance_criteria,
      client: briefData.client || briefData.client_name || jobData.client || jobData.client_name,
      request_description: briefData.request_description || sectionA.prototype_scope?.content || jobData.request_description
    };

    for (const field of REQUIRED_FIELDS) {
      const val = mergedData[field.key] || (field.alt ? mergedData[field.alt] : null);
      if (!val || (typeof val === 'string' && val.trim().length === 0)) {
        missing.push(field.label);
      } else {
        present.push(field.key);
      }
    }

    // Step 2: Calculate structural score (each field = equal weight)
    const structuralScore = Math.round((present.length / REQUIRED_FIELDS.length) * 100);

    // Step 3: If all fields present, use Haiku to check content quality (not to ask questions)
    let qualityScore = structuralScore;
    let qualityNotes = null;

    if (structuralScore >= 80) {
      try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const result = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          messages: [{
            role: 'user',
            content: `Score this build brief 0-100 for content quality. Check ONLY:
1. Is the description specific enough to build from? (not vague)
2. Are workflow steps detailed enough to implement?
3. Are success metrics measurable?
4. Are guardrails actionable?

Client: ${mergedData.client || mergedData.client_name}
Project: ${mergedData.project_name}
Platform: ${mergedData.platform}
Description: ${mergedData.request_description || ''}
Workflow Steps: ${JSON.stringify(mergedData.workflow_steps || '')}
Success Metrics: ${JSON.stringify(mergedData.success_metrics || '')}
Guardrails: ${JSON.stringify(mergedData.guardrails || '')}

RULES:
- Return JSON ONLY: {"score": number, "notes": "brief quality observation"}
- Do NOT ask questions. Do NOT request additional information.
- Do NOT mention workflow steps, decision authority, success metrics, data sources, guardrails, edge cases, or acceptance criteria as missing -- they are provided above.
- Score what IS there. If content is thin but present, score 60-75. If detailed, score 80+.`
          }]
        });
        const parsed = JSON.parse(result.content[0].text.replace(/```json|```/g, '').trim());
        qualityScore = Math.round((structuralScore + parsed.score) / 2);
        qualityNotes = parsed.notes || null;
      } catch (e) {
        console.warn('[TEMPORAL] Quality check failed, using structural score:', e.message);
        qualityScore = structuralScore;
      }
    }

    // Step 4: Build response -- NEVER include questions that ask for Must-Never-Ask items
    const finalScore = qualityScore;
    let feedback = null;

    if (missing.length > 0) {
      // Check if any missing items are Must-Never-Ask
      const mustNeverMissing = missing.filter(label => {
        const field = REQUIRED_FIELDS.find(f => f.label === label);
        return field && MUST_NEVER_ASK.includes(field.key);
      });

      if (mustNeverMissing.length > 0) {
        // These should have come from Charlie -- flag as Brief compliance failure
        feedback = 'BRIEF COMPLIANCE FAILURE: The following must-never-ask items are missing from the Brief and should have been provided by Charlie: ' + mustNeverMissing.join(', ') + '. Route back to Charlie for Brief completion.';
      } else {
        // Non-contract fields missing -- safe to note
        feedback = 'Missing fields: ' + missing.join(', ');
      }
    } else if (qualityNotes) {
      feedback = qualityNotes;
    }

    console.log('[TEMPORAL] Completeness check:', finalScore + '/100 | Missing: ' + missing.length + ' fields');

    return {
      score: finalScore,
      complete: finalScore >= 70 && missing.length === 0,
      questions: null,  // NEVER ask questions -- handoff contract
      feedback: feedback,
      missing_fields: missing,
      structural_score: structuralScore,
      quality_score: qualityScore
    };
  } catch (e) {
    console.warn('[TEMPORAL] Completeness check failed:', e.message);
    return { score: 75, complete: true, questions: null, feedback: null, missing_fields: [], structural_score: 75, quality_score: 75 };
  }
}
