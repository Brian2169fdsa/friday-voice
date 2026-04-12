import cron from 'node-cron';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

// ── Data collectors ───────────────────────────────────────────────────────────

async function collectRecurringPatterns(supabase) {
  // Patterns seen at least twice across any customer
  const { data: patterns } = await supabase
    .from('cross_build_learnings')
    .select('id, customer_id, pattern_type, pattern_description, agent_affected, frequency, improvement_applied, last_seen_ticket, updated_at')
    .gte('frequency', 2)
    .order('frequency', { ascending: false })
    .limit(100);

  return patterns || [];
}

async function collectRecentBuildPerformance(supabase) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: builds } = await supabase
    .from('friday_builds')
    .select('id, ticket_id, customer_id, qa_score, status, created_at')
    .gte('created_at', thirtyDaysAgo)
    .order('created_at', { ascending: false })
    .limit(200);

  const rows = builds || [];
  const failed = rows.filter(b => b.status === 'failed' || b.status === 'error');
  const scores = rows.filter(b => b.qa_score != null).map(b => b.qa_score);
  const avgQa = scores.length ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : 0;

  return {
    total: rows.length,
    failed: failed.length,
    avgQaScore: avgQa,
    failRate: rows.length ? Math.round((failed.length / rows.length) * 100) : 0
  };
}

async function collectAgentFailureSummary(supabase) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: runs } = await supabase
    .from('build_agent_runs')
    .select('agent_id, status, error_message, created_at')
    .gte('created_at', thirtyDaysAgo)
    .eq('status', 'error')
    .order('created_at', { ascending: false })
    .limit(500);

  const rows = runs || [];
  const byAgent = {};
  for (const r of rows) {
    const key = r.agent_id || 'unknown';
    byAgent[key] = (byAgent[key] || 0) + 1;
  }

  return Object.entries(byAgent)
    .sort((a, b) => b[1] - a[1])
    .map(([agent, count]) => ({ agent, errorCount: count }));
}

async function collectQualitySignalPatterns(supabase) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: signals } = await supabase
    .from('build_quality_signals')
    .select('from_agent, signal_type, confidence, flags, created_at')
    .gte('created_at', thirtyDaysAgo)
    .in('signal_type', ['qa_results', 'quality_gate_block', 'compliance_failure'])
    .order('created_at', { ascending: false })
    .limit(200);

  const rows = signals || [];
  const blocks = rows.filter(s => s.signal_type === 'quality_gate_block');
  const complianceFails = rows.filter(s => s.signal_type === 'compliance_failure');

  // Flatten all flags arrays to find most common flags
  const flagCounts = {};
  for (const s of rows) {
    for (const flag of (s.flags || [])) {
      flagCounts[flag] = (flagCounts[flag] || 0) + 1;
    }
  }
  const topFlags = Object.entries(flagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([flag, count]) => ({ flag, count }));

  return {
    qualityBlocks: blocks.length,
    complianceFailures: complianceFails.length,
    topFlags
  };
}

// ── Claude analysis ───────────────────────────────────────────────────────────

async function generateLearningInsights(patterns, buildPerf, agentFailures, signalPatterns) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Group patterns by agent
  const byAgent = {};
  for (const p of patterns) {
    const key = p.agent_affected || 'unknown';
    if (!byAgent[key]) byAgent[key] = [];
    byAgent[key].push(p);
  }

  const agentSummary = Object.entries(byAgent)
    .map(([agent, pts]) => {
      const sorted = pts.sort((a, b) => b.frequency - a.frequency);
      return `${agent}: ${sorted.length} recurring patterns (max frequency: ${sorted[0]?.frequency})\n` +
        sorted.slice(0, 3).map(p => `  - [${p.pattern_type}] freq=${p.frequency}: ${p.pattern_description.slice(0, 120)}`).join('\n');
    })
    .join('\n\n');

  const prompt = `You are the FRIDAY Build Intelligence System analyzing cross-build learning patterns.

RECURRING FAILURE PATTERNS (frequency >= 2, last 30 days):
${agentSummary || 'None found'}

RECENT BUILD PERFORMANCE (30 days):
Total builds: ${buildPerf.total}
Failed: ${buildPerf.failed} (${buildPerf.failRate}% failure rate)
Avg QA score: ${buildPerf.avgQaScore}/100

AGENT ERROR COUNTS (30 days):
${agentFailures.slice(0, 10).map(a => `${a.agent}: ${a.errorCount} errors`).join('\n') || 'None'}

QUALITY GATE & COMPLIANCE SIGNALS:
Quality gate blocks: ${signalPatterns.qualityBlocks}
Compliance failures: ${signalPatterns.complianceFailures}
Top flags: ${signalPatterns.topFlags.map(f => `${f.flag}(${f.count})`).join(', ') || 'none'}

Your task: Produce actionable prompt improvements for each agent that has recurring failures.
Focus on: what specific instructions to add to agent prompts, what to check, what formats to enforce.

Return ONLY valid JSON (no markdown):
{
  "analysis_date": "${new Date().toISOString()}",
  "total_patterns_analyzed": ${patterns.length},
  "high_priority_agents": [string],
  "agent_improvements": {
    "BUILD-002": string,
    "BUILD-004": string,
    "BUILD-005": string,
    "BUILD-006": string,
    "BUILD-007": string
  },
  "systemic_issues": [string],
  "recommended_actions": [string],
  "patterns_to_mark_resolved": [string]
}`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: 'You are the FRIDAY Cross-Build Learning Engine. Analyze recurring build failures and produce specific, actionable prompt improvements for each specialist agent. Be concrete — specify exactly what instruction to add, not vague suggestions. Max 1500 words.',
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = message.content[0].text;
  const clean = raw.replace(/```json\n?|\n?```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch(e) {
    console.warn('[CROSS-BUILD] Insights parse error:', e.message);
    return {
      analysis_date: new Date().toISOString(),
      total_patterns_analyzed: patterns.length,
      high_priority_agents: [],
      agent_improvements: {},
      systemic_issues: [],
      recommended_actions: [],
      patterns_to_mark_resolved: []
    };
  }
}

