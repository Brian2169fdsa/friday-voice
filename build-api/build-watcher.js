import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const WATCH_INTERVAL_MS = 5 * 60 * 1000;
const CONFIDENCE_THRESHOLD = 0.70;
const PATTERN_THRESHOLD = 3;

async function recordIntelligence(data) {
  try {
    const { data: existing } = await supabase
      .from('build_intelligence')
      .select('id')
      .eq('category', data.category)
      .eq('affected_agent', data.affected_agent || '')
      .eq('status', 'pending')
      .gte('created_at', new Date(Date.now() - 86400000).toISOString())
      .maybeSingle();
    if (existing) return;
    await supabase.from('build_intelligence').insert(data);
    console.log(`[WATCHER] Intelligence recorded: ${data.title}`);
  } catch(e) {
    console.error('[WATCHER] recordIntelligence error:', e.message);
  }
}

async function watchBuilds() {
  console.log('[WATCHER] Build watcher tick:', new Date().toISOString());
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data: signals } = await supabase
      .from('build_quality_signals')
      .select('from_agent, signal_type, confidence, flags, payload, created_at, ticket_id')
      .gte('created_at', sevenDaysAgo)
      .order('created_at', { ascending: false });

    if (!signals || signals.length === 0) { console.log('[WATCHER] No signals yet'); return; }

    // Pattern 1: Low confidence agents
    const agentConfidence = {};
    for (const sig of signals) {
      if (['qa_results','quality_review'].includes(sig.signal_type)) {
        if (!agentConfidence[sig.from_agent]) agentConfidence[sig.from_agent] = [];
        agentConfidence[sig.from_agent].push(sig.confidence || 0);
      }
    }
    for (const [agent, scores] of Object.entries(agentConfidence)) {
      if (scores.length >= 3) {
        const avg = scores.reduce((a,b) => a+b, 0) / scores.length;
        if (avg < CONFIDENCE_THRESHOLD) {
          await recordIntelligence({
            source: 'watcher', category: 'agent_performance',
            title: `${agent} confidence trending low (${(avg*100).toFixed(0)}%)`,
            description: `${agent} averaged ${(avg*100).toFixed(0)}% confidence across ${scores.length} builds. Threshold: ${CONFIDENCE_THRESHOLD*100}%.`,
            affected_agent: agent, relevance_score: 0.9, risk_level: 'medium', estimated_effort: 'low',
            implementation_plan: `Review and update ${agent} system prompt. Ensure it receives adequate context from upstream agents.`
          });
        }
      }
    }

    // Pattern 2: Recurring fix requests
    const qaFailures = signals.filter(s => s.signal_type === 'fix_request');
    const failuresByAgent = {};
    for (const f of qaFailures) {
      const agent = f.to_agent || f.payload?.agent;
      if (!agent) continue;
      if (!failuresByAgent[agent]) failuresByAgent[agent] = [];
      failuresByAgent[agent].push(f);
    }
    for (const [agent, failures] of Object.entries(failuresByAgent)) {
      if (failures.length >= PATTERN_THRESHOLD) {
        await recordIntelligence({
          source: 'watcher', category: 'recurring_failure',
          title: `${agent} receiving repeated QA fix requests (${failures.length}x this week)`,
          description: `BUILD-003 sent ${failures.length} fix requests to ${agent} this week. Same class of failure recurring.`,
          affected_agent: agent, relevance_score: 0.95, risk_level: 'high', estimated_effort: 'medium',
          implementation_plan: `Analyze ${agent} failure patterns. Most recent: ${JSON.stringify(failures[0]?.payload?.fix_instructions || '').slice(0,200)}`
        });
      }
    }

    // Pattern 3: Security failures
    const securityFailures = signals.filter(s => s.signal_type === 'security_scan' && s.confidence === 0);
    if (securityFailures.length >= 2) {
      await recordIntelligence({
        source: 'watcher', category: 'security_pattern',
        title: `Recurring security scan failures (${securityFailures.length} this week)`,
        description: `${securityFailures.length} builds failed security scan. Review code generation for credential patterns.`,
        affected_agent: 'BUILD-005', relevance_score: 0.99, risk_level: 'critical', estimated_effort: 'medium',
        implementation_plan: 'Update BUILD-005 prompt to explicitly prohibit hardcoded secrets. Add .env.example pattern enforcement.'
      });
    }

    // Pattern 4: Compliance trends
    const { data: complianceResults } = await supabase
      .from('build_compliance_results')
      .select('compliance_score, passed, created_at')
      .gte('created_at', sevenDaysAgo);
    if (complianceResults && complianceResults.length >= 3) {
      const avgCompliance = complianceResults.reduce((sum,r) => sum + (r.compliance_score||0), 0) / complianceResults.length;
      const failRate = complianceResults.filter(r => !r.passed).length / complianceResults.length;
      if (avgCompliance < 85 || failRate > 0.3) {
        await recordIntelligence({
          source: 'watcher', category: 'compliance_trend',
          title: `Compliance averaging ${avgCompliance.toFixed(0)}% (${(failRate*100).toFixed(0)}% fail rate)`,
          description: `Week avg compliance: ${avgCompliance.toFixed(0)}%. ${(failRate*100).toFixed(0)}% of builds failing compliance gate.`,
          affected_agent: 'BUILD-011', relevance_score: 0.9, risk_level: 'high', estimated_effort: 'medium',
          implementation_plan: 'Review BUILD-000 success criteria extraction. Check agents are addressing all extracted criteria in outputs.'
        });
      }
    }

    console.log('[WATCHER] Watch cycle complete');
  } catch(e) {
    console.error('[WATCHER] Error:', e.message);
  }
}

export function startBuildWatcher() {
  console.log('[WATCHER] Build watcher starting -- 5 minute interval');
  watchBuilds();
  setInterval(watchBuilds, WATCH_INTERVAL_MS);
}
