/**
 * BUILD-022: Integration Specialist
 * Builds platform-native integrations (Salesforce, HubSpot, Slack, Teams, etc.).
 * Runs on deep queue. Coordination-native.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { runClaudeCode, runTests, countOutputFiles } from './deep-shared.js';
import { buildSiblingContext, publishState } from './coordination.js';
import { createClient } from '@supabase/supabase-js';
import { promisify } from 'util';
import { execFile } from 'child_process';

const execFileAsync = promisify(execFile);

const INTEGRATION_TYPES = {
  'integration_salesforce': { name: 'Salesforce', stack: 'Apex + LWC', timeout_min: 120 },
  'integration_hubspot': { name: 'HubSpot', stack: 'Node.js + Custom Cards', timeout_min: 75 },
  'integration_slack': { name: 'Slack', stack: 'Bolt (TypeScript)', timeout_min: 60 },
  'integration_teams': { name: 'Microsoft Teams', stack: 'Teams Toolkit + Node.js', timeout_min: 90 },
  'integration_shopify': { name: 'Shopify', stack: 'App Bridge + Polaris', timeout_min: 75 },
  'integration_zendesk': { name: 'Zendesk', stack: 'Zendesk Apps Framework', timeout_min: 60 },
  'integration_gworkspace': { name: 'Google Workspace', stack: 'Apps Script', timeout_min: 60 }
};

export async function buildIntegrationActivity(jobData) {
  const ticketId = jobData.ticket_id;
  const parentTicketId = jobData.parent_ticket_id || null;
  const buildDir = `/tmp/friday-deep-${ticketId}`;
  const startTime = Date.now();

  // Determine integration type
  const integrationType = jobData.integration_platform
    || jobData.deep_build_type
    || 'integration_slack';

  const config = INTEGRATION_TYPES[integrationType] || INTEGRATION_TYPES['integration_slack'];
  console.log(`[BUILD-022] Starting ${config.name} integration build`);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Publish starting state
  await publishState({
    parent_ticket_id: parentTicketId,
    child_ticket_id: ticketId,
    agent_id: 'BUILD-022',
    deep_build_type: integrationType,
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
  const siblingContext = await buildSiblingContext(parentTicketId, 'BUILD-022');

  const prompt = buildIntegrationPrompt(jobData, integrationType, config);
  const enhancedPrompt = prompt + siblingContext;

  await publishState({
    parent_ticket_id: parentTicketId,
    child_ticket_id: ticketId,
    agent_id: 'BUILD-022',
    deep_build_type: integrationType,
    phase: 'writing',
    progress_percent: 10
  });

  // Initial build with platform-specific timeout
  const timeoutMs = config.timeout_min * 60 * 1000;
  const { output, exitCode, duration } = await runClaudeCode(
    buildDir, enhancedPrompt, 'BUILD-022', timeoutMs
  );

  const fileCount = await countOutputFiles(buildDir);
  console.log(`[BUILD-022] Files written: ${fileCount}`);

  await publishState({
    parent_ticket_id: parentTicketId,
    child_ticket_id: ticketId,
    agent_id: 'BUILD-022',
    deep_build_type: integrationType,
    phase: 'installing',
    progress_percent: 60
  });

  // Install deps
  let installPassed = false;
  try {
    await execFileAsync('bash', ['-c',
      `cd ${buildDir} && ` +
      `[ -f package.json ] && npm install --silent 2>&1 | tail -5 || echo "no npm deps"`
    ], {
      timeout: 600000,
      maxBuffer: 30 * 1024 * 1024,
      uid: parseInt(process.env.CLAUDE_AGENT_UID || '1001'),
      gid: parseInt(process.env.CLAUDE_AGENT_GID || '1001')
    });
    installPassed = true;
  } catch (e) {
    console.warn(`[BUILD-022] Install failed:`, e.message?.slice(0, 200));
  }

  // Run tests
  let testResult = { passed: false, output: 'not run' };
  if (installPassed) {
    testResult = await runTests(
      buildDir,
      `[ -f package.json ] && npm test --silent 2>&1 || echo "test-skipped"`,
      'BUILD-022'
    );
  }

  // Revision loop
  let revisions = 0;
  while (!testResult.passed && installPassed && revisions < 2 && !testResult.output?.includes('test-skipped')) {
    revisions++;
    console.log(`[BUILD-022] Revision ${revisions}`);

    await publishState({
      parent_ticket_id: parentTicketId,
      child_ticket_id: ticketId,
      agent_id: 'BUILD-022',
      deep_build_type: integrationType,
      phase: `revision-${revisions}`,
      progress_percent: 70 + revisions * 10
    });

    const revisionPrompt = `
${config.name} integration tests are failing. Fix the issues.

Test output:
\`\`\`
${testResult.output?.slice(0, 3000) || ''}
${testResult.error?.slice(0, 2000) || ''}
\`\`\`

Common ${config.name} integration issues:
${getRevisionHints(integrationType)}

Do NOT skip tests. Fix the real bugs. Work from ${buildDir}.`;

    await runClaudeCode(buildDir, revisionPrompt, 'BUILD-022-rev' + revisions, 1800000);
    testResult = await runTests(buildDir, 'npm test --silent 2>&1', 'BUILD-022');
  }

  const totalDuration = Math.round((Date.now() - startTime) / 1000);
  const finalFileCount = await countOutputFiles(buildDir);

  const exposedArtifacts = buildExposedArtifacts(integrationType, jobData);
  exposedArtifacts.test_passed = testResult.passed;
  exposedArtifacts.install_passed = installPassed;
  exposedArtifacts.revisions = revisions;

  await publishState({
    parent_ticket_id: parentTicketId,
    child_ticket_id: ticketId,
    agent_id: 'BUILD-022',
    deep_build_type: integrationType,
    phase: testResult.passed ? 'complete' : 'partial',
    progress_percent: 100,
    exposed_artifacts: exposedArtifacts
  });

  try {
    await supabase.from('build_agent_runs').insert({
      ticket_id: ticketId,
      agent_id: 'BUILD-022',
      agent_name: `Integration Specialist (${config.name})`,
      status: testResult.passed ? 'complete' : 'partial',
      duration_seconds: totalDuration,
      output: {
        file_count: finalFileCount,
        integration_type: integrationType,
        ...exposedArtifacts
      }
    });
  } catch (_) {}

  return {
    agent_id: 'BUILD-022',
    integration_type: integrationType,
    file_count: finalFileCount,
    install_passed: installPassed,
    test_passed: testResult.passed,
    revisions,
    duration_seconds: totalDuration,
    build_dir: buildDir,
    exposed_artifacts: exposedArtifacts
  };
}

function buildExposedArtifacts(integrationType, jobData) {
  const base = {
    integration_platform: integrationType,
    supabase_tables_written: ['integration_events', 'integration_sync_state']
  };

  switch (integrationType) {
    case 'integration_salesforce':
      return {
        ...base,
        custom_objects: 'defined in /force-app/main/default/objects/',
        apex_classes: 'triggers + service classes',
        lwc_components: 'visual components for Salesforce UI',
        named_credentials: 'for FRIDAY API calls',
        deployment: 'sfdx package ready',
        webhook_endpoint: '/api/webhooks/salesforce'
      };
    case 'integration_hubspot':
      return {
        ...base,
        custom_cards: 'CRM card components',
        workflows: 'HubSpot workflow JSONs',
        webhook_endpoint: '/api/webhooks/hubspot',
        app_marketplace_ready: true
      };
    case 'integration_slack':
      return {
        ...base,
        slash_commands: jobData.slash_commands || ['/ask-friday'],
        modals: 'Block Kit modal definitions',
        shortcuts: 'global + message shortcuts',
        app_manifest: 'manifest.yml ready for Slack app creation',
        socket_mode: true
      };
    case 'integration_teams':
      return {
        ...base,
        tabs: 'configurable + static tabs',
        message_extensions: 'search + action commands',
        bot_endpoint: '/api/messages',
        manifest: 'Teams app manifest ready'
      };
    case 'integration_shopify':
      return {
        ...base,
        admin_blocks: 'product/order/customer blocks',
        webhook_endpoint: '/api/webhooks/shopify',
        app_bridge: 'embedded admin app'
      };
    case 'integration_zendesk':
      return {
        ...base,
        apps: 'ticket sidebar + admin settings',
        macros: 'automation macros',
        triggers: 'ticket event triggers'
      };
    case 'integration_gworkspace':
      return {
        ...base,
        apps_script_project: 'scripts for Sheets/Docs/Gmail',
        workspace_addon: 'sidebar addon for Workspace apps'
      };
    default:
      return base;
  }
}

function getRevisionHints(integrationType) {
  const hints = {
    'integration_salesforce': `
1. Apex test coverage must be 75%+
2. @AuraEnabled methods must have proper access modifiers
3. Named Credentials must be referenced, not hardcoded URLs
4. LWC @wire decorators need imperative fallbacks
5. SOQL queries must use bind variables, not string concat`,

    'integration_hubspot': `
1. OAuth scopes must match app definition exactly
2. Custom card endpoints must return HubSpot card format (not arbitrary JSON)
3. Workflow actions must register with HubSpot extension API
4. Rate limiting: 100 req/10s on most endpoints
5. Webhook signatures validated with app secret`,

    'integration_slack': `
1. Bolt event handlers must call ack() within 3 seconds
2. Modal views must follow Block Kit schema exactly
3. OAuth scopes declared in manifest must match code usage
4. Socket Mode vs HTTP Mode — pick one and be consistent
5. Signing secret validation on every request`,

    'integration_teams': `
1. Bot Framework activity handlers must return promises
2. Adaptive Card schema version 1.4+ required
3. Manifest must include all required permissions
4. SSO token validation against Microsoft tenant
5. Tab configuration must persist in Teams context`,

    'integration_shopify': `
1. App Bridge context required in all admin UIs
2. Polaris components used for UI (not custom)
3. HMAC webhook verification with app secret
4. GraphQL preferred over REST for Shopify 2024+
5. Session tokens must be verified server-side`,

    'integration_zendesk': `
1. ZAF (Zendesk Apps Framework) v2 required
2. OAuth for Zendesk API, not basic auth
3. App locations declared in manifest.json
4. Macros must follow Zendesk action schema
5. Rate limiting: 700 req/min on most endpoints`,

    'integration_gworkspace': `
1. Apps Script manifest must declare scopes explicitly
2. CardService API for UI, not HTML service
3. UrlFetchApp for external calls, not fetch
4. Triggers registered in appsscript.json
5. Time zone handling — always use user's TZ`
  };
  return hints[integrationType] || 'Platform-specific debugging required';
}

function buildIntegrationPrompt(jobData, integrationType, config) {
  const platformPrompts = {
    'integration_salesforce': buildSalesforcePrompt,
    'integration_hubspot': buildHubSpotPrompt,
    'integration_slack': buildSlackPrompt,
    'integration_teams': buildTeamsPrompt,
    'integration_shopify': buildShopifyPrompt,
    'integration_zendesk': buildZendeskPrompt,
    'integration_gworkspace': buildGWorkspacePrompt
  };

  const builder = platformPrompts[integrationType] || buildSlackPrompt;
  return builder(jobData);
}

function buildSalesforcePrompt(jobData) {
  return `You are BUILD-022, the Integration Specialist for ManageAI FRIDAY. You are writing a complete Salesforce integration.

BRIEF:
${JSON.stringify(jobData, null, 2)}

STACK: Salesforce DX (SFDX) project with Apex triggers, service classes, Lightning Web Components, Named Credentials, and Flow actions.

Work in /tmp/friday-deep-${jobData.ticket_id}.

REQUIRED STRUCTURE:
\`\`\`
force-app/main/default/
  objects/
    [CustomObject]__c/
      [CustomObject]__c.object-meta.xml
      fields/
      listViews/
  classes/
    [ServiceName]Service.cls
    [ServiceName]Service.cls-meta.xml
    [TriggerHandler]Handler.cls
    [TestClass]Test.cls
  triggers/
    [ObjectName]Trigger.trigger
  lwc/
    [componentName]/
      [componentName].js
      [componentName].html
      [componentName].css
      [componentName].js-meta.xml
  namedCredentials/
    ManageAI_FRIDAY.namedCredential-meta.xml
  flows/
    [FlowName].flow-meta.xml
sfdx-project.json
package.xml
scripts/
  deploy.sh
README.md
SETUP.md
\`\`\`

REQUIREMENTS:
1. Custom objects for integration data (sync state, event log)
2. Apex triggers handle write events, call FRIDAY API via Named Credential
3. Service classes with @AuraEnabled methods for LWC access
4. Test classes with 75%+ coverage (Salesforce requirement)
5. Named Credentials for FRIDAY API auth (no hardcoded URLs/keys)
6. LWC for custom UI in record pages or app pages
7. Flow actions wrap Apex service methods for declarative users
8. Webhook endpoint in Node.js app (src/webhooks/salesforce.ts) for inbound events
9. SOQL uses bind variables (never string concat)
10. Governor limits respected (bulk-safe patterns)

SETUP.md must include: SFDX CLI install, Dev hub auth, scratch org creation, package deployment, Named Credential setup, test customer creation.

Write COMPLETE, deployable code. Begin.`;
}

function buildHubSpotPrompt(jobData) {
  return `You are BUILD-022, the Integration Specialist for ManageAI FRIDAY. You are writing a complete HubSpot integration.

BRIEF:
${JSON.stringify(jobData, null, 2)}

STACK: Node.js + TypeScript app with HubSpot OAuth, custom CRM cards, workflow actions, webhook handlers.

Work in /tmp/friday-deep-${jobData.ticket_id}.

REQUIRED STRUCTURE:
\`\`\`
src/
  index.ts
  oauth/
    install.ts          # OAuth install flow
    callback.ts         # Token exchange
    token-manager.ts    # Refresh handling
  webhooks/
    contact.ts          # Contact events
    deal.ts             # Deal events
    ticket.ts           # Ticket events
  cards/
    contact-card.ts     # Custom CRM card for contacts
    deal-card.ts        # Custom CRM card for deals
  workflows/
    custom-actions.ts   # Workflow action definitions
  api/
    contacts.ts         # HubSpot contacts API wrapper
    deals.ts
    tickets.ts
  types/
    hubspot.ts
tests/
  webhooks.test.ts
  cards.test.ts
  oauth.test.ts
hubspot/
  app-manifest.json
  workflow-actions.json
  custom-cards.json
package.json
tsconfig.json
.env.example
README.md
SETUP.md
\`\`\`

REQUIREMENTS:
1. OAuth flow (install + callback + token refresh)
2. Webhook handlers with app secret signature verification
3. Custom CRM cards return HubSpot card format
4. Workflow custom actions callable from HubSpot workflows
5. Rate limiting respected (100 req/10s)
6. Error handling with exponential backoff
7. Tests with fixture payloads (not live calls)
8. 80%+ coverage
9. SETUP.md: how to create HubSpot app, install, configure scopes

Write COMPLETE code. Begin.`;
}

function buildSlackPrompt(jobData) {
  return `You are BUILD-022, the Integration Specialist for ManageAI FRIDAY. You are writing a complete Slack app.

BRIEF:
${JSON.stringify(jobData, null, 2)}

STACK: Slack Bolt for TypeScript. Full app — slash commands, modals, shortcuts, message buttons, Block Kit UI.

Work in /tmp/friday-deep-${jobData.ticket_id}.

REQUIRED STRUCTURE:
\`\`\`
src/
  index.ts
  config.ts
  handlers/
    commands/         # Slash command handlers
    actions/          # Button/select actions
    shortcuts/
      global/
      message/
    events/
      app-mention.ts
      message.ts
    views/            # Modal submissions
  blocks/             # Reusable Block Kit blocks
  modals/             # Modal view definitions
  middleware/
    auth.ts
    logging.ts
  services/           # Business logic
tests/
  handlers.test.ts
  blocks.test.ts
slack-app/
  manifest.yml        # App manifest for Slack
package.json
tsconfig.json
.env.example
README.md
SETUP.md
\`\`\`

REQUIREMENTS:
1. Slack Bolt framework (official SDK)
2. Signing secret verification on every request
3. ack() called within 3 seconds on every event/action
4. Block Kit for all UI (valid schema, tested)
5. Modals for complex input
6. Socket Mode for local dev, HTTP Mode for production
7. OAuth scopes declared in manifest match code usage
8. Tests with mocked Slack API
9. 80%+ coverage
10. SETUP.md: create app, install, set env vars

Write COMPLETE code. Begin.`;
}

function buildTeamsPrompt(jobData) {
  return `You are BUILD-022, building a Microsoft Teams app.

BRIEF:
${JSON.stringify(jobData, null, 2)}

STACK: Teams Toolkit + Bot Framework + Node.js/TypeScript. Tabs, message extensions, bot, optional meeting app.

Work in /tmp/friday-deep-${jobData.ticket_id}.

Build the full Teams app with Adaptive Cards, SSO support, configurable tabs, message extensions. Bot endpoint at /api/messages. Valid manifest. 80%+ test coverage. SETUP.md explains tenant registration and app upload.

Write COMPLETE code. Begin.`;
}

function buildShopifyPrompt(jobData) {
  return `You are BUILD-022, building a Shopify app.

BRIEF:
${JSON.stringify(jobData, null, 2)}

STACK: Shopify App Bridge + Polaris + Node.js. Embedded admin UI, GraphQL Admin API, webhook handlers.

Work in /tmp/friday-deep-${jobData.ticket_id}.

Build the full Shopify app with HMAC webhook verification, OAuth, session tokens, Polaris UI, admin blocks. Valid for Shopify App Store submission. 80%+ test coverage.

Write COMPLETE code. Begin.`;
}

function buildZendeskPrompt(jobData) {
  return `You are BUILD-022, building a Zendesk app.

BRIEF:
${JSON.stringify(jobData, null, 2)}

STACK: Zendesk Apps Framework v2. Ticket sidebar app, admin settings, custom fields, macros, triggers.

Work in /tmp/friday-deep-${jobData.ticket_id}.

Build the full Zendesk app with ZAF v2, OAuth for API access, proper manifest.json, app locations, macros. 80%+ test coverage.

Write COMPLETE code. Begin.`;
}

function buildGWorkspacePrompt(jobData) {
  return `You are BUILD-022, building a Google Workspace add-on.

BRIEF:
${JSON.stringify(jobData, null, 2)}

STACK: Apps Script. CardService for UI. Runs inside Gmail/Sheets/Docs/Drive.

Work in /tmp/friday-deep-${jobData.ticket_id}.

Build the full Workspace add-on with CardService UI, declared scopes in appsscript.json, time-driven triggers, UrlFetchApp for FRIDAY API calls. Complete with README and SETUP.md.

Write COMPLETE code. Begin.`;
}
