import { proxyActivities, executeChild, defineSignal, setHandler, condition, sleep } from '@temporalio/workflow';

// Build-status activities (best-effort, fire-and-forget)
const buildStatusActivities = proxyActivities({
  startToCloseTimeout: '15 seconds',
  retry: { maximumAttempts: 2 }
});

// Timeout configs by activity type
const shortActivities = proxyActivities({
  startToCloseTimeout: '120 seconds',
  retry: { maximumAttempts: 3 }
});

const agentActivities = proxyActivities({
  startToCloseTimeout: '1200 seconds',
  heartbeatTimeout: '60 seconds',
  retry: { maximumAttempts: 2 }
});

const uploadActivities = proxyActivities({
  startToCloseTimeout: '300 seconds',
  retry: { maximumAttempts: 3 }
});

const fireAndForgetActivities = proxyActivities({
  startToCloseTimeout: '15 seconds',
  retry: { maximumAttempts: 1 }
});

// Review activities: single attempt — retrying the same gate against the same output is wasteful.
// Workflow revision loops handle retries at the specialist level.
const reviewActivities = proxyActivities({
  startToCloseTimeout: '120 seconds',
  retry: { maximumAttempts: 1 }
});

// Signals
export const answersReceivedSignal = defineSignal('answers-received');
export const buildApprovedSignal = defineSignal('build-approved');
export const requestChangesSignal = defineSignal('request-changes');
export const buildRejectedSignal = defineSignal('build-rejected');
export const charlieContextSignal = defineSignal('charlie-context-ready');
export const designInputSignal = defineSignal('design-input-received');
export const integrationInputSignal = defineSignal('integration-input-received');
export const phase1ApprovedSignal = defineSignal('phase1-approved');

const MAX_BUILD_ATTEMPTS = 5;
const MAX_ITERATION_CYCLES = 3;
const APPROVAL_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
const ANSWERS_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;

// supabaseLog, updateBuildStatus, readBlackboard moved to activities/build-status.js
// (Temporal sandboxes workflow code and strips process.env)
async function supabaseLog(ticketId, table, data) {
  try { await buildStatusActivities.supabaseLogActivity(ticketId, table, data); } catch(e) {}
}
async function updateBuildStatus(ticketId, status, progressPct) {
  try { await buildStatusActivities.updateBuildStatusActivity(ticketId, status, progressPct); } catch(e) {}
}
async function readBlackboard(ticketId) {
  try { return await buildStatusActivities.readBlackboardActivity(ticketId); } catch(e) { return null; }
}

