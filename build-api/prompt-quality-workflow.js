import { proxyActivities } from '@temporalio/workflow';

const { promptQualityAssessmentActivity } = proxyActivities({
  startToCloseTimeout: '30 minutes',
});

export async function promptQualityWorkflow(options = {}) {
  return await promptQualityAssessmentActivity(options);
}
