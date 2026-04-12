// Test BUILD-001 Planner directly (no Temporal)
import { runPlannerActivity } from './temporal/activities/planner.js';

const jobData = {
  job_id: 'test-001',
  ticket_id: 'TEST-001',
  client: 'SelfTest-Final',
  project_name: 'Matter Intake Automation',
  platform: 'n8n',
  customer_id: '882d9329-4e05-4467-8773-27dc2ce5db48',
  workflow_steps: '1. Receive webhook 2. Classify matter 3. Route to queue 4. Extract clauses 5. Notify paralegal',
  decision_authority: 'AI classifies, paralegals decide',
  success_metrics: '95% accuracy, under 90 seconds, QA above 75',
  data_sources: 'Supabase, OneDrive, firm portal webhook',
  guardrails: 'Never auto-close matters, flag low confidence',
  edge_cases: 'Duplicates, incomplete forms, unsupported types',
  acceptance_criteria: '95% accuracy on 200 test matters'
};

console.log('=== BUILD-001 PLANNER TEST ===');
const start = Date.now();
try {
  const contract = await runPlannerActivity(jobData);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n✓ PASS — BUILD-001 completed in ${elapsed}s`);
  console.log('  system_summary:', contract.system_summary?.slice(0, 100));
  console.log('  tables_required:', contract.BUILD_006?.tables_required);
  console.log('  workflow_name:', contract.BUILD_002?.workflow_name);
  console.log('  plannerUsed:', contract.plannerUsed);
  console.log('  cost_estimate tokens:', contract.cost_estimate?.tokens?.total);
} catch (e) {
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.error(`\n✗ FAIL — BUILD-001 failed in ${elapsed}s`);
  console.error('  Error:', e.message);
  process.exit(1);
}
