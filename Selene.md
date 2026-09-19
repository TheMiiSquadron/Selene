# SELENE

**One assistant. Twelve capabilities. A modular architecture.**

> Project reference and development roadmap. Update this document as architectural decisions and milestones are approved.

## 1. Vision

Selene is a local-first personal AI assistant designed to operate across multiple devices through a shared architecture.

The goal is one assistant with multiple Homes, a connected device ecosystem called the Constellation, and twelve modular capability areas known as the Pillars.

Development priorities:

* Build stable foundations before expanding capabilities.
* Prefer local processing and user-controlled infrastructure.
* Keep privileged actions behind explicit authority boundaries.
* Develop and validate one small milestone at a time.
* Keep the Homes consistent without requiring identical interfaces.

---

## 2. Architecture

| Component               | Purpose                                                      |
| ----------------------- | ------------------------------------------------------------ |
| Selene Core             | Assistant logic, models, memory, authority, and capabilities |
| Companion API / Gateway | Controlled communication between Core and Homes              |
| Homes                   | Interfaces through which users interact with Selene          |
| Constellation           | Connected devices, their roles, and coordination             |
| Twelve Pillars          | Selene's modular capabilities                                |

**Architecture principle:** Homes communicate with Selene through controlled interfaces rather than directly accessing privileged Core functionality.

The name *Gateway* is proposed but has not yet replaced *Companion API* in the codebase.

---

## 3. The Homes

Homes are the interfaces where Selene lives.

| Home             | Platform           | Status                                        |
| ---------------- | ------------------ | --------------------------------------------- |
| Windows Home     | Windows / Electron | Foundation built; further development planned |
| iPhone Home      | iOS / SwiftUI      | Active development                            |
| Web Companion    | Browser            | Foundation built; website development paused  |
| Mac Home         | macOS              | Planned                                       |
| Apple Watch Home | watchOS            | Future                                        |

### Current priorities

1. Complete shared conversation infrastructure.
2. Integrate persistent conversations into the iPhone Home.
3. Finish the initial iPhone experience.
4. Expand Pebble using the shared infrastructure.
5. Develop additional native Homes as needed.

The Web Companion website is optional and is not a prerequisite for beginning the Pillars. The Companion API remains essential infrastructure.

---

## 4. The Constellation

The Constellation is Selene's connected device ecosystem.

| Device                          | Role                   |
| ------------------------------- | ---------------------- |
| NOVA                            | Host                   |
| ORION                           | Node                   |
| ENVY                            | Node                   |
| iPhone                          | Companion              |
| Apple Watch                     | Companion              |
| Friends' and family's computers | Future nodes           |

NOVA is the initial canonical host for shared conversation history.

### Planned capabilities

* Device registration and pairing
* Connection status
* Device-specific permissions
* Credential revocation
* Secure local and remote communication
* Coordination between authorized devices

**Current scope:** Alex's own devices. Friends and family are a potential future expansion.

The Constellation menu is planned for the iPhone Home. Its first version will be read-only.

---

## 5. The Twelve Pillars

The Pillars represent Selene's twelve modular capability areas.

Their exact names, responsibilities, and implementation order should be recorded here as they are confirmed.

| #  | Pillar          | Status      |
| -- | --------------- | ----------- |
| 01 | Conversation | Not started |
| 02 | Coding | Not started |
| 03 | Computer Control | Not started |
| 04 | Memory & Knowledge | Not started |
| 05 | Research | Not started |
| 06 | Productivity | Not started |
| 07 | Creativity | Not started |
| 08 | Automation | Not started |
| 09 | Multimodal Understanding | Not started |
| 10 | Data Analysis | Not started |
| 11 | Artifact Creation | Not started |
| 12 | Integrations | Not started |

**Development rule:** Each Pillar should have a clearly defined scope, interfaces, permissions, tests, and completion criteria.

The Pillars begin once the initial Homes and shared infrastructure provide a stable, usable foundation. Not every future device or Home feature must be finished first.

---

## 6. Conversation Infrastructure

**Canonical host:** NOVA

| Milestone                           | Status               |
| ----------------------------------- | -------------------- |
| Conversation Store v1.0             | Complete             |
| Conversation Access v1.0 — Security | Audit pending review |
| Conversation Access v1.1 — API      | Planned              |
| Conversation Chat integration       | Planned              |
| iPhone conversation integration     | Planned              |

### Conversation Store v1.0

* SQLite persistence
* Conversation and message identifiers
* Ordered message sequences
* Transactional writes
* Persistent storage outside the repository

Production database location:

`%LOCALAPPDATA%\Selene\data\conversations.sqlite3`

Storage exists, but it is not yet integrated with the Companion API or iPhone Home.

---

## 7. Security Principles

* Local-first operation
* Explicit authority for privileged actions
* Separate Home credentials from Core authority permissions
* No direct exposure of privileged Core interfaces
* Authentication before exposing private conversation history
* Protected transport for credentials and private data
* Device-specific access and revocation
* No secrets committed to the repository

Specific authentication and pairing mechanisms remain under review.

---

## 8. Development Workflow

**NOVA:** Primary development host, Core, and Companion services.

**ORION:** Xcode development and Apple builds.

**Physical iPhone:** Final validation for iOS milestones.

Typical workflow:

1. Define a small milestone.
2. Inspect the existing implementation.
3. Implement and test.
4. Review the changed files.
5. Validate on the relevant device.
6. Commit and push after approval.

Do not treat unverified builds or tests as successful.

---

## 9. Current Focus

**Conversation Access v1.0 — Security**

Review the Companion API's authentication, LAN exposure, transport, credential storage, and compatibility with the existing iPhone connection check.

The security audit is pending review.

No conversation HTTP endpoints or Apple changes should be implemented until the design is approved.

---

## 10. Decision Log

| Decision                                          | Status           |
| ------------------------------------------------- | ---------------- |
| NOVA hosts canonical conversation history         | Approved         |
| SQLite for persistent conversations               | Implemented      |
| Native Homes remain the primary interfaces        | Approved         |
| Web Companion website development paused          | Approved         |
| Companion API retained                            | Approved         |
| Constellation initially limited to Alex's devices | Approved         |
| Authentication and pairing design                 | Pending          |
| Twelve Pillar definitions                         | To be documented |

---

*Selene is one assistant—not a collection of disconnected assistants sharing a name.*