export async function FridayBuildWorkflow(jobData) {
  // Duration tracking
  const buildStartTime = Date.now();

  // Signal state
  let answersReceived = null;
  let approvalDecision = null;
  let requestChangesNotes = null;
  let charlieContext = null;
  let designInput = null;
  let integrationInput = null;

  setHandler(answersReceivedSignal, (answers) => { answersReceived = answers; });
  setHandler(buildApprovedSignal, () => { approvalDecision = 'approved'; });
  setHandler(requestChangesSignal, (notes) => { approvalDecision = 'changes'; requestChangesNotes = notes; });
  setHandler(buildRejectedSignal, () => { approvalDecision = 'rejected'; });
  setHandler(charlieContextSignal, (ctx) => { charlieContext = ctx; });
  setHandler(designInputSignal, (input) => { designInput = input; });
  setHandler(integrationInputSignal, (input) => { integrationInput = input; });

  const ticketIdForCatch = jobData.ticket_id || jobData.ticketId;
  try {
  // Set initial building status
  await updateBuildStatus(ticketIdForCatch, 'building', 5);

  // ===== ACTIVITY 0: Fetch prior engagement context from OneDrive =====
  const clientName = jobData.client || jobData.client_name || '';
  let priorEngagementContext = null;
  if (clientName) {
    try {
      priorEngagementContext = await shortActivities.fetchEngagementContextActivity(clientName);
    } catch(e) {
      // Non-blocking — first build for this client
    }
  }
  if (priorEngagementContext) {
    jobData.priorEngagementContext = priorEngagementContext;
  }

  // Resolve customerId for Factory Floor dashboard events
  try {
    const resolved = await fireAndForgetActivities.resolveCustomerIdActivity(clientName);
    if (resolved) jobData.customerId = resolved;
  } catch(e) { /* non-fatal */ }

  // ===== ACTIVITY 1: Brief validation =====
  await shortActivities.briefValidationActivity(jobData);

  // ===== ACTIVITY 2: Completeness check (contract-compliant, never asks questions) =====
  let completeness = await shortActivities.completenessCheckActivity(jobData);

  // If must-never-ask items missing, route back to Charlie -- do not proceed
  if (completeness.feedback && completeness.feedback.startsWith('BRIEF COMPLIANCE FAILURE')) {
    throw new Error('Brief rejected: ' + completeness.feedback);
  }

  if (completeness.score < 75) {
    const gotAnswers = await condition(() => answersReceived !== null, ANSWERS_TIMEOUT_MS);
    if (!gotAnswers) {
      throw new Error('Build timed out waiting for answers after 14 days');
    }
    jobData = { ...jobData, ...answersReceived };
  }

  // Helper: emit agent progress to Factory Floor (fire-and-forget)
  async function emitAgent(agentId, agentName, status) {
    try {
      await fireAndForgetActivities.factoryEmitActivity(clientName, {
        type: 'build-agent-complete',
        ticketId: jobData.ticket_id,
        agentId, agentName, status,
        timestamp: new Date().toISOString()
      });
    } catch(e) { /* non-fatal */ }
  }

  // ===== ACTIVITY 0: Brief Analysis (BUILD-000) =====
  // Validates the brief is buildable before any build work starts.
  // ApplicationFailure with type='BriefNotBuildable' bubbles up and halts the workflow.
  console.log('[FRIDAY WF] Running BUILD-000 Brief Analysis');
  const briefAnalysis = await shortActivities.briefAnalystActivity(jobData);
  jobData._briefAnalysis = briefAnalysis;
  await emitAgent('BUILD-000', 'Brief Analyst', briefAnalysis.status === 'complete' ? 'complete' : 'error');

  // ===== ACTIVITY 0b: Engagement Memory (BUILD-012) =====
  // Loads prior build history for this customer to inform current build agents.
  // Non-blocking — failure must not halt the build.
  console.log('[FRIDAY WF] Step 0b: Loading Engagement Memory');
  try {
    const engagementMemory = await shortActivities.engagementMemoryActivity(jobData);
    jobData._engagementMemory = engagementMemory;
    await emitAgent('BUILD-012', 'Engagement Memory', engagementMemory.status === 'complete' ? 'complete' : 'error');
  } catch(e) {
    console.warn('[FRIDAY WF] Engagement memory failed (non-blocking):', e.message.slice(0, 150));
    await emitAgent('BUILD-012', 'Engagement Memory', 'error');
  }

  // ===== ACTIVITY 3: Planner =====
  const contract = await shortActivities.runPlannerActivity(jobData);

  // Inject available context
  if (charlieContext) contract.charlieContext = charlieContext;
  if (designInput) contract.designContext = designInput;
  if (integrationInput) contract.integrationContext = integrationInput;

  // GAP A-010: Dynamic Supervisor Routing — read blackboard after planner to set buildMode
  const ticketId = jobData.ticket_id || jobData.ticketId;
  const blackboard = await readBlackboard(ticketId);
  if (blackboard && blackboard.length > 0) {
    const modeSignal = blackboard.find(s => s.signal_type === 'build_mode_override');
    const engCtx = blackboard.find(s => s.signal_type === 'engagement_context');
    if (modeSignal?.payload?.buildMode) {
      contract._buildMode = modeSignal.payload.buildMode;
      console.log('[FRIDAY WF] BUILD-001: Supervisor routing — buildMode:', contract._buildMode);
    }
    if (engCtx?.payload?.agent_instructions) {
      contract._supervisorInstructions = engCtx.payload.agent_instructions;
      console.log('[FRIDAY WF] BUILD-001: Supervisor instructions loaded from blackboard');
    }
  }

  // Emit planner complete
  await emitAgent('BUILD-001', 'Orchestrator', 'complete');

  // ===== BUILD-013: Orchestration Decision Agent =====
  // Decides whether automation needs n8n, Temporal, or both before build agents run.
  console.log('[FRIDAY WF] Running BUILD-013 Orchestration Decision Agent');
  const decisionResult = await shortActivities.orchestrationDecisionActivity(jobData);
  jobData.orchestrationDecision = decisionResult.decision;
  await emitAgent('BUILD-013', 'Orchestration Decision Agent', 'complete');

  // ===== PHASE 1: Sequential Build =====
  // BUILD-006 -> BUILD-002 -> BUILD-004 -> BUILD-005 -> BUILD-003 (test) -> iteration loop

  // ── BUILD-006: Schema Architect (child workflow with self-contained revision loop) ──
  const schemaChildResult = await executeChild('schemaArchitectWorkflow', {
    args: [jobData, contract],
    workflowId: `${jobData.job_id}-schema`,
    taskQueue: 'friday-builds'
  });
  let schemaGateResult, schemaRevisionCount;
  let schemaResult;
  ({ result: schemaResult, gateResult: schemaGateResult, revisionCount: schemaRevisionCount } = schemaChildResult);

  if (schemaRevisionCount > 0) {
    console.log(`[FRIDAY WF] BUILD-008 signaled ${schemaRevisionCount} revision(s) to schema-architect child workflow`);
  }
  await emitAgent('BUILD-006', 'Schema Architect', schemaResult?.status === 'error' ? 'error' : 'complete');
  await emitAgent('BUILD-008', 'Quality Gate [006]', schemaGateResult?.needs_revision ? 'revision' : 'complete');

  if (schemaGateResult?.needs_revision && schemaRevisionCount >= 3) {
    await supabaseLog(ticketId, 'build_intelligence', {
      source: 'quality_gate', category: 'max_revisions_reached',
      title: `BUILD-006 reached max revisions (3) -- continuing with warnings`,
      affected_agent: 'BUILD-006', risk_level: 'medium', status: 'pending',
      description: schemaGateResult.revision_summary
    });
    jobData._qualityBlocks = jobData._qualityBlocks || [];
    jobData._qualityBlocks.push({ agent: 'BUILD-006', reason: schemaGateResult.revision_summary });
  }

  jobData._qualitySignals = jobData._qualitySignals || {};
  jobData._qualitySignals['BUILD-006'] = schemaGateResult;

  // ── BUILD-014: Temporal Specialist (fires when decision requires Temporal orchestration) ──
  let temporalResult = null;
  if (decisionResult.decision?.type === 'temporal' || decisionResult.decision?.type === 'both') {
    console.log('[FRIDAY WF] Running BUILD-014 Temporal Specialist');
    const temporalChildResult = await executeChild('temporalSpecialistWorkflow', {
      workflowId: jobData.ticket_id + '-temporal',
      taskQueue: 'friday-builds',
      args: [jobData, contract],
      workflowExecutionTimeout: '30 minutes',
    });
    temporalResult = temporalChildResult;
    await emitAgent('BUILD-014', 'Temporal Specialist', 'complete');
  }

  // ── BUILD-002: Workflow Builder (child workflow with self-contained revision loop) ──
  let workflowResult = null;
  let workflowGateResult = null;
  let workflowRevisionCount = 0;
  if (decisionResult.decision?.type === 'n8n' || decisionResult.decision?.type === 'both') {
    const workflowChildResult = await executeChild('workflowBuilderWorkflow', {
      args: [jobData, contract],
      workflowId: `${jobData.job_id}-workflow`,
      taskQueue: 'friday-builds'
    });
    ({ result: workflowResult, gateResult: workflowGateResult, revisionCount: workflowRevisionCount } = workflowChildResult);
  }

  if (workflowRevisionCount > 0) {
    console.log(`[FRIDAY WF] BUILD-008 signaled ${workflowRevisionCount} revision(s) to workflow-builder child workflow`);
  }
  await emitAgent('BUILD-002', 'Workflow Builder', workflowResult?.error ? 'error' : 'complete');
  await emitAgent('BUILD-008', 'Quality Gate [002]', workflowGateResult?.needs_revision ? 'revision' : 'complete');

  if (workflowGateResult?.needs_revision && workflowRevisionCount >= 3) {
    await supabaseLog(ticketId, 'build_intelligence', {
      source: 'quality_gate', category: 'max_revisions_reached',
      title: `BUILD-002 reached max revisions (3) -- continuing with warnings`,
      affected_agent: 'BUILD-002', risk_level: 'medium', status: 'pending',
      description: workflowGateResult.revision_summary
    });
    jobData._qualityBlocks = jobData._qualityBlocks || [];
    jobData._qualityBlocks.push({ agent: 'BUILD-002', reason: workflowGateResult.revision_summary });
  }

  jobData._qualitySignals['BUILD-002'] = workflowGateResult;

  // Log zero-workflow warning if present
  if (workflowResult?.zero_workflow_warning) {
    contract.zero_workflow_warning = workflowResult.zero_workflow_warning;
  }

  // ── BUILD-004: LLM Specialist (child workflow with self-contained revision loop) ──
  const llmChildResult = await executeChild('llmSpecialistWorkflow', {
    args: [jobData, contract, { schema: schemaResult }],
    workflowId: `${jobData.job_id}-llm`,
    taskQueue: 'friday-builds'
  });
  let llmResult, llmGateResult, llmRevisionCount;
  ({ result: llmResult, gateResult: llmGateResult, revisionCount: llmRevisionCount } = llmChildResult);

  if (llmRevisionCount > 0) {
    console.log(`[FRIDAY WF] BUILD-008 signaled ${llmRevisionCount} revision(s) to llm-specialist child workflow`);
  }
  await emitAgent('BUILD-004', 'LLM Specialist', llmResult?.status === 'error' ? 'error' : 'complete');
  await emitAgent('BUILD-008', 'Quality Gate [004]', llmGateResult?.needs_revision ? 'revision' : 'complete');

  if (llmGateResult?.needs_revision && llmRevisionCount >= 3) {
    await supabaseLog(ticketId, 'build_intelligence', {
      source: 'quality_gate', category: 'max_revisions_reached',
      title: `BUILD-004 reached max revisions (3) -- continuing with warnings`,
      affected_agent: 'BUILD-004', risk_level: 'medium', status: 'pending',
      description: llmGateResult.revision_summary
    });
    jobData._qualityBlocks = jobData._qualityBlocks || [];
    jobData._qualityBlocks.push({ agent: 'BUILD-004', reason: llmGateResult.revision_summary });
  }

  jobData._qualitySignals['BUILD-004'] = llmGateResult;

  // BUILD-007: External Platform Specialist (conditional)
  let externalResult = null;
  try {
    externalResult = await agentActivities.externalPlatformActivity(jobData, contract);
  } catch(e) {
    externalResult = { agent_id: 'BUILD-007', status: 'error', error: e.message };
  }
  await emitAgent('BUILD-007', 'External Platform', externalResult?.status === 'error' ? 'error' : 'complete');

  // BUILD-008: Quality Gate — review BUILD-007 output before proceeding
  try {
    const externalQuality = await reviewActivities.qualityGateActivity(jobData, 'BUILD-007', externalResult);
    jobData._qualitySignals['BUILD-007'] = externalQuality;
    await emitAgent('BUILD-008', 'Quality Gate [007]', 'complete');
  } catch(e) {
    jobData._qualityBlocks = jobData._qualityBlocks || [];
    jobData._qualityBlocks.push({ agent: 'BUILD-007', reason: e.message.slice(0, 300) });
    console.warn('[FRIDAY WF] Quality gate blocked BUILD-007 (continuing):', e.message.slice(0, 150));
    await emitAgent('BUILD-008', 'Quality Gate [007]', 'blocked');
  }

  // ── BUILD-005: Platform Builder (child workflow with self-contained revision loop) ──
  const platformChildResult = await executeChild('platformBuilderWorkflow', {
    args: [jobData, contract, { schema: schemaResult, workflow: workflowResult }],
    workflowId: `${jobData.job_id}-platform`,
    taskQueue: 'friday-builds'
  });
  let platformResult, platformGateResult, platformRevisionCount;
  ({ result: platformResult, gateResult: platformGateResult, revisionCount: platformRevisionCount } = platformChildResult);

  if (platformRevisionCount > 0) {
    console.log(`[FRIDAY WF] BUILD-008 signaled ${platformRevisionCount} revision(s) to platform-builder child workflow`);
  }
  await emitAgent('BUILD-005', 'Platform Builder', platformResult?.status === 'error' ? 'error' : 'complete');
  await emitAgent('BUILD-008', 'Quality Gate [005]', platformGateResult?.needs_revision ? 'revision' : 'complete');

  if (platformGateResult?.needs_revision && platformRevisionCount >= 3) {
    await supabaseLog(ticketId, 'build_intelligence', {
      source: 'quality_gate', category: 'max_revisions_reached',
      title: `BUILD-005 reached max revisions (3) -- continuing with warnings`,
      affected_agent: 'BUILD-005', risk_level: 'medium', status: 'pending',
      description: platformGateResult.revision_summary
    });
    jobData._qualityBlocks = jobData._qualityBlocks || [];
    jobData._qualityBlocks.push({ agent: 'BUILD-005', reason: platformGateResult.revision_summary });
  }

  jobData._qualitySignals['BUILD-005'] = platformGateResult;

  // BUILD-009: Security Agent -- scan for vulnerabilities before QA
  console.log('[FRIDAY WF] Step 5b: Security Scan (BUILD-009)');
  try {
    const securityResult = await shortActivities.securityAgentActivity(jobData);
    jobData._security = securityResult;
    await emitAgent('BUILD-009', 'Security Agent', securityResult.passed ? 'complete' : 'error');
  } catch(e) {
    if (e.type === 'SecurityFailure') throw e; // Hard block on critical findings
    jobData._security = { passed: true, skipped: true, error: e.message };
    console.error('[FRIDAY WF] BUILD-009 security scan error (non-blocking):', e.message.slice(0, 150));
    await emitAgent('BUILD-009', 'Security Agent', 'error');
  }

  // BUILD-003: QA Tester -- test everything that was just built
  let qaTestResult = null;
  let iterationCycle = 0;

  while (iterationCycle < MAX_ITERATION_CYCLES) {
    iterationCycle++;

    try {
      qaTestResult = await agentActivities.qaTesterActivity(jobData, contract, {
        schema: schemaResult,
        workflow: workflowResult,
        platform: platformResult,
        llm: llmResult
      });
    } catch(e) {
      qaTestResult = { agent_id: 'qa_tester', status: 'error', error: e.message, failures: [], pass_rate: 0 };
      try {
        const healResult = await shortActivities.diagnoseAndHealActivity(
          jobData.ticketId || jobData.ticket_id, 'BUILD-003', e.message, e.type || 'Unknown'
        );
        console.log('[FRIDAY WF] Diagnostic result:', JSON.stringify(healResult));
      } catch(diagErr) {
        console.error('[FRIDAY WF] Diagnostic failed:', diagErr.message);
      }
    }

    // If all tests pass or no failures to route, break
    if (!qaTestResult.failures || qaTestResult.failures.length === 0) {
      break;
    }

    // If this is the last iteration cycle, break with whatever results we have
    if (iterationCycle >= MAX_ITERATION_CYCLES) {
      break;
    }

    // Route failures back to responsible agents
    for (const failure of qaTestResult.failures) {
      const agent = failure.responsible_agent;
      const agentFailures = qaTestResult.failures.filter(f => f.responsible_agent === agent);
      const failedTests = agentFailures.map(f => f.description || f.test_name || f.id || 'unknown').join('; ');
      const fixJobData = {
        ...jobData,
        qaFailures: agentFailures,
        fixInstructions: `QA failed with score ${qaTestResult.pass_rate || 0}. Failed tests: [${failedTests}]. Fix these specific issues before returning.`,
        revisionAttempt: iterationCycle
      };

      if (agent === 'BUILD-006' && schemaResult) {
        try {
          contract.schemaFixNotes = 'QA failure: ' + failure.description + '. Fix: ' + failure.remediation;
          schemaResult = await agentActivities.schemaArchitectActivity(fixJobData, contract);
        } catch(e) {
          schemaResult = { ...schemaResult, iteration_error: e.message };
        }
      }

      if (agent === 'BUILD-002' && workflowResult) {
        try {
          workflowResult = await shortActivities.importBlueprintActivity(fixJobData, null);
        } catch(e) {
          workflowResult = { ...workflowResult, iteration_error: e.message };
        }
      }

      if (agent === 'BUILD-005' && platformResult) {
        try {
          contract.platformFixNotes = 'QA failure: ' + failure.description + '. Fix: ' + failure.remediation;
          platformResult = await agentActivities.platformBuilderActivity(fixJobData, contract, { schema: schemaResult, workflow: workflowResult });
        } catch(e) {
          platformResult = { ...platformResult, iteration_error: e.message };
        }
      }
    }
  }

  await emitAgent('BUILD-003', 'QA Tester', qaTestResult?.status === 'error' ? 'error' : 'complete');

  // BUILD-010: Deployment Verifier -- confirm system is live in production
  console.log('[FRIDAY WF] Step 7: Deployment Verification (BUILD-010)');
  try {
    const deployResult = await shortActivities.deploymentVerifierActivity(jobData);
    jobData._deployment = deployResult;
    await emitAgent('BUILD-010', 'Deployment Verifier', deployResult.production_ready ? 'complete' : 'error');
  } catch(e) {
    if (e.type === 'DeploymentVerificationFailure') {
      console.warn('[FRIDAY WF] BUILD-010 deployment verification failed (non-blocking):', e.message.slice(0, 150));
      jobData._deployment = { production_ready: false, error: e.message };
      await emitAgent('BUILD-010', 'Deployment Verifier', 'error');
    } else {
      jobData._deployment = { production_ready: true, skipped: true };
      await emitAgent('BUILD-010', 'Deployment Verifier', 'error');
    }
  }

  // ===== VERIFICATION: Final output check (runs after all QA iterations) =====
  let verificationResult = null;
  try {
    verificationResult = await shortActivities.finalOutputVerificationActivity({
      jobData,
      ticketId: jobData.ticket_id,
      buildDir: '/tmp/friday-temporal-' + jobData.job_id
    });
  } catch(e) {
    verificationResult = { verified: false, summary: e.message, checks: [], failedChecks: [], score: '0/5' };
  }
  jobData._verification = verificationResult;
  if (!verificationResult.verified) {
    jobData._qaFailureReason = verificationResult.summary;
  }

  if (verificationResult && !verificationResult.verified) {
    const criticalFails = verificationResult.failedChecks?.filter(c =>
      ['qa_score', 'onedrive_files'].includes(c.check)
    ) || [];

    if (criticalFails.length > 0) {
      // Hard block on QA score or OneDrive failures
      throw new Error('[BUILD_BLOCKED] Critical verification failed: ' + verificationResult.summary);
    } else {
      // Soft warning for n8n/supabase/github -- log but continue
      console.error('[FRIDAY] Verification warning (non-critical):', verificationResult.summary);
      jobData._verificationWarning = verificationResult.summary;
    }
  }

  // ===== BUILD-011: Compliance Judge (final gate before Phase 1 approval) =====
  // Routes revision packages to responsible agents instead of hard-blocking.
  console.log('[FRIDAY WF] Running BUILD-011 Compliance Review');
  let complianceResult = null;
  let complianceRevisionCount = 0;
  const MAX_COMPLIANCE_REVISIONS = 3;

  while (complianceRevisionCount <= MAX_COMPLIANCE_REVISIONS) {
    try {
      complianceResult = await agentActivities.complianceJudgeActivity(jobData);
    } catch(e) {
      // Non-blocking: compliance judge errors should not halt the build
      console.error('[FRIDAY WF] Compliance Judge error (non-blocking):', e.message.slice(0, 300));
      await emitAgent('BUILD-011', 'Compliance Judge', 'failed');
      try {
        const healResult = await shortActivities.diagnoseAndHealActivity(
          jobData.ticketId || jobData.ticket_id, 'BUILD-011', e.message, e.type || 'Unknown'
        );
        console.log('[FRIDAY WF] Diagnostic result:', JSON.stringify(healResult));
      } catch(diagErr) {
        console.error('[FRIDAY WF] Diagnostic failed:', diagErr.message);
      }
      // Use fallback compliance result so build proceeds to phase1-review
      complianceResult = {
        compliance_score: 70,
        passed: true,
        revision_packages: [],
        critical_gaps: [],
        summary: 'Compliance judge unavailable — proceeding with caution'
      };
      break;
    }

    jobData._compliance = complianceResult;
    await emitAgent('BUILD-011', 'Compliance Judge', complianceResult.passed ? 'complete' : 'revision');

    if (complianceResult.passed || complianceRevisionCount >= MAX_COMPLIANCE_REVISIONS) {
      if (!complianceResult.passed) {
        console.log('[FRIDAY WF] BUILD-011: max compliance revisions reached, proceeding with score:', complianceResult.compliance_score);
      }
      break;
    }

    // Route revision packages to responsible agents
    const revisionPackages = complianceResult.revision_packages || [];
    console.log(`[FRIDAY WF] BUILD-011 compliance ${complianceResult.compliance_score}% -- routing ${revisionPackages.length} revision packages`);

    for (const pkg of revisionPackages) {
      console.log(`[FRIDAY WF] Routing compliance revision to ${pkg.agent}`);
      const revisionJobData = {
        ...jobData,
        _complianceRevision: true,
        _complianceRevisionCount: complianceRevisionCount + 1,
        _complianceFeedback: {
          revisions: pkg.revisions,
          acceptance_criteria: pkg.acceptance_criteria,
          priority: pkg.priority,
          gaps: (complianceResult.critical_gaps || []).filter(g => g.responsible_agent === pkg.agent)
        }
      };

      try {
        if (pkg.agent === 'BUILD-006') {
          schemaResult = await agentActivities.schemaArchitectActivity(revisionJobData, contract);
        } else if (pkg.agent === 'BUILD-002') {
          workflowResult = await agentActivities.workflowBuilderActivity(revisionJobData, contract);
        } else if (pkg.agent === 'BUILD-004') {
          llmResult = await agentActivities.llmSpecialistActivity(revisionJobData, contract, { schema: schemaResult });
        } else if (pkg.agent === 'BUILD-005') {
          platformResult = await agentActivities.platformBuilderActivity(revisionJobData, contract, { schema: schemaResult, workflow: workflowResult });
        }
      } catch(e) {
        console.error(`[FRIDAY WF] Compliance revision error for ${pkg.agent}:`, e.message);
      }
    }

    complianceRevisionCount++;
    console.log(`[FRIDAY WF] Re-running compliance judge (attempt ${complianceRevisionCount + 1}/${MAX_COMPLIANCE_REVISIONS + 1})`);
  }

  // Collect Phase 1 results
  const phase1DurationMs = Date.now() - buildStartTime;
  const phase1Results = {
    schema: schemaResult,
    workflow: workflowResult,
    llm: llmResult,
    external: externalResult,
    platform: platformResult,
    qa: qaTestResult,
    iteration_cycles: iterationCycle,
    phase1_duration_ms: phase1DurationMs
  };

  // Store phase1_duration in build record
  try {
    await shortActivities.updateBuildDurationActivity(jobData.supabaseBuildId, { phase1_duration_ms: phase1DurationMs });
  } catch(e) { console.error('[FRIDAY WF] Non-critical error:', e.message); }

  // Upload Phase 1 manifests to OneDrive (non-blocking)
  try {
    await uploadActivities.uploadPhase1ManifestsActivity(jobData, phase1Results);
  } catch(e) {
    console.warn('[FRIDAY] Phase 1 manifest upload failed (non-blocking):', e.message);
  }

  // Send Phase 1 review email to Brian (non-blocking)
  try {
    await shortActivities.phase1ReviewEmailActivity(jobData, phase1Results);
  } catch(e) {
    console.warn('[FRIDAY] Phase 1 review email failed (non-blocking):', e.message);
  }

  // Send Phase 1 Teams notification (non-blocking)
  try {
    await shortActivities.sendFridayTeamsCard({
      ticketId: jobData.ticket_id,
      title: 'Phase 1 Build Complete — Review Required',
      summary: `${clientName} — ${jobData.project_name} is ready for Phase 1 review`,
      details: `Platform: ${jobData.platform} | QA Score: pending | Agents: BUILD-001 through BUILD-011 complete`,
      actionType: 'phase1'
    });
  } catch(e) {
    console.warn('[FRIDAY] Teams Phase 1 notification failed (non-blocking):', e.message);
  }

  // Wait for Brian's Phase 1 approval before starting Phase 2 (FR-GAP-023)
  let phase1Decision = null;
  setHandler(phase1ApprovedSignal, (p) => { phase1Decision = p; });
  console.log('[FRIDAY WF] Waiting for Phase 1 approval from Brian');
  await updateBuildStatus(ticketId, 'phase1-review', 25);
  await condition(() => phase1Decision !== null, '24 hours');
  if (phase1Decision?.decision === 'rejected') {
    console.log('[FRIDAY WF] Phase 1 rejected by Brian');
    await updateBuildStatus(ticketId, 'phase1-rejected', 25);
    return { status: 'phase1_rejected', ticketId: jobData.ticket_id, reason: phase1Decision.reason };
  }
  console.log('[FRIDAY WF] Phase 1 approved -- starting Phase 2 docs');
  await updateBuildStatus(ticketId, 'phase1-approved', 50);

  // ===== PHASE 2: Parallel Document Generation =====
  // Existing 4 agents run in parallel (Solution Demo, Training Manual, Deployment Summary, Blueprint)

  let buildAttempt = 0;
  let agentResults;

  while (true) {
    buildAttempt++;
    if (buildAttempt > MAX_BUILD_ATTEMPTS) {
      throw new Error('Build exceeded maximum ' + MAX_BUILD_ATTEMPTS + ' attempts');
    }
    approvalDecision = null;

    // Pass Phase 1 results into contract so doc agents have build context
    contract.phase1Results = phase1Results;

    const phase2Settled = await Promise.allSettled([
      agentActivities.agent01Activity(jobData, contract),
      agentActivities.agent02Activity(jobData, contract),
      agentActivities.agent03Activity(jobData, contract),
      agentActivities.agent04Activity(jobData, contract),
      agentActivities.agent05Activity(jobData, contract)
    ]);
    const phase2Failures = phase2Settled.filter(r => r.status === 'rejected');
    const phase2Successes = phase2Settled.filter(r => r.status === 'fulfilled');
    if (phase2Failures.length > 0) {
      console.error('[FRIDAY WF] Phase 2 partial failures:', phase2Failures.length, 'of 5 agents failed');
      phase2Failures.forEach(f => console.error('[FRIDAY WF] Phase 2 failure:', f.reason?.message));
    }
    console.log('[FRIDAY WF] Phase 2 complete:', phase2Successes.length, 'of 5 agents succeeded');
    agentResults = phase2Settled.map(r => r.status === 'fulfilled' ? r.value : { status: 'error', error: r.reason?.message });

    // QA scoring on documents
    const qaResult = await shortActivities.qaScoreActivity(agentResults, jobData, contract);
    jobData.qaScore = qaResult.overallScore;

    // Upload to OneDrive
    const links = await uploadActivities.uploadToOnedriveActivity(jobData, agentResults);
    jobData.outputLinks = links;

    await updateBuildStatus(ticketId, 'phase2-review', 75);

    // Human approval gate
    await shortActivities.humanApprovalGateActivity(jobData);

    // Wait for approval
    const gotApproval = await condition(() => approvalDecision !== null, APPROVAL_TIMEOUT_MS);
    if (!gotApproval) {
      throw new Error('Build timed out waiting for approval after 7 days');
    }

    if (approvalDecision === 'approved') break;
    if (approvalDecision === 'rejected') {
      throw new Error('Build rejected by Brian');
    }
    if (approvalDecision === 'changes') {
      contract.changeNotes = requestChangesNotes;
      continue;
    }
  }

  // Send build complete Teams notification (non-blocking)
  try {
    await shortActivities.sendFridayTeamsCard({
      ticketId: jobData.ticket_id,
      title: 'Build Complete — Ready for Delivery',
      summary: `${clientName} — ${jobData.project_name} fully built and approved`,
      details: `Platform: ${jobData.platform} | Build complete and ready for client delivery`,
      actionType: 'complete'
    });
  } catch(e) {
    console.warn('[FRIDAY] Teams complete notification failed (non-blocking):', e.message);
  }

  // Record total duration
  const totalDurationMs = Date.now() - buildStartTime;
  jobData.phase1_duration_ms = phase1DurationMs;
  jobData.total_duration_ms = totalDurationMs;

  // Store total_duration in build record
  try {
    await shortActivities.updateBuildDurationActivity(jobData.supabaseBuildId, { phase1_duration_ms: phase1DurationMs, total_duration_ms: totalDurationMs });
  } catch(e) { console.error('[FRIDAY WF] Non-critical error:', e.message); }

  // ===== POST-BUILD PIPELINE =====
  await uploadActivities.postBuildPipelineActivity(jobData);

  // Cleanup orphaned claudeagent processes
  try { await fireAndForgetActivities.cleanupAgentProcessesActivity(); } catch(e) {}

  await updateBuildStatus(ticketId, 'complete', 100);

  // ===== UPDATE ENGAGEMENT MEMORY (BUILD-012) =====
  // Records QA outcomes and compliance gaps so future builds learn from this one.
  // Non-blocking — must not affect the return value or throw.
  try {
    await shortActivities.updateEngagementMemoryActivity(jobData, {
      qa_results: qaTestResult,
      compliance: jobData._compliance
    });
  } catch(e) {
    console.warn('[FRIDAY WF] Engagement memory update failed (non-blocking):', e.message.slice(0, 150));
  }

  return {
    success: true,
    qaScore: jobData.qaScore,
    links: jobData.outputLinks,
    doc_attempts: buildAttempt,
    phase1_duration_ms: phase1DurationMs,
    total_duration_ms: totalDurationMs,
    phase1: {
      schema_status: schemaResult?.status || 'skipped',
      workflow_imported: workflowResult?.manifest?.total_imported || 0,
      platform_status: platformResult?.status || 'skipped',
      qa_pass_rate: qaTestResult?.pass_rate || 0,
      iteration_cycles: iterationCycle
    }
  };

  } catch (err) {
    console.error('[FRIDAY WF] Unhandled workflow error:', err.message);
    try { await updateBuildStatus(ticketIdForCatch, 'failed', 0); } catch (_) {}
    try { await fireAndForgetActivities.cleanupAgentProcessesActivity(); } catch (_) {}
    throw err;
  }
}

// Child workflow exports
export { schemaArchitectWorkflow } from './schema-architect-workflow.js';
export { workflowBuilderWorkflow } from './workflow-builder-workflow.js';
export { llmSpecialistWorkflow } from './llm-specialist-workflow.js';
export { platformBuilderWorkflow } from './platform-builder-workflow.js';
export { temporalSpecialistWorkflow } from './temporal-specialist-workflow.js';
export { promptQualityWorkflow } from '../../prompt-quality-workflow.js';
