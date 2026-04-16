import fs from 'fs/promises';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { createClient } from '@supabase/supabase-js';

const CLAUDE = '/usr/bin/claude';
const COMPARISON_TIMEOUT = 300000; // 5 min

let AGENT_UID, AGENT_GID;
try {
  AGENT_UID = parseInt(execSync('id -u claudeagent').toString().trim());
  AGENT_GID = parseInt(execSync('id -g claudeagent').toString().trim());
} catch (e) {
  AGENT_UID = null;
  AGENT_GID = null;
}

function runClaudeComparison(promptFile, workDir, timeoutMs) {
  timeoutMs = timeoutMs || COMPARISON_TIMEOUT;
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-c', CLAUDE + ' --dangerously-skip-permissions -p "$(cat ' + promptFile + ')"'], {
      cwd: workDir,
      uid: AGENT_UID, gid: AGENT_GID,
      env: { ...process.env, HOME: '/home/claudeagent', USER: 'claudeagent', CLAUDECODE: undefined },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('Comparison timeout ' + Math.round(timeoutMs / 1000) + 's')); }, timeoutMs);
    proc.on('close', code => {
      clearTimeout(timer);
      try { if (proc.pid) execSync('pkill -9 -P ' + proc.pid + ' 2>/dev/null || true'); } catch (_) {}
      if (code === 0) resolve(stdout);
      else reject(new Error('Exit ' + code + ': ' + stderr.slice(0, 300)));
    });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

function detectDocType(fileName) {
  const n = (fileName || '').toLowerCase();
  if (n.includes('solution demo')) return 'solution_demo';
  if (n.includes('build manual') || n.includes('training manual') || n.includes('skillset manual')) return 'build_manual';
  return null;
}

function getReferenceTemplate(docType) {
  if (docType === 'solution_demo') return '/opt/manageai/build-api/templates/solution-demo-reference.html';
  if (docType === 'build_manual') return '/opt/manageai/build-api/templates/build-manual-reference.html';
  return null;
}

