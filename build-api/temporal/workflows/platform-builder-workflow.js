// BUILD-005 child workflow — self-contained with revision loop and quality gate
// Sprint 2: runs as independent Temporal child workflow for visibility + durability
import { proxyActivities } from '@temporalio/workflow';

const agentActivities = proxyActivities({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 2 }
});

const reviewActivities = proxyActivities({
  startToCloseTimeout: '120 seconds',
  retry: { maximumAttempts: 1 }
});

export async function platformBuilderWorkflow(jobData, contract, buildOutputs) {
  let result = null;
  let gateResult = null;
  let revisionCount = 0;
  const MAX_REVISIONS = 3;

  while (revisionCount <= MAX_REVISIONS) {
    try {
      result = await agentActivities.platformBuilderActivity({
        ...jobData,
        _revisionCount: revisionCount,
        _revisionFeedback: revisionCount > 0 ? gateResult?.revision_package : null,
        _buildOutputs: buildOutputs
      }, contract, buildOutputs);
    } catch(e) {
      result = { agent_id: 'platform_builder', status: 'error', error: e.message };
    }

    gateResult = await reviewActivities.qualityGateActivity(
      { ...jobData, _revisionCount: revisionCount }, 'BUILD-005', result
    );

    if (!gateResult.needs_revision || revisionCount >= MAX_REVISIONS) {
      if (gateResult.needs_revision && revisionCount >= MAX_REVISIONS) {
        console.log(`[PLATFORM WF] BUILD-008 max revisions (${MAX_REVISIONS}) reached for BUILD-005 -- proceeding with warnings`);
      }
      break;
    }

    revisionCount++;
    console.log(`[PLATFORM WF] BUILD-008 revision signal: platform-builder attempt ${revisionCount}/${MAX_REVISIONS} | score: ${gateResult.overall_score}`);
  }

  return { result, gateResult, revisionCount };
}
