# 02 — Coding

**Project:** Aether 2.0  
**Pillar:** 02 — Coding  
**Status:** Approved design requirements; implementation pending  
**Scope:** Local-first software development assistance coordinated by Aether Core

## Purpose

Provide a Codex-like coding experience within the assistant's existing conversation interface. Coding supports code generation, analysis, debugging, tests, and development workflows. It is an Aether capability domain, not a separate assistant or an unrestricted execution authority.

## Approved design decisions

### 01 — Progressive autonomy
- **Initial:** Collaborative Developer. Inspect projects, propose plans, perform authorized edits, run checks, and report results.
- **Future:** Autonomous Developer for larger delegated assignments, contingent on demonstrated reliability, configured authority, and review checkpoints.
- Autonomy does not imply unlimited filesystem, operating-system, or network privileges.

### 02 — Flexible workspace operations
- Support direct edits in authorized folders and isolated Git worktrees or temporary workspaces when useful for safety or task separation.
- Support creating project folders and files within an authorized workspace.
- Select an appropriate working strategy based on the task and risk; report where changes were made.

### 03 — Configurable permission modes
- **Ask for Approval:** Conservative approval prompts for changes and protected operations.
- **Approve for Me:** Permit routine development operations within explicitly authorized scope; request approval for elevated or risky actions.
- **Full Access:** Explicit high-trust mode for broad development operations, still subject to operating-system privileges and separately protected actions.
- Modes can be changed at any time. Enforce tightened permissions at the next safe execution boundary; expose active permissions, logs, and Pause/Stop controls.
- Permission to execute tools is separate from authorization to initiate new work, repair failures, commit, or push.

### 04 — Integrated, chat-first coding experience
- Coding assignments appear in Selene's normal conversations and project organization, rather than requiring a separate IDE or application window.
- Show relevant commands, output, progress, diffs, test results, and approval requests inline or in optional expandable views.
- Open files and projects in the user's installed VS Code. A full built-in source editor and elaborate dashboard are **not** initial requirements.
- A session can continue while the user navigates to other conversations, with visible status and Pause/Stop.

### 05 — Automatic and manual model selection
- Automatic mode selects among available local models based on task, benchmark evidence, hardware resources, and user preferences.
- Manual mode lets the user select a model and keeps that selection unless the user changes it or it becomes unavailable; do not silently override it.
- Show which model is being used. Future automatic routing may use different models for planning and implementation.
- Local-first operation should degrade gracefully when a model/provider is unavailable.

### 06 — Persistent coding knowledge and automatic retrieval
- Automatically retrieve relevant curated programming documentation, repository conventions, and authorized prior project context.
- Integrate with the separate **Aether 2.0 Code Knowledge** repository and Pillar 04 Memory & Knowledge; do not duplicate their storage responsibilities.
- Knowledge persists independently of any model's weights, allowing model replacement without losing stored documentation.
- Preserve source provenance, version/applicability, and boundaries around private project information.
- Retrieval does not grant permission to modify trusted knowledge.

### 07 — Test-gated learning
- Initially, Selene may identify and propose reusable lessons but must not independently promote them to trusted permanent knowledge.
- Evaluate lesson quality using reproducible tests, retrieval accuracy, contradiction handling, version specificity, correction/retirement behavior, and privacy safeguards.
- Only consider narrowly scoped automatic promotion after dedicated repeated benchmark validation.
- Changes to trusted reference documentation or major architecture decisions continue to require review.

### 08 — Testing and failure handling
- Automatically run authorized tests, builds, and validation checks relevant to an assigned task.
- Automatically detect, inspect, and report failures.
- **Attempting fixes requires a user request.** An implementation request permits its agreed implementation edits, but test failures do not authorize an open-ended new repair loop.
- Once a fix is requested, work within the authorized scope; retry count and limits remain to be specified.
- Report checks that could not run and do not claim unverified success.

### 09 — Git review-first workflow
- Prepare a summary, diffs, test outcomes, and suggested commit message.
- **Do not commit or push automatically.** Await explicit authorization for each operation unless the user explicitly defines a bounded exception.
- Keep approvals and changes distinct for each repository in a multi-repository task.
- Destructive Git actions (such as force push, hard reset, and branch deletion) require separate explicit approval.

### 10 — Multi-project workspace
- The user's chosen default authorized root is `A:\OneDrive\Desktop\VS Code` (the parent of `Personal`).
- A single coding session may inspect, compare, create, and edit across multiple projects under that root according to active permissions, including existing and future subfolders.
- Outside that root requires separate authorization. Resolve canonical paths and prevent symlinks/junctions from silently escaping scope.
- The root is configurable for other Aether users; it is not a hardcoded global path.
- Parallel independent coding agents are a **future consideration**, distinct from multi-folder access.

### 11 — Lightweight project discovery
- Discover project directories and Git repositories within the authorized root.
- Infer languages/frameworks from standard manifests and remember project locations.
- Refresh on demand or when stale; avoid expensive recursive indexing of generated/dependency folders.
- Project discovery does not itself expand read/write permissions.

### 12 — Interrupted session recovery
- Persist task goals, plans, progress, checkpoints, changed-file references, last test results, and pending approvals.
- On process/model disconnect, crash, or host restart, offer recovery after reconciling checkpoints with actual workspace and Git state.
- Never blindly rerun a potentially side-effecting command. Require confirmation where appropriate.
- Reevaluate current authority on recovery; never restore broader permissions from an old checkpoint.

## Coordination and boundaries

- **Aether Core:** Task interpretation and orchestration.
- **Authority system:** Workspace scope, protected commands, approvals, and auditability.
- **Pillar 01 Conversation:** Chat-first interaction, projects, and session presentation.
- **Pillar 03 Computer Control:** Authorized OS/application execution where needed.
- **Pillar 04 Memory & Knowledge:** Persistent documentation, project knowledge, and candidate lessons.
- **Pillar 05 Research / Pillar 12 Integrations:** Optional authorized external sources, Git providers, and other services.
- **Selene Benchmarks:** Evidence for model routing and eventual learning/autonomy gates.

## Initial delivery priorities

1. Authorized workspace access and simple project discovery.
2. Conversational coding task execution with observable commands and diffs.
3. Configurable approval modes and explicit Git commit/push gates.
4. Automated test execution and failure reporting; request-gated repair attempts.
5. Persistent task checkpoints and safe recovery.
6. Local model selection and retrieval of existing coding knowledge.

## Deferred or open implementation details

- Precise approval boundaries for each command and filesystem operation.
- Fix-loop iteration limits after explicit authorization.
- Session checkpoint format, reconciliation algorithm, and recovery UI.
- Benchmark thresholds for autonomous coding and trusted lesson promotion.
- Parallel agent scheduling and resource budgeting.
- Advanced embedded editing/dashboard features.

**Design note:** These are target requirements, not claims that the described capabilities have already been implemented.
