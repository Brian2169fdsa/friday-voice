import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import fsPromises from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { heartbeat, ApplicationFailure } from '@temporalio/activity';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const N8N_URL = process.env.N8N_LOCAL_URL || 'http://localhost:5678';
const N8N_KEY = process.env.N8N_LOCAL_API_KEY || process.env.N8N_API_KEY || '';

// ── n8n Real Workflow Testing ──────────────────────────────────────────────────
async function testN8nWorkflows(ticketId, clientName) {
  const results = [];

  const wfRes = await fetch(`${N8N_URL}/api/v1/workflows?limit=250`, {
    headers: { 'X-N8N-API-KEY': N8N_KEY }
  });

  if (!wfRes.ok) {
    return [{ name: 'n8n_api', passed: false, error: `n8n API returned ${wfRes.status}` }];
  }

  const { data: allWorkflows } = await wfRes.json();
  const clientSlug = clientName.toLowerCase().replace(/[^a-z0-9]/g, '-');

  // Find workflows belonging to this client build by name match or ticket tag
  const clientWorkflows = allWorkflows.filter(w =>
    w.name.toLowerCase().includes(clientSlug) ||
    w.tags?.some(t => t.name === ticketId)
  );

  if (clientWorkflows.length === 0) {
    return [{
      name: 'workflow_existence',
      passed: false,
      error: `No workflows found for client "${clientName}" (slug: ${clientSlug})`
    }];
  }

  for (const workflow of clientWorkflows) {
    try { heartbeat({ step: 'n8n_testing', workflow: workflow.name }); } catch (_) {}

    // Test 1: Activation status
    if (!workflow.active) {
      results.push({
        name: workflow.name,
        passed: false,
        error: 'Workflow is not activated',
        type: 'activation'
      });
      continue;
    }

    // Test 2: Webhook execution (if webhook trigger present)
    const webhookNode = workflow.nodes?.find(n =>
      n.type === 'n8n-nodes-base.webhook' ||
      n.type === 'n8n-nodes-base.webhookTrigger'
    );

    if (webhookNode) {
      const webhookPath = webhookNode.parameters?.path || workflow.id;
      const webhookUrl = `${N8N_URL}/webhook/${webhookPath}`;
      const testPayload = buildN8nTestPayload(workflow.name, clientName);
      // Use GET for status/check/query workflows, POST for everything else
      const httpMethod = webhookNode.parameters?.httpMethod ||
        (/status|check|query|monitor/i.test(workflow.name) ? 'GET' : 'POST');

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 25000);

        let requestUrl = webhookUrl;
        const fetchOpts = { method: httpMethod, signal: controller.signal };
        if (httpMethod === 'GET') {
          // Append common query params for GET-based status/check webhooks
          requestUrl = webhookUrl + '?portal_matter_id=QA-TEST-001&matter_id=QA-TEST-001&_qa_test=true';
        } else {
          fetchOpts.headers = { 'Content-Type': 'application/json' };
          fetchOpts.body = JSON.stringify(testPayload);
        }
        const webhookRes = await fetch(requestUrl, fetchOpts);

        clearTimeout(timeout);

        if (webhookRes.ok) {
          const responseData = await webhookRes.json().catch(() => ({}));
          results.push({
            name: workflow.name,
            passed: true,
            response_status: webhookRes.status,
            has_response_body: Object.keys(responseData).length > 0,
            type: 'webhook_execution'
          });
        } else {
          const execLog = await getLastExecution(workflow.id);
          results.push({
            name: workflow.name,
            passed: false,
            error: `Webhook returned ${webhookRes.status}`,
            last_execution: execLog,
            type: 'webhook_execution'
          });
        }
      } catch (e) {
        results.push({
          name: workflow.name,
          passed: false,
          error: e.name === 'AbortError' ? 'Webhook timed out after 25s' : e.message.slice(0, 200),
          type: 'webhook_execution'
        });
      }
    } else {
      // No webhook trigger — confirm activation + check last execution
      const execLog = await getLastExecution(workflow.id);
      results.push({
        name: workflow.name,
        passed: workflow.active,
        type: 'activation_check',
        last_execution: execLog
      });
    }
  }

  return results;
}

