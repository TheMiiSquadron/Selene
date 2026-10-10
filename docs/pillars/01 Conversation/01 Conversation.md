# 01 — Conversation

**Document:** Pillar 01 — Conversation  
**Project:** Aether / Selene  
**Status:** Approved design requirements; implementation not established by this document  
**Scope:** Natural-language interaction and dialogue management  
**Parent:** [00 — Master Roadmap](../00%20-%20Master%20Roadmap.md)

---

## 01.1 — Purpose and Boundaries

Conversation is Aether's primary user-facing communication domain. It interprets and maintains dialogue, presents responses, handles conversational context and initiative, and coordinates with other Pillars through Aether Core.

Conversation is **not** an independent assistant or a substitute for Aether Core. Aether Core coordinates cross-Pillar execution; the Authority system determines whether protected actions are permitted. Conversation does not own persistent memory storage, unrestricted computer control, or external integrations.

**Design status key**
- **Implemented:** Verified in repository code or tests; not asserted in this specification without a separate implementation audit.
- **Approved / Planned:** Agreed behavior to implement, not a claim of current functionality.
- **Proposed:** Candidate behavior awaiting a design decision.
- **Deferred:** Intentionally excluded from the initial scope.

The following ten decisions are **Approved / Planned**, not verified implemented.

---

## 01.2 — Approved Design Decisions

### D01 — Consistent identity, adaptive communication

An assistant retains its recognizable personality while adapting delivery to context. Casual dialogue can be warm and playful; coding should be precise and collaborative; research should be evidence-oriented; errors should be calm and actionable; urgent warnings should be concise. Adaptation must not silently replace the assistant's identity or override user preferences.

### D02 — Contextual, nonintrusive initiative

The assistant may occasionally initiate a relevant suggestion when there is a meaningful, authorized contextual reason. It must avoid repetitive or unsolicited interruptions, respect dismissals such as “not right now,” and not treat an observation as authorization to take action.

### D03 — Cross-session conversational continuity

The assistant should resume relevant discussion across sessions and recognize references to earlier topics when authorized context is available. It should acknowledge missing or ambiguous context rather than inventing continuity. Persistent storage and retrieval belong to Pillar 04 — Memory & Knowledge.

### D04 — Hybrid, human-manageable memory

Routine, useful context may be retained automatically under user-configured rules. Sensitive information and significant changes to established memories require appropriate permission or confirmation. Persistent memories must be human-readable, inspectable, searchable, correctable, and deletable; provenance and freshness should be visible. These are requirements for the collaboration with Pillar 04, not a storage design. Remembered information must never itself grant action permissions.

### D05 — Consequence-aware uncertainty

For low-risk dialogue, the assistant may answer with appropriately qualified assumptions. When accuracy matters, it should clarify or verify using available authorized means. Before high-impact, destructive, or permission-sensitive operations, it must seek required approvals. An uncertainty disclaimer is not a substitute for authorization.

### D06 — Context-aware interruption management

The assistant should classify observations by priority and respect user-configured notification rules. Nonessential alerts should be suppressed during detected gaming or other immersive activities, without stealing focus, injecting input, or opening intrusive windows. Deferred notifications may be queued for later review. A brief Alt+Tab should not automatically end gaming suppression.

### D07 — Critical warning exception

Genuinely critical system warnings may override gaming suppression according to explicit severity rules and user settings. Routine resource fluctuations must not be treated as emergencies. Critical alerts are notifications, not blanket authorization for remediation.

### D08 — Seamless Constellation conversation continuity

Authenticated personal devices should be able to resume the same conversations, subject to availability, privacy, and synchronization rules. Nova is the intended primary host for Selene; graceful behavior when it is unavailable requires later design. Sharing conversation context across devices must **not** transfer privileges or authorize remote execution.

### D09 — Familiar conversations and projects, with intelligent linking

Users should be able to create, rename, search, archive, and delete distinct conversations and organize them into projects. With appropriate privacy boundaries, the assistant may retrieve relevant context across conversations and suggest links between related discussions without merging them automatically. Projects or conversations marked isolated must not be used as cross-conversation context without permission.

### D10 — Universal engine, configurable assistant identity; text first

Aether's Conversation engine is identity-independent. Each assistant may have its own name, personality, tone, appearance, and eventually voice without duplicating the underlying engine or sharing another assistant's private data or authority. Selene is one configuration of Aether, not a hard-coded universal identity.

