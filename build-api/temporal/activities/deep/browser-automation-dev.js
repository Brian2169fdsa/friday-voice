/**
 * BUILD-020: Browser Automation Specialist
 * Writes Playwright scripts for customer systems without APIs.
 * Runs on deep queue (2-8 hour timeout).
 * Uses Claude Code to write, execute, and self-validate scripts.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { runClaudeCode, runTests, countOutputFiles } from './deep-shared.js';
import { createClient } from '@supabase/supabase-js';
import { promisify } from 'util';
import { execFile } from 'child_process';

const execFileAsync = promisify(execFile);

export async function buildBrowserAutomationActivity(jobData) {
  const ticketId = jobData.ticket_id;
  const buildDir = `/tmp/friday-deep-${ticketId}`;
  const startTime = Date.now();

  console.log(`[BUILD-020] Starting browser automation build: ${jobData.project_name}`);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    await supabase.from('friday_deep_builds').update({
      status: 'running',
      started_at: new Date().toISOString()
    }).eq('ticket_id', ticketId);
  } catch (_) {}

  const prompt = buildBrowserAutomationPrompt(jobData);

  // Initial build (up to 1 hour)
  const { output, exitCode, duration } = await runClaudeCode(
    buildDir, prompt, 'BUILD-020', 3600000
  );

  // Verify output files
  const fileCount = await countOutputFiles(buildDir);
  console.log(`[BUILD-020] Files written: ${fileCount}`);

  // Set up Python venv + install deps
  console.log(`[BUILD-020] Setting up venv and installing playwright...`);
  let installPassed = false;
  try {
    await execFileAsync('bash', ['-c',
      `cd ${buildDir} && ` +
      `python3 -m venv venv && ` +
      `./venv/bin/pip install --quiet --upgrade pip && ` +
      `./venv/bin/pip install --quiet -r requirements.txt && ` +
      `./venv/bin/python -m playwright install chromium 2>&1 | tail -5`
    ], {
      timeout: 900000,
      maxBuffer: 30 * 1024 * 1024,
      uid: parseInt(process.env.CLAUDE_AGENT_UID || '1001'),
      gid: parseInt(process.env.CLAUDE_AGENT_GID || '1001')
    });
    installPassed = true;
  } catch (e) {
    console.warn(`[BUILD-020] Install failed:`, e.message?.slice(0, 200));
  }

  // Run the validation tests (against mock site or dry-run mode)
  let testResult = { passed: false, output: 'not run' };
  if (installPassed) {
    testResult = await runTests(
      buildDir,
      './venv/bin/pytest -v --tb=short',
      'BUILD-020'
    );
  }

  // Revision loop if tests fail
  let revisions = 0;
  while (!testResult.passed && installPassed && revisions < 2) {
    revisions++;
    console.log(`[BUILD-020] Revision ${revisions} — routing test failures to Claude Code`);

    const revisionPrompt = `
Tests are failing for the Playwright automation. Fix the issues.

Test output:
\`\`\`
${testResult.output?.slice(0, 3000) || ''}
${testResult.error?.slice(0, 2000) || ''}
\`\`\`

Common Playwright issues to check:
1. Selectors: use data-testid or semantic locators, not fragile CSS
2. Timing: add proper waits (page.wait_for_load_state, page.wait_for_selector)
3. Headless vs headed mode (use headless=True for CI)
4. Browser context isolation
5. Error handling: retry on timeout, screenshot on failure
6. Element visibility before interaction

Do NOT skip tests. Fix the real bugs. Work from ${buildDir}.`;

    await runClaudeCode(buildDir, revisionPrompt, 'BUILD-020-rev' + revisions, 1800000);
    testResult = await runTests(buildDir, './venv/bin/pytest -v --tb=short', 'BUILD-020');
  }

  const totalDuration = Math.round((Date.now() - startTime) / 1000);
  const finalFileCount = await countOutputFiles(buildDir);

  // Persist agent run record
  try {
    await supabase.from('build_agent_runs').insert({
      ticket_id: ticketId,
      agent_id: 'BUILD-020',
      agent_name: 'Browser Automation Specialist',
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
    agent_id: 'BUILD-020',
    file_count: finalFileCount,
    install_passed: installPassed,
    test_passed: testResult.passed,
    revisions,
    duration_seconds: totalDuration,
    build_dir: buildDir
  };
}

function buildBrowserAutomationPrompt(jobData) {
  return `You are BUILD-020, the Browser Automation Specialist for ManageAI FRIDAY. You write production-grade Playwright automation scripts for customers whose systems have no API.

BRIEF:
${JSON.stringify(jobData, null, 2)}

YOUR TASK:
Build a complete Playwright automation project that implements the brief. Work in /tmp/friday-deep-${jobData.ticket_id}.

DEFAULT STACK:
- Python 3.11+
- Playwright 1.47+ (sync API for scripts, async for concurrent)
- pydantic v2 for data validation
- supabase-py for persisting extracted data
- python-dotenv for credentials
- pytest + pytest-playwright for testing
- structlog for structured logging
- tenacity for retry logic

REQUIRED STRUCTURE:
\`\`\`
src/
  __init__.py
  config.py              # Env vars, credentials, URLs
  auth.py                # Login flow (OAuth, form-based, MFA handling)
  scrapers/
    __init__.py
    [system_name].py     # Per-target-system scraper
  extractors/
    __init__.py
    [data_type].py       # Parsers for specific data shapes
  sinks/
    supabase_sink.py     # Persistence layer
  models.py              # pydantic models for extracted data
  runner.py              # Main entry point
  utils/
    retry.py             # Tenacity decorators
    screenshot.py        # Debug screenshots on failure
    selectors.py         # Centralized selector definitions
tests/
  __init__.py
  conftest.py            # Shared fixtures (mock browser, mock data)
  test_auth.py
  test_scrapers.py
  test_extractors.py
  test_sinks.py
  fixtures/
    [mock HTML pages]
requirements.txt
.env.example             # Documented credentials template
.gitignore               # Exclude venv, __pycache__, .env, screenshots/
pyproject.toml
README.md
docker/
  Dockerfile             # Containerized runs
n8n/
  workflow.json          # n8n workflow that triggers this on schedule
\`\`\`

REQUIREMENTS:

1. **Credentials management**
   - Never hardcode credentials
   - Load from .env via python-dotenv
   - .env.example lists all required vars with descriptions
   - README explains how to rotate

2. **Resilience**
   - Use tenacity retries on network errors
   - Wait for selectors with timeouts (not sleep)
   - Screenshot on failure with timestamp
   - Log everything with correlation IDs
   - Handle session expiration mid-run

3. **Selector strategy**
   - Prefer data-testid, aria-label, role over CSS
   - Centralize selectors in utils/selectors.py
   - Comment why each selector was chosen
   - Mark fragile selectors with TODO

4. **Anti-detection**
   - Random user agents from realistic pool
   - Variable delays between actions (0.5-3s)
   - Use browser contexts, not persistent profiles
   - Respect robots.txt where legally relevant

5. **Data validation**
   - pydantic model for each data type
   - Validate BEFORE persisting
   - Reject rows that fail validation, log them
   - Never silently corrupt data

6. **Supabase sink**
   - Upsert (not insert) to handle re-runs
   - Composite keys for natural deduplication
   - Wrapped in transaction where possible
   - Audit timestamp on every row

7. **Testing**
   - Mock HTML fixtures for each page shape
   - Use page.set_content() to load fixtures
   - Test auth flow with mocked responses
   - Test extractor parsers against fixtures
   - Test sink against local Supabase or mock
   - Minimum 80% coverage
   - All tests offline (no live site calls)

8. **Observability**
   - Structured logs (JSON) with timestamps
   - Metrics: rows extracted, rows persisted, errors, duration
   - Write metrics to Supabase metrics table at end
   - n8n workflow can read metrics for health monitoring

9. **n8n workflow**
   - Scheduled trigger (cron from brief)
   - Docker exec or SSH to run the script
   - Read stdout/metrics, alert on failure
   - Valid n8n JSON format (compatible with import API)

10. **README must include**
    - Setup steps (clone, venv, install, playwright install)
    - Environment variables with examples
    - First run walkthrough
    - Troubleshooting common issues
    - How to add a new page extractor

WORKFLOW:
1. Read brief carefully — identify the target system(s), data types, schedule
2. Design selectors and page flow (write as comments first)
3. Write auth module
4. Write scrapers and extractors
5. Write pydantic models
6. Write Supabase sink
7. Write tests with HTML fixtures
8. Write n8n workflow
9. Install deps and run tests
10. Fix failures
11. Confirm everything works

CRITICAL:
- Write COMPLETE files. No placeholders. No "TODO: implement this."
- Every selector must have a fallback
- Every network call must have retry logic
- Every extraction must validate before persisting
- Tests must actually run and pass with \`pytest\`
- If target system is unknown/unreachable, write MOCK HTML fixtures that match the brief description and test against those

SECURITY NOTES:
- Never log credentials
- Screenshots must not include credential fields
- .env must be in .gitignore
- Session cookies must not be persisted to disk

Begin building now. Work in the current directory.`;
}
