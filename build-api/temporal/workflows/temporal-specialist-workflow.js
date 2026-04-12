// BUILD-014 child workflow — deploys isolated Temporal environment for client
import { proxyActivities } from '@temporalio/workflow';

const agentActivities = proxyActivities({
  startToCloseTimeout: '30 minutes',
  retry: { maximumAttempts: 1 }
});

export async function temporalSpecialistWorkflow(jobData, contract) {
  let result = null;
  try {
    result = await agentActivities.temporalSpecialistActivity(jobData, contract);
  } catch(e) {
    result = { agent_id: 'BUILD-014', status: 'error', error: e.message.slice(0, 300) };
  }
  return result;
}