export async function documentComparisonActivity(jobData, buildDir) {
  console.log('[BUILD-026] Starting document comparison for build:', jobData.ticket_id || jobData.job_id);
  const startTime = Date.now();

  const comparisonDir = path.join(buildDir, 'comparison');
  await fs.mkdir(comparisonDir, { recursive: true });
  if (AGENT_UID) {
    try { await fs.chown(comparisonDir, AGENT_UID, AGENT_GID); } catch (_) {}
  }

  // Scan deliverables directory for HTML files
  const deliverablesDir = path.join(buildDir, 'deliverables');
  let files = [];
  try { files = await fs.readdir(deliverablesDir); } catch (_) { files = []; }
  const htmlFiles = files.filter(f => f.endsWith('.html'));

  const results = [];

  for (const file of htmlFiles) {
    const docType = detectDocType(file);
    const refTemplate = getReferenceTemplate(docType);

    if (!docType || !refTemplate) {
      results.push({
        file,
        type: 'unknown',
        score: 50,
        pass: false,
        checks: { fonts_correct: false, colors_correct: false, react_pattern_correct: false, sections_present: false, data_populated: false, matches_reference: false },
        issues: ['Unknown document type — no reference template to compare against'],
        fixes: []
      });
      continue;
    }

    // Build comparison prompt
    const prompt = `You are BUILD-026, the Document Comparison Agent. Compare a generated document against a reference template.

TASK:
1. Read the reference template: cat ${refTemplate}
2. Read the generated file: cat ${path.join(deliverablesDir, file)}
3. Compare them on these dimensions and write a JSON result file.

COMPARISON CHECKS:
- fonts_correct: Does the generated file use the same Google Fonts as the reference? (DM Sans/Inter/JetBrains Mono for solution demo, Montserrat/JetBrains Mono for build manual)
- colors_correct: Does it use the same color palette? (#4A8FD6 accent, #1E3348 navy, #FFFFFF bg, etc.)
- react_pattern_correct: Does it use React 18 via CDN with React.createElement (NOT JSX)?
- sections_present: Does it have the same major sections/tabs as the reference?
- data_populated: Are the data arrays/objects populated with real build data (not empty arrays or placeholder text)?
- matches_reference: Overall structural match — same component patterns, layout, animations?

SCORING:
- Each check that passes = +16 points (6 checks × 16 = 96 max, + 4 bonus for excellence)
- Score 70+ = pass

Write the result as JSON to: ${path.join(comparisonDir, file.replace('.html', '-comparison.json'))}

The JSON must have this exact structure:
{
  "file": "${file}",
  "type": "${docType}",
  "score": <number 0-100>,
  "pass": <boolean>,
  "checks": {
    "fonts_correct": <boolean>,
    "colors_correct": <boolean>,
    "react_pattern_correct": <boolean>,
    "sections_present": <boolean>,
    "data_populated": <boolean>,
    "matches_reference": <boolean>
  },
  "issues": ["list of specific issues found"],
  "fixes": ["list of specific fixes needed"]
}

Be objective and specific. If an issue exists, describe exactly what's wrong and how to fix it.`;

    const promptFile = '/tmp/friday-comparison-' + jobData.job_id + '-' + file.replace(/[^a-zA-Z0-9]/g, '_') + '.txt';
    await fs.writeFile(promptFile, prompt);

    try {
      await runClaudeComparison(promptFile, comparisonDir);
      await fs.rm(promptFile, { force: true });

      // Try to read the comparison result
      const resultFile = path.join(comparisonDir, file.replace('.html', '-comparison.json'));
      try {
        const resultText = await fs.readFile(resultFile, 'utf-8');
        const parsed = JSON.parse(resultText);
        results.push(parsed);
      } catch (_) {
        results.push({
          file, type: docType, score: 0, pass: false,
          checks: { fonts_correct: false, colors_correct: false, react_pattern_correct: false, sections_present: false, data_populated: false, matches_reference: false },
          issues: ['Comparison agent did not produce valid JSON output'], fixes: []
        });
      }
    } catch (err) {
      await fs.rm(promptFile, { force: true });
      console.error('[BUILD-026] Comparison failed for', file + ':', err.message.slice(0, 200));
      results.push({
        file, type: docType, score: 0, pass: false,
        checks: { fonts_correct: false, colors_correct: false, react_pattern_correct: false, sections_present: false, data_populated: false, matches_reference: false },
        issues: ['Comparison agent error: ' + err.message.slice(0, 200)], fixes: []
      });
    }
  }

  // Also check build-docs for any HTML files
  const buildDocsDir = path.join(buildDir, 'build-docs');
  let buildDocFiles = [];
  try { buildDocFiles = await fs.readdir(buildDocsDir); } catch (_) {}
  const buildDocHtml = buildDocFiles.filter(f => f.endsWith('.html'));
  for (const file of buildDocHtml) {
    const docType = detectDocType(file);
    if (!docType) continue;
    // Same comparison logic - but for brevity we just note it
    results.push({
      file, type: docType, score: 50, pass: false,
      checks: { fonts_correct: false, colors_correct: false, react_pattern_correct: false, sections_present: false, data_populated: false, matches_reference: false },
      issues: ['File in build-docs instead of deliverables — may need to be moved'], fixes: ['Move to deliverables directory']
    });
  }

  const filesCompared = results.length;
  const filesPassing = results.filter(r => r.pass).length;
  const overallScore = filesCompared > 0 ? Math.round(results.reduce((sum, r) => sum + r.score, 0) / filesCompared) : 0;

  const summary = {
    files_compared: filesCompared,
    files_passing: filesPassing,
    files_failing: filesCompared - filesPassing,
    results,
    overall_score: overallScore,
    duration_seconds: Math.round((Date.now() - startTime) / 1000)
  };

  // Write summary
  const summaryPath = path.join(comparisonDir, 'comparison-results.json');
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.log('[BUILD-026] Comparison complete:', filesPassing + '/' + filesCompared + ' passing, overall score: ' + overallScore);

  // Persist to build_agent_runs
  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    await sb.from('build_agent_runs').insert({
      ticket_id: jobData.ticket_id || jobData.job_id,
      agent_id: 'BUILD-026',
      agent_name: 'Document Comparison',
      status: 'complete',
      started_at: new Date(startTime).toISOString(),
      completed_at: new Date().toISOString(),
      duration_seconds: Math.round((Date.now() - startTime) / 1000),
      output: summary
    });
  } catch (_) {}

  // Persist to build_quality_signals
  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    await sb.from('build_quality_signals').insert({
      ticket_id: jobData.ticket_id || jobData.job_id,
      signal_type: 'doc_comparison',
      score: overallScore,
      details: summary,
      created_at: new Date().toISOString()
    });
  } catch (_) {}

  return summary;
}
