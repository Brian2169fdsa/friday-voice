/**
 * FRIDAY Deep Build Worker
 * Runs on separate task queue: friday-deep-builds
 * Handles long-running code generation builds (2-8 hours)
 * Does NOT interact with fast queue (friday-builds)
 */

import { Worker, NativeConnection } from '@temporalio/worker';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';

// Load env from ecosystem
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

// Import deep build activities
import * as nodeServiceDev from './activities/deep/node-service-dev.js';
import * as pythonDev from './activities/deep/python-dev.js';
import * as frontendDev from './activities/deep/frontend-dev.js';
import * as browserAutomationDev from './activities/deep/browser-automation-dev.js';
import * as voiceAgentDev from './activities/deep/voice-agent-dev.js';
import * as deepShared from './activities/deep/deep-shared.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS || 'localhost:7233'
  });

  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: 'friday-deep-builds',
    workflowsPath: path.join(__dirname, 'workflows/deep-build.js'),
    activities: {
      ...nodeServiceDev,
      ...pythonDev,
      ...frontendDev,
      ...browserAutomationDev,
      ...voiceAgentDev,
      ...deepShared
    },
    maxConcurrentActivityTaskExecutions: 4,
    maxConcurrentWorkflowTaskExecutions: 2
  });

  console.log('FRIDAY Deep Build Worker started — task queue: friday-deep-builds');
  await worker.run();
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('[DEEP-WORKER] SIGINT received — shutting down gracefully');
  process.exit(0);
});

run().catch(err => {
  console.error('[DEEP-WORKER] Fatal error:', err);
  process.exit(1);
});
