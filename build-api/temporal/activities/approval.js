import { sendFridayTeamsCard } from './teams-notify.js';
import { getGraphToken } from './onedrive.js';

const FRIDAY_BASE = process.env.FRIDAY_PUBLIC_URL || 'http://5.223.79.255:3000';
const CHARLIE_FACTORY_URL = process.env.CHARLIE_FACTORY_URL || 'http://5.223.60.100:3002';
const GRAPH_USER_EMAIL = process.env.GRAPH_USER_EMAIL || 'brian@manageai.io';
const NOTIFY_EMAILS = [process.env.BRIAN_EMAIL, process.env.DAN_EMAIL, process.env.DAVE_EMAIL].filter(Boolean);

export async function emitToFactoryDashboard(customerId, eventData) {
  if (!customerId) return;
  try {
    await fetch(`${CHARLIE_FACTORY_URL}/api/factory/emit/${customerId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(eventData)
    });
  } catch(e) {
    console.log('[FRIDAY] Factory emit non-fatal error:', e.message);
  }
}

// Temporal activity: resolve customerId from client name
export async function resolveCustomerIdActivity(clientName) {
  if (!clientName) return null;
  try {
    const SB_URL = process.env.SUPABASE_URL;
    const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
    const shortName = clientName.split(' ').slice(0, 2).join(' ');
    const r = await fetch(`${SB_URL}/rest/v1/friday_customers?name=ilike.*${encodeURIComponent(shortName)}*&select=id&limit=1`, {
      headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
    });
    const rows = await r.json();
    return rows?.[0]?.id || null;
  } catch(e) {
    console.log('[FRIDAY] resolveCustomerIdActivity non-fatal:', e.message);
    return null;
  }
}

// Temporal activity: resolve customerId from client name then emit event
export async function factoryEmitActivity(clientName, eventData) {
  if (!clientName) return;
  try {
    const SB_URL = process.env.SUPABASE_URL;
    const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
    const shortName = clientName.split(' ').slice(0, 2).join(' ');
    const r = await fetch(`${SB_URL}/rest/v1/friday_customers?name=ilike.*${encodeURIComponent(shortName)}*&select=id&limit=1`, {
      headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
    });
    const rows = await r.json();
    const customerId = rows?.[0]?.id;
    if (customerId) {
      await emitToFactoryDashboard(customerId, eventData);
    }
  } catch(e) {
    console.log('[FRIDAY] factoryEmitActivity non-fatal:', e.message);
  }
}

async function sendEmailNotification(subject, bodyHtml) {
  if (NOTIFY_EMAILS.length === 0) {
    console.warn('[FRIDAY] No notification emails configured, skipping email send');
    return;
  }
  const token = await getGraphToken();
  const url = `https://graph.microsoft.com/v1.0/users/${GRAPH_USER_EMAIL}/sendMail`;
  const payload = {
    message: {
      subject,
      body: { contentType: 'HTML', content: bodyHtml },
      toRecipients: NOTIFY_EMAILS.map(email => ({ emailAddress: { address: email } }))
    },
    saveToSentItems: false
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Graph sendMail failed (' + res.status + '): ' + text.slice(0, 300));
  }
}

export async function humanApprovalGateActivity(jobData) {
  console.log('[FRIDAY] Posting build approval card for:', jobData.ticket_id);

  const qaScore = jobData.qaScore || 0;
  const outputLinks = jobData.outputLinks || [];
  const phase1 = jobData.phase1Results || {};
  const reviewUrl = `${FRIDAY_BASE}/build-review/${jobData.ticket_id}/final`;

  const linksText = outputLinks.length > 0
    ? outputLinks.map(l => (l.name || l.url || l)).join('\n')
    : 'Links available in OneDrive';

  // Send Teams card with review link (gated -- disabled when Factory Floor is primary)
  if (process.env.NOTIFICATIONS_MODE !== 'factory') {
    try {
      await sendFridayTeamsCard({
        ticketId: jobData.ticket_id,
        title: 'Build Ready for Approval',
        summary: `Build complete for ${jobData.project_name || 'Unknown'}. QA Score: ${qaScore}/100`,
        details: `Phase 1 Results:\nSchema: ${phase1.schema?.status || 'completed'}\nWorkflow: ${phase1.workflow?.status || 'completed'}\nPlatform: ${phase1.platform?.status || 'completed'}\nQA Pass Rate: ${phase1.qa?.pass_rate || 0}%\nIteration Cycles: ${phase1.iteration_cycles || 0}\n\nOutput Files:\n${linksText}`,
        actionType: 'build-approval'
      });
    } catch(e) {
      console.warn('[FRIDAY] Teams approval card failed (non-fatal):', e.message);
    }
  }

  // Send email notification with review link (gated -- disabled when Factory Floor is primary)
  if (process.env.NOTIFICATIONS_MODE !== 'factory') {
    try {
      await sendEmailNotification(
        `[FRIDAY] Build Ready for Approval — ${jobData.ticket_id}`,
        `<p style="margin:0 0 20px 0"><a href="${reviewUrl}" style="background:#16a34a;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px">Review &amp; Approve Build</a></p>
<p style="color:#666;font-size:13px;margin:0 0 24px 0">${reviewUrl}</p>
<h2>Build Ready for Approval</h2>
<p><strong>Ticket:</strong> ${jobData.ticket_id}</p>
<p><strong>Project:</strong> ${jobData.project_name || 'Unknown'}</p>
<p><strong>QA Score:</strong> ${qaScore}/100</p>`
      );
      console.log('[FRIDAY] Approval email sent to:', NOTIFY_EMAILS.join(', '));
    } catch(e) {
      console.warn('[FRIDAY] Approval email failed (non-fatal):', e.message);
    }
  }

  // n8n webhook disabled -- not provisioned, replaced by Factory Floor
  // try {
  //   const webhookUrl = (process.env.N8N_LOCAL_URL || 'http://localhost:5678') + '/webhook/wf-approval';
  //   await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify({ ticket_id: jobData.ticket_id, client_name: jobData.client, project_name: jobData.project_name, qa_score: qaScore })
  //   });
  // } catch(e) {}

  // Emit to Factory Floor dashboard
  await emitToFactoryDashboard(jobData.customerId, {
    type: 'build-complete',
    ticketId: jobData.ticket_id,
    customerName: jobData.client || jobData.client_name,
    qaScore,
    fileCount: outputLinks.length,
    reviewUrl: reviewUrl,
    timestamp: new Date().toISOString()
  });

  return { posted: true };
}

export async function phase1ReviewEmailActivity(jobData, phase1Results) {
  console.log('[FRIDAY] Posting Phase 1 review card for:', jobData.ticket_id);

  const reviewUrl = `${FRIDAY_BASE}/build-review/${jobData.ticket_id}/phase1`;

  // Update build status to phase1-review in Supabase
  try {
    const SB_URL = process.env.SUPABASE_URL;
    const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
    if (SB_URL && SB_KEY) {
      await fetch(`${SB_URL}/rest/v1/friday_builds?ticket_id=eq.${jobData.ticket_id}`, {
        method: 'PATCH',
        headers: {
          'apikey': SB_KEY,
          'Authorization': `Bearer ${SB_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ status: 'phase1-review', updated_at: new Date().toISOString() })
      });
      console.log('[FRIDAY] Build status set to phase1-review for:', jobData.ticket_id);
    }
  } catch(e) {
    console.warn('[FRIDAY] Failed to update build status to phase1-review:', e.message);
  }

  // Send Teams card with review link (always fires for phase1-review)
  try {
    await sendFridayTeamsCard({
      ticketId: jobData.ticket_id,
      title: 'Phase 1 Build Complete -- Review Required',
      summary: `Phase 1 complete for ${jobData.project_name || 'Unknown'}. QA: ${phase1Results?.qa?.pass_rate || 0}%`,
      details: `Schema: ${phase1Results?.schema?.status || 'unknown'}\nWorkflows: ${phase1Results?.workflow?.manifest?.total_imported || 0} imported, ${phase1Results?.workflow?.manifest?.total_activated || 0} activated\nLLM Files: ${(phase1Results?.llm?.files_produced || []).join(', ') || 'none'}\nExternal Platforms: ${(phase1Results?.external?.platforms || []).join(', ') || 'none'}\nGitHub Repo: ${phase1Results?.platform?.manifest?.repo_url || 'not created'}\nQA Pass Rate: ${phase1Results?.qa?.pass_rate || 0}%\nIteration Cycles: ${phase1Results?.iteration_cycles || 0}`,
      actionType: 'phase1'
    });
    console.log('[FRIDAY] Teams Phase 1 card sent');
  } catch(e) {
    console.warn('[FRIDAY] Teams Phase 1 card failed (non-fatal):', e.message);
  }

  // Send email notification with review link (always fires for phase1-review)
  try {
    await sendEmailNotification(
      `[FRIDAY] Phase 1 Complete — Review Required — ${jobData.ticket_id}`,
      `<p style="margin:0 0 20px 0"><a href="${reviewUrl}" style="background:#2563eb;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px">Review Phase 1 Build</a></p>
<p style="color:#666;font-size:13px;margin:0 0 24px 0">${reviewUrl}</p>
<h2>Phase 1 Build Complete — Review Required</h2>
<p><strong>Ticket:</strong> ${jobData.ticket_id}</p>
<p><strong>Project:</strong> ${jobData.project_name || 'Unknown'}</p>
<p><strong>QA:</strong> ${phase1Results?.qa?.pass_rate || 0}%</p>`
    );
    console.log('[FRIDAY] Phase 1 review email sent to:', NOTIFY_EMAILS.join(', '));
  } catch(e) {
    console.warn('[FRIDAY] Phase 1 review email failed (non-fatal):', e.message);
  }

  // Emit to Factory Floor dashboard
  const agentCount = ['schema', 'workflow', 'llm', 'external', 'platform', 'qa']
    .filter(k => phase1Results?.[k] && phase1Results[k].status !== 'error').length;
  await emitToFactoryDashboard(jobData.customerId, {
    type: 'build-phase1-ready',
    ticketId: jobData.ticket_id,
    customerName: jobData.client || jobData.client_name,
    qaScore: phase1Results?.qa?.pass_rate || 0,
    agentCount,
    reviewUrl: reviewUrl,
    timestamp: new Date().toISOString()
  });

  return { sent: true };
}
