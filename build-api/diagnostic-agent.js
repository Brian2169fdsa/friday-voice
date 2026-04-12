/**
 * BUILD-013: Diagnostic Agent
 * Standalone PM2 process — monitors system health every 15 minutes,
 * writes infrastructure/process findings to build_intelligence table.
 */
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const DIAG_INTERVAL_MS = 15 * 60 * 1000;
const DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1 hour dedup window for infra alerts
const FRIDAY_BASE = process.env.FRIDAY_PUBLIC_URL || 'http://5.223.79.255:3000';
const N8N_LOCAL_URL = process.env.N8N_LOCAL_URL || 'http://localhost:5678';
const N8N_LOCAL_API_KEY = process.env.N8N_LOCAL_API_KEY;
const PM2_RESTART_THRESHOLD = 3; // alert if any process restarted this many times since last check

// ── State ─────────────────────────────────────────────────────────────────────

const lastKnownRestarts = {}; // process name → restart count at last check

// ── Helpers ───────────────────────────────────────────────────────────────────

async function recordDiagnostic(data) {
  try {
    const { data: existing } = await supabase
      .from('build_intelligence')
      .select('id')
      .eq('category', data.category)
      .eq('title', data.title)
      .eq('status', 'pending')
      .gte('created_at', new Date(Date.now() - DEDUP_WINDOW_MS).toISOString())
      .maybeSingle();
    if (existing) return;

    await supabase.from('build_intelligence').insert({
      source: 'diagnostic',
      status: 'pending',
      risk_level: 'medium',
      ...data
    });
    console.log(`[DIAG] Finding recorded: ${data.title}`);
  } catch(e) {
    console.error('[DIAG] recordDiagnostic error:', e.message);
  }
}

// ── Build-failure intercept (called as Temporal activity) ─────────────────────

export async function diagnoseAndHeal(ticketId, agentName, errorMessage, errorType) {
  try {
    await recordDiagnostic({
      source: 'build-failure',
      category: 'build_pipeline',
      title: `${agentName} failed on ${ticketId || 'unknown'}: ${(errorType || 'Unknown').slice(0, 80)}`,
      description: `Agent ${agentName} threw during build for ticket ${ticketId}. ` +
        `Error type: ${errorType || 'Unknown'}. Message: ${(errorMessage || '').slice(0, 400)}`,
      affected_agent: agentName,
      risk_level: 'high',
      relevance_score: 90,
      estimated_effort: 'Immediate — review build logs and retry or escalate to Brian'
    });
    return { recorded: true, agentName, ticketId, errorType };
  } catch(e) {
    return { recorded: false, error: e.message };
  }
}

// ── Checks ────────────────────────────────────────────────────────────────────

