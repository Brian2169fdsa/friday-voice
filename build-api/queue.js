import { Queue, Worker } from 'bullmq';

const connection = { host: 'localhost', port: 6379 };
const buildQueue = new Queue('friday-builds', { connection });

// Worker processes jobs
const worker = new Worker('friday-builds', async (job) => {
  console.log('[QUEUE] Processing job:', job.data.ticket_id);
  // The actual work happens in server.js runSwarm
  // Queue just tracks job state
  return { processed: true, ticket_id: job.data.ticket_id };
}, { connection, concurrency: 2 });

worker.on('completed', (job) => {
  console.log('[QUEUE] Job completed:', job.data.ticket_id);
});
worker.on('failed', (job, err) => {
  console.error('[QUEUE] Job failed:', job?.data?.ticket_id, err.message);
});

export async function addBuildJob(jobData) {
  const job = await buildQueue.add('build', jobData, {
    attempts: 2,
    backoff: { type: 'fixed', delay: 5000 }
  });
  return job.id;
}

export async function getQueueStats() {
  const [waiting, active, completed, failed] = await Promise.all([
    buildQueue.getWaitingCount(),
    buildQueue.getActiveCount(),
    buildQueue.getCompletedCount(),
    buildQueue.getFailedCount()
  ]);
  return { waiting, active, completed, failed };
}
