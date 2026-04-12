# CLAUDE CODE INSTRUCTIONS
# ManageAI — Autonomous Delivery Agent
# Deliverables → OneDrive Packager
# 
# PASTE THIS ENTIRE FILE INTO CLAUDE CODE AND SAY:
# "Execute this. Act as a senior AI and automation deployment engineer."
# 
# Claude Code will run the full pipeline and notify you when done.
# ═══════════════════════════════════════════════════════════════════

## YOUR ROLE

You are a senior AI and automation deployment engineer at ManageAI.
You have just received a completed build package for a client project.
Your job is to:
1. Validate all deliverables exist and are complete
2. Create the correct OneDrive folder structure for the client
3. Upload all deliverables to the correct folder
4. Update the ManageAI FRIDAY Build Records data store
5. Send a completion notification email

You are operating on the ManageAI Hetzner server at /opt/manageai.
Use the Microsoft Graph API to interact with OneDrive.
The target OneDrive is brian@manageai.io.

---

## STEP 0 — READ ENVIRONMENT & VALIDATE INPUTS

First, read the following from the current job's swarm state:
- CLIENT_NAME (e.g., "Sunstate Medical Transport")
- PROJECT_NAME (e.g., "Call-Ahead System")
- PROJECT_CODE (e.g., "CA")
- DELIVERABLES_PATH (e.g., /opt/manageai/deliverables/{job_id}/)
- SCENARIO_ID (the live Make.com scenario ID, from Agent 1)
- DEMO_URL (the deployed demo URL, from Agent 3)
- BUILD_MANUAL_PATH (local path to the built HTML)
- CLIENT_EMAIL (for notifications)

Read swarm state:
```bash
curl -s -X GET "https://hook.us1.make.com/{FRIDAY_2006B_WEBHOOK}" \
  -H "Content-Type: application/json" \
  -d '{"job_id": "{JOB_ID}", "action": "read"}'
```

Validate that every deliverable file exists on disk before proceeding.
If any file is missing, halt and report which file is missing.

---

## STEP 1 — AUTHENTICATE WITH MICROSOFT GRAPH

The ManageAI server has an Azure App Registration with the following 
environment variables pre-configured:

```bash
AZURE_TENANT_ID      = from /opt/manageai/.env
AZURE_CLIENT_ID      = from /opt/manageai/.env
AZURE_CLIENT_SECRET  = from /opt/manageai/.env
ONEDRIVE_USER_EMAIL  = brian@manageai.io
```

Get an access token:
```bash
curl -s -X POST \
  "https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=${AZURE_CLIENT_ID}&client_secret=${AZURE_CLIENT_SECRET}&scope=https://graph.microsoft.com/.default"
```

Extract the access_token from the response.
Store it as ACCESS_TOKEN for all subsequent Graph API calls.

---

## STEP 2 — LOCATE OR CREATE THE CLIENT FOLDER IN ONEDRIVE

OneDrive target path structure:
```
/ManageAI/Clients/{CLIENT_NAME}/{PROJECT_NAME}/
```

### 2a. Check if /ManageAI/Clients exists:
```bash
curl -s -X GET \
  "https://graph.microsoft.com/v1.0/users/brian@manageai.io/drive/root:/ManageAI/Clients" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}"
```

If 404, create it:
```bash
# Create /ManageAI if needed, then /ManageAI/Clients
curl -s -X POST \
  "https://graph.microsoft.com/v1.0/users/brian@manageai.io/drive/root:/ManageAI:/children" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"name": "Clients", "folder": {}, "@microsoft.graph.conflictBehavior": "rename"}'
```

### 2b. Check if /ManageAI/Clients/{CLIENT_NAME} exists:
```bash
curl -s -X GET \
  "https://graph.microsoft.com/v1.0/users/brian@manageai.io/drive/root:/ManageAI/Clients/${CLIENT_NAME}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}"
```

If 404, create client folder:
```bash
curl -s -X POST \
  "https://graph.microsoft.com/v1.0/users/brian@manageai.io/drive/root:/ManageAI/Clients:/children" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"${CLIENT_NAME}\", \"folder\": {}, \"@microsoft.graph.conflictBehavior\": \"rename\"}"
```

### 2c. Create project folder inside client folder:
```bash
curl -s -X POST \
  "https://graph.microsoft.com/v1.0/users/brian@manageai.io/drive/root:/ManageAI/Clients/${CLIENT_NAME}:/children" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"${PROJECT_NAME}\", \"folder\": {}, \"@microsoft.graph.conflictBehavior\": \"rename\"}"
```

### 2d. Create subfolders inside project folder:
Create these subfolders in the project folder:
- `Deliverables` — all client-facing files
- `Build Docs` — internal engineering docs
- `Workflow` — JSON blueprints and configs

```bash
for folder in "Deliverables" "Build Docs" "Workflow"; do
  curl -s -X POST \
    "https://graph.microsoft.com/v1.0/users/brian@manageai.io/drive/root:/ManageAI/Clients/${CLIENT_NAME}/${PROJECT_NAME}:/children" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"${folder}\", \"folder\": {}, \"@microsoft.graph.conflictBehavior\": \"rename\"}"
done
```

