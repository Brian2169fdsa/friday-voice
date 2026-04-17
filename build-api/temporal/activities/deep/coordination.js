/**
 * Coordination helpers for deep build agents
 * Shared utilities for inter-agent state, context, and messaging
 */

import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

/**
 * Publish this agent's current state so siblings can read it
 */
export async function publishState(stateData) {
  try {
    const supabase = getSupabase();
    await supabase.from('deep_build_sibling_state').upsert({
      parent_ticket_id: stateData.parent_ticket_id,
      child_ticket_id: stateData.child_ticket_id,
      agent_id: stateData.agent_id,
      deep_build_type: stateData.deep_build_type,
      phase: stateData.phase,
      progress_percent: stateData.progress_percent || 0,
      exposed_artifacts: stateData.exposed_artifacts || null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'child_ticket_id' });
  } catch (e) {
    // Non-blocking — coordination failures must not stop builds
    console.warn(`[COORDINATION] publishState failed:`, e.message);
  }
}

/**
 * Build a context string from sibling agents for use in Claude Code prompts
 */
export async function buildSiblingContext(parentTicketId, selfAgentId) {
  if (!parentTicketId) return '';

  try {
    const supabase = getSupabase();

    // Get sibling states
    const { data: siblings } = await supabase
      .from('deep_build_sibling_state')
      .select('*')
      .eq('parent_ticket_id', parentTicketId)
      .neq('agent_id', selfAgentId);

    // Get coordination contract
    const { data: contract } = await supabase
      .from('build_contracts')
      .select('*')
      .eq('ticket_id', parentTicketId)
      .single();

    // Get fast-queue plan
    const { data: fastBuildData } = await supabase
      .from('friday_builds')
      .select('ticket_id, project_name, client, brief_summary')
      .eq('ticket_id', parentTicketId)
      .single();

    if (!siblings?.length && !contract) return '';

    const lines = [
      '',
      '---',
      '# SIBLING COORDINATION CONTEXT',
      `# Parent build: ${parentTicketId}`,
      ''
    ];

    if (fastBuildData) {
      lines.push(`## Fast Queue Build (n8n workflows)`);
      lines.push(`- Ticket: ${fastBuildData.ticket_id}`);
      lines.push(`- Project: ${fastBuildData.project_name}`);
      if (fastBuildData.brief_summary) {
        lines.push(`- Summary: ${fastBuildData.brief_summary}`);
      }
      lines.push('');
    }

    if (siblings?.length) {
      lines.push(`## Sibling Deep Builds (${siblings.length} total)`);
      for (const sib of siblings) {
        lines.push(`\n### ${sib.agent_id} — ${sib.deep_build_type}`);
        lines.push(`- Phase: ${sib.phase} (${sib.progress_percent}%)`);
        if (sib.exposed_artifacts) {
          lines.push(`- Exposed artifacts:`);
          const arts = sib.exposed_artifacts;
          if (arts.webhook_endpoints) lines.push(`  - Webhooks: ${arts.webhook_endpoints.join(', ')}`);
          if (arts.api_endpoints) lines.push(`  - APIs: ${arts.api_endpoints.join(', ')}`);
          if (arts.supabase_tables_written) lines.push(`  - Supabase tables: ${arts.supabase_tables_written.join(', ')}`);
          if (arts.components_exported) lines.push(`  - Components: ${arts.components_exported.join(', ')}`);
        }
      }
      lines.push('');
    }

    if (contract) {
      lines.push(`## Coordination Contract`);
      if (contract.shared_supabase_schema) {
        lines.push(`- Shared Supabase tables: ${JSON.stringify(contract.shared_supabase_schema).slice(0, 500)}`);
      }
      if (contract.shared_auth) {
        lines.push(`- Auth approach: ${contract.shared_auth}`);
      }
      if (contract.api_gateway_url) {
        lines.push(`- API gateway: ${contract.api_gateway_url}`);
      }
      lines.push('');
    }

    lines.push('## YOUR COORDINATION OBLIGATIONS');
    lines.push('- Use the same Supabase table names as siblings if they write to related tables');
    lines.push('- Use the shared auth model (JWT, API key, or OAuth) if present in contract');
    lines.push('- Expose your endpoints clearly so siblings can integrate with you');
    lines.push('- Do NOT hardcode sibling URLs — use env vars');
    lines.push('---');
    lines.push('');

    return lines.join('\n');
  } catch (e) {
    console.warn(`[COORDINATION] buildSiblingContext failed:`, e.message);
    return '';
  }
}

/**
 * Send a message to another agent in this build group
 */
export async function sendAgentMessage(fromAgent, toAgent, parentTicketId, messageType, content) {
  try {
    const supabase = getSupabase();
    await supabase.from('build_agent_messages').insert({
      ticket_id: parentTicketId,
      from_agent: fromAgent,
      to_agent: toAgent,
      message_type: messageType,
      content: content
    });
  } catch (e) {
    console.warn(`[COORDINATION] sendAgentMessage failed:`, e.message);
  }
}

/**
 * Wait for a response from another agent (polling, max retries)
 * Returns null if no response within timeout
 */
export async function waitForResponse(parentTicketId, fromAgent, messageType, maxWaitMs = 300000) {
  const supabase = getSupabase();
  const pollInterval = 15000;
  const maxPolls = Math.ceil(maxWaitMs / pollInterval);

  for (let i = 0; i < maxPolls; i++) {
    try {
      const { data } = await supabase
        .from('build_agent_messages')
        .select('*')
        .eq('ticket_id', parentTicketId)
        .eq('from_agent', fromAgent)
        .eq('message_type', messageType)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (data) return data;
    } catch (_) {}

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  return null;
}
