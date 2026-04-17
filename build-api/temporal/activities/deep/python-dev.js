/**
 * BUILD-018: Python Developer
 * Writes complete Python scripts, services, and tools
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { runClaudeCode, runTests, countOutputFiles } from './deep-shared.js';
import { createClient } from '@supabase/supabase-js';
import { promisify } from 'util';
import { execFile } from 'child_process';

const execFileAsync = promisify(execFile);

export async function buildPythonActivity(jobData) {
  const ticketId = jobData.ticket_id;
  const buildDir = `/tmp/friday-deep-${ticketId}`;
  const startTime = Date.now();

  console.log(`[BUILD-018] Starting Python build: ${jobData.project_name}`);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    await supabase.from('friday_deep_builds').update({
      status: 'running',
      started_at: new Date().toISOString()
    }).eq('ticket_id', ticketId);
  } catch (_) {}

  const prompt = buildPythonPrompt(jobData);

  const { output, exitCode, duration } = await runClaudeCode(
    buildDir, prompt, 'BUILD-018', 3600000
  );

  const fileCount = await countOutputFiles(buildDir);
  console.log(`[BUILD-018] Files written: ${fileCount}`);

  // Install deps via venv
  console.log(`[BUILD-018] Setting up venv and installing...`);
  let installPassed = false;
  try {
    await execFileAsync('bash', ['-c',
      `cd ${buildDir} && ` +
      `python3 -m venv venv && ` +
      `./venv/bin/pip install --quiet --upgrade pip && ` +
      `./venv/bin/pip install --quiet -r requirements.txt`
    ], {
      timeout: 600000,
      maxBuffer: 20 * 1024 * 1024,
      uid: parseInt(process.env.CLAUDE_AGENT_UID || '1001'),
      gid: parseInt(process.env.CLAUDE_AGENT_GID || '1001')
    });
    installPassed = true;
  } catch (e) {
    console.warn(`[BUILD-018] pip install failed:`, e.message?.slice(0, 200));
  }

  // Run pytest
  let testResult = { passed: false, output: 'not run' };
  if (installPassed) {
    testResult = await runTests(buildDir, './venv/bin/pytest -v', 'BUILD-018');
  }

  // Revision loop
  let revisions = 0;
  while (!testResult.passed && installPassed && revisions < 2) {
    revisions++;
    const revisionPrompt = `
Tests are failing. Fix the bugs and re-run.

Test output:
\`\`\`
${testResult.output?.slice(0, 3000) || ''}
${testResult.error?.slice(0, 2000) || ''}
\`\`\`

Fix the underlying bugs. Do not skip or disable tests. Work from ${buildDir}.`;

    await runClaudeCode(buildDir, revisionPrompt, 'BUILD-018-rev' + revisions, 1800000);
    testResult = await runTests(buildDir, './venv/bin/pytest -v', 'BUILD-018');
  }

  const totalDuration = Math.round((Date.now() - startTime) / 1000);
  const finalFileCount = await countOutputFiles(buildDir);

  try {
    await supabase.from('build_agent_runs').insert({
      ticket_id: ticketId,
      agent_id: 'BUILD-018',
      agent_name: 'Python Developer',
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
    agent_id: 'BUILD-018',
    file_count: finalFileCount,
    install_passed: installPassed,
    test_passed: testResult.passed,
    revisions,
    duration_seconds: totalDuration,
    build_dir: buildDir
  };
}

function buildPythonPrompt(jobData) {
  return `You are BUILD-018, the Python Developer for ManageAI FRIDAY. You write complete, tested, production-ready Python code.

BRIEF:
${JSON.stringify(jobData, null, 2)}

YOUR TASK:
Build a complete Python project that implements the brief. Work in /tmp/friday-deep-${jobData.ticket_id}.

DEFAULT STACK (unless brief overrides):
- Python 3.11+
- pytest for testing
- pydantic v2 for data validation
- requests / httpx for HTTP
- pandas for data work (if needed)
- playwright for browser automation (if needed)
- beautifulsoup4 for HTML parsing (if needed)
- pdfplumber / PyMuPDF for PDF work (if needed)
- supabase-py for database (if needed)
- python-dotenv for env vars
- typer or click for CLIs
- fastapi for APIs (if web service needed)

REQUIRED STRUCTURE:
\`\`\`
src/
  __init__.py
  main.py                  # Entry point
  [modules matching the task]
tests/
  __init__.py
  conftest.py
  test_*.py                # Tests for each module
requirements.txt           # Runtime deps
requirements-dev.txt       # Test deps
.env.example
.gitignore                 # Must exclude venv/, __pycache__, .env
pyproject.toml             # Project config
README.md                  # Complete setup + usage docs
\`\`\`

If it's a service: add Dockerfile + startup script.
If it's a CLI: make main.py invocable via \`python -m src.main\` or entry point in pyproject.

REQUIREMENTS:
1. Type hints everywhere (Python 3.11+ syntax)
2. pydantic models for all data structures
3. Comprehensive docstrings (Google style)
4. Error handling with specific exception types
5. Logging with structured format
6. At least 80% test coverage with pytest
7. Mock external services in tests
8. Tests must run offline
9. .env.example with all required vars documented
10. README must have working setup instructions

TESTING:
- Use pytest fixtures
- Use pytest-mock for mocking
- Use responses or httpx_mock for HTTP mocking
- Tests must pass with: \`pytest\`

WORKFLOW:
1. Analyze brief
2. Design module structure
3. Write all files
4. Test by running \`pip install -r requirements.txt && pytest\`
5. Fix failures
6. Confirm everything works

CRITICAL:
- Complete files only — no placeholders
- All code must run and all tests must pass
- Use modern Python (match statements, walrus operator, type hints, async where appropriate)

Begin now. Work in the current directory.`;
}