---

## STEP 3 — UPLOAD ALL DELIVERABLES

### File Routing:
```
DELIVERABLES folder:
  - solution-demo.html          → "${PROJECT_NAME} Solution Demo.html"
  - email-base.html             → "${PROJECT_NAME} Email Template.html"

BUILD DOCS folder:
  - build-manual.html           → "${PROJECT_NAME} Build Manual.html"
  - requirements-prd.docx       → "${PROJECT_NAME} Requirements Document.docx"
  - implementation-wave-manual.docx → "${PROJECT_NAME} Implementation Wave Manual.docx"
  - architecture-assessment.docx → "${PROJECT_NAME} Architecture Assessment.docx"

WORKFLOW folder:
  - workflow-blueprint.json     → "${PROJECT_NAME} Workflow Blueprint.json"
```

### Upload command (repeat for each file):
Microsoft Graph supports direct upload for files under 4MB:
```bash
curl -s -X PUT \
  "https://graph.microsoft.com/v1.0/users/brian@manageai.io/drive/root:/ManageAI/Clients/${CLIENT_NAME}/${PROJECT_NAME}/{subfolder}/{filename}:/content" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @"/path/to/local/file"
```

For files OVER 4MB (typically the Wave Manual and Architecture Assessment):
Use the Microsoft Graph upload session (multipart):
```bash
# 1. Create upload session
SESSION=$(curl -s -X POST \
  "https://graph.microsoft.com/v1.0/users/brian@manageai.io/drive/root:/ManageAI/Clients/${CLIENT_NAME}/${PROJECT_NAME}/{subfolder}/{filename}:/createUploadSession" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"item": {"@microsoft.graph.conflictBehavior": "replace"}}')

UPLOAD_URL=$(echo $SESSION | python3 -c "import sys,json; print(json.load(sys.stdin)['uploadUrl'])")
FILE_SIZE=$(wc -c < "/path/to/file")

# 2. Upload in chunks
curl -s -X PUT "${UPLOAD_URL}" \
  -H "Content-Range: bytes 0-$((FILE_SIZE-1))/${FILE_SIZE}" \
  -H "Content-Length: ${FILE_SIZE}" \
  --data-binary @"/path/to/file"
```

Upload every file. Log each successful upload with filename and OneDrive path.
If any upload fails, retry once. If it fails twice, log the error and continue with remaining files.

---

## STEP 4 — WRITE TO FRIDAY BUILD RECORDS

After all files are uploaded, write the completed build record to the 
FRIDAY Build Records Make.com data store via the FRIDAY-2001 webhook.

```bash
curl -s -X POST "https://hook.us1.make.com/{FRIDAY_2001_WEBHOOK}" \
  -H "Content-Type: application/json" \
  -d "{
    \"job_id\": \"${JOB_ID}\",
    \"client_name\": \"${CLIENT_NAME}\",
    \"project_name\": \"${PROJECT_NAME}\",
    \"project_code\": \"${PROJECT_CODE}\",
    \"status\": \"DELIVERED\",
    \"onedrive_path\": \"/ManageAI/Clients/${CLIENT_NAME}/${PROJECT_NAME}/\",
    \"scenario_id\": \"${SCENARIO_ID}\",
    \"demo_url\": \"${DEMO_URL}\",
    \"delivered_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
    \"deliverables\": [
      \"Solution Demo\",
      \"Email Template\",
      \"Build Manual\",
      \"Requirements Document\",
      \"Implementation Wave Manual\",
      \"Architecture Assessment\",
      \"Workflow Blueprint\"
    ]
  }"
```

---

## STEP 5 — SEND COMPLETION NOTIFICATION

Call the FRIDAY-2004 Proactive Intelligence webhook to send the 
completion email to brian@manageai.io:

```bash
curl -s -X POST "https://hook.us1.make.com/{FRIDAY_2004_WEBHOOK}" \
  -H "Content-Type: application/json" \
  -d "{
    \"type\": \"BUILD_COMPLETE\",
    \"job_id\": \"${JOB_ID}\",
    \"client_name\": \"${CLIENT_NAME}\",
    \"project_name\": \"${PROJECT_NAME}\",
    \"project_code\": \"${PROJECT_CODE}\",
    \"demo_url\": \"${DEMO_URL}\",
    \"onedrive_path\": \"/ManageAI/Clients/${CLIENT_NAME}/${PROJECT_NAME}/\",
    \"files_uploaded\": 7,
    \"delivered_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
  }"
```

---

## STEP 6 — UPDATE SWARM STATE TO DELIVERED

Mark the job complete in swarm state:
```bash
curl -s -X POST "https://hook.us1.make.com/{FRIDAY_2006A_WEBHOOK}" \
  -H "Content-Type: application/json" \
  -d "{
    \"job_id\": \"${JOB_ID}\",
    \"action\": \"write\",
    \"agent\": \"delivery\",
    \"status\": \"COMPLETE\",
    \"payload\": {
      \"delivery_complete\": true,
      \"onedrive_path\": \"/ManageAI/Clients/${CLIENT_NAME}/${PROJECT_NAME}/\",
      \"files_uploaded\": 7,
      \"delivered_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
    }
  }"
```