async function checkTemporalHealth() {
  try {
    const res = await fetch('http://localhost:7233/api/v1/namespaces/default', {
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      await recordDiagnostic({
        category: 'infrastructure_health',
        title: `Temporal API unhealthy (HTTP ${res.status})`,
        description: `Temporal server returned HTTP ${res.status} on namespace check. Build workflows may fail to start.`,
        affected_agent: 'friday-worker',
        risk_level: 'high',
        relevance_score: 90,
        estimated_effort: 'Immediate — check Temporal server logs and restart if needed'
      });
    }
  } catch(e) {
    await recordDiagnostic({
      category: 'infrastructure_health',
      title: `Temporal API unreachable: ${e.message.slice(0, 60)}`,
      description: `Cannot connect to Temporal on localhost:7233. All new builds will fail until resolved. Error: ${e.message}`,
      affected_agent: 'friday-worker',
      risk_level: 'high',
      relevance_score: 95,
      estimated_effort: 'Immediate — restart Temporal server'
    });
  }
}

async function checkBuildApiHealth() {
  try {
    const res = await fetch(`${FRIDAY_BASE}/health`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      await recordDiagnostic({
        category: 'infrastructure_health',
        title: `Build API unhealthy (HTTP ${res.status})`,
        description: `FRIDAY Build API /health returned HTTP ${res.status}. New build requests may not be accepted.`,
        affected_agent: 'manageai-build-api',
        risk_level: 'high',
        relevance_score: 85,
        estimated_effort: 'Immediate — check PM2 process and server logs'
      });
    }
  } catch(e) {
    console.warn('[DIAG] Build API health check failed (may be normal during startup):', e.message.slice(0, 60));
  }
}

async function checkPm2ProcessHealth() {
  try {
    const raw = execSync('pm2 jlist 2>/dev/null', { timeout: 8000 }).toString().trim();
    if (!raw) return;
    const processes = JSON.parse(raw);

    for (const proc of processes) {
      const name = proc.name;
      const status = proc.pm2_env?.status;
      const restarts = proc.pm2_env?.restart_time || 0;

      // Check for stopped/errored processes
      if (status === 'stopped' || status === 'errored') {
        await recordDiagnostic({
          category: 'process_stability',
          title: `PM2 process "${name}" is ${status}`,
          description: `PM2 reports process "${name}" in state: ${status}. Restart count: ${restarts}.`,
          affected_agent: name,
          risk_level: name.includes('worker') || name.includes('build-api') ? 'high' : 'medium',
          relevance_score: 80,
          estimated_effort: 'Immediate — run: pm2 restart ' + name
        });
      }

      // Check for restart spikes since last check
      const prevRestarts = lastKnownRestarts[name] ?? restarts;
      const newRestarts = restarts - prevRestarts;
      if (newRestarts >= PM2_RESTART_THRESHOLD) {
        await recordDiagnostic({
          category: 'process_stability',
          title: `PM2 process "${name}" restarted ${newRestarts}x since last check`,
          description: `"${name}" has restarted ${newRestarts} times in the last 15 minutes. Total lifetime restarts: ${restarts}. Likely crash-looping — check logs.`,
          affected_agent: name,
          risk_level: 'high',
          relevance_score: 85,
          estimated_effort: 'Immediate — run: pm2 logs ' + name + ' --lines 50 to diagnose'
        });
      }
      lastKnownRestarts[name] = restarts;
    }
  } catch(e) {
    console.warn('[DIAG] PM2 check failed:', e.message.slice(0, 80));
  }
}

async function checkN8nHealth() {
  if (!N8N_LOCAL_API_KEY) return;
  try {
    const res = await fetch(`${N8N_LOCAL_URL}/api/v1/workflows?limit=10`, {
      headers: { 'X-N8N-API-KEY': N8N_LOCAL_API_KEY },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) {
      await recordDiagnostic({
        category: 'infrastructure_health',
        title: `n8n API unhealthy (HTTP ${res.status})`,
        description: `n8n returned HTTP ${res.status}. Workflow imports and BUILD-002 automation will fail.`,
        affected_agent: 'BUILD-002',
        risk_level: 'medium',
        relevance_score: 65,
        estimated_effort: '30 min — check n8n process and database'
      });
    }
  } catch(e) {
    await recordDiagnostic({
      category: 'infrastructure_health',
      title: `n8n unreachable: ${e.message.slice(0, 60)}`,
      description: `n8n at ${N8N_LOCAL_URL} is not responding. BUILD-002 workflow imports will fail for all new builds.`,
      affected_agent: 'BUILD-002',
      risk_level: 'medium',
      relevance_score: 70,
      estimated_effort: '30 min — restart n8n and check database integrity'
    });
  }
}

async function checkSupabaseHealth() {
  try {
    const start = Date.now();
    const { error } = await supabase
      .from('friday_builds')
      .select('id', { count: 'exact', head: true });
    const latency = Date.now() - start;

    if (error) {
      await recordDiagnostic({
        category: 'infrastructure_health',
        title: `Supabase query error: ${error.message.slice(0, 80)}`,
        description: `Supabase returned an error on health check query. All agents writing to Supabase may be failing silently.`,
        affected_agent: '',
        risk_level: 'high',
        relevance_score: 88,
        estimated_effort: 'Immediate — check Supabase project status and RLS policies'
      });
    } else if (latency > 5000) {
      await recordDiagnostic({
        category: 'infrastructure_health',
        title: `Supabase latency high: ${latency}ms`,
        description: `Supabase query took ${latency}ms. Slow responses will slow all agents and may cause build timeouts.`,
        affected_agent: '',
        risk_level: 'medium',
        relevance_score: 55,
        estimated_effort: '1 hour — check Supabase project metrics and active connections'
      });
    }
  } catch(e) {
    console.warn('[DIAG] Supabase health check error:', e.message.slice(0, 80));
  }
}

async function checkBuildQueueDepth() {
  try {
    const { data: inProgress, error } = await supabase
      .from('friday_builds')
      .select('id, ticket_id, client_name, created_at')
      .in('status', ['in_progress', 'running', 'pending'])
      .order('created_at', { ascending: true });

    if (error || !inProgress) return;

    // Flag builds stuck for more than 3 hours
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const stuckBuilds = inProgress.filter(b => b.created_at < threeHoursAgo);

    if (stuckBuilds.length > 0) {
      const stuckList = stuckBuilds.map(b => `${b.client_name || 'unknown'} (${b.ticket_id})`).join(', ');
      await recordDiagnostic({
        category: 'build_pipeline',
        title: `${stuckBuilds.length} build(s) stuck >3 hours: ${stuckList.slice(0, 100)}`,
        description: `${stuckBuilds.length} builds have been in progress for over 3 hours. May indicate a workflow waiting for a signal, a hung activity, or a Temporal timeout. Tickets: ${stuckList}`,
        affected_agent: 'friday-worker',
        risk_level: stuckBuilds.length >= 2 ? 'high' : 'medium',
        relevance_score: 75,
        estimated_effort: 'Immediate — check Temporal UI for stuck workflows and signal if needed'
      });
    }

    // Flag large queue
    if (inProgress.length >= 5) {
      await recordDiagnostic({
        category: 'build_pipeline',
        title: `Build queue depth high: ${inProgress.length} active builds`,
        description: `${inProgress.length} builds are currently in progress or pending. Worker may be at capacity. Monitor for timeouts.`,
        affected_agent: 'friday-worker',
        risk_level: 'low',
        relevance_score: 40,
        estimated_effort: 'Monitor — no immediate action needed unless builds start failing'
      });
    }
  } catch(e) {
    console.warn('[DIAG] Build queue check error:', e.message.slice(0, 80));
  }
}

// ── Main diagnostic tick ──────────────────────────────────────────────────────

async function runDiagnostics() {
  const startTime = Date.now();
  console.log('[DIAG] Diagnostic tick:', new Date().toISOString());

  await Promise.all([
    checkTemporalHealth(),
    checkBuildApiHealth(),
    checkPm2ProcessHealth(),
    checkN8nHealth(),
    checkSupabaseHealth(),
    checkBuildQueueDepth()
  ]);

  console.log(`[DIAG] Tick complete in ${Date.now() - startTime}ms`);
}

// ── Startup (only when run directly, not when imported as a module) ───────────

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log('[DIAG] BUILD-013 Diagnostic Agent starting...');
  // Delay first run 30 seconds to let other processes start
  setTimeout(() => {
    runDiagnostics();
    setInterval(runDiagnostics, DIAG_INTERVAL_MS);
  }, 30000);
}
