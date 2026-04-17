/**
 * BUILD-017: Node.js Service Developer
 * Writes complete Express/Fastify services in TypeScript
 * Runs on deep queue (2-8 hour timeout)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { runClaudeCode, runTests, countOutputFiles } from './deep-shared.js';
import { createClient } from '@supabase/supabase-js';

export async function buildNodeServiceActivity(jobData) {
  const ticketId = jobData.ticket_id;
  const buildDir = `/tmp/friday-deep-${ticketId}`;
  const startTime = Date.now();

  console.log(`[BUILD-017] Starting Node.js service build: ${jobData.project_name}`);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    await supabase.from('friday_deep_builds').update({
      status: 'running',
      started_at: new Date().toISOString()
    }).eq('ticket_id', ticketId);
  } catch (_) {}

  const prompt = buildNodeServicePrompt(jobData);

  // Initial build (up to 1 hour)
  const { output, exitCode, duration } = await runClaudeCode(
    buildDir, prompt, 'BUILD-017', 3600000
  );

  // Verify output
  const fileCount = await countOutputFiles(buildDir);
  console.log(`[BUILD-017] Files written: ${fileCount}`);

  // Install deps
  console.log(`[BUILD-017] Installing dependencies...`);
  let installPassed = false;
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('bash', ['-c', `cd ${buildDir} && npm install --silent`], {
      timeout: 600000,
      maxBuffer: 10 * 1024 * 1024,
      uid: parseInt(process.env.CLAUDE_AGENT_UID || '1001'),
      gid: parseInt(process.env.CLAUDE_AGENT_GID || '1001')
    });
    installPassed = true;
  } catch (e) {
    console.warn(`[BUILD-017] npm install failed:`, e.message?.slice(0, 200));
  }

  // Run tests
  let testResult = { passed: false, output: 'not run' };
  if (installPassed) {
    testResult = await runTests(buildDir, 'npm test -- --passWithNoTests', 'BUILD-017');
  }

  // Revision loop if tests failed
  let revisions = 0;
  while (!testResult.passed && installPassed && revisions < 2) {
    revisions++;
    console.log(`[BUILD-017] Revision ${revisions} — tests failing, routing to Claude Code`);

    const revisionPrompt = `
Tests are failing. Fix the issues and re-run. Test output:

\`\`\`
${testResult.output?.slice(0, 3000) || ''}
${testResult.error?.slice(0, 2000) || ''}
\`\`\`

Review the test failures, fix the underlying code bugs, and ensure all tests pass. Do not disable tests. Do not skip tests. Fix the actual bugs.

Work from ${buildDir}. When done, confirm tests pass.`;

    await runClaudeCode(buildDir, revisionPrompt, 'BUILD-017-rev' + revisions, 1800000);
    testResult = await runTests(buildDir, 'npm test -- --passWithNoTests', 'BUILD-017');
  }

  const totalDuration = Math.round((Date.now() - startTime) / 1000);
  const finalFileCount = await countOutputFiles(buildDir);

  // Persist agent run
  try {
    await supabase.from('build_agent_runs').insert({
      ticket_id: ticketId,
      agent_id: 'BUILD-017',
      agent_name: 'Node.js Service Developer',
      status: testResult.passed ? 'complete' : 'partial',
      duration_seconds: totalDuration,
      output: {
        file_count: finalFileCount,
        install_passed: installPassed,
        test_passed: testResult.passed,
        revisions
      }
    });
  } catch (_) {}

  return {
    agent_id: 'BUILD-017',
    file_count: finalFileCount,
    install_passed: installPassed,
    test_passed: testResult.passed,
    revisions,
    duration_seconds: totalDuration,
    build_dir: buildDir
  };
}

function buildNodeServicePrompt(jobData) {
  return `You are BUILD-017, the Node.js Service Developer for the ManageAI FRIDAY Build Factory. You write complete, tested, production-ready Node.js services.

BRIEF:
${JSON.stringify(jobData, null, 2)}

YOUR TASK:
Build a complete Node.js service that implements the brief above. Work in the current directory (/tmp/friday-deep-${jobData.ticket_id}).

DEFAULT STACK (unless brief says otherwise):
- TypeScript (strict mode)
- Express 4 or Fastify 4 (your choice based on brief)
- Node 18+ (ES modules)
- Zod for runtime validation
- Winston for logging
- Jest for testing
- Supabase JS client for database (if DB needed)
- dotenv for env vars

REQUIRED STRUCTURE:
\`\`\`
src/
  index.ts                 # Server entry point
  routes/                  # Route handlers
  services/                # Business logic
  middleware/              # Auth, logging, rate limiting, error handling
  types/                   # TypeScript types
  lib/                     # Shared utilities
tests/
  [matching structure]
  .env.test                # Test env vars
package.json
tsconfig.json
.env.example               # Template env vars with comments
.gitignore
ecosystem.config.cjs       # PM2 config for deployment
Dockerfile                 # Container deployment
README.md                  # Setup, usage, deployment
\`\`\`

REQUIREMENTS:
1. All endpoints have request validation (Zod)
2. All endpoints have proper error handling
3. All endpoints have TypeScript types
4. At least 80% test coverage with Jest
5. Health check endpoint (GET /health)
6. Graceful shutdown handling (SIGTERM, SIGINT)
7. Structured logging with correlation IDs
8. Rate limiting middleware
9. CORS configured appropriately
10. Security headers (helmet)
11. Environment variable validation on startup
12. README with complete setup instructions
13. PM2 ecosystem.config.cjs for deployment
14. Dockerfile for containerization
15. .gitignore must exclude node_modules, dist, .env

NPM SCRIPTS REQUIRED:
- \`npm start\` — production start
- \`npm run dev\` — dev mode with nodemon
- \`npm test\` — run test suite
- \`npm run build\` — compile TypeScript
- \`npm run lint\` — lint check (optional)

TESTING REQUIREMENTS:
- Unit tests for all services
- Integration tests for all routes
- Use supertest for route testing
- Mock external services (Supabase, APIs) in tests
- Tests must run without network access
- Tests must pass with \`npm test\`

WORKFLOW:
1. Analyze the brief
2. Design the API (routes, data flow, dependencies)
3. Write all files
4. Run \`npm install\` to verify package.json works
5. Run \`npm test\` to verify tests pass
6. Fix any failures
7. Confirm everything works

CRITICAL:
- Write COMPLETE files. No placeholders. No "TODO: implement this later."
- If you can't finish something, note it in README under "Known Limitations" but make the code functional
- All code must actually run — not just compile
- Tests must actually pass — not just exist
- When you say you're done, everything must work

Begin building now. Work in the current directory.`;
}