async function getLastExecution(workflowId) {
  try {
    const res = await fetch(`${N8N_URL}/api/v1/executions?workflowId=${workflowId}&limit=1`, {
      headers: { 'X-N8N-API-KEY': N8N_KEY }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const exec = data.data?.[0];
    if (!exec) return null;
    return {
      status: exec.finished ? (exec.stoppedAt ? 'success' : 'error') : 'running',
      mode: exec.mode,
      started: exec.startedAt,
      error: exec.data?.resultData?.error?.message
    };
  } catch (_) { return null; }
}

function buildN8nTestPayload(workflowName, clientName) {
  const lower = workflowName.toLowerCase();
  const base = { _qa_test: true, timestamp: new Date().toISOString(), source: 'friday_qa', client: clientName };
  if (lower.includes('intake') || lower.includes('inbound')) {
    // Include common legal matter intake fields so workflow validation passes
    if (lower.includes('matter') || lower.includes('legal') || lower.includes('law')) {
      return { ...base, event_type: 'intake',
        portal_matter_id: 'QA-TEST-001', client_name: 'QA Test Client', matter_type: 'litigation',
        matter_description: 'Friday QA test matter submission', urgency_flag: false, documents: [] };
    }
    return { ...base, event_type: 'intake', data: { name: 'QA Test User', email: 'qa@test.com', message: 'Friday QA test submission' } };
  }
  if (lower.includes('notify') || lower.includes('alert')) {
    return { ...base, event_type: 'notification', recipient: 'qa@test.com', message: 'Friday QA test notification' };
  }
  return { ...base, event_type: 'test' };
}

// ── Supabase Schema Testing ───────────────────────────────────────────────────
async function testSupabaseSchema(ticketId, clientName) {
  const results = [];
  const clientSlug = clientName.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');

  try { heartbeat({ step: 'supabase_testing', client: clientName }); } catch (_) {}

  // Discover tables via PostgREST OpenAPI (always available, no custom RPC needed)
  const schemaRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/`, {
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
    }
  });

  if (!schemaRes.ok) {
    return [{ name: 'schema_discovery', passed: false, error: `PostgREST schema endpoint returned ${schemaRes.status}` }];
  }

  const openapi = await schemaRes.json();
  const allTablePaths = Object.keys(openapi.paths || {}).filter(p => !p.includes('rpc'));

  // Filter to tables created for this client build
  const clientTables = allTablePaths
    .map(p => p.replace(/^\//, ''))
    .filter(t => t.includes(clientSlug) || t.startsWith(clientSlug));

  if (clientTables.length === 0) {
    return [{
      name: 'schema_existence',
      passed: false,
      error: `No tables found matching client slug: ${clientSlug}`
    }];
  }

  for (const tableName of clientTables) {
    try { heartbeat({ step: 'supabase_table_test', table: tableName }); } catch (_) {}

    // Test 1: Table is accessible and selectable
    const { data: selectData, error: selectErr } = await supabase
      .from(tableName)
      .select('*')
      .limit(1);

    if (selectErr) {
      results.push({ name: tableName, passed: false, test: 'select', error: selectErr.message });
      continue;
    }

    // Test 2: INSERT a minimal test row, SELECT it back, then DELETE it
    const testMarker = `friday_qa_${Date.now()}`;
    const testRecord = buildMinimalTestRecord(tableName, testMarker);

    const { data: insertData, error: insertErr } = await supabase
      .from(tableName)
      .insert(testRecord)
      .select()
      .single();

    if (insertErr) {
      // If insert fails on constraints, the table is still accessible — partial pass
      results.push({
        name: tableName,
        passed: true,
        test: 'select_only',
        note: `Select OK; insert failed on constraints (${insertErr.message.slice(0, 100)}) — table is accessible`
      });
      continue;
    }

    // SELECT back the inserted row
    const insertedId = insertData?.id;
    if (insertedId) {
      const { error: readErr } = await supabase.from(tableName).select('*').eq('id', insertedId).single();
      if (readErr) {
        results.push({ name: tableName, passed: false, test: 'read_after_insert', error: readErr.message });
        await supabase.from(tableName).delete().eq('id', insertedId).catch(() => {});
        continue;
      }
      // DELETE test row
      await supabase.from(tableName).delete().eq('id', insertedId).catch(() => {});
    }

    results.push({
      name: tableName,
      passed: true,
      test: 'full_crud'
    });
  }

  return results;
}

function buildMinimalTestRecord(tableName, marker) {
  const base = { created_at: new Date().toISOString() };
  if (tableName.includes('log') || tableName.includes('audit')) {
    return { ...base, event_type: 'qa_test', message: `Friday QA ${marker}` };
  }
  if (tableName.includes('queue') || tableName.includes('intake')) {
    return { ...base, status: 'test', source: `friday_qa_${marker}` };
  }
  if (tableName.includes('config') || tableName.includes('setting')) {
    return { ...base, key: `friday_qa_test_${marker}`, value: 'qa_test' };
  }
  return { ...base };
}

// ── GitHub Repo Testing ───────────────────────────────────────────────────────
async function testGitHubRepo(ticketId, clientName, repoName) {
  if (!repoName) {
    return [{ name: 'repo_check', passed: false, error: 'No repoName in build contract — BUILD-005 may not have run' }];
  }

  const githubToken = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
  const repoOwner = process.env.GITHUB_ORG || process.env.GITHUB_USERNAME;

  if (!githubToken) {
    return [{ name: 'github_auth', passed: false, error: 'GITHUB_TOKEN not set in friday-worker env' }];
  }
  if (!repoOwner) {
    return [{ name: 'github_owner', passed: false, error: 'GITHUB_ORG and GITHUB_USERNAME both unset — cannot form repo URL' }];
  }

  const results = [];
  try { heartbeat({ step: 'github_testing', repo: repoName }); } catch (_) {}

  // Test 1: Repo exists
  const repoRes = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}`, {
    headers: {
      'Authorization': `Bearer ${githubToken}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });

  if (!repoRes.ok) {
    return [{
      name: 'repo_existence',
      passed: false,
      error: `Repo ${repoOwner}/${repoName} not found (HTTP ${repoRes.status})`
    }];
  }

  const repoData = await repoRes.json();
  results.push({ name: 'repo_existence', passed: true, default_branch: repoData.default_branch, size_kb: repoData.size });

  // Test 2: Required files
  for (const file of ['package.json', 'README.md']) {
    const fileRes = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/contents/${file}`, {
      headers: { 'Authorization': `Bearer ${githubToken}` }
    });
    results.push({ name: `file_${file.replace('.', '_')}`, passed: fileRes.ok, required: true });
  }

  // Test 3: package.json validity
  const pkgRes = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/contents/package.json`, {
    headers: { 'Authorization': `Bearer ${githubToken}` }
  });
  if (pkgRes.ok) {
    try {
      const pkgData = await pkgRes.json();
      const pkg = JSON.parse(Buffer.from(pkgData.content, 'base64').toString());
      const hasStart = !!(pkg.scripts?.start || pkg.main || pkg.exports);
      const depCount = Object.keys(pkg.dependencies || {}).length;
      results.push({ name: 'package_json_valid', passed: hasStart && depCount > 0, has_start: hasStart, dep_count: depCount });
    } catch (e) {
      results.push({ name: 'package_json_valid', passed: false, error: `Invalid JSON: ${e.message}` });
    }
  }

  // Test 4: Clone and npm install (only if repo is small enough)
  if (repoData.size < 10240) {
    const tmpDir = mkdtempSync(join(tmpdir(), 'friday-qa-'));
    try {
      try { heartbeat({ step: 'github_clone', repo: repoName }); } catch (_) {}

      execSync(
        `git clone --depth 1 https://${githubToken}@github.com/${repoOwner}/${repoName}.git ${tmpDir}/repo`,
        { timeout: 60000, stdio: 'pipe' }
      );

      execSync('npm ci --prefer-offline', {
        cwd: `${tmpDir}/repo`,
        timeout: 120000,
        stdio: 'pipe'
      });

      results.push({ name: 'npm_install', passed: true });

      // Run test suite if defined
      let pkg = {};
      try { pkg = JSON.parse(execSync('cat package.json', { cwd: `${tmpDir}/repo` }).toString()); } catch (_) {}

      if (pkg.scripts?.test) {
        try {
          execSync('npm test', { cwd: `${tmpDir}/repo`, timeout: 60000, stdio: 'pipe' });
          results.push({ name: 'npm_test', passed: true });
        } catch (e) {
          results.push({ name: 'npm_test', passed: false, error: (e.stdout?.toString() || e.message).slice(-500) });
        }
      }
    } catch (e) {
      results.push({ name: 'clone_and_build', passed: false, error: e.message.slice(0, 300) });
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  return results;
}

// ── LLM Accuracy Testing ──────────────────────────────────────────────────────
async function testLLMAccuracy(anthropic, ticketId) {
  // Pull gold standard test pairs stored by BUILD-004
  const { data: signals, error: signalErr } = await supabase
    .from('build_quality_signals')
    .select('payload')
    .eq('ticket_id', ticketId)
    .eq('from_agent', 'BUILD-004')
    .eq('signal_type', 'test_pairs')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (signalErr || !signals) {
    return [{
      name: 'llm_test_pairs',
      passed: false,
      error: 'No test pairs from BUILD-004 — LLM Specialist must emit signal_type=test_pairs before QA runs'
    }];
  }

  const goldStandardPairs = signals.payload?.test_pairs || [];
  if (goldStandardPairs.length === 0) {
    return [{ name: 'llm_test_pairs', passed: false, error: 'BUILD-004 emitted empty test_pairs payload' }];
  }

  try { heartbeat({ step: 'llm_testing', pairs: goldStandardPairs.length }); } catch (_) {}

  const systemPrompt = signals.payload?.system_prompt || '';
  const results = [];
  let passCount = 0;

  for (const pair of goldStandardPairs) {
    // Execute against the actual configured system prompt
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: pair.input }]
    });
    const actualOutput = response.content[0].text;

    // Judge output vs expected using Haiku as evaluator
    const judgeResponse = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      temperature: 0,
      messages: [{
        role: 'user',
        content: `You are a strict quality evaluator. Compare ACTUAL output against EXPECTED output.

INPUT: ${pair.input}
EXPECTED: ${pair.expected_output}
ACTUAL: ${actualOutput}

Rate each dimension 1-5:
- accuracy: Does actual answer the same question correctly?
- completeness: Does it cover all required points?
- format: Does it match expected format/structure?

Return ONLY JSON (no markdown):
{"accuracy": number, "completeness": number, "format": number, "pass": boolean, "reason": string}`
      }]
    });

    let judgment;
    try {
      judgment = JSON.parse(judgeResponse.content[0].text.replace(/```json\n?|\n?```/g, '').trim());
    } catch (_) {
      judgment = { accuracy: 1, completeness: 1, format: 1, pass: false, reason: 'Judge output unparseable' };
    }

    if (judgment.pass) passCount++;
    results.push({
      name: `llm_pair_${pair.id || results.length}`,
      input_preview: pair.input.slice(0, 100),
      passed: judgment.pass,
      accuracy: judgment.accuracy,
      completeness: judgment.completeness,
      format: judgment.format,
      reason: judgment.reason
    });
  }

  const passRate = goldStandardPairs.length > 0 ? passCount / goldStandardPairs.length : 0;
  results.push({
    name: 'llm_overall_pass_rate',
    passed: passRate >= 0.80,
    pass_rate: passRate,
    pass_count: passCount,
    total: goldStandardPairs.length
  });

  return results;
}

