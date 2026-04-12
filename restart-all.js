#!/usr/bin/env node
// FRIDAY System Restart Script
// Run: node /opt/manageai/restart-all.js
// Or: HOME=/home/claudeagent PM2_HOME=/home/claudeagent/.pm2 node /opt/manageai/restart-all.js

import { spawn } from 'child_process';

const env = {
  ...process.env,
  HOME: '/home/claudeagent',
  PM2_HOME: '/home/claudeagent/.pm2',
};

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { env, stdio: 'inherit' });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(cmd + ' exited ' + code)));
  });
}

async function main() {
  console.log('[RESTART] Starting FRIDAY system restart...');
  try {
    await run('/usr/bin/pm2', ['resurrect']);
    console.log('[RESTART] pm2 resurrect succeeded');
  } catch(e) {
    console.log('[RESTART] resurrect failed, starting from ecosystem.config.js:', e.message);
    try {
      await run('/usr/bin/pm2', ['start', '/opt/manageai/ecosystem.config.js', '--update-env']);
      console.log('[RESTART] pm2 start succeeded');
    } catch(e2) {
      console.error('[RESTART] pm2 start failed:', e2.message);
      process.exit(1);
    }
  }
  await run('/usr/bin/pm2', ['save']);
  console.log('[RESTART] Done. Use pm2 status to verify.');
}

main().catch(e => { console.error('[RESTART] Fatal:', e.message); process.exit(1); });
