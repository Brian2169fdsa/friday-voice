// BUILD-002 child workflow — self-contained with revision loop and quality gate
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

export async function workflowBuilderWorkflow(jobData, contract) {
  let result = null;
  let gateResult = null;
  let revisionCount = 0;
  const MAX_REVISIONS = 3;

  while (revisionCount <= MAX_REVISIONS) {
    try {
      result = await agentActivities.workflowBuilderActivity({
        ...jobData,
        _revisionCount: revisionCount,
        _revisionFeedback: revisionCount > 0 ? gateResult?.revision_package : null
      }, contract);
    } catch(e) {
      result = { agent_id: 'workflow_builder', status: 'error', error: e.message };
    }

    gateResult = await reviewActivities.qualityGateActivity(
      { ...jobData, _revisionCount: revisionCount }, 'BUILD-002', result
    );

    if (!gateResult.needs_revision || revisionCount >= MAX_REVISIONS) {
      if (gateResult.needs_revision && revisionCount >= MAX_REVISIONS) {
        console.log(`[WORKFLOW WF] BUILD-008 max revisions (${MAX_REVISIONS}) reached for BUILD-002 -- proceeding with warnings`);
      }
      break;
    }

    revisionCount++;
    console.log(`[WORKFLOW WF] BUILD-008 revision signal: workflow-builder attempt ${revisionCount}/${MAX_REVISIONS} | score: ${gateResult.overall_score}`);
  }

  return { result, gateResult, revisionCount };
}