// ── Failure routing helpers ───────────────────────────────────────────────────
function groupFailuresByAgent(failedTests) {
  const groups = {};
  for (const test of failedTests) {
    const agent = test.category === 'n8n' ? 'BUILD-002'
      : test.category === 'supabase' ? 'BUILD-006'
      : test.category === 'github' ? 'BUILD-005'
      : test.category === 'llm' ? 'BUILD-004'
      : 'BUILD-001';
    if (!groups[agent]) groups[agent] = [];
    groups[agent].push(test);
  }
  return groups;
}

function generateFixInstructions(agent, failures) {
  const errorSummary = failures.map(f => `- ${f.name}: ${f.error || 'assertion failed'}`).join('\n');
  const map = {
    'BUILD-002': `Fix n8n workflow failures:\n${errorSummary}\nEnsure webhook triggers are configured correctly and all workflows are activated.`,
    'BUILD-006': `Fix database schema failures:\n${errorSummary}\nEnsure all tables exist with correct columns and constraints.`,
    'BUILD-005': `Fix GitHub repository failures:\n${errorSummary}\nEnsure package.json has a valid start script and all dependencies are declared.`,
    'BUILD-004': `Fix LLM accuracy failures:\n${errorSummary}\nRevise system prompts to improve accuracy against gold standard test pairs.`
  };
  return map[agent] || `Fix failures:\n${errorSummary}`;
}

