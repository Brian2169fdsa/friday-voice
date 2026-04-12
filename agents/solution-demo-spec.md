# FRIDAY Agent 01 — Solution Demo Output Specification
# Version: 2.0
# Lives at: /opt/manageai/agents/solution-demo-spec.md
# Agent 01 MUST read this before writing any Solution Demo output.

---

## WHAT YOU ARE BUILDING

You are Agent 01 — Solution Demo Builder.
Your output is ONE self-contained HTML file that is an interactive demo of the system built.
It is NOT a training manual. It is the client-facing prototype that shows the system working.

File name: `[ProjectName] Solution Demo.html`
Save to: `deliverables/[ProjectName] Solution Demo.html`

---

## CRITICAL DESIGN RULES

Font stack (load from Google Fonts):
  DM Sans: weights 300,400,500,600,700
  JetBrains Mono: weights 400,500

Color palette (store in const C = {}):
  accent:    "#4A8FD6"
  accentDim: "rgba(74,143,214,0.07)"
  bg:        "#FFFFFF"
  surface:   "#F8F9FB"
  surface2:  "#F0F2F5"
  border:    "#E2E5EA"
  text:      "#1A1A2E"
  textDim:   "#8890A0"
  textMid:   "#5A6070"
  success:   "#22A860"
  warning:   "#E5A200"
  danger:    "#E04848"
  logo:      "#2A2A3E"
  purple:    "#7C5CFC"
  orange:    "#E8723A"
  teal:      "#1AA8A8"

React 18 from CDN (same as skillset manual):
  https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js
  https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js

Use createElement syntax (const e = React.createElement) — NO JSX.

---

## REQUIRED PAGE STRUCTURE

### Header (sticky, becomes translucent on scroll)
- Left: pencil edit button (✏️) + MANAGEAI logo text + divider + client name + solution name
- Right: 4 navigation tab buttons (pill style, dark navy when active)
- Subtle grid background pattern (CSS)
- Floating particle animation (12 dots rising)

### 4 Navigation Tabs

**Tab 1: Overview**
- Solution title (28px, 700 weight, -0.02em letter spacing)
- One paragraph description
- Execution flow pipeline: horizontal nodes with → arrows, each node has icon + label + sub-label + colored border
- Stat cards grid: 3-4 cards, each with colored top border, large number, label, sub-label
- In Scope section (green) + Out of Scope section (red) side by side

**Tab 2: Prototype**
- Sub-tabs (varies by build type):
  - For n8n/Make.com: show the workflow JSON structure, trigger simulation, sample output
  - For Retell/voice: show the agent configuration, sample call transcript
  - For data/sheets: show the data table with real-looking mock data
  - IMPORTANT: If you cannot build real interactive prototype content for this specific build, render a white card with the message: "Prototype content will be configured during client handoff. Contact the ManageAI team to activate."
  - DO NOT leave blank screens — always render something.

**Tab 3: How It Works**
- Numbered step cards (vertical, connected with line)
- Each step: colored circle number + title + description paragraph + optional mono code block
- Data flow explanation
- Any tier/classification tables if relevant to this build

**Tab 4: Build Spec**
- Tech stack grid (icon + name + role cards)
- Scenario/workflow specifications (expandable accordion cards)
  - Each card: ID badge + name + module count + expand/collapse
  - Expanded: description + trigger + module sequence (numbered)
- Variables/configuration table (mono font)

### Footer
- Left: MANAGEAI logo + solution name + version + date
- Right: CONFIDENTIAL — Prepared for [Client Name]

---

## REQUIRED CSS ANIMATIONS

Include these in the <style> block:
```css
@keyframes floatUp { 0%{opacity:0;transform:translateY(0) scale(1)} 10%{opacity:.2} 90%{opacity:0} 100%{opacity:0;transform:translateY(-800px) scale(0)} }
@keyframes pulseGlow { 0%,100%{box-shadow:0 0 15px rgba(74,143,214,.06)} 50%{box-shadow:0 0 30px rgba(74,143,214,.18)} }
@keyframes slideIn { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
@keyframes pulseDot { 0%,100%{transform:scale(1);opacity:.7} 50%{transform:scale(1.4);opacity:1} }
@keyframes fadeIn { from{opacity:0} to{opacity:1} }
```

---

## HEADER IMPLEMENTATION

```javascript
// Sticky header with scroll blur effect
const [scrolled, setScrolled] = useState(false);
useEffect(() => {
  const onScroll = () => setScrolled(window.scrollY > 12);
  window.addEventListener("scroll", onScroll);
  return () => window.removeEventListener("scroll", onScroll);
}, []);

// Header style changes on scroll:
// - padding reduces
// - border-bottom appears
// - background gets blur backdrop
// - box shadow appears
```

---

## NAVIGATION BUTTON STYLE

```javascript
// Active: dark navy bg (#1E3348), white text, box shadow
// Inactive: transparent bg, dim text
// Pill shape: borderRadius 7px, padding 7px 14px
// Font: DM Sans, 12px, weight 500 active=700
```

---

## EXECUTION FLOW PIPELINE COMPONENT

