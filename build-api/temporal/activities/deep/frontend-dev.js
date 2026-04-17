/**
 * BUILD-019: Frontend Developer
 * Writes complete Next.js 15 apps with Tailwind + shadcn/ui
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { runClaudeCode, runTests, countOutputFiles } from './deep-shared.js';
import { createClient } from '@supabase/supabase-js';
import { promisify } from 'util';
import { execFile } from 'child_process';

const execFileAsync = promisify(execFile);

export async function buildFrontendActivity(jobData) {
  const ticketId = jobData.ticket_id;
  const buildDir = `/tmp/friday-deep-${ticketId}`;
  const startTime = Date.now();

  console.log(`[BUILD-019] Starting frontend build: ${jobData.project_name}`);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    await supabase.from('friday_deep_builds').update({
      status: 'running',
      started_at: new Date().toISOString()
    }).eq('ticket_id', ticketId);
  } catch (_) {}

  const prompt = buildFrontendPrompt(jobData);

  const { output, exitCode } = await runClaudeCode(
    buildDir, prompt, 'BUILD-019', 4500000  // 75 min for frontend
  );

  const fileCount = await countOutputFiles(buildDir);
  console.log(`[BUILD-019] Files written: ${fileCount}`);

  // Install + build
  console.log(`[BUILD-019] Installing and building...`);
  let installPassed = false;
  let buildPassed = false;
  try {
    await execFileAsync('bash', ['-c',
      `cd ${buildDir} && npm install --silent --no-audit --no-fund`
    ], {
      timeout: 900000,
      maxBuffer: 30 * 1024 * 1024,
      uid: parseInt(process.env.CLAUDE_AGENT_UID || '1001'),
      gid: parseInt(process.env.CLAUDE_AGENT_GID || '1001')
    });
    installPassed = true;

    await execFileAsync('bash', ['-c',
      `cd ${buildDir} && npm run build`
    ], {
      timeout: 900000,
      maxBuffer: 30 * 1024 * 1024,
      uid: parseInt(process.env.CLAUDE_AGENT_UID || '1001'),
      gid: parseInt(process.env.CLAUDE_AGENT_GID || '1001')
    });
    buildPassed = true;
  } catch (e) {
    console.warn(`[BUILD-019] Build failed:`, e.message?.slice(0, 200));
  }

  // Revision loop on build failure
  let revisions = 0;
  while (!buildPassed && installPassed && revisions < 2) {
    revisions++;
    const revisionPrompt = `
Next.js build is failing. Fix the TypeScript/build errors.

Work from ${buildDir}. Run \`npm run build\` yourself to see errors. Fix the actual bugs. Common issues: TypeScript errors, missing dependencies, incorrect imports, server/client component boundary issues.

Do not disable type checking. Fix the real problems.`;

    await runClaudeCode(buildDir, revisionPrompt, 'BUILD-019-rev' + revisions, 1800000);

    try {
      await execFileAsync('bash', ['-c', `cd ${buildDir} && npm run build`], {
        timeout: 900000,
        maxBuffer: 30 * 1024 * 1024,
        uid: parseInt(process.env.CLAUDE_AGENT_UID || '1001'),
        gid: parseInt(process.env.CLAUDE_AGENT_GID || '1001')
      });
      buildPassed = true;
    } catch (_) {}
  }

  const totalDuration = Math.round((Date.now() - startTime) / 1000);
  const finalFileCount = await countOutputFiles(buildDir);

  try {
    await supabase.from('build_agent_runs').insert({
      ticket_id: ticketId,
      agent_id: 'BUILD-019',
      agent_name: 'Frontend Developer',
      status: buildPassed ? 'complete' : 'partial',
      duration_seconds: totalDuration,
      output: {
        file_count: finalFileCount,
        install_passed: installPassed,
        build_passed: buildPassed,
        revisions
      }
    });
  } catch (_) {}

  return {
    agent_id: 'BUILD-019',
    file_count: finalFileCount,
    install_passed: installPassed,
    test_passed: buildPassed,  // frontend "test" = build success
    revisions,
    duration_seconds: totalDuration,
    build_dir: buildDir
  };
}

function buildFrontendPrompt(jobData) {
  return `You are BUILD-019, the Frontend Developer for ManageAI FRIDAY. You write complete, production-ready Next.js 15 applications.

BRIEF:
${JSON.stringify(jobData, null, 2)}

YOUR TASK:
Build a complete Next.js 15 application. Work in /tmp/friday-deep-${jobData.ticket_id}.

DEFAULT STACK:
- Next.js 15 (App Router, RSC, Server Actions)
- TypeScript (strict)
- Tailwind CSS 4
- shadcn/ui components
- Lucide React for icons
- Zod for validation
- React Hook Form for forms
- SWR or TanStack Query for data fetching (if API needed)
- Supabase client for auth + DB (if needed)
- next-themes for dark mode

REQUIRED STRUCTURE:
\`\`\`
app/
  (marketing)/             # Public routes group
  (app)/                   # Protected routes group
  layout.tsx               # Root layout
  globals.css              # Tailwind + global styles
  api/                     # API routes
components/
  ui/                      # shadcn components
  [feature-specific]/
lib/
  utils.ts
  supabase/                # If using Supabase
hooks/
public/
  (static assets)
types/
next.config.ts
tailwind.config.ts
tsconfig.json
components.json            # shadcn config
.env.local.example
.gitignore
README.md
package.json
\`\`\`

REQUIREMENTS:
1. TypeScript strict mode, no \`any\`
2. Server components by default, client components only when needed
3. Responsive design (mobile-first, Tailwind breakpoints)
4. Accessible (proper ARIA, keyboard nav, semantic HTML)
5. Dark mode support via next-themes
6. All forms use React Hook Form + Zod validation
7. Loading states (loading.tsx) and error states (error.tsx) per route
8. SEO: metadata exports, OpenGraph, structured data where relevant
9. Performance: lazy loading, image optimization (next/image)
10. README with setup, env vars, deployment (Vercel/self-hosted)

DESIGN SYSTEM:
- Use shadcn/ui components (install via \`npx shadcn@latest add [component]\`)
- Primary color: Clean modern neutrals unless brief specifies brand colors
- Typography: Inter or brief-specified
- Spacing: Tailwind's spacing scale, generous whitespace
- Rounded corners: Default 8-12px
- Shadows: Subtle, layered

TESTING:
- \`npm run build\` must succeed without errors
- No TypeScript errors
- No ESLint errors (use next/core-web-vitals config)
- No "use client" where not needed
- No "use server" on client code

WORKFLOW:
1. Analyze brief to understand the app's purpose
2. Sketch the routes (which pages, which protected, which public)
3. Initialize Next.js project with required deps
4. Install shadcn/ui components needed
5. Build pages, components, hooks
6. Test with \`npm run build\`
7. Fix errors
8. Confirm clean build

CRITICAL:
- Modern design. Clean. Professional. No AI-generic styling.
- Real content, not lorem ipsum
- Working forms with actual validation
- Working navigation
- Working dark mode toggle
- Use shadcn components correctly — do not reinvent what shadcn already provides

Begin now. Work in the current directory.`;
}
