import { ApplicationFailure } from '@temporalio/activity';

const BRIEF_SECTIONS = [
  'executive_summary',
  'business_context',
  'functional_requirements',
  'technical_requirements',
  'integration_requirements',
  'success_criteria',
  'constraints_and_risks'
];

export async function briefValidationActivity(jobData) {
  // If raw ticket format (no brief sections), pass through for backwards compatibility
  if (!jobData.brief && !jobData.sections && !jobData.brief_sections && !jobData.section_a) {
    console.log('[TEMPORAL] Raw ticket format — skipping brief validation');
    return { format: 'raw_ticket', valid: true };
  }

  // Support Charlie's section_a/section_b format
  const brief = jobData.brief || jobData.brief_sections || jobData;
  const sectionA = brief.section_a || brief.sections || brief;

  // If Charlie format detected, map section_a fields to expected format
  if (brief.section_a || jobData.section_a) {
    const sa = brief.section_a || jobData.section_a;
    const requiredFields = ['client_profile', 'current_state', 'prototype_scope', 'success_metrics', 'workforce_vision', 'technical_constraints', 'opportunity_assessment'];
    const gaps = [];
    for (const field of requiredFields) {
      if (!sa[field] || !sa[field].content) {
        gaps.push({ section: field, reason: 'Missing entirely' });
      }
    }
    if (gaps.length > 0) {
      const gapDetails = gaps.map(g => g.section + ': ' + g.reason).join('; ');
      throw ApplicationFailure.nonRetryable('Brief validation failed — incomplete sections: ' + gapDetails, 'BRIEF_INCOMPLETE', { gaps });
    }
    console.log('[TEMPORAL] Brief validation passed — Charlie section_a format, all 7 sections complete');
    return { format: 'charlie_brief', valid: true, sections: 7 };
  }

  const sections = sectionA;
  const gaps = [];

  for (const section of BRIEF_SECTIONS) {
    const sectionData = sections[section];
    if (!sectionData) {
      gaps.push({ section, reason: 'Missing entirely' });
      continue;
    }
    const confidence = sectionData.confidence_score || sectionData.confidence;
    if (confidence && confidence !== 'Complete' && confidence !== 'complete') {
      gaps.push({
        section,
        reason: 'Incomplete — confidence: ' + confidence,
        details: sectionData.gaps || sectionData.missing || null
      });
    }
  }

  if (gaps.length > 0) {
    const gapDetails = gaps.map(g => g.section + ': ' + g.reason + (g.details ? ' (' + g.details + ')' : '')).join('; ');
    console.error('[TEMPORAL] Brief validation failed:', gapDetails);
    throw ApplicationFailure.nonRetryable(
      'Brief validation failed — incomplete sections: ' + gapDetails,
      'BRIEF_INCOMPLETE',
      { gaps }
    );
  }

  console.log('[TEMPORAL] Brief validation passed — all 7 sections complete');
  return { format: 'brief', valid: true, sections: BRIEF_SECTIONS.length };
}
