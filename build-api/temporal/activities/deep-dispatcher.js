/**
 * Deep Build Dispatcher
 * Runs on fast queue. Triggers deep queue workflows based on routing plan.
 * Returns ticket IDs of spawned deep builds so main workflow can track them.
 */

import { Client, Connection } from '@temporalio/client';
import { createClient } from '@supabase/supabase-js';

export async function dispatchDeepBuildsActivity(parentJobData, routingPlan) {
  const parentTicketId = parentJobData.ticket_id || parentJobData.ticketId;
  console.log(`[DISPATCHER] Dispatching deep builds for parent ${parentTicketId}`);

  const deepDispatches = (routingPlan.dispatches || []).filter(
    d => d.queue === 'friday-deep-builds'
  );

  if (deepDispatches.length === 0) {
    console.log(`[DISPATCHER] No deep builds to dispatch`);
    return { spawned: [], skipped: 0 };
  }

  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS || 'localhost:7233'
  });
  const client = new Client({ connection });
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const spawned = [];

  for (const dispatch of deepDispatches) {
    const deepTicketId = `${parentTicketId}-DEEP-${dispatch.type.toUpperCase()}-${Date.now()}`;

    const deepJobData = {
      ticket_id: deepTicketId,
      parent_ticket_id: parentTicketId,
      deep_build_type: mapTypeToDeepBuildType(dispatch.type),
      project_name: `${parentJobData.project_name} — ${dispatch.type}`,
      client: parentJobData.client,
      agent_owner_email: parentJobData.agent_owner_email,
      role: dispatch.role || 'sub-build',
      reason: dispatch.reason,
      parent_brief: parentJobData
    };

    // Track in Supabase
    try {
      await supabase.from('friday_deep_builds').insert({
        ticket_id: deepTicketId,
        parent_ticket_id: parentTicketId,
        deep_build_type: deepJobData.deep_build_type,
        project_name: deepJobData.project_name,
        client: deepJobData.client,
        agent_owner_email: deepJobData.agent_owner_email,
        brief: deepJobData,
        status: 'queued'
      });
    } catch (e) {
      console.warn(`[DISPATCHER] Failed to log deep build:`, e.message);
    }

    // Start the deep workflow
    try {
      await client.workflow.start('DeepBuildWorkflow', {
        taskQueue: 'friday-deep-builds',
        workflowId: deepTicketId,
        args: [deepJobData]
      });

      spawned.push({
        ticket_id: deepTicketId,
        type: dispatch.type,
        role: dispatch.role,
        builder: dispatch.builder
      });

      console.log(`[DISPATCHER] Spawned ${dispatch.type} deep build: ${deepTicketId}`);
    } catch (e) {
      console.error(`[DISPATCHER] Failed to spawn ${dispatch.type}:`, e.message);
    }
  }

  return { spawned, skipped: 0 };
}

function mapTypeToDeepBuildType(routerType) {
  const map = {
    'custom_service': 'node-service',
    'data_pipeline': 'python',
    'frontend_app': 'frontend',
    'browser_automation': 'browser_automation',
    'browser-automation': 'browser_automation'
  };
  return map[routerType] || 'node-service';
}

/**
 * Poll deep builds for completion status
 * Returns summary of all spawned deep builds
 */
export async function checkDeepBuildsStatusActivity(spawnedBuilds) {
  if (!spawnedBuilds || spawnedBuilds.length === 0) {
    return { all_complete: true, statuses: [] };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const statuses = [];

  for (const build of spawnedBuilds) {
    try {
      const { data } = await supabase
        .from('friday_deep_builds')
        .select('ticket_id, status, repo_url, duration_seconds, file_count')
        .eq('ticket_id', build.ticket_id)
        .single();

      statuses.push({
        ...build,
        status: data?.status || 'unknown',
        repo_url: data?.repo_url,
        file_count: data?.file_count,
        duration_seconds: data?.duration_seconds
      });
    } catch (_) {
      statuses.push({ ...build, status: 'error' });
    }
  }

  const allComplete = statuses.every(s =>
    s.status === 'complete' || s.status === 'failed' || s.status === 'cancelled'
  );

  return { all_complete: allComplete, statuses };
}
