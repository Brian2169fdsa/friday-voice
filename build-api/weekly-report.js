import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import cron from 'node-cron';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export async function generateWeeklyReport() {
  console.log('[WEEKLY] Generating weekly intelligence report');
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

  const [{ data: intelligence }, { data: builds }, { data: compliance }, { data: healing }] = await Promise.all([
    supabase.from('build_intelligence').select('*').gte('created_at', sevenDaysAgo).eq('status','pending').order('relevance_score',{ascending:false}),
    supabase.from('friday_builds').select('status,qa_score,created_at').gte('created_at', sevenDaysAgo),
    supabase.from('build_compliance_results').select('compliance_score,passed').gte('created_at', sevenDaysAgo),
    supabase.from('build_intelligence').select('title,status').eq('source','diagnostic').gte('created_at', sevenDaysAgo)
  ]);

  const totalBuilds = (builds||[]).length;
  const avgQA = totalBuilds > 0 ? (builds||[]).reduce((s,b)=>s+(b.qa_score||0),0)/totalBuilds : 0;
  const avgCompliance = (compliance||[]).length > 0 ? (compliance||[]).reduce((s,c)=>s+(c.compliance_score||0),0)/(compliance||[]).length : 0;
  const autoHealed = (healing||[]).filter(e=>e.status==='deployed').length;
  const escalated = (healing||[]).filter(e=>e.status==='pending').length;

  const reportResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages:[{role:'user',content:`Write a concise weekly intelligence report for Brian (Head of Build, ManageAI). Phone-readable. Be specific and actionable.

METRICS: Builds:${totalBuilds} | Avg QA:${avgQA.toFixed(0)}/100 | Avg Compliance:${avgCompliance.toFixed(0)}% | Auto-healed:${autoHealed} | Escalated:${escalated}

PENDING INTELLIGENCE (${(intelligence||[]).length} items):
${JSON.stringify((intelligence||[]).slice(0,8),null,2)}

Sections: 1) System Health 2) Research Findings (each: approve/defer recommendation) 3) Build Issues 4) Self-Healing Events 5) Actions for Brian. Keep it tight.`}]
  });

  const reportText = reportResponse.content[0].text;

  await supabase.from('build_intelligence').insert({
    source:'weekly_report', category:'report',
    title:`Weekly Intelligence Report -- ${new Date().toLocaleDateString()}`,
    description: reportText, relevance_score:1, status:'pending',
    implementation_plan:'Approve or defer each item via /api/intelligence/:id/approve or /defer'
  });

  console.log('[WEEKLY] Report generated');
  return { report_text: reportText, metrics: { totalBuilds, avgQA, avgCompliance, autoHealed, escalated } };
}

export function scheduleWeeklyReport(app) {
  cron.schedule('0 18 * * 5', () => {
    generateWeeklyReport().catch(err => console.error('[WEEKLY] Error:', err));
  });

  app.post('/api/intelligence/report/generate', async (req, res) => {
    try {
      const result = await generateWeeklyReport();
      res.json({ success: true, metrics: result.metrics, preview: result.report_text.slice(0,300) });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/intelligence/pending', async (req, res) => {
    try {
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data } = await sb.from('build_intelligence').select('*').eq('status','pending').order('relevance_score',{ascending:false}).limit(20);
      res.json({ items: data||[], count: (data||[]).length });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/intelligence/all', async (req, res) => {
    try {
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data } = await sb.from('build_intelligence').select('*').order('created_at',{ascending:false}).limit(50);
      res.json({ items: data||[] });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/intelligence/topics', async (req, res) => {
    try {
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data } = await sb.from('monitoring_topics').select('*').order('topic_key');
      res.json({ topics: data||[] });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/intelligence/:id/approve', async (req, res) => {
    try {
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      await sb.from('build_intelligence').update({ status:'approved', approved_at:new Date().toISOString(), approved_by:'Brian' }).eq('id',req.params.id);
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/intelligence/:id/defer', async (req, res) => {
    try {
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      await sb.from('build_intelligence').update({ status:'deferred' }).eq('id',req.params.id);
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  console.log('[FRIDAY] Weekly report scheduled: Friday 6 PM');
}
