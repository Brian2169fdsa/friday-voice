// Test BUILD-004 LLM Specialist directly (no Temporal)
import { llmSpecialistActivity } from './temporal/activities/llm-specialist.js';
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

let contract, schemaResult, workflowResult;
try {
  const raw = await fs.readFile('/tmp/friday-temporal-test-001/planner/build-contract.json', 'utf-8');
  contract = JSON.parse(raw);
  console.log('Loaded contract from BUILD-001 run.');
} catch(e) { console.warn('No contract:', e.message); process.exit(1); }

try {
  const raw = await fs.readFile('/tmp/friday-temporal-test-001/schema/confirmed-schema.json', 'utf-8');
  schemaResult = JSON.parse(raw);
  console.log('Loaded schema from BUILD-006 run.');
} catch(e) { console.warn('No schema (non-fatal):', e.message); }

try {
  const raw = await fs.readFile('/tmp/friday-temporal-test-001/workflows/workflow-manifest.json', 'utf-8');
  workflowResult = JSON.parse(raw);
  console.log('Loaded workflow manifest from BUILD-002 run.');
} catch(e) { console.warn('No workflow manifest (non-fatal):', e.message); }

console.log('=== BUILD-004 LLM SPECIALIST TEST ===');
const start = Date.now();
try {
  const result = await llmSpecialistActivity(jobData, contract, { schema: schemaResult, workflow: workflowResult });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (result.status === 'error') {
    console.error(`\n✗ FAIL — BUILD-004 returned error in ${elapsed}s`);
    console.error('  Error:', result.error);
    process.exit(1);
  }
  console.log(`\n✓ PASS — BUILD-004 completed in ${elapsed}s`);
  console.log('  status:', result.status);
  console.log('  prompts_written:', result.prompts_written);
  console.log('  output_subdir:', result.output_subdir);
} catch(e) {
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.error(`\n✗ FAIL — BUILD-004 threw in ${elapsed}s`);
  console.error('  Error:', e.message);
  process.exit(1);
}