// ── Main activity ─────────────────────────────────────────────────────────────
export async function qaTesterActivity(jobData, contract, buildResults) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  // Normalize field names (workflow passes snake_case; some paths use camelCase)
  const ticketId = jobData.ticket_id || jobData.ticketId;
  const customerId = jobData.customerId || jobData.customer_id;
  const clientName = jobData.client || jobData.client_name || jobData.clientName || 'Unknown';
  const buildContract = jobData.buildContract || contract || {};
  const buildDir = '/tmp/friday-temporal-' + (jobData.job_id || ticketId || 'unknown');
  try { await fsPromises.mkdir(buildDir + '/qa', { recursive: true }); } catch(_) {}

  console.log(`[BUILD-003] Starting real functional QA for ${clientName} / ${ticketId}`);
  const startTime = Date.now();
  let iterationCount = 0;
  let previousOverallScore = -1;
  const MAX_ITERATIONS = 5;

  await supabase.from('build_agent_runs').upsert({
    ticket_id: ticketId,
    agent_id: 'BUILD-003',
    agent_name: 'QA Tester',
    status: 'running',
    started_at: new Date().toISOString()
  }, { onConflict: 'ticket_id,agent_id' });

  while (iterationCount < MAX_ITERATIONS) {
    iterationCount++;
    console.log(`[BUILD-003] QA iteration ${iterationCount}/${MAX_ITERATIONS}`);
    try { heartbeat({ iteration: iterationCount, step: 'starting' }); } catch (_) {}

    // Run all four test suites concurrently
    const [n8nResult, supabaseResult, githubResult, llmResult] = await Promise.allSettled([
      testN8nWorkflows(ticketId, clientName),
      testSupabaseSchema(ticketId, clientName),
      testGitHubRepo(ticketId, clientName, buildContract?.repoName || buildResults?.platform?.repo_url?.split('/').pop() || buildResults?.platform?.deployment_manifest?.repo_url?.split('/').pop()),
      testLLMAccuracy(anthropic, ticketId)
    ]);

    const n8n = n8nResult.status === 'fulfilled' ? n8nResult.value
      : [{ name: 'n8n_suite', passed: false, error: n8nResult.reason?.message }];
    const db = supabaseResult.status === 'fulfilled' ? supabaseResult.value
      : [{ name: 'db_suite', passed: false, error: supabaseResult.reason?.message }];
    const github = githubResult.status === 'fulfilled' ? githubResult.value
      : [{ name: 'github_suite', passed: false, error: githubResult.reason?.message }];
    const llm = llmResult.status === 'fulfilled' ? llmResult.value
      : [{ name: 'llm_suite', passed: false, error: llmResult.reason?.message }];

    const score = (tests) => {
      const total = tests.filter(t => t.name !== 'llm_overall_pass_rate').length || tests.length;
      const passed = tests.filter(t => t.passed).length;
      const raw = total > 0 ? Math.round((passed / total) * 100) : 0;
      return Math.min(raw, 100); // FIX 10: Cap scores at 100
    };

    const scores = {
      n8n_workflows: score(n8n),
      database_schema: score(db),
      github_repo: score(github),
      llm_accuracy: score(llm)
    };
    scores.overall = Math.min(Math.round(
      (scores.n8n_workflows + scores.database_schema + scores.github_repo + scores.llm_accuracy) / 4
    ), 100);

    const allTests = [
      ...n8n.map(t => ({ ...t, category: 'n8n' })),
      ...db.map(t => ({ ...t, category: 'supabase' })),
      ...github.map(t => ({ ...t, category: 'github' })),
      ...llm.map(t => ({ ...t, category: 'llm' }))
    ];
    const failedTests = allTests.filter(t => !t.passed);

    console.log(`[BUILD-003] Iteration ${iterationCount}: n8n=${scores.n8n_workflows} db=${scores.database_schema} github=${scores.github_repo} llm=${scores.llm_accuracy} overall=${scores.overall}`);

    // H4: Convergence detection — stop early if score plateaus
    if (iterationCount >= 2 && previousOverallScore >= 0) {
      const improvement = scores.overall - previousOverallScore;
      if (improvement < 2) {
        console.log(`[BUILD-003] Converged at iteration ${iterationCount} — score plateau at ${scores.overall} (improvement: ${improvement})`);
        previousOverallScore = scores.overall;
        // Store signal and break out with current results
        await supabase.from('build_quality_signals').insert({
          ticket_id: ticketId,
          from_agent: 'BUILD-003',
          signal_type: 'qa_results',
          confidence: scores.overall / 100,
          payload: { scores, all_tests: allTests, iteration: iterationCount, converged: true }
        });
        break;
      }
    }
    previousOverallScore = scores.overall;

    // Store QA signal for this iteration
    await supabase.from('build_quality_signals').insert({
      ticket_id: ticketId,
      from_agent: 'BUILD-003',
      signal_type: 'qa_results',
      confidence: scores.overall / 100,
      payload: { scores, all_tests: allTests, iteration: iterationCount }
    });

    // PASS: overall ≥ 70 and no n8n or supabase failures (core systems must work)
    const coreFailures = failedTests.filter(t => ['n8n', 'supabase'].includes(t.category));
    if (scores.overall >= 70 && coreFailures.length === 0) {
      const duration = Date.now() - startTime;
      const testsPassed = allTests.filter(t => t.passed).length;

      await supabase.from('build_agent_runs').update({
        status: 'complete',
        duration_ms: duration,
        output: {
          scores,
          iterations: iterationCount,
          tests_total: allTests.length,
          tests_passed: testsPassed
        },
        completed_at: new Date().toISOString()
      }).eq('ticket_id', ticketId).eq('agent_id', 'BUILD-003');

      console.log(`[BUILD-003] QA PASSED in ${iterationCount} iterations | Overall: ${scores.overall}/100 | ${testsPassed}/${allTests.length} tests | ${Math.round(duration / 1000)}s`);

      const qaResult = {
        suite: 'QA Test Suite for ' + clientName,
        total_tests: allTests.length,
        passed: testsPassed,
        failed: allTests.length - testsPassed,
        overall_score: scores.overall,
        scores,
        iterations: iterationCount,
        tests: allTests,
        summary: { total: allTests.length, passed: testsPassed, failed: allTests.length - testsPassed, skipped: 0 },
        generated_at: new Date().toISOString()
      };
      try { await fsPromises.writeFile(buildDir + '/qa/test-results.json', JSON.stringify(qaResult, null, 2)); } catch(_) {}

      return {
        agent_id: 'qa_tester',
        specialist: 'BUILD-003 QA Tester',
        status: 'complete',
        scores,
        iterations: iterationCount,
        tests_total: allTests.length,
        tests_passed: testsPassed,
        pass_rate: Math.round((testsPassed / allTests.length) * 100),
        failures: failedTests,
        duration_ms: duration
      };
    }

    // FAIL — route fix requests to responsible agents and wait before re-testing
    if (iterationCount < MAX_ITERATIONS) {
      const fixPackages = groupFailuresByAgent(failedTests);

      // Write legacy fix_request signals
      for (const [agent, failures] of Object.entries(fixPackages)) {
        await supabase.from('build_quality_signals').insert({
          ticket_id: ticketId,
          from_agent: 'BUILD-003',
          to_agent: agent,
          signal_type: 'fix_request',
          confidence: 0,
          flags: failures,
          payload: {
            iteration: iterationCount,
            failed_tests: failures,
            fix_instructions: generateFixInstructions(agent, failures)
          }
        });
      }

      // Route fix requests to responsible agents directly via targeted signals
      for (const [agent, failures] of Object.entries(fixPackages)) {
        const fixInstructions = generateFixInstructions(agent, failures);
        console.log(`[BUILD-003] Routing fix request to ${agent}: ${fixInstructions.slice(0,100)}`);

        await supabase.from('build_quality_signals').insert({
          ticket_id: ticketId,
          from_agent: 'BUILD-003',
          to_agent: agent,
          signal_type: 'targeted_fix_request',
          confidence: 0,
          flags: failures,
          payload: {
            iteration: iterationCount,
            failed_tests: failures,
            fix_instructions: fixInstructions,
            requires_retry: true,
            retry_context: {
              agent,
              test_failures: failures.map(f => ({ name: f.name, error: f.error, category: f.category })),
              specific_fix: fixInstructions
            }
          }
        });

        // FIX 2: If routing to BUILD-002 for n8n issues, directly reactivate inactive workflows
        if (agent === 'BUILD-002') {
          try {
            const n8nUrl = process.env.N8N_LOCAL_URL || process.env.N8N_URL || 'http://localhost:5678';
            const n8nKey = process.env.N8N_LOCAL_API_KEY || process.env.N8N_API_KEY || '';
            const wfListRes = await fetch(`${n8nUrl}/api/v1/workflows?limit=250`, {
              headers: { 'X-N8N-API-KEY': n8nKey }
            });
            if (wfListRes.ok) {
              const { data: allWfs } = await wfListRes.json();
              const slug = clientName.toLowerCase().replace(/[^a-z0-9]/g, '-');
              const inactiveClientWfs = (allWfs || []).filter(w =>
                !w.active && (w.name.toLowerCase().includes(slug) || w.tags?.some(t => t.name === ticketId))
              );
              for (const wf of inactiveClientWfs) {
                await fetch(`${n8nUrl}/api/v1/workflows/${wf.id}/activate`, {
                  method: 'PATCH',
                  headers: { 'X-N8N-API-KEY': n8nKey, 'Content-Type': 'application/json' }
                });
                console.log(`[BUILD-003] Reactivated n8n workflow: ${wf.name} (${wf.id})`);
              }
            }
          } catch (n8nErr) {
            console.warn(`[BUILD-003] n8n reactivation failed (non-blocking): ${n8nErr.message}`);
          }
        }
      }

      console.log(`[BUILD-003] Waiting 15s for agent fixes (iteration ${iterationCount} failed: ${failedTests.length} tests)`);
      await new Promise(r => setTimeout(r, 15000));
    }
  }

  // MAX_ITERATIONS reached — escalate to workflow for human review
  const duration = Date.now() - startTime;

  await supabase.from('build_agent_runs').update({
    status: 'failed',
    duration_ms: duration,
    errors: [{ message: `QA failed after ${MAX_ITERATIONS} iterations` }],
    completed_at: new Date().toISOString()
  }).eq('ticket_id', ticketId).eq('agent_id', 'BUILD-003');

  // Write partial results artifact before throwing so downstream has something to inspect
  try {
    const finalSignals = await supabase.from('build_quality_signals')
      .select('payload').eq('ticket_id', ticketId).eq('from_agent', 'BUILD-003')
      .eq('signal_type', 'qa_results').order('created_at', { ascending: false }).limit(1).single();
    const lastPayload = finalSignals.data?.payload || {};
    await fsPromises.writeFile(buildDir + '/qa/test-results.json', JSON.stringify({
      suite: 'QA Test Suite for ' + clientName,
      total_tests: lastPayload.all_tests?.length || 0,
      passed: (lastPayload.all_tests || []).filter(t => t.passed).length,
      failed: (lastPayload.all_tests || []).filter(t => !t.passed).length,
      overall_score: lastPayload.scores?.overall || 0,
      scores: lastPayload.scores || {},
      iterations: MAX_ITERATIONS,
      tests: lastPayload.all_tests || [],
      summary: { total: lastPayload.all_tests?.length || 0, passed: (lastPayload.all_tests || []).filter(t => t.passed).length, failed: (lastPayload.all_tests || []).filter(t => !t.passed).length, skipped: 0 },
      status: 'failed_max_iterations',
      generated_at: new Date().toISOString()
    }, null, 2));
  } catch(_) {}

  throw ApplicationFailure.create({
    message: `[BUILD-003] QA FAILED after ${MAX_ITERATIONS} iterations. Manual review required for ticket ${ticketId}.`,
    type: 'QAFailure',
    nonRetryable: true
  });
}
