/**
 * BUILD-013: Research Agent
 * Standalone PM2 process — checks monitoring_topics hourly, fetches release notes
 * from GitHub/known URLs, uses Claude to assess relevance, writes to build_intelligence.
 */
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const RESEARCH_INTERVAL_MS = 60 * 60 * 1000; // every hour
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// Known GitHub repos for each topic_key
const TOPIC_GITHUB_REPOS = {
  anthropic_releases: null, // no public GitHub releases — use knowledge
  temporal_releases: 'temporalio/sdk-typescript',
  n8n_releases: 'n8n-io/n8n',
  supabase_releases: 'supabase/supabase',
  agent_frameworks: null,
  security_advisories: null,
  claude_code_updates: 'anthropics/claude-code',
  agentic_testing: null
};

// ── GitHub fetcher ────────────────────────────────────────────────────────────

async function fetchGithubReleases(repo) {
  if (!repo) return null;
  try {
    const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'ManageAI-Friday' };
    if (GITHUB_TOKEN) headers['Authorization'] = 'Bearer ' + GITHUB_TOKEN;
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=5`, {
      headers, signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    const releases = await res.json();
    return releases.slice(0, 5).map(r => ({
      tag: r.tag_name,
      name: r.name,
      published: r.published_at,
      body: (r.body || '').slice(0, 800),
      url: r.html_url
    }));
  } catch(e) {
    console.warn(`[RESEARCH] GitHub fetch failed for ${repo}:`, e.message.slice(0, 60));
    return null;
  }
}

// ── Claude research ───────────────────────────────────────────────────────────

async function assessTopicWithClaude(topic, releasesContext) {
  const today = new Date().toISOString().slice(0, 10);

  const contextBlock = releasesContext
    ? `RECENT GITHUB RELEASES:\n${JSON.stringify(releasesContext, null, 2)}`
    : `No live release data available — use your training knowledge up to your cutoff date.`;

  const prompt = `You are the ManageAI Intelligence Research Agent. Today is ${today}.

TOPIC: ${topic.display_name}
SEARCH QUERY: ${topic.search_query}

${contextBlock}

FRIDAY BUILD SYSTEM CONTEXT:
- FRIDAY is an autonomous AI build system on Node.js/TypeScript
- Uses: Anthropic Claude (claude-sonnet-4-6, claude-haiku-4-5-20251001), Temporal.io TypeScript SDK, n8n, Supabase
- Team: Brian Reinhart (Head of Build), Dan Ray (CCO), Dave Albertson (CEO)

Your task: Identify any recent changes, releases, or advisories for "${topic.display_name}" that the FRIDAY team should know about.

Focus on:
1. Breaking changes or deprecations affecting our stack
2. New features we could use to improve builds
3. Security vulnerabilities in our dependencies
4. Performance improvements or new APIs relevant to agent workflows

Return ONLY valid JSON (no markdown):
{
  "has_findings": boolean,
  "relevance_score": number,
  "risk_level": "low|medium|high",
  "title": string,
  "description": string,
  "implementation_plan": string,
  "affected_agent": string,
  "estimated_effort": string,
  "source_details": string
}

If nothing notable found, set has_findings: false and relevance_score < 30.`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    system: 'You are a technical intelligence agent. Return only valid JSON. Be concise and specific to the FRIDAY build system.',
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = msg.content[0].text;
  const clean = raw.replace(/```json\n?|\n?```/g, '').trim();
  return JSON.parse(clean);
}

// ── Topic scheduler ───────────────────────────────────────────────────────────

function isDue(topic) {
  if (!topic.active) return false;
  if (!topic.last_checked) return true;

  const last = new Date(topic.last_checked).getTime();
  const now = Date.now();

  if (topic.frequency === 'daily') return now - last > 23 * 60 * 60 * 1000;
  if (topic.frequency === 'weekly') return now - last > 6.5 * 24 * 60 * 60 * 1000;
  return false;
}

async function markTopicChecked(topicId) {
  await supabase
    .from('monitoring_topics')
    .update({ last_checked: new Date().toISOString() })
    .eq('id', topicId);
}

async function saveIntelligence(topic, finding) {
  if (!finding.has_findings || finding.relevance_score < 30) return;

  // Dedup by title in last 7 days
  const { data: existing } = await supabase
    .from('build_intelligence')
    .select('id')
    .eq('title', finding.title)
    .gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString())
    .maybeSingle();
  if (existing) return;

  await supabase.from('build_intelligence').insert({
    source: 'research',
    category: `research_${topic.topic_key}`,
    title: finding.title,
    description: finding.description,
    relevance_score: finding.relevance_score,
    implementation_plan: finding.implementation_plan,
    affected_agent: finding.affected_agent || '',
    risk_level: finding.risk_level || 'low',
    estimated_effort: finding.estimated_effort,
    status: 'pending'
  });
  console.log(`[RESEARCH] Finding saved for ${topic.topic_key}: ${finding.title}`);
}

// ── Main research tick ────────────────────────────────────────────────────────

async function runResearch() {
  const startTime = Date.now();
  console.log('[RESEARCH] Research tick:', new Date().toISOString());

  try {
    const { data: topics, error } = await supabase
      .from('monitoring_topics')
      .select('*')
      .eq('active', true);

    if (error || !topics || topics.length === 0) {
      console.log('[RESEARCH] No active topics found');
      return;
    }

    const dueTopics = topics.filter(isDue);
    if (dueTopics.length === 0) {
      console.log('[RESEARCH] No topics due this tick');
      return;
    }

    console.log(`[RESEARCH] Processing ${dueTopics.length} due topic(s)...`);

    for (const topic of dueTopics) {
      try {
        console.log(`[RESEARCH] Checking: ${topic.display_name}`);
        const repo = TOPIC_GITHUB_REPOS[topic.topic_key] || null;
        const releases = repo ? await fetchGithubReleases(repo) : null;

        const finding = await assessTopicWithClaude(topic, releases);
        await saveIntelligence(topic, finding);
        await markTopicChecked(topic.id);
      } catch(e) {
        console.error(`[RESEARCH] Error processing topic ${topic.topic_key}:`, e.message.slice(0, 120));
        await markTopicChecked(topic.id); // mark anyway to avoid tight retry loops
      }
    }

    console.log(`[RESEARCH] Tick complete in ${Date.now() - startTime}ms`);
  } catch(e) {
    console.error('[RESEARCH] runResearch error:', e.message);
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

console.log('[RESEARCH] BUILD-013 Research Agent starting...');
// Delay first run 60 seconds to avoid startup congestion
setTimeout(() => {
  runResearch();
  setInterval(runResearch, RESEARCH_INTERVAL_MS);
}, 60000);

export function scheduleResearchAgent(app) {
  app.post('/api/intelligence/research/run', async (req, res) => {
    try {
      const result = await runResearch();
      res.json({ success: true, ...result });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/intelligence/topics', async (req, res) => {
    try {
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data } = await sb.from('monitoring_topics').select('*').order('topic_key');
      res.json({ topics: data||[] });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });
  console.log('[FRIDAY] Research agent scheduled: nightly 2 AM');
}