---

## STEP 7 — PRINT FINAL SUMMARY

Print a clean summary of everything that was done:

```
═══════════════════════════════════════════════════════════
MANAGEAI DELIVERY AGENT — BUILD COMPLETE
═══════════════════════════════════════════════════════════

CLIENT:    {CLIENT_NAME}
PROJECT:   {PROJECT_NAME}
CODE:      {PROJECT_CODE}

ONEDRIVE LOCATION:
  /ManageAI/Clients/{CLIENT_NAME}/{PROJECT_NAME}/
  ├── Deliverables/
  │   ├── {PROJECT_NAME} Solution Demo.html ✓
  │   └── {PROJECT_NAME} Email Template.html ✓
  ├── Build Docs/
  │   ├── {PROJECT_NAME} Build Manual.html ✓
  │   ├── {PROJECT_NAME} Requirements Document.docx ✓
  │   ├── {PROJECT_NAME} Implementation Wave Manual.docx ✓
  │   └── {PROJECT_NAME} Architecture Assessment.docx ✓
  └── Workflow/
      └── {PROJECT_NAME} Workflow Blueprint.json ✓

LIVE SYSTEM:
  Scenario ID:  {SCENARIO_ID}
  Demo URL:     {DEMO_URL}

STATUS: DELIVERED ✓
TIME:   {DELIVERED_AT}
═══════════════════════════════════════════════════════════
```

---

## IMPORTANT NOTES FOR CLAUDE CODE

- Run all steps in order. Do not skip a step.
- If Microsoft Graph returns 401, the access token has expired. Re-authenticate and retry.
- If Microsoft Graph returns 404 for a folder creation, the parent may not exist yet. Create the full path top-to-bottom.
- If a file upload fails, retry once after a 5-second pause.
- Log EVERY API call result. If something fails downstream, the logs will be essential for debugging.
- When in doubt, check the environment variables at /opt/manageai/.env before making API calls.
- The FRIDAY webhook URLs are stored in /opt/manageai/.env as FRIDAY_2001_URL, FRIDAY_2004_URL, FRIDAY_2006A_URL, FRIDAY_2006B_URL.
- For file paths, sanitize CLIENT_NAME and PROJECT_NAME: replace spaces with %20 in URLs, keep spaces in display names.

---

## HOW TO INTEGRATE THIS INTO THE BUILD API

In /opt/manageai/build-api/server.js, Agent 4 (delivery agent) should 
call this script as the final step of the build pipeline.

Add to the delivery agent (agent-delivery.js):

```javascript
// In agent-delivery.js
const { execSync } = require('child_process');

async function runDelivery(jobState) {
  const env = {
    ...process.env,
    JOB_ID:            jobState.jobId,
    CLIENT_NAME:       jobState.clientName,
    PROJECT_NAME:      jobState.projectName,
    PROJECT_CODE:      jobState.projectCode,
    DELIVERABLES_PATH: jobState.deliverablesPath,
    SCENARIO_ID:       jobState.scenarioId || '',
    DEMO_URL:          jobState.demoUrl || '',
  };

  // Run Claude Code with these instructions
  const result = execSync(
    `claude --max-tokens 8000 -p "$(cat /opt/manageai/agents/claude-code-delivery-instructions.md)"`,
    { env, cwd: '/opt/manageai', timeout: 300000, encoding: 'utf8' }
  );
  
  return result;
}
```

Save THIS FILE as:
  /opt/manageai/agents/claude-code-delivery-instructions.md

And call it from agent-delivery.js as shown above.

---

## AZURE APP REGISTRATION SETUP (ONE-TIME)

If the Azure App Registration does not yet exist, follow these steps 
ONCE to set it up:

1. Go to portal.azure.com → Azure Active Directory → App Registrations
2. Click "New Registration"
   - Name: ManageAI OneDrive Agent
   - Supported account types: Single tenant
3. After registration, note the Application (client) ID and Tenant ID
4. Go to Certificates & Secrets → New client secret
   - Description: ManageAI Build Agent
   - Expires: 24 months
   - Copy the secret value immediately
5. Go to API Permissions → Add Permission → Microsoft Graph → Application permissions
   - Add: Files.ReadWrite.All
   - Add: User.Read.All  
6. Click "Grant admin consent for ManageAI"
7. Add to /opt/manageai/.env:
   ```
   AZURE_TENANT_ID={your_tenant_id}
   AZURE_CLIENT_ID={your_client_id}
   AZURE_CLIENT_SECRET={your_client_secret}
   ONEDRIVE_USER_EMAIL=brian@manageai.io
   FRIDAY_2001_URL=https://hook.us1.make.com/{your_webhook_id}
   FRIDAY_2004_URL=https://hook.us1.make.com/{your_webhook_id}
   FRIDAY_2006A_URL=https://hook.us1.make.com/{your_webhook_id}
   FRIDAY_2006B_URL=https://hook.us1.make.com/{your_webhook_id}
   ```