// ── Apply improvements ────────────────────────────────────────────────────────

async function markPatternsImproved(supabase, patterns, insights) {
  const toMark = insights.patterns_to_mark_resolved || [];
  if (toMark.length === 0) return 0;

  let marked = 0;
  for (const p of patterns) {
    const isResolved = toMark.some(desc =>
      p.pattern_description.toLowerCase().includes(desc.toLowerCase().slice(0, 40))
    );
    if (isResolved && !p.improvement_applied) {
      await supabase
        .from('cross_build_learnings')
        .update({ improvement_applied: true, updated_at: new Date().toISOString() })
        .eq('id', p.id);
      marked++;
    }
  }
  return marked;
}

async function storeInsights(supabase, insights, summary) {
  // Store as a quality signal so agents and the dashboard can read it
  await supabase.from('build_quality_signals').insert({
    ticket_id: `cross-build-${new Date().toISOString().slice(0, 10)}`,
    from_agent: 'CROSS-BUILD-LEARNING',
    signal_type: 'cross_build_insights',
    confidence: 1,
    payload: { ...insights, run_summary: summary }
  });
}

// ── Main runner ───────────────────────────────────────────────────────────────

async function runCrossBuildLearning() {
  console.log('[CROSS-BUILD] Starting cross-build learning analysis...');
  const startTime = Date.now();

  const supabase = createClient(SB_URL, SB_KEY);

  const [patterns, buildPerf, agentFailures, signalPatterns] = await Promise.all([
    collectRecurringPatterns(supabase).catch(e => { console.warn('[CROSS-BUILD] patterns error:', e.message); return []; }),
    collectRecentBuildPerformance(supabase).catch(e => { console.warn('[CROSS-BUILD] builds error:', e.message); return {}; }),
    collectAgentFailureSummary(supabase).catch(e => { console.warn('[CROSS-BUILD] agent errors:', e.message); return []; }),
    collectQualitySignalPatterns(supabase).catch(e => { console.warn('[CROSS-BUILD] signals error:', e.message); return {}; })
  ]);

  console.log(`[CROSS-BUILD] Data collected: ${patterns.length} patterns, ${buildPerf.total || 0} builds`);

  if (patterns.length === 0) {
    console.log('[CROSS-BUILD] No recurring patterns found — skipping analysis');
    return { analyzed: 0, insights: null, duration_ms: Date.now() - startTime };
  }

  const insights = await generateLearningInsights(patterns, buildPerf, agentFailures, signalPatterns);

  const markedResolved = await markPatternsImproved(supabase, patterns, insights).catch(e => {
    console.warn('[CROSS-BUILD] mark-improved error:', e.message);
    return 0;
  });

  const summary = {
    patterns_analyzed: patterns.length,
    high_priority_agents: insights.high_priority_agents || [],
    systemic_issues_count: (insights.systemic_issues || []).length,
    recommended_actions_count: (insights.recommended_actions || []).length,
    patterns_marked_resolved: markedResolved,
    build_fail_rate: buildPerf.failRate || 0,
    avg_qa_score: buildPerf.avgQaScore || 0,
    duration_ms: Date.now() - startTime
  };

  await storeInsights(supabase, insights, summary).catch(e => {
    console.warn('[CROSS-BUILD] store-insights error:', e.message);
  });

  console.log(`[CROSS-BUILD] Analysis complete | Patterns: ${patterns.length} | Resolved: ${markedResolved} | ${summary.duration_ms}ms`);
  return { analyzed: patterns.length, insights, ...summary };
}

// ── Scheduler & route registration ───────────────────────────────────────────

export function scheduleCrossBuildLearning(app) {
  // Cron: Every Monday at 8:10 AM (10-min offset from Charlie, 5-min after weekly-intel)
  cron.schedule('10 8 * * 1', () => {
    runCrossBuildLearning().catch(err => {
      console.error('[CROSS-BUILD] Cron run failed:', err.message);
    });
  });
  console.log('[FRIDAY] Cross-Build Learning scheduled: Monday 8:10 AM');

  // Manual trigger endpoint
  app.post('/api/build/cross-build-learning/run', async (req, res) => {
    const key = req.headers['x-cockpit-key'];
    if (key !== 'friday-cockpit-2026') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const result = await runCrossBuildLearning();
      res.json(result);
    } catch(e) {
      console.error('[CROSS-BUILD] Manual run failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });
}
