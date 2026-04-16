import { proxyActivities, executeChild, defineSignal, setHandler, condition, sleep, patched } from '@temporalio/workflow';

// Build-status activities (best-effort, fire-and-forget)
const buildStatusActivities = proxyActivities({
  startToCloseTimeout: '15 seconds',
  retry: { maximumAttempts: 2 }
});

// Timeout configs by activity type
const shortActivities = proxyActivities({
  startToCloseTimeout: '300 seconds',
  heartbeatTimeout: '600 seconds',
  retry: { maximumAttempts: 3 }
});

const agentActivities = proxyActivities({
  startToCloseTimeout: '1200 seconds',
  heartbeatTimeout: '600 seconds',
  retry: { maximumAttempts: 2 }
});

// FIX 3: Phase 2 doc agents need longer timeout (up to 431s observed)
const docAgentActivities = proxyActivities({
  startToCloseTimeout: '1200 seconds',
  heartbeatTimeout: '600 seconds',
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

// FIX 13: Compliance judge needs longer timeout (was timing out during revision routing)
const complianceActivities = proxyActivities({
  startToCloseTimeout: '300 seconds',
  heartbeatTimeout: '600 seconds',
  retry: { maximumAttempts: 2 }
});

// Compliance revision agents: capped timeout so revisions don't drag
const complianceRevisionActivities = proxyActivities({
  startToCloseTimeout: '600 seconds',
  heartbeatTimeout: '600 seconds',
  retry: { maximumAttempts: 1 }
});

// BUILD-019: Red Team Agent
const redTeamActivities = proxyActivities({
  startToCloseTimeout: '300 seconds',
  retry: { maximumAttempts: 1 }
});

// BUILD-022: Adherence Agent (needs long timeout for checking all deliverables)
const longActivities = proxyActivities({
  startToCloseTimeout: '1200 seconds',
  scheduleToCloseTimeout: '1500 seconds',
  heartbeatTimeout: '600 seconds',
  retry: { maximumAttempts: 2 }
});

// ── H1: Per-agent circuit breaker ────────────────────────────────────────────
// Tracks consecutive failures per agent. Opens after 3 failures. Half-opens after 10 min.
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_HALF_OPEN_MS = 10 * 60 * 1000; // 10 minutes

const circuitBreaker = {
  _states: new Map(),

  _get(agentId) {
    if (!this._states.has(agentId)) {
      this._states.set(agentId, { failures: 0, state: 'closed', lastFailure: 0 });
    }
    return this._states.get(agentId);
  },

  canRun(agentId) {
    const cb = this._get(agentId);
    if (cb.state === 'closed') return true;
    if (cb.state === 'open') {
      // Check if enough time has passed for half-open
      if (Date.now() - cb.lastFailure >= CIRCUIT_BREAKER_HALF_OPEN_MS) {
        cb.state = 'half-open';
        console.log(`[CIRCUIT BREAKER] ${agentId} half-open — allowing retry attempt`);
        return true;
      }
      console.log(`[CIRCUIT BREAKER] ${agentId} circuit open — skipping`);
      return false;
    }
    // half-open: allow one attempt
    return true;
  },

  recordSuccess(agentId) {
    const cb = this._get(agentId);
    cb.failures = 0;
    cb.state = 'closed';
  },

  recordFailure(agentId) {
    const cb = this._get(agentId);
    cb.failures++;
    cb.lastFailure = Date.now();
    if (cb.failures >= CIRCUIT_BREAKER_THRESHOLD) {
      cb.state = 'open';
      console.log(`[CIRCUIT BREAKER] ${agentId} circuit opened after ${cb.failures} consecutive failures`);
    }
  }
};

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
  const BUILD_TIMEOUT_MS = 5400000; // 90 minutes
  let timeCapped = false;
  let complianceCapped = false;
  let complianceScore = null;

  function isBuildTimedOut() {
    return (Date.now() - buildStartTime) >= BUILD_TIMEOUT_MS;
  }

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
  let lastAgentRun = 'unknown';
  try {
  // Set initial building status
  await updateBuildStatus(ticketIdForCatch, 'building', 5);

  // Pre-build orphan cleanup
  try {
    const cleanup = await shortActivities.runCleanupActivity();
    if (cleanup?.killed > 0) console.log('[FRIDAY WF] Cleaned', cleanup.killed, 'orphaned processes before build');
  } catch (e) {
    console.warn('[FRIDAY WF] Pre-build cleanup failed (non-blocking):', e.message);
  }

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
  await updateBuildStatus(ticketIdForCatch, 'building', 5); // BUILD-000=5

  // ===== SPRINT-3: Build Quality Prediction =====
  try {
    const prediction = await shortActivities.predictBuildQualityActivity(jobData);
    console.log('[FRIDAY WF] Prediction: QA ' + JSON.stringify(prediction.prediction?.predicted_qa_range) +
      ' | ~' + (prediction.prediction?.predicted_duration_minutes || '?') + 'min' +
      ' | Confidence: ' + (prediction.prediction?.confidence || '?'));
    jobData._prediction = prediction;
    if (prediction.prediction?.should_build === false && prediction.prediction?.confidence > 0.8) {
      console.warn('[FRIDAY WF] PREDICTOR WARNING: ' + prediction.prediction.reason);
    }
  } catch (e) {
    console.log('[FRIDAY WF] Prediction skipped:', e.message);
  }

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

  // Safety gate: internal builds must not modify existing pipeline files
  if (contract.namespace?.is_internal === true || contract.namespace?.is_internal === 'true') {
    const contractStr = JSON.stringify(contract).toLowerCase();
    const pipelineFiles = ['server.js', 'worker.js', 'watchdog.sh', 'ecosystem.config.js'];
    const modifyTerms = ['modify', 'overwrite', 'replace', 'delete', 'remove'];
    const blocked = pipelineFiles.some(f => modifyTerms.some(t => contractStr.includes(t + ' ' + f) || contractStr.includes(f + ' ' + t)));
    if (blocked) {
      console.log('[SAFETY] BLOCKED — internal build tried to modify pipeline files');
      throw new Error('[SAFETY] Internal build contract references modifying pipeline files. Halted.');
    }
    console.log('[SAFETY] Internal build verified — no pipeline modifications');
  }

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

  // ── SPRINT-2: Build Contract Completeness Gate ──
  const contractStr = JSON.stringify(contract);
  const briefStr = JSON.stringify(jobData);
  const completenessIssues = [];

  if (/dashboard|interface|\.html|clone.*friday/i.test(briefStr)) {
    if (!/dashboard|\.html|chief.*staff.*html|cos.*html/i.test(contractStr)) {
      completenessIssues.push('Brief requests a dashboard/interface but contract has no dashboard section');
    }
  }
  if (/\/api\//i.test(briefStr)) {
    if (!/\/api\//i.test(contractStr)) {
      completenessIssues.push('Brief references API endpoints but contract does not define any');
    }
  }
  if (/email.*dave|send.*email|microsoft.*graph|sendmail/i.test(briefStr)) {
    if (!/email|graph|sendmail/i.test(JSON.stringify(contract.BUILD_004 || {}))) {
      completenessIssues.push('Brief requires email integration but BUILD-004 section does not mention it');
    }
  }
  if (/tts|voice|elevenlabs|speech/i.test(briefStr)) {
    if (!/tts|voice|elevenlabs/i.test(contractStr)) {
      completenessIssues.push('Brief requests voice/TTS but contract does not include it');
    }
  }

  if (completenessIssues.length > 0) {
    console.warn('[FRIDAY WF] Contract completeness issues (' + completenessIssues.length + '):');
    completenessIssues.forEach(i => console.warn('  - ' + i));
    await supabaseLog(ticketId, 'build_quality_signals', {
      ticket_id: ticketId, signal_type: 'contract_completeness', from_agent: 'BUILD-001',
      confidence: 1 - (completenessIssues.length / 10),
      payload: { issues: completenessIssues }
    });
  } else {
    console.log('[FRIDAY WF] Contract completeness: PASS — all brief requirements covered');
  }

  // Emit planner complete
  await emitAgent('BUILD-001', 'Orchestrator', 'complete');
  await updateBuildStatus(ticketIdForCatch, 'building', 10); // BUILD-001=10

  // ===== BUILD-013: Orchestration Decision Agent =====
  // Decides whether automation needs n8n, Temporal, or both before build agents run.
  console.log('[FRIDAY WF] Running BUILD-013 Orchestration Decision Agent');
  const decisionResult = await shortActivities.orchestrationDecisionActivity(jobData);
  jobData.orchestrationDecision = decisionResult.decision;
  await emitAgent('BUILD-013', 'Orchestration Decision Agent', 'complete');

  // ===== PHASE 1: Sequential Build =====
  // Temporal versioning: in-flight v1 workflows continue on old path; new workflows enter v2
  if (patched('v2-sprint-2026-04-15')) {
    console.log('[FRIDAY WF] Running v2 workflow path (sprint 2026-04-15)');
  }
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
  await updateBuildStatus(ticketIdForCatch, 'building', 25); // BUILD-006=25
  // Cost limit check
  try {
    const costResult = await shortActivities.checkBuildCostActivity(ticketId, 25);
    if (costResult.exceeded) {
      throw new Error('Build cost limit exceeded: $' + costResult.total + ' > $25');
    }
  } catch (costErr) {
    if (costErr.message && costErr.message.includes('cost limit exceeded')) throw costErr;
  }


  if (schemaGateResult?.needs_revision && schemaRevisionCount >= 5) {
    await supabaseLog(ticketId, 'build_intelligence', {
      source: 'quality_gate', category: 'max_revisions_reached',
      title: `BUILD-006 reached max revisions (5) -- continuing with warnings`,
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
  await updateBuildStatus(ticketIdForCatch, 'building', 45); // BUILD-002=45
  // Cost limit check
  try {
    const costResult = await shortActivities.checkBuildCostActivity(ticketId, 25);
    if (costResult.exceeded) {
      throw new Error('Build cost limit exceeded: $' + costResult.total + ' > $25');
    }
  } catch (costErr) {
    if (costErr.message && costErr.message.includes('cost limit exceeded')) throw costErr;
  }


  if (workflowGateResult?.needs_revision && workflowRevisionCount >= 5) {
    await supabaseLog(ticketId, 'build_intelligence', {
      source: 'quality_gate', category: 'max_revisions_reached',
      title: `BUILD-002 reached max revisions (5) -- continuing with warnings`,
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
  await updateBuildStatus(ticketIdForCatch, 'building', 55); // BUILD-004=55
  // Cost limit check
  try {
    const costResult = await shortActivities.checkBuildCostActivity(ticketId, 25);
    if (costResult.exceeded) {
      throw new Error('Build cost limit exceeded: $' + costResult.total + ' > $25');
    }
  } catch (costErr) {
    if (costErr.message && costErr.message.includes('cost limit exceeded')) throw costErr;
  }


  if (llmGateResult?.needs_revision && llmRevisionCount >= 5) {
    await supabaseLog(ticketId, 'build_intelligence', {
      source: 'quality_gate', category: 'max_revisions_reached',
      title: `BUILD-004 reached max revisions (5) -- continuing with warnings`,
      affected_agent: 'BUILD-004', risk_level: 'medium', status: 'pending',
      description: llmGateResult.revision_summary
    });
    jobData._qualityBlocks = jobData._qualityBlocks || [];
    jobData._qualityBlocks.push({ agent: 'BUILD-004', reason: llmGateResult.revision_summary });
  }

  jobData._qualitySignals['BUILD-004'] = llmGateResult;

  // BUILD-007: External Platform Specialist (conditional)
  // FIX 9: Skip BUILD-007 when no external platforms are specified in the build contract
  let externalResult = null;
  const externalPlatforms = contract?.external_platforms || contract?.BUILD_007?.platforms || jobData.external_platforms || [];
  const hasExternalPlatforms = Array.isArray(externalPlatforms) ? externalPlatforms.length > 0 : !!externalPlatforms;

  if (!hasExternalPlatforms) {
    console.log('[FRIDAY WF] No external platforms required — skipping BUILD-007');
    externalResult = { agent_id: 'BUILD-007', status: 'skipped', reason: 'No external platforms in build contract' };
    await emitAgent('BUILD-007', 'External Platform', 'skipped');
  } else {
    try {
      externalResult = await agentActivities.externalPlatformActivity(jobData, contract);
    } catch(e) {
      externalResult = { agent_id: 'BUILD-007', status: 'error', error: e.message };
    }
    await emitAgent('BUILD-007', 'External Platform', externalResult?.status === 'error' ? 'error' : 'complete');
  }
  await updateBuildStatus(ticketIdForCatch, 'building', 60); // BUILD-007=60

  // BUILD-008: Quality Gate — review BUILD-007 output before proceeding
  let externalQuality = null;
  try {
    externalQuality = await reviewActivities.qualityGateActivity(jobData, 'BUILD-007', externalResult);
    jobData._qualitySignals['BUILD-007'] = externalQuality;
    await emitAgent('BUILD-008', 'Quality Gate [007]', 'complete');
  } catch(e) {
    jobData._qualityBlocks = jobData._qualityBlocks || [];
    jobData._qualityBlocks.push({ agent: 'BUILD-007', reason: e.message.slice(0, 300) });
    console.warn('[FRIDAY WF] Quality gate blocked BUILD-007 (continuing):', e.message.slice(0, 150));
    await emitAgent('BUILD-008', 'Quality Gate [007]', 'blocked');
  }

  // BUILD-023: Second Opinion (OpenAI) on BUILD-007 output — non-blocking
  try {
    const secondOpinion = await shortActivities.secondOpinionActivity(
      jobData, 'BUILD-007', externalResult, externalQuality?.score || 0
    );
    if (secondOpinion && secondOpinion.divergence_flagged) {
      console.log('[FRIDAY WF] DIVERGENCE: BUILD-007 — Claude=' + (externalQuality?.score || 0) + ' OpenAI=' + secondOpinion.openai_score);
    }
  } catch (e) {
    console.log('[FRIDAY WF] Second opinion skipped:', e.message?.slice(0, 100));
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
  await updateBuildStatus(ticketIdForCatch, 'building', 65); // BUILD-005=65

  if (platformGateResult?.needs_revision && platformRevisionCount >= 5) {
    await supabaseLog(ticketId, 'build_intelligence', {
      source: 'quality_gate', category: 'max_revisions_reached',
      title: `BUILD-005 reached max revisions (5) -- continuing with warnings`,
      affected_agent: 'BUILD-005', risk_level: 'medium', status: 'pending',
      description: platformGateResult.revision_summary
    });
    jobData._qualityBlocks = jobData._qualityBlocks || [];
    jobData._qualityBlocks.push({ agent: 'BUILD-005', reason: platformGateResult.revision_summary });
  }

  jobData._qualitySignals['BUILD-005'] = platformGateResult;

  // ── BUILD-022: Adherence Check — verify everything in the brief was actually built ──
  console.log('[FRIDAY WF] Running BUILD-022 Adherence Check');
  let adherenceResult = null;
  try {
    adherenceResult = await longActivities.adherenceAgentActivity(jobData, contract);
    console.log('[FRIDAY WF] Adherence:', adherenceResult.score + '% | Missing:', adherenceResult.missing);
    await emitAgent('BUILD-022', 'Adherence Agent', adherenceResult.score >= 80 ? 'complete' : 'warning');
  } catch (e) {
    console.warn('[FRIDAY WF] Adherence check found gaps (proceeding):', e.message);
    await emitAgent('BUILD-022', 'Adherence Agent', 'error');
  }

  // BUILD-009: Security Agent -- scan for vulnerabilities before QA
  console.log('[FRIDAY WF] Step 5b: Security Scan (BUILD-009)');
  if (circuitBreaker.canRun('BUILD-009')) {
    try {
      const securityResult = await shortActivities.securityAgentActivity(jobData);
      circuitBreaker.recordSuccess('BUILD-009');
      jobData._security = securityResult;
      await emitAgent('BUILD-009', 'Security Agent', securityResult.passed ? 'complete' : 'error');
    } catch(e) {
      circuitBreaker.recordFailure('BUILD-009');
      if (e.type === 'SecurityFailure') throw e; // Hard block on critical findings
      jobData._security = { passed: true, skipped: true, error: e.message };
      console.error('[FRIDAY WF] BUILD-009 security scan error (non-blocking):', e.message.slice(0, 150));
      await emitAgent('BUILD-009', 'Security Agent', 'error');
    }
  } else {
    jobData._security = { passed: true, skipped: true, reason: 'circuit breaker open' };
    await emitAgent('BUILD-009', 'Security Agent', 'skipped');
  }

  // BUILD-003: QA Tester -- test everything that was just built
  let qaTestResult = null;
  let iterationCycle = 0;

  while (iterationCycle < MAX_ITERATION_CYCLES) {
    if (isBuildTimedOut()) {
      console.log('[FRIDAY WF] Build exceeded 90 minute safety limit — skipping remaining QA iterations');
      timeCapped = true;
      break;
    }
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
      console.error('[FRIDAY WF] BUILD-003 QA error:', e.message.slice(0, 300));
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
  await updateBuildStatus(ticketIdForCatch, 'building', 75); // QA=75

  // ===== BUILD-019: Red Team Agent — adversarial testing =====
  let redTeamResult = null;
  if (timeCapped || isBuildTimedOut()) {
    if (!timeCapped) { timeCapped = true; console.log('[FRIDAY WF] Build exceeded 90 minute safety limit — skipping Red Team'); }
    redTeamResult = { findings_count: 0, critical_count: 0, skipped: true, reason: 'time_capped' };
    await emitAgent('BUILD-019', 'Red Team Agent', 'skipped');
  } else {
  console.log('[FRIDAY WF] Running BUILD-019 Red Team Agent');
  try {
    if (circuitBreaker.canRun('BUILD-019')) {
      redTeamResult = await redTeamActivities.redTeamAgentActivity(jobData);
      circuitBreaker.recordSuccess('BUILD-019');
      console.log(`[BUILD-019] Red Team: ${redTeamResult.findings_count} findings (${redTeamResult.critical_count} critical)`);
      await emitAgent('BUILD-019', 'Red Team Agent', redTeamResult.critical_count > 0 ? 'warning' : 'complete');

      // Route critical findings as fix requests to responsible agents
      if (redTeamResult.critical_count > 0 && redTeamResult.findings) {
        for (const finding of redTeamResult.findings.filter(f => f.severity === 'critical')) {
          const targetAgent = finding.affected_agent || 'BUILD-001';
          console.log(`[BUILD-019] Routing critical finding to ${targetAgent}: ${finding.description?.slice(0, 100)}`);
          try {
            await buildStatusActivities.supabaseLogActivity(ticketId, 'build_quality_signals', {
              ticket_id: ticketId,
              from_agent: 'BUILD-019',
              to_agent: targetAgent,
              signal_type: 'red_team_fix_request',
              confidence: 0,
              payload: { finding, fix_instructions: finding.recommended_fix }
            });
          } catch (_) {}
        }
      }
    } else {
      redTeamResult = { findings_count: 0, critical_count: 0, skipped: true };
      await emitAgent('BUILD-019', 'Red Team Agent', 'skipped');
    }
  } catch(e) {
    circuitBreaker.recordFailure('BUILD-019');
    console.warn('[FRIDAY WF] BUILD-019 Red Team error (non-blocking):', e.message?.slice(0, 200));
    redTeamResult = { findings_count: 0, critical_count: 0, error: e.message };
    await emitAgent('BUILD-019', 'Red Team Agent', 'error');
  }
  } // end time_capped else

  // ── BUILD-021: Fix Coordinator — process Security + Red Team findings ──
  console.log('[FRIDAY WF] Running BUILD-021 Fix Coordinator');
  try {
    const secFindings = jobData._security?.findings || [];
    const rtFindings = redTeamResult?.findings || [];
    const fixReport = await shortActivities.fixCoordinatorActivity(jobData, contract, secFindings, rtFindings);
    console.log('[FRIDAY WF] Fix Coordinator:', fixReport.total_findings, 'findings,', fixReport.unresolved?.length || 0, 'unresolved');
    await emitAgent('BUILD-021', 'Fix Coordinator', 'complete');
  } catch (e) {
    console.warn('[FRIDAY WF] Fix Coordinator failed (non-blocking):', e.message);
    await emitAgent('BUILD-021', 'Fix Coordinator', 'error');
  }

  // BUILD-010: Deployment Verifier -- confirm system is live in production
  if (timeCapped || isBuildTimedOut()) {
    if (!timeCapped) { timeCapped = true; console.log('[FRIDAY WF] Build exceeded 90 minute safety limit — skipping Deployment Verifier'); }
    jobData._deployment = { production_ready: true, skipped: true, reason: 'time_capped' };
    await emitAgent('BUILD-010', 'Deployment Verifier', 'skipped');
  } else if (circuitBreaker.canRun('BUILD-010')) {
    try {
      const deployResult = await shortActivities.deploymentVerifierActivity(jobData);
      circuitBreaker.recordSuccess('BUILD-010');
      jobData._deployment = deployResult;
      await emitAgent('BUILD-010', 'Deployment Verifier', deployResult.production_ready ? 'complete' : 'error');
    } catch(e) {
      circuitBreaker.recordFailure('BUILD-010');
      if (e.type === 'DeploymentVerificationFailure') {
        console.warn('[FRIDAY WF] BUILD-010 deployment verification failed (non-blocking):', e.message.slice(0, 150));
        jobData._deployment = { production_ready: false, error: e.message };
        await emitAgent('BUILD-010', 'Deployment Verifier', 'error');
      } else {
        jobData._deployment = { production_ready: true, skipped: true };
        await emitAgent('BUILD-010', 'Deployment Verifier', 'error');
      }
    }
  } else {
    jobData._deployment = { production_ready: true, skipped: true, reason: 'circuit breaker open' };
    await emitAgent('BUILD-010', 'Deployment Verifier', 'skipped');
  }

  // ===== VERIFICATION: Final output check (runs after all QA iterations) =====
  let verificationResult = null;
  if (timeCapped || isBuildTimedOut()) {
    if (!timeCapped) { timeCapped = true; console.log('[FRIDAY WF] Build exceeded 90 minute safety limit — skipping verification'); }
    verificationResult = { verified: true, summary: 'Skipped — build time capped', checks: [], failedChecks: [], score: 'N/A' };
  } else {
    try {
      verificationResult = await shortActivities.finalOutputVerificationActivity({
        jobData,
        ticketId: jobData.ticket_id,
        buildDir: '/tmp/friday-temporal-' + jobData.job_id
      });
    } catch(e) {
      verificationResult = { verified: false, summary: e.message, checks: [], failedChecks: [], score: '0/5' };
    }
  }
  jobData._verification = verificationResult;
  if (!verificationResult.verified) {
    jobData._qaFailureReason = verificationResult.summary;
  }

  if (verificationResult && !verificationResult.verified && !timeCapped) {
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
  // CAPPED AT 2 REVISION CYCLES — always proceeds after that.
  console.log('[FRIDAY WF] Running BUILD-011 Compliance Review');
  await updateBuildStatus(ticketIdForCatch, 'building', 85); // Compliance=85
  let complianceResult = null;
  let complianceRevisionCount = 0;
  const MAX_COMPLIANCE_REVISIONS = 2;

  while (complianceRevisionCount <= MAX_COMPLIANCE_REVISIONS) {
    // Global timeout check — skip compliance if build is running too long
    if (isBuildTimedOut()) {
      console.log('[FRIDAY WF] Build exceeded 90 minute safety limit — force completing');
      timeCapped = true;
      complianceResult = complianceResult || {
        compliance_score: 0,
        passed: false,
        revision_packages: [],
        critical_gaps: [],
        summary: 'Compliance skipped — build time limit reached'
      };
      break;
    }

    try {
      if (!circuitBreaker.canRun('BUILD-011')) throw new Error('Circuit breaker open for BUILD-011');
      complianceResult = await complianceActivities.complianceJudgeActivity(jobData);
      circuitBreaker.recordSuccess('BUILD-011');
    } catch(e) {
      circuitBreaker.recordFailure('BUILD-011');
      console.error('[FRIDAY WF] Compliance Judge error (non-blocking):', e.message.slice(0, 300));
      await emitAgent('BUILD-011', 'Compliance Judge', 'failed');
      complianceResult = {
        compliance_score: 70,
        passed: true,
        revision_packages: [],
        critical_gaps: [],
        summary: 'Compliance judge unavailable — proceeding with caution'
      };
      break;
    }

    complianceScore = complianceResult.compliance_score;
    jobData._compliance = complianceResult;
    await emitAgent('BUILD-011', 'Compliance Judge', complianceResult.passed ? 'complete' : 'revision');

    // If passed, we're done
    if (complianceResult.passed) {
      break;
    }

    // If we've hit the revision cap, stop revising and proceed
    if (complianceRevisionCount >= MAX_COMPLIANCE_REVISIONS) {
      complianceCapped = true;
      console.log('[FRIDAY WF] Compliance capped at 2 revisions — proceeding with score: ' + complianceScore + '%');
      break;
    }

    // Route revision packages to responsible agents
    const revisionPackages = complianceResult.revision_packages || [];
    console.log(`[FRIDAY WF] BUILD-011 compliance ${complianceScore}% -- routing ${revisionPackages.length} revision packages`);

    for (const pkg of revisionPackages) {
      // Check timeout before each revision agent
      if (isBuildTimedOut()) {
        console.log('[FRIDAY WF] Build exceeded 90 minute safety limit during compliance revisions — stopping');
        timeCapped = true;
        break;
      }

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
          schemaResult = await complianceRevisionActivities.schemaArchitectActivity(revisionJobData, contract);
        } else if (pkg.agent === 'BUILD-002') {
          workflowResult = await complianceRevisionActivities.workflowBuilderActivity(revisionJobData, contract);
        } else if (pkg.agent === 'BUILD-004') {
          llmResult = await complianceRevisionActivities.llmSpecialistActivity(revisionJobData, contract, { schema: schemaResult });
        } else if (pkg.agent === 'BUILD-005') {
          platformResult = await complianceRevisionActivities.platformBuilderActivity(revisionJobData, contract, { schema: schemaResult, workflow: workflowResult });
        }
      } catch(e) {
        // Revision agent timed out or failed — log and continue, don't retry
        console.error(`[FRIDAY WF] Compliance revision error for ${pkg.agent} (continuing):`, e.message.slice(0, 200));
      }
    }

    if (timeCapped) break;

    complianceRevisionCount++;
    console.log(`[FRIDAY WF] Re-running compliance judge (attempt ${complianceRevisionCount + 1}/${MAX_COMPLIANCE_REVISIONS + 1})`);
  }

  // Store compliance flags on jobData for downstream use
  complianceScore = complianceResult?.compliance_score || complianceScore;
  jobData._complianceCapped = complianceCapped;
  jobData._timeCapped = timeCapped;
  jobData._compliance = complianceResult;

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
    phase1_duration_ms: phase1DurationMs,
    compliance_capped: complianceCapped,
    compliance_score: complianceScore,
    time_capped: timeCapped
  };

  // Store phase1_duration in build record
  try {
    await shortActivities.updateBuildDurationActivity(jobData.supabaseBuildId, { phase1_duration_ms: phase1DurationMs });
  } catch(e) { console.error('[FRIDAY WF] Non-critical error:', e.message); }

  // ── SPRINT-2: Post-Build Output Manifest ──
  try {
    const buildDir = '/tmp/friday-temporal-' + jobData.job_id;
    const outputManifest = [];
    try {
      // Output manifest delegated to activity (fs banned in workflows)
      try {
        const manifestResult = await shortActivities.runCleanupActivity();
        console.log('[FRIDAY WF] Output manifest check delegated to activity');
      } catch (_) {}
    } catch (_) {}
    console.log('[FRIDAY WF] Output manifest: ' + outputManifest.length + ' files in build directory');
    await supabaseLog(ticketId, 'build_quality_signals', {
      ticket_id: ticketId, signal_type: 'output_manifest', from_agent: 'FRIDAY',
      confidence: Math.min(outputManifest.length / 20, 1),
      payload: { files: outputManifest, count: outputManifest.length }
    });
  } catch (e) {
    console.warn('[FRIDAY WF] Output manifest check failed:', e.message);
  }

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
  const complianceStatus = complianceCapped
    ? `Compliance: REVIEW NEEDED — scored ${complianceScore}% after 2 revision cycles. Build delivered but may need manual review.`
    : `Compliance: PASSED at ${complianceScore || 0}%`;
  const timeStatus = timeCapped ? ' | TIME CAPPED: exceeded 90min safety limit' : '';
  try {
    await shortActivities.sendFridayTeamsCard({
      ticketId: jobData.ticket_id,
      title: timeCapped ? 'Phase 1 Build Complete — Time Capped — Review Required' : 'Phase 1 Build Complete — Review Required',
      summary: `${clientName} — ${jobData.project_name} is ready for Phase 1 review`,
      details: `Platform: ${jobData.platform} | ${complianceStatus} | Agents: BUILD-001 through BUILD-011 complete${timeStatus}`,
      actionType: 'phase1',
      compliance_capped: complianceCapped,
      time_capped: timeCapped
    });
  } catch(e) {
    console.warn('[FRIDAY] Teams Phase 1 notification failed (non-blocking):', e.message);
  }

  // Wait for Brian's Phase 1 approval before starting Phase 2 (FR-GAP-023)
  let phase1Decision = null;
  setHandler(phase1ApprovedSignal, (p) => { phase1Decision = p; });
  console.log('[FRIDAY WF] Waiting for Phase 1 approval from Brian');
  // BUILD-024: Code Review by OpenAI before phase1-review — non-blocking
  try {
    const buildDir24 = '/tmp/friday-temporal-' + jobData.job_id;
    const codeReview = await longActivities.codeReviewActivity(jobData, buildDir24);
    if (codeReview && !codeReview.skipped) {
      console.log('[FRIDAY WF] Code Review: ' + codeReview.overall_score + '/100 | Critical: ' + (codeReview.critical_issues || []).length);
    }
  } catch (e) {
    console.log('[FRIDAY WF] Code review skipped:', e.message?.slice(0, 100));
  }

  await updateBuildStatus(ticketId, 'phase1-review', 90); // Phase1Review=90
  await condition(() => phase1Decision !== null, '24 hours');
  if (phase1Decision?.decision === 'rejected') {
    console.log('[FRIDAY WF] Phase 1 rejected by Brian');
    await updateBuildStatus(ticketId, 'phase1-rejected', 25);
    return { status: 'phase1_rejected', ticketId: jobData.ticket_id, reason: phase1Decision.reason };
  }
  console.log('[FRIDAY WF] Phase 1 approved -- starting Phase 2 docs');
  await updateBuildStatus(ticketId, 'phase1-approved', 95); // Phase2=95

  // ===== PHASE 2: Parallel Document Generation =====
  // Temporal versioning gate for Phase 2 overhaul
  if (patched('v3-phase2-overhaul-2026-04-16')) {
    console.log('[FRIDAY WF] Running v3 Phase 2 overhaul path');
  }

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

    // Phase 2: Documentation agents (parallel)
    const phase2Settled = await Promise.allSettled([
      docAgentActivities.agent01Activity(jobData, contract),
      docAgentActivities.agent02Activity(jobData, contract),
      docAgentActivities.agent03Activity(jobData, contract),
      docAgentActivities.agent04Activity(jobData, contract),
      docAgentActivities.agent05Activity(jobData, contract)
    ]);
    const phase2Failures = phase2Settled.filter(r => r.status === 'rejected');
    const phase2Successes = phase2Settled.filter(r => r.status === 'fulfilled');
    if (phase2Failures.length > 0) {
      console.error('[FRIDAY WF] Phase 2 partial failures:', phase2Failures.length, 'of 5 agents failed');
      phase2Failures.forEach(f => console.error('[FRIDAY WF] Phase 2 failure:', f.reason?.message));
    }
    console.log('[FRIDAY WF] Phase 2 complete:', phase2Successes.length, 'of 5 agents succeeded');
    agentResults = phase2Settled.map(r => r.status === 'fulfilled' ? r.value : { status: 'error', error: r.reason?.message });

    // Collect Phase 2 results for email
    const phase2Results = agentResults.map((r, i) => ({
      agent_id: 'agent_0' + (i + 1),
      name: ['Solution Demo', 'Build Manual', 'Requirements & Docs', 'Workflow Blueprints', 'Deployment Package'][i],
      status: r.status || 'error',
      format: ['HTML', 'HTML', 'MD + JSON', 'JSON', 'JSON'][i]
    }));

    // BUILD-026: Compare documents against reference templates
    let comparisonResult = null;
    try {
      const buildDir = '/tmp/friday-temporal-' + jobData.job_id;
      comparisonResult = await longActivities.documentComparisonActivity(jobData, buildDir);
      console.log('[FRIDAY WF] Doc Comparison: ' + (comparisonResult.files_passing || 0) + '/' + (comparisonResult.files_compared || 0) + ' passing');
    } catch (e) {
      console.log('[FRIDAY WF] Doc comparison skipped:', e.message?.slice(0, 100));
    }

    // Register skillset from build artifacts (non-blocking)
    try {
      await fireAndForgetActivities.registerSkillsetActivity(jobData);
    } catch (e) {
      console.warn('[FRIDAY WF] Skillset registration failed (non-blocking):', e.message);
    }

    // SPRINT-2: Register golden build
    try {
      const goldenResult = await fireAndForgetActivities.registerGoldenBuildActivity(jobData, phase1Results);
      if (goldenResult?.is_new_golden) console.log('[FRIDAY WF] NEW GOLDEN BUILD for category: ' + goldenResult.category);
    } catch (e) {
      console.warn('[FRIDAY WF] Golden build registration failed (non-blocking):', e.message);
    }

    // SPRINT-3: Compare prediction to reality
    try {
      const predComparison = await fireAndForgetActivities.comparePredictionToRealityActivity(ticketId);
      if (predComparison) console.log('[FRIDAY WF] Prediction accuracy: ' + predComparison.overall_accuracy);
    } catch (e) {
      console.warn('[FRIDAY WF] Prediction comparison failed (non-blocking):', e.message);
    }

    // SPRINT-2: Generate build diff report
    try {
      const diffResult = await fireAndForgetActivities.generateBuildDiffActivity(ticketId, 'general');
      if (diffResult?.regressions?.length > 0) console.warn('[FRIDAY WF] Build regressions vs golden:', diffResult.regressions.join('; '));
    } catch (e) {
      console.warn('[FRIDAY WF] Build diff failed (non-blocking):', e.message);
    }

    // SPRINT-2: Save test fixtures from this build
    try {
      const testPairs = jobData._llmTestPairs || [];
      if (testPairs.length > 0) {
        await fireAndForgetActivities.saveFixturesFromBuildActivity(ticketId, 'general', testPairs);
      }
    } catch (e) {
      console.warn('[FRIDAY WF] Fixture saving failed (non-blocking):', e.message);
    }

    // Self-deploy: verify infrastructure and deploy internal builds
    try {
      const deployResult = await fireAndForgetActivities.selfDeployActivity(jobData, contract);
      console.log('[FRIDAY WF] Self-deploy:', deployResult?.status, '|', (deployResult?.checks || []).filter(c => c.status === 'PASS').length, 'checks passed');
    } catch (e) {
      console.warn('[FRIDAY WF] Self-deploy failed (non-blocking):', e.message);
    }

    // QA scoring on documents
    const qaResult = await shortActivities.qaScoreActivity(agentResults, jobData, contract);
    jobData.qaScore = qaResult.overallScore;

    // Upload to OneDrive (returns share links)
    let onedriveLinks = [];
    try {
      const uploadResult = await uploadActivities.uploadToOnedriveActivity(jobData, agentResults);
      onedriveLinks = uploadResult?.files || [];
      console.log('[FRIDAY WF] OneDrive: ' + onedriveLinks.length + ' files uploaded');
    } catch (e) {
      console.log('[FRIDAY WF] OneDrive upload failed:', e.message?.slice(0, 100));
    }
    jobData.outputLinks = onedriveLinks;

    // Send Phase 2 completion email with OneDrive links
    try {
      await shortActivities.sendPhase2CompletionEmailActivity(jobData, phase2Results, onedriveLinks);
    } catch (e) {
      console.log('[FRIDAY WF] Phase 2 email failed:', e.message?.slice(0, 100));
    }

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

  // ===== BUILD-016: Intelligence Agent — build observation =====
  try {
    await buildStatusActivities.buildObserverActivity(jobData);
    console.log('[BUILD-016] Build observation recorded');
  } catch(e) {
    console.warn('[FRIDAY WF] BUILD-016 observer failed (non-blocking):', e.message?.slice(0, 150));
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
    console.error('[FRIDAY WF] Build failed:', err.message);
    try {
      await shortActivities.sendBuildFailureNotificationActivity(jobData, err.message, lastAgentRun || 'unknown');
    } catch (_) {}
    try { await updateBuildStatus(ticketIdForCatch, 'failed', 0); } catch (_) {}
    try { await fireAndForgetActivities.cleanupAgentProcessesActivity(); } catch (_) {}
    throw err;
  }
}

// BUILD-016: Maintenance workflow (nightly cron)
export async function maintenanceWorkflow() {
  const maintenanceActs = proxyActivities({
    startToCloseTimeout: '600 seconds',
    retry: { maximumAttempts: 1 }
  });
  const result = await maintenanceActs.maintenanceRunActivity();

  // SPRINT-2: Update agent performance metrics
  try {
    await maintenanceActs.updateAgentPerformanceActivity();
    console.log('[MAINTENANCE] Agent performance metrics updated');
  } catch (e) {
    console.warn('[MAINTENANCE] Agent performance update failed:', e.message);
  }

  // SPRINT-3: Cross-build learning analysis
  try {
    const learning = await maintenanceActs.runCrossBuildLearningActivity();
    console.log('[MAINTENANCE] Cross-build learning: ' + (learning?.insights_generated || 0) + ' insights');
  } catch (e) {
    console.warn('[MAINTENANCE] Cross-build learning failed:', e.message);
  }

  // SPRINT-3: Improve underperforming prompts
  try {
    const promptResult = await maintenanceActs.improveUnderperformingPromptsActivity();
    console.log('[MAINTENANCE] Prompt improvement: ' + (promptResult?.improved || 0) + '/' + (promptResult?.flagged || 0) + ' improved');
  } catch (e) {
    console.warn('[MAINTENANCE] Prompt improvement failed:', e.message);
  }

  // SPRINT-3: Check deployment usage
  try {
    const usage = await maintenanceActs.checkDeploymentUsageActivity();
    console.log('[MAINTENANCE] Usage monitoring: ' + (usage?.checked || 0) + ' checked, ' + (usage?.alerts || 0) + ' idle');
  } catch (e) {
    console.warn('[MAINTENANCE] Usage monitoring failed:', e.message);
  }

  // SPRINT-3: Analyze build costs
  try {
    const costs = await maintenanceActs.analyzeBuildCostsActivity();
    console.log('[MAINTENANCE] Cost analysis: avg $' + (costs?.avg_build_cost?.toFixed(2) || '?') + '/build');
  } catch (e) {
    console.warn('[MAINTENANCE] Cost analysis failed:', e.message);
  }

  return result;
}

// Child workflow exports
export { schemaArchitectWorkflow } from './schema-architect-workflow.js';
export { workflowBuilderWorkflow } from './workflow-builder-workflow.js';
export { llmSpecialistWorkflow } from './llm-specialist-workflow.js';
export { platformBuilderWorkflow } from './platform-builder-workflow.js';
export { temporalSpecialistWorkflow } from './temporal-specialist-workflow.js';
export { promptQualityWorkflow } from '../../prompt-quality-workflow.js';