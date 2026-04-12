// Test BUILD-002 Workflow Builder directly (no Temporal)
import { workflowBuilderActivity } from './temporal/activities/workflow-builder.js';
import fs from 'fs/promises';

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

// Load contract from BUILD-001 test run
let contract;
try {
  const raw = await fs.readFile('/tmp/friday-temporal-test-001/planner/build-contract.json', 'utf-8');
  contract = JSON.parse(raw);
  console.log('Loaded contract from BUILD-001 run.');
} catch(e) {
  console.warn('Could not load contract:', e.message);
  process.exit(1);
}

console.log('=== BUILD-002 WORKFLOW BUILDER TEST ===');
const start = Date.now();
try {
  const result = await workflowBuilderActivity(jobData, contract);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (result.status === 'error') {
    console.error(`\n✗ FAIL — BUILD-002 returned error in ${elapsed}s`);
    console.error('  Error:', result.error);
    process.exit(1);
  }
  console.log(`\n✓ PASS — BUILD-002 completed in ${elapsed}s`);
  console.log('  status:', result.status);
  console.log('  workflows deployed:', result.workflows_deployed + '/' + result.workflows_total);
  if (result.zero_workflow_warning) console.warn('  WARNING:', result.zero_workflow_warning);
  console.log('  workflows:', result.workflow_manifest?.workflows?.map(w => w.name));
} catch(e) {
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.error(`\n✗ FAIL — BUILD-002 threw in ${elapsed}s`);
  console.error('  Error:', e.message);
  process.exit(1);
}
