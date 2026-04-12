import fs from 'fs/promises';
import path from 'path';
import { collectOutputsFromDir, scoreOutputs } from '../../orchestrator.js';

export async function qaScoreActivity(agentResults, jobData, contract) {
  // agentResults contain { agent_id, status, output_subdir, duration }
  // We need to read actual files from disk to score them
  const outputDir = '/tmp/friday-temporal-' + (jobData?.job_id || 'unknown');

  // Try reading files from disk first (like the direct swarm path)
  let outputs;
  try {
    outputs = await collectOutputsFromDir(outputDir, jobData || {}, contract || {});
  } catch (e) {
    console.warn('[TEMPORAL QA] collectOutputsFromDir failed, building from results:', e.message);
    // Fallback: build outputs from agent results + disk reads
    outputs = [];
    const typeMap = {
      agent_01: { type: 'solution_demo', subdir: 'deliverables', match: /solution\s*demo/i },
      agent_02: { type: 'skillset_manual', subdir: 'deliverables', match: /skillset\s*manual/i },
      agent_03: { type: 'requirements_doc', subdir: 'build-docs', match: /requirements|architecture|implementation/i },
      agent_04: { type: 'blueprint', subdir: 'workflow', match: /\.json$/i }
    };

    for (const result of agentResults) {
      const mapping = typeMap[result.agent_id] || {};
      let content = '';
      let fileName = '';

      if (result.status === 'complete' && result.output_subdir) {
        const subDir = path.join(outputDir, result.output_subdir);
        try {
          const files = await fs.readdir(subDir);
          for (const f of files) {
            if (mapping.match && mapping.match.test(f)) {
              try {
                const fc = await fs.readFile(path.join(subDir, f), 'utf-8');
                if (fc.length > content.length) {
                  content = fc;
                  fileName = f;
                }
              } catch (readErr) { /* skip unreadable */ }
            }
          }
        } catch (dirErr) { /* subdir doesn't exist */ }
      }

      outputs.push({
        type: mapping.type || result.agent_id,
        name: fileName,
        content,
        success: result.status === 'complete' && content.length > 0,
        duration: result.duration || 0
      });
    }
  }

  const job = jobData || {};
  const qaResult = scoreOutputs(outputs, job);
  console.log('[TEMPORAL QA] Score:', qaResult.overallScore + '/100 | Passed:', qaResult.passed +
    ' | Agents succeeded:', qaResult.successCount + '/4');
  return qaResult;
}
