/**
 * Deep Build Workflow
 * Routes to the right language agent based on brief.platform
 */

import { proxyActivities, defineSignal, setHandler, condition } from '@temporalio/workflow';

const longActivities = proxyActivities({
  startToCloseTimeout: '2 hours',
  heartbeatTimeout: '20 minutes',
  retry: { maximumAttempts: 2, initialInterval: '10s' }
});

const mediumActivities = proxyActivities({
  startToCloseTimeout: '10 minutes',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 3 }
});

export const cancelDeepBuildSignal = defineSignal('cancel-deep-build');

export async function DeepBuildWorkflow(jobData) {
  let cancelled = false;
  setHandler(cancelDeepBuildSignal, () => { cancelled = true; });

  const ticketId = jobData.ticket_id;
  const language = jobData.deep_build_type; // 'node-service' | 'python' | 'frontend'

  console.log(`[DEEP-WF(${ticketId})] Starting deep build: ${language}`);

  // Initialize build directory
  await mediumActivities.initDeepBuildDirActivity(jobData);

  let result;
  switch (language) {
    case 'node-service':
      result = await longActivities.buildNodeServiceActivity(jobData);
      break;
    case 'python':
      result = await longActivities.buildPythonActivity(jobData);
      break;
    case 'frontend':
      result = await longActivities.buildFrontendActivity(jobData);
      break;
    case 'browser_automation':
    case 'browser-automation':
      result = await longActivities.buildBrowserAutomationActivity(jobData);
      break;
    case 'voice_agent':
    case 'voice-agent':
      result = await longActivities.buildVoiceAgentActivity(jobData);
      break;
    default:
      throw new Error(`Unknown deep build type: ${language}`);
  }

  if (cancelled) {
    return { status: 'cancelled', ticketId };
  }

  // Push to GitHub
  const repo = await mediumActivities.deepGitHubPushActivity(jobData, result);

  // Notify completion
  await mediumActivities.deepCompletionNotifyActivity(jobData, { ...result, repo });

  return { status: 'complete', ticketId, ...result, repo };
}
