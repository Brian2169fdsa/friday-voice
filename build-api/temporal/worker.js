import { NativeConnection, Worker } from '@temporalio/worker';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  const connection = await NativeConnection.connect({ address: 'localhost:7233' });

  const worker = await Worker.create({
    connection,
    // Points directly to friday-build.js; that file re-exports all 4 child workflows at its
    // bottom, so Temporal's bundler picks them all up through this single entry point.
    workflowsPath: new URL('./workflows/friday-build.js', import.meta.url).pathname,
    activities: {
      ...(await import('./activities/completeness.js')),
      ...(await import('./activities/planner.js')),
      ...(await import('./activities/agents.js')),
      ...(await import('./activities/qa.js')),
      ...(await import('./activities/onedrive.js')),
      ...(await import('./activities/n8n-import.js')),
      ...(await import('./activities/workflow-builder.js')),
      ...(await import('./activities/approval.js')),
      ...(await import('./activities/pipeline.js')),
      ...(await import('./activities/brief-validation.js')),
      ...(await import('./activities/schema-architect.js')),
      ...(await import('./activities/platform-builder.js')),
    ...(await import('./activities/llm-specialist.js')),
    ...(await import('./activities/external-platform.js')),
      ...(await import('./activities/brief-analyst.js')),
      ...(await import('./activities/qa-tester.js')),
      ...(await import('./activities/verification.js')),
      ...(await import('./activities/quality-gate.js')),
      ...(await import('./activities/compliance-judge.js')),
      ...(await import('./activities/engagement-memory.js')),
      ...(await import('./activities/security-agent.js')),
      ...(await import('./activities/deployment-verifier.js')),
      ...(await import('./activities/decision-agent.js')),
      ...(await import('./activities/temporal-specialist.js')),
      ...(await import('./activities/prompt-quality-agent.js')),
      ...(await import('./activities/teams-notify.js')),
      ...(await import('./activities/build-status.js')),
      ...(await import('./activities/red-team-agent.js')),
      ...(await import('./activities/intelligence-agent.js')),
      ...(await import('./activities/skillset-registry.js')),
      ...(await import('./activities/self-deploy.js')),
      ...(await import('./activities/cleanup.js')),
      ...(await import('./activities/agent-bus.js')),
      ...(await import('./activities/adherence-agent.js')),
      ...(await import('./activities/fix-coordinator.js')),
      ...(await import('./activities/golden-build.js')),
      ...(await import('./activities/prompt-versioning.js')),
      ...(await import('./activities/test-fixtures.js')),
      ...(await import('./activities/agent-performance.js')),
      ...(await import('./activities/build-diff.js')),
      ...(await import('./activities/cross-build-learning.js')),
      ...(await import('./activities/build-predictor.js')),
      ...(await import('./activities/prompt-improver.js')),
      ...(await import('./activities/usage-monitor.js')),
      ...(await import('./activities/cost-optimizer.js')),
      ...(await import('./activities/prediction-compare.js')),
      ...(await import('./activities/second-opinion.js')),
      ...(await import('./activities/code-review.js')),
      ...(await import('./activities/failure-notify.js')),
      ...(await import('./activities/doc-comparison.js')),
    },
    taskQueue: 'friday-builds',
    maxConcurrentActivityTaskExecutions: 10,
  });

  process.on('SIGTERM', () => {
    console.log('[WORKER] SIGTERM received — shutting down gracefully');
    worker.shutdown();
  });
  process.on('SIGINT', () => {
    console.log('[WORKER] SIGINT received — shutting down gracefully');
    worker.shutdown();
  });

  console.log('FRIDAY Temporal worker started — task queue: friday-builds');
  await worker.run();
}

run().catch(err => {
  console.error('FRIDAY Temporal worker error:', err.message);
  process.exit(1);
});