**Text conversation is the approved initial interaction mode**, including typing on supported Constellation devices. Voice conversations are **Deferred**, not rejected. Text-to-speech responses and voice guidance for Selene Maps are separate, undecided design topics and are not initial Conversation requirements.

---

## 01.3 — Safety, Privacy, and Authority

- Aether Core remains responsible for coordinating requests involving multiple Pillars.
- The Authority system enforces permissions at execution boundaries; conversational confidence, initiative, remembered preferences, and device continuity do not expand authority.
- Requests involving deletion, privileged system changes, sensitive data, or external side effects require applicable authorization and confirmation.
- Conversation history, project context, and assistant identity must be scoped to the authorized user/assistant and device.
- Users must be able to correct context and manage retained memories through Pillar 04.
- When context or an integration is unavailable, explain the limitation and continue with authorized, locally available functionality where practical.
- Detection of active games, system health, or foreground applications depends on separately authorized platform capabilities; this document does not grant monitoring access.

---

## 01.4 — Cross-Pillar Dependencies

| Component | Conversation responsibility | Other component responsibility |
| --- | --- | --- |
| Aether Core | Interpret dialogue and present coordinated results | Route and coordinate execution |
| Authority system | Request/communicate approvals | Enforce permissions |
| 04 Memory & Knowledge | Request and present relevant context; surface memory controls | Persist, retrieve, edit, delete, and synchronize memories |
| 03 Computer Control | Explain proposed actions and results | Perform authorized OS/application interaction and contextual detection |
| 08 Automation | Discuss reminders, alerts, and proactive suggestions | Manage scheduled or event-driven execution |
| 12 Integrations / Constellation | Maintain user-facing continuity | Authenticate, transport, and constrain device/service access |
| Other Pillars | Provide natural-language interaction | Supply their specialized capabilities |

Dependencies describe intended boundaries, not completed integrations.

---

## 01.5 — Acceptance Criteria for Future Benchmarks

The following are **planned test cases**, not passing results:

1. **Style adaptation:** Given casual, technical, and urgent prompts, responses adjust tone while preserving configured assistant identity.
2. **Initiative restraint:** Relevant suggestions occur only under permitted conditions; dismissal suppresses repeated prompting about the same observation.
3. **Continuity:** A discussion can resume in a later session with correct authorized context; absent context produces an honest clarification.
4. **Memory controls:** A routine memory and a sensitive memory follow different consent rules; edits and deletions are reflected in later retrieval.
5. **Uncertainty:** Ambiguous low-risk questions receive qualified answers; destructive ambiguous requests receive review and confirmation rather than action.
6. **Gaming suppression:** Noncritical notifications are queued during gameplay; focus is not stolen; brief Alt+Tab does not release the queue.
7. **Critical exception:** A validated critical condition may alert during gaming; benign temperature fluctuations do not.
8. **Cross-device continuity:** An authenticated device resumes a conversation; unauthorized devices cannot read it or inherit another device's permissions.
9. **Conversation isolation:** Search, archive, project organization, and approved cross-conversation retrieval work; isolated projects remain excluded.
10. **Identity separation:** Two differently named/configured assistants use the same engine while retaining separate identities, private context, and permissions.
11. **Text-only initial release:** All core Conversation flows work without microphone or speech dependencies.

Tests must identify prerequisites, simulated versus real integrations, and objective pass/fail evidence before implementation claims are made.

---

## 01.6 — Open Questions and Deferred Work

- Exact initiative thresholds, cooldowns, and dismissal duration.
- Priority taxonomy and thresholds for critical system warnings; notification settings and quiet hours.
- How to detect games and immersive applications reliably and privately on each platform.
- Conversation/project retention defaults, deletion propagation, and audit/provenance behavior (Pillar 04).
- Constellation sync conflict resolution, offline behavior, authentication, and encryption details.
- Detailed UI design and accessibility for conversation/project management.
- Text-to-speech output and Selene Maps voice guidance: **undecided**.
- Two-way voice conversation: **deferred**.

No specific database, API, event format, model, or platform implementation is mandated by this document.

---

## 01.7 — Implementation Tracking

**Documentation milestone:** Initial Pillar 01 requirements agreed and recorded.  
**Implementation verification:** Pending a separate repository/code audit.  
**Benchmark status:** Acceptance criteria drafted; tests not yet implemented or executed.  
**Next step:** Review this specification, then plan incremental capabilities and test coverage without assuming the approved behaviors already exist.