Each node:
```javascript
e("div", { style: {
  padding: "10px 14px",
  borderRadius: 10,
  background: C.bg,
  border: "2px solid " + item.color,
  textAlign: "center",
  minWidth: 100
}},
  e("div", { style: { fontSize: 18, marginBottom: 3 }}, item.icon),
  e("div", { style: { fontSize: 10, fontWeight: 600, fontFamily: mono, color: item.color }}, item.label),
  e("div", { style: { fontSize: 8, color: C.textDim, marginTop: 1 }}, item.sub)
)
```

Arrow between nodes: `e("span", { style: { color: C.textDim, fontSize: 14, flexShrink: 0 }}, "→")`

---

## STAT CARD STYLE

```javascript
e("div", { style: {
  padding: 20,
  borderRadius: 12,
  background: C.surface,
  border: "1px solid " + C.border,
  borderTop: "3px solid " + stat.color,
  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
  transition: "box-shadow 0.2s ease"
}},
  e("div", { style: { fontSize: 10, fontWeight: 600, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}, stat.label),
  e("div", { style: { fontSize: 28, fontWeight: 700, fontFamily: mono, color: C.text }}, stat.value),
  e("div", { style: { fontSize: 11, color: C.textDim, marginTop: 4 }}, stat.sub)
)
```

---

## EXPANDABLE SCENARIO CARD STYLE

```javascript
// Collapsed header:
// - scenario ID badge (mono font, colored bg, small)
// - scenario name (14px bold)
// - module count (right aligned, large colored number + "MODULES" label)
// - expand arrow (▼, rotates 180deg when open)
// - background changes to colored tint when expanded

// Expanded body:
// - description paragraph
// - trigger badge + scenario ID badge
// - MODULE SEQUENCE heading
// - numbered list: circle number + module name + description
```

---

## BUILD-SPECIFIC CONTENT RULES

1. Read the request_description carefully — extract the actual workflows, triggers, platforms, and outputs
2. Name all workflows/scenarios based on what this build actually does (WF-01, WF-02... or SC-01, SC-02...)
3. The execution flow pipeline must show the ACTUAL data flow for this specific build
4. Stat cards must show REAL numbers from this build (workflow count, integration count, estimated time saved)
5. The Build Spec accordion must have one card per workflow/scenario actually built
6. Module sequences must reflect the actual nodes in the workflow
7. Tech stack must only list services actually used in this build

---

## PROTOTYPE TAB RULES (CRITICAL)

This is the hardest tab. Rules:

- For n8n: show a simulated webhook payload input + what the workflow does with it + sample output
- For Make.com: show a data table or process simulation relevant to the build
- For Retell/voice: show an agent config panel + sample transcript
- For Google Sheets integrations: show a mock data table with realistic data
- For email/notification systems: show a sample formatted email output

IF you cannot determine what specific prototype content to show:
- Render the tab with a clean placeholder card
- Include the system's main trigger, process, and output as text descriptions
- Add: "Interactive prototype will be configured during client handoff."
- DO NOT crash, leave blank, or error

---

## FLOATING PARTICLES

At the root level, render 12 absolutely positioned divs:
```javascript
Array.from({length: 12}, (_, i) =>
  e("div", {
    key: i,
    style: {
      position: "absolute",
      width: 2, height: 2,
      borderRadius: "50%",
      background: C.accent,
      opacity: 0,
      left: (Math.random() * 100) + "%",
      top: "100%",
      animation: `floatUp 10s ${i * 0.9}s infinite ease-out`
    }
  })
)
```

---

## QUALITY CHECKLIST

Before saving the file, verify:
- [ ] All 4 navigation tabs render content (none are empty or crash)
- [ ] Client name appears at least 5 times
- [ ] Execution flow shows actual build data flow
- [ ] All workflow/scenario names are specific to this build
- [ ] Prototype tab renders something (even a placeholder — never a white screen)
- [ ] File is self-contained
- [ ] File size is at least 60KB
- [ ] No placeholder text like "[INSERT]" remains
- [ ] Footer shows correct client and version

---

## CONSTANTS TO DEFINE AT TOP OF SCRIPT

```javascript
const CLIENT_NAME = "[actual client name]";
const SOLUTION_NAME = "[actual project name]";
const VERSION = "v1.0";
const PLATFORM = "[n8n | Make.com | Custom Code | Retell AI]";
const DATE = "[Month Year]";
const TICKET_ID = "[MAI-XXXX]";

// Build-specific workflow definitions
const WORKFLOWS = [
  {
    id: "WF-01",
    name: "[Actual workflow name]",
    trigger: "[What triggers it]",
    description: "[What it does]",
    modules: ["Module 1 name", "Module 2 name", ...],
    color: C.accent
  },
  // one per workflow actually built
];

// Execution flow steps
const FLOW_STEPS = [
  { icon: "⚡", label: "[Step name]", sub: "[Platform/service]", color: C.accent },
  // ...
];

// Stat cards
const STATS = [
  { label: "Workflows Built", value: "3", sub: "WF-01 through WF-03", color: C.accent },
  // ...
];
```

---

## OUTPUT

Save the completed file as:
  `deliverables/[ProjectName] Solution Demo.html`

This file MUST be delivered. If Agent 01 does not produce this file, the build is incomplete.
