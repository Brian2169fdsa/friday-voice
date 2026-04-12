// Test BUILD-006 Schema Architect directly (no Temporal)
import { schemaArchitectActivity } from './temporal/activities/schema-architect.js';
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
  console.warn('Could not load BUILD-001 contract, using minimal fallback:', e.message);
  contract = {
    build_id: 'test-001',
    client: 'SelfTest-Final',
    project: 'Matter Intake Automation',
    platform: 'n8n',
    BUILD_006: {
      tables_required: ['selftest_matters', 'selftest_matter_clauses', 'selftest_matter_routing', 'selftest_notifications'],
      key_columns: 'matter_id, status, matter_type, urgency_flag',
      special_requirements: 'Deduplication on portal_matter_id'
    }
  };
}

console.log('=== BUILD-006 SCHEMA ARCHITECT TEST ===');
const start = Date.now();
try {
  const result = await schemaArchitectActivity(jobData, contract);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (result.status === 'error') {
    console.error(`\n✗ FAIL — BUILD-006 returned error in ${elapsed}s`);
    console.error('  Error:', result.error);
    process.exit(1);
  }
  console.log(`\n✓ PASS — BUILD-006 completed in ${elapsed}s`);
  console.log('  status:', result.status);
  console.log('  tables deployed:', result.tables_deployed + '/' + result.tables_total);
  console.log('  tables:', result.confirmed_schema?.tables?.map(t => t.name));
} catch(e) {
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.error(`\n✗ FAIL — BUILD-006 threw in ${elapsed}s`);
  console.error('  Error:', e.message);
  process.exit(1);
}
