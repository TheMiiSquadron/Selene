# Selene Link Migration Audit

**Branch:** `cleanup/selene-gateway`  
**Status:** Static inspection in progress; **not approved for merge**  
**Scope:** Retirement of the Web Companion frontend and renaming the retained API backend to Selene Link.

## Verified from GitHub repository inspection

- The comparison with `main` shows the Web Companion frontend files removed, with the Core backend and native Apple application retained.
- The Core Link modules are present: `linkServer.js`, `linkChat.js`, `linkConversations.js`, and their corresponding tests.
- `core/package.json` references the renamed Link test modules and runtime modules.
- `core/src/index.js` and `core/src/server.js` import `startLinkServer` from `linkServer.js`.
- `linkServer.js` exports `LINK_HOST`, `LINK_LAN_HOST`, `LINK_PORT`, `resolveLinkHost`, and `startLinkServer`; the corresponding test file imports those names.
- The iOS app entry point now constructs `SeleneLinkAPIClient`; `ChatViewModel.swift` and its tests use the renamed Link API protocol/types.
- The renamed Swift client and test files are present. The Xcode project does not contain an explicit `CompanionAPI.swift` filename reference in its inspected project file (Xcode build verification is still required).
- The privileged Core command server and the non-privileged Link API remain distinct services.
- `ARCHITECTURE.md` defines the canonical names and four native Homes. `Selene.md` references it.

## Findings corrected on this branch

1. **iOS build-blocking reference:** `SeleneApp.swift` still instantiated the deleted `CompanionAPIClient` symbol. Updated to `SeleneLinkAPIClient`.
2. **Core renamed LAN constant:** `COMPANION_LAN_HOST` references remained after the Link module rename. Updated to `LINK_LAN_HOST` in the server and tests.
3. **Core startup compatibility:** Existing `startSeleneServers` callers and tests still pass `companionPort`, `onCompanionListening`, and `onCompanionError`. These option names are deliberately retained for now.
4. **Stale error expectation:** Core startup test expects the new `Selene Link failed to start` message.
5. **User-facing naming:** Link startup messages and iOS error descriptions now use Selene Link.

## Compatibility and security safeguards

Do **not** rename or migrate the following as part of a cosmetic naming cleanup:

- `SELENE_COMPANION_*` environment variables used for LAN and TLS configuration.
- `gateway-credentials.sqlite3`, SQLite schema tables, and existing credential token prefix `selene_gateway_v1`.
- HTTP routes, request/response payloads, or authentication headers.
- Existing Core startup option names without a deliberate compatibility layer.

The current development iOS configuration includes a fixed local network address. Verify the correct NOVA address, protocol, certificate trust, and authorization before testing from an iPhone. Do not assume LAN mode is secure or production-ready merely because it starts.

## Remaining work (not verified)

- **Repository-wide static dependency scan:** Review all remaining JS/Swift references, imports, exports, scripts, and documentation. The inspections above are targeted, not an exhaustive import graph.
- **Security review:** Exercise authentication, pairing, revocation, permissions, TLS, CORS, LAN exposure, and error sanitization. Inspection alone does not prove these protections work.
- **NOVA:** In `core/`, run `npm run check` (which also invokes `npm test`), then verify Core loopback port `3030` and Link port `8787` and test the configured transport.
- **ORION:** Open the Xcode project, build the iOS target, and run the Swift test suite; then test the connection from the physical iPhone.
- **Final diff review:** Inspect the cleanup branch against `main`, resolve all failures, and merge only after approval.

**Important:** No Node, Swift, Xcode, or device tests have been executed as part of this audit. Do not interpret inspected test files as passing tests.
