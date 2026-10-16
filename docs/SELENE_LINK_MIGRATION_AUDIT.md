# Selene Link Migration Audit

**Branch:** `cleanup/selene-gateway`  
**Status:** Final static review and Core check passed; production and Apple device validation pending
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

## Final dependency and compatibility review — October 15, 2026

- Reviewed the cleanup branch against local `main`. Relative JavaScript import/require targets under Core, Pebble, and Homes resolve; no references to the deleted Core Companion modules or old Swift API types remain.
- The renamed Core service implementations retain their request routing, payloads, status codes, authentication, capabilities, and limits. Differences beyond identifier renaming are service wording and diagnostics. The chat system prompt retains its non-privileged boundary with updated service terminology.
- Credential storage/runtime, schemas, token formats, pairing implementation, conversation storage, M4.6 script, and iOS connection configuration are unchanged from `main`. Existing `SELENE_COMPANION_*` variables and Core startup option names remain intact.
- The Swift client retains its transport and request/response behavior. Xcode uses synchronized source groups; no explicit reference to the deleted Swift filename remains. Apple builds and tests require ORION and were not run on NOVA.
- Corrected iPhone/Apple Watch roles in `Selene.md`, stale iPhone settings labels, and the README's outdated unauthenticated-access description. These corrections do not change API behavior.
- The first Core check encountered an inherited PowerShell module-path conflict: Windows PowerShell could not import its security module. The rerun uses the Machine module path in a temporary Windows PowerShell child process; no persistent environment settings or security policies were changed.
- `npm run check` from `core/` passed on October 15, 2026: JavaScript syntax checks, Python compilation, and all 392 automated tests passed, with zero failures or skips. The user authorized a normal local merge into `main` after successful checks.

## Remaining production/device validation

- Validate production HTTPS, certificate trust, pairing, credentials, and persistence against NOVA's running services separately. M4.6 was not executed during this review.
- On ORION, build the Apple targets, run the Swift tests, and validate the physical iPhone connection. Existing development transport and authentication limitations are not resolved by this naming cleanup.

Static compatibility review and automated tests do not establish production or device readiness.
