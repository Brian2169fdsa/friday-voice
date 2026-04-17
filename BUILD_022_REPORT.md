# BUILD-022 Integration Specialist — Sprint Report
## Date: 2026-04-17
## Status: LIVE on deep worker

## What Was Added

### New Files
- `build-api/temporal/activities/deep/integration-specialist-dev.js` — BUILD-022 activity

### Wiring Updates (additive only)
- `temporal/deep-worker.js` — BUILD-022 imported + registered
- `temporal/workflows/deep-build.js` — 7 integration_ cases added
- `temporal/activities/router-agent.js` — 7 integration_ types in validTypes + typeToBuilder
- `temporal/activities/deep-dispatcher.js` — 7 integration_ types in mapTypeToDeepBuildType
- `temporal/activities/deep/deep-coordinator.js` — 7 integration_ types in typeToBuilder + integration coordination patterns in coordinator prompt
- `server.js` — 7 integration_ types in both validDeepTypes arrays

## Supported Platforms

| Type | Platform | Stack | Timeout |
|------|----------|-------|---------|
| `integration_salesforce` | Salesforce | Apex + LWC | 120 min |
| `integration_hubspot` | HubSpot | Node.js + Custom Cards | 75 min |
| `integration_slack` | Slack | Bolt (TypeScript) | 60 min |
| `integration_teams` | Microsoft Teams | Teams Toolkit + Node.js | 90 min |
| `integration_shopify` | Shopify | App Bridge + Polaris | 75 min |
| `integration_zendesk` | Zendesk | Zendesk Apps Framework | 60 min |
| `integration_gworkspace` | Google Workspace | Apps Script | 60 min |

## What BUILD-022 Produces

### Salesforce
- Apex classes (triggers, controllers, batch jobs, test classes)
- Lightning Web Components with Supabase sync
- Named Credentials for external callouts
- Permission sets + profiles
- SFDX project structure (force-app/)
- SETUP.md: Salesforce DX CLI walkthrough

### HubSpot
- CRM Card / Custom Card (sidebar app)
- Webhook subscriptions (contacts, deals, companies)
- OAuth 2.0 scoped token flow
- Supabase sync via webhook handlers
- n8n workflows: deal stage changes, contact enrichment
- SETUP.md: HubSpot developer account + app creation

### Slack
- Bolt app (TypeScript) with slash commands, shortcuts, event subscriptions
- Block Kit UI components
- OAuth install flow (workspace-level)
- Supabase persistence for workspace tokens
- n8n workflows: Slack → trigger → action
- SETUP.md: Slack app manifest YAML

### Microsoft Teams
- Teams Toolkit project structure
- Bot Framework + Adaptive Cards
- Tab application with MSAL SSO
- Webhook endpoints for Teams events
- Azure Function stubs for hosting
- SETUP.md: Teams Toolkit + Azure setup

### Shopify
- Embedded app (App Bridge 3.x + Polaris)
- OAuth install flow + session tokens
- Shopify webhooks: orders, products, customers
- Admin API integration (GraphQL + REST)
- Supabase sync for order/product data
- SETUP.md: Shopify Partner account + CLI

### Zendesk
- Zendesk App Framework (ZAF) app
- Ticket sidebar + Top Bar placements
- Zendesk API integration (OAuth + API token)
- Supabase enrichment data sync
- SETUP.md: Zendesk developer account

### Google Workspace
- Apps Script project (clasp structure)
- Google Sheets add-on / Docs sidebar
- Workspace OAuth scopes
- Admin SDK + Drive/Sheets API integration
- Supabase sync via UrlFetchApp
- SETUP.md: GCP project + OAuth consent screen

## Coordination Behavior (when siblings present)

BUILD-022 exposes (varies by platform):
- `webhook_endpoints`: platform-specific inbound webhooks
- `oauth_endpoints`: install/callback routes
- `supabase_tables_written`: platform-specific sync tables
- `api_endpoints`: sidebar/card endpoints (HubSpot, Zendesk)

BUILD-022 consumes from siblings:
- Shared Supabase schema (from coordination contract)
- Shared auth model
- Sibling API endpoints (if custom_service provides business logic)

### New Coordinator Patterns
BUILD-030 now knows cross-agent patterns for all 7 integration types:
- `integration_salesforce + custom_service` → Service handles webhook callbacks
- `integration_hubspot + frontend_app` → Frontend embeds HubSpot Custom Cards
- `integration_slack + custom_service` → Bolt app calls service for business logic
- `integration_teams + frontend_app` → Teams tab embeds frontend with MSAL SSO
- `integration_shopify + data_pipeline` → Order webhooks feed pipeline analytics
- `integration_zendesk + custom_service` → Sidebar calls service for enrichment
- `integration_gworkspace + data_pipeline` → Apps Script pushes into pipeline

## Opt-In Usage

Single platform:
```json
{
  "enable_deep_builds": true,
  "deep_builds": ["integration_slack"],
  "request_description": "Slack bot for incident management — slash command to open incidents, post updates to #incidents channel"
}
```

Salesforce + frontend dashboard:
```json
{
  "enable_deep_builds": true,
  "deep_builds": ["integration_salesforce", "frontend_app"],
  "request_description": "Salesforce lead capture → Next.js dashboard showing pipeline"
}
```

Full enterprise stack:
```json
{
  "enable_deep_builds": true,
  "deep_builds": ["integration_slack", "custom_service", "frontend_app"],
  "request_description": "Slack-first support bot backed by Node.js service, React dashboard for agents"
}
```

## Syntax Checks

```
✓ integration-specialist-dev.js
✓ deep-worker.js
✓ deep-build.js
✓ router-agent.js
✓ deep-dispatcher.js
✓ deep-coordinator.js
```

All 6 passed.

## PM2 Status

- manageai-build-api: online
- friday-worker: online
- friday-deep-worker: online (BUILD-022 registered alongside 017/018/019/020/021)

## Fix Applied
`dotenv` was missing from `build-api/node_modules` — installed via `npm install dotenv`.
Deep worker now boots cleanly.

## What Did NOT Change

- Fast queue (friday-worker, friday-build.js) — untouched
- BUILD-001 through BUILD-021 — untouched
- Watchdog — untouched

## Files Created / Modified

| File | Action |
|------|--------|
| temporal/activities/deep/integration-specialist-dev.js | CREATED |
| temporal/deep-worker.js | +import + spread |
| temporal/workflows/deep-build.js | +7 switch cases |
| temporal/activities/router-agent.js | +7 validTypes + 7 typeToBuilder |
| temporal/activities/deep-dispatcher.js | +7 mapTypeToDeepBuildType |
| temporal/activities/deep/deep-coordinator.js | +7 typeToBuilder + integration patterns |
| server.js | +7 validDeepTypes (×2 arrays) |

## Next Steps

- [ ] BUILD-023: Analytics & Reporting Agent (Metabase, Looker, BigQuery pipelines)
- [ ] Wire BUILD-030 coordinator into dispatcher (auto-create contracts)
- [ ] Test hybrid: integration_slack + custom_service
- [ ] FRIDAY Remote UI: deep build type selector with platform icons
