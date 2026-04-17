/**
 * BUILD-021: Voice Agent Developer
 * Writes production voice automation systems using Retell AI or Vapi + Twilio.
 * Runs on deep queue. Coordination-native.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { runClaudeCode, runTests, countOutputFiles } from './deep-shared.js';
import { buildSiblingContext, publishState, sendAgentMessage } from './coordination.js';
import { createClient } from '@supabase/supabase-js';
import { promisify } from 'util';
import { execFile } from 'child_process';

const execFileAsync = promisify(execFile);

export async function buildVoiceAgentActivity(jobData) {
  const ticketId = jobData.ticket_id;
  const parentTicketId = jobData.parent_ticket_id || null;
  const buildDir = `/tmp/friday-deep-${ticketId}`;
  const startTime = Date.now();

  console.log(`[BUILD-021] Starting voice agent build: ${jobData.project_name}`);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Publish starting state for siblings
  await publishState({
    parent_ticket_id: parentTicketId,
    child_ticket_id: ticketId,
    agent_id: 'BUILD-021',
    deep_build_type: 'voice_agent',
    phase: 'starting',
    progress_percent: 0
  });

  try {
    await supabase.from('friday_deep_builds').update({
      status: 'running',
      started_at: new Date().toISOString()
    }).eq('ticket_id', ticketId);
  } catch (_) {}

  // Build context from siblings + fast-queue + contract
  const siblingContext = await buildSiblingContext(parentTicketId, 'BUILD-021');

  const basePrompt = buildVoiceAgentPrompt(jobData);
  const enhancedPrompt = basePrompt + siblingContext;

  // Publish progress
  await publishState({
    parent_ticket_id: parentTicketId,
    child_ticket_id: ticketId,
    agent_id: 'BUILD-021',
    deep_build_type: 'voice_agent',
    phase: 'writing',
    progress_percent: 10
  });

  // Initial build — up to 90 min (voice stacks are complex)
  const { output, exitCode, duration } = await runClaudeCode(
    buildDir, enhancedPrompt, 'BUILD-021', 5400000
  );

  const fileCount = await countOutputFiles(buildDir);
  console.log(`[BUILD-021] Files written: ${fileCount}`);

  await publishState({
    parent_ticket_id: parentTicketId,
    child_ticket_id: ticketId,
    agent_id: 'BUILD-021',
    deep_build_type: 'voice_agent',
    phase: 'installing',
    progress_percent: 60
  });

  // Install deps
  let installPassed = false;
  try {
    await execFileAsync('bash', ['-c',
      `cd ${buildDir} && ` +
      `[ -f package.json ] && npm install --silent 2>&1 | tail -5 || echo "no package.json"`
    ], {
      timeout: 600000,
      maxBuffer: 30 * 1024 * 1024,
      uid: parseInt(process.env.CLAUDE_AGENT_UID || '1001'),
      gid: parseInt(process.env.CLAUDE_AGENT_GID || '1001')
    });
    installPassed = true;
  } catch (e) {
    console.warn(`[BUILD-021] Install failed:`, e.message?.slice(0, 200));
  }

  // Run validation tests
  let testResult = { passed: false, output: 'not run' };
  if (installPassed) {
    testResult = await runTests(
      buildDir,
      `[ -f package.json ] && npm test --silent 2>&1 || echo "test-skipped"`,
      'BUILD-021'
    );
  }

  // Revision loop if tests fail
  let revisions = 0;
  while (!testResult.passed && installPassed && revisions < 2 && !testResult.output?.includes('test-skipped')) {
    revisions++;
    console.log(`[BUILD-021] Revision ${revisions}`);

    await publishState({
      parent_ticket_id: parentTicketId,
      child_ticket_id: ticketId,
      agent_id: 'BUILD-021',
      deep_build_type: 'voice_agent',
      phase: `revision-${revisions}`,
      progress_percent: 70 + revisions * 10
    });

    const revisionPrompt = `
Voice agent tests are failing. Fix the issues.

Test output:
\`\`\`
${testResult.output?.slice(0, 3000) || ''}
${testResult.error?.slice(0, 2000) || ''}
\`\`\`

Common voice agent issues:
1. Retell/Vapi webhook signature validation (HMAC with correct secret)
2. Twilio TwiML response format (XML, not JSON)
3. Async handlers not awaiting Supabase writes
4. Missing intent-to-action mapping
5. Call context passing between turns
6. Transcription postprocessing (trim, dedupe, speaker labels)

Do NOT skip tests. Fix the real bugs. Work from ${buildDir}.`;

    await runClaudeCode(buildDir, revisionPrompt, 'BUILD-021-rev' + revisions, 1800000);
    testResult = await runTests(buildDir, 'npm test --silent 2>&1', 'BUILD-021');
  }

  const totalDuration = Math.round((Date.now() - startTime) / 1000);
  const finalFileCount = await countOutputFiles(buildDir);

  // Extract exposed artifacts for siblings
  const exposedArtifacts = {
    webhook_endpoints: [
      '/webhooks/retell/call-started',
      '/webhooks/retell/call-ended',
      '/webhooks/retell/transcript',
      '/webhooks/twilio/voice',
      '/webhooks/twilio/sms'
    ],
    call_initiation_api: '/api/calls/outbound',
    call_status_api: '/api/calls/:id/status',
    phone_numbers_managed: 'configured via Twilio console',
    voice_provider: jobData.voice_provider || 'retell',
    supabase_tables_written: ['call_logs', 'call_transcripts', 'call_sentiment'],
    test_passed: testResult.passed,
    install_passed: installPassed,
    revisions
  };

  // Publish final state with exposed artifacts
  await publishState({
    parent_ticket_id: parentTicketId,
    child_ticket_id: ticketId,
    agent_id: 'BUILD-021',
    deep_build_type: 'voice_agent',
    phase: testResult.passed ? 'complete' : 'partial',
    progress_percent: 100,
    exposed_artifacts: exposedArtifacts
  });

  // Notify siblings of completion
  if (parentTicketId) {
    await sendAgentMessage('BUILD-021', 'BUILD-030', parentTicketId, 'agent_complete', exposedArtifacts);
  }

  try {
    await supabase.from('build_agent_runs').insert({
      ticket_id: ticketId,
      agent_id: 'BUILD-021',
      agent_name: 'Voice Agent Developer',
      status: testResult.passed ? 'complete' : 'partial',
      duration_seconds: totalDuration,
      output: {
        file_count: finalFileCount,
        ...exposedArtifacts
      }
    });
  } catch (_) {}

  return {
    agent_id: 'BUILD-021',
    file_count: finalFileCount,
    install_passed: installPassed,
    test_passed: testResult.passed,
    revisions,
    duration_seconds: totalDuration,
    build_dir: buildDir,
    exposed_artifacts: exposedArtifacts
  };
}

function buildVoiceAgentPrompt(jobData) {
  const voiceProvider = jobData.voice_provider || 'retell';

  return `You are BUILD-021, the Voice Agent Developer for ManageAI FRIDAY. You write complete voice automation stacks for customers.

BRIEF:
${JSON.stringify(jobData, null, 2)}

VOICE PROVIDER: ${voiceProvider} (Retell AI if unspecified — better Claude integration)

YOUR TASK:
Build a complete voice automation project. Work in /tmp/friday-deep-${jobData.ticket_id}.

DEFAULT STACK:
- Node.js 20+ with TypeScript
- Express or Fastify for webhook handlers
- ${voiceProvider === 'vapi' ? 'Vapi' : 'Retell AI'} for LLM-driven voice agent
- Twilio for phone numbers and call routing
- Supabase for call logs, transcripts, sentiment
- Jest for testing webhook handlers
- Zod for webhook payload validation

REQUIRED STRUCTURE:

\`\`\`
src/
  index.ts                          # Entry point, server startup
  config.ts                         # Env vars, provider configs
  webhooks/
    retell.ts                       # Retell event handlers (call-started, ended, transcript)
    twilio.ts                       # Twilio voice + SMS webhooks
  voice/
    agent-config.ts                 # Retell/Vapi agent definition (system prompt, tools, voice)
    prompts.ts                      # All voice agent prompts (intro, fallback, transfer)
    tools.ts                        # Tool definitions the agent can call
    transcription.ts                # Transcript processing (cleanup, speaker labels, sentiment)
  calls/
    outbound.ts                     # Initiate outbound call via provider API
    status.ts                       # Get call status
    recording.ts                    # Access recordings (with compliance controls)
  integrations/
    supabase-sink.ts                # Persist call data
    crm-updater.ts                  # Update CRM on call outcomes
    transfer.ts                     # Warm transfer to human
  middleware/
    signature-verify.ts             # HMAC webhook signature validation
    rate-limit.ts
    logging.ts
  types/
    call.ts                         # Call, Transcript, Sentiment types
    webhook.ts                      # Provider webhook payload types
tests/
  webhooks/
    retell.test.ts
    twilio.test.ts
  voice/
    agent-config.test.ts
    transcription.test.ts
  calls/
    outbound.test.ts
  integrations/
    supabase-sink.test.ts
  fixtures/
    retell-call-started.json
    retell-transcript.json
    twilio-voice.json
n8n/
  outbound-campaign-workflow.json   # n8n workflow: trigger outbound calls from Supabase
  call-outcome-followup.json        # n8n workflow: post-call actions
twilio/
  twiml-templates/
    voicemail.xml
    hold.xml
    transfer.xml
package.json
tsconfig.json
.env.example
README.md
SETUP.md                            # Step-by-step: create Retell agent, buy Twilio number, configure webhooks
\`\`\`

REQUIREMENTS:

1. **Agent configuration**
   - System prompt written from the brief's agent persona
   - Tools defined with JSON Schema for arguments
   - Voice selected from provider's voice library
   - Fallback responses for unrecognized intents
   - Transfer-to-human triggers clearly defined

2. **Webhook handlers**
   - HMAC signature verification on every webhook (Retell and Twilio both sign)
   - Idempotent handlers (same event twice = same result)
   - Response within provider timeout (Retell: 5s, Twilio: 10s)
   - Async work offloaded so webhook returns fast

3. **Call context**
   - Pass customer ID, agent ID, correlation ID through every turn
   - Reconstruct context from Supabase on session resume
   - Handle dropped calls (auto-reconnect logic for Twilio)

4. **Transcription processing**
   - Clean up filler words, ASR errors
   - Speaker labeling (agent vs customer)
   - Sentiment scoring per turn
   - Final summary at call end
   - All stored in Supabase tables

5. **Compliance**
   - TCPA: no outbound calls outside allowed hours, honor DNC list
   - HIPAA (if healthcare): no PHI in logs, encrypt transcripts at rest
   - Call recording consent: prefix message for recorded calls
   - Opt-out handling: detect and action immediately

6. **Outbound calls**
   - API endpoint to initiate call (triggered by n8n)
   - Rate limiting (don't flood the Twilio number)
   - Call queue for campaigns
   - Retry on no-answer (max 2 retries, spaced appropriately)

7. **Human transfer**
   - Warm transfer to configurable numbers (by intent, by location, by hours)
   - Handoff context delivered to human (summary + transcript link)
   - Fallback voicemail if human unavailable

8. **Testing**
   - Fixture-based tests using saved webhook payloads
   - No live calls in tests
   - Mock provider SDKs
   - 80%+ coverage on webhook handlers

9. **n8n integration**
   - Workflow to trigger outbound campaigns from Supabase queries
   - Workflow for post-call followup (SMS, email, CRM update)
   - Both workflows valid JSON for n8n import API

10. **SETUP.md**
    - How to create Retell/Vapi account
    - How to buy Twilio number and configure
    - How to set all env vars
    - How to test first call
    - How to configure outbound campaign

WORKFLOW:
1. Read brief — identify intents, transfer triggers, data integrations
2. Design agent config (system prompt, tools, voice)
3. Design webhook event flow
4. Write handlers with signature verification
5. Write Supabase sinks for each event type
6. Write outbound calling module
7. Write transfer logic
8. Write n8n workflows
9. Write tests with realistic fixtures
10. Write SETUP.md

CRITICAL:
- Write COMPLETE files. No "TODO: configure here."
- Signature verification is not optional
- Every Supabase write inside try/catch with logging
- Tests must pass with \`npm test\`
- README explains the FULL picture

SECURITY:
- Webhook secrets in env vars, never in code
- Transcripts encrypted at rest (Supabase RLS + service role only)
- Recordings accessible only with audit log
- PII redacted in logs
- All webhook handlers must validate signature before processing

Begin building. Work in current directory.`;
}
