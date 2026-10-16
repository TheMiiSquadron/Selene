# Temporary M4.6 pairing client

Preparation only: creating/testing this utility does not pair a client. It does
not manage or restart any service. Keep the existing HTTPS startup terminal open.

## Operator procedure (only after pairing is separately authorized)

Open a separate interactive PowerShell terminal and run:

```powershell
Set-Location -LiteralPath 'A:\OneDrive\Desktop\VS Code\Personal\Selene\core'
$env:NODE_EXTRA_CA_CERTS = 'C:\Users\alexm\AppData\Local\Selene\tls\m46\ca.pem'
node scripts/m46PairingClient.js --show-secret
```

This changes only that terminal's process environment. Do not set or paste a
bearer credential into the shell. The CLI accepts only the optional `--show-secret` flag and refuses pipes
or redirected input. Use a clean Node invocation without preloads, debug logging,
or disabled TLS verification. Node must load the public CA at process startup.

At the secret prompt, use Pebble's existing **Pair a Device** action, then
enter its temporary secret and press Enter. With `--show-secret`, characters are
visible so you can check them and correct mistakes with Backspace. The code remains
visible in the terminal; keep it out of screenshots and terminal recordings.
Omit the flag for hidden entry. Neither mode records input history. Ctrl+C cancels
before submission. Never paste the secret into chat, source files, or commands.
The returned bearer credential is never displayed in either mode.

The client sends exactly one request to the fixed endpoint:

```text
POST https://127.0.0.1:8787/api/pairing/claim
Content-Type: application/json
{"deviceName":"NOVA M4.6 Validation","secret":<interactive input>}
```

The server accepts exactly `deviceName` and `secret`. Success is HTTP 200,
`Content-Type: application/json`, `Cache-Control: no-store`, and JSON containing
exactly `paired: true` and `credential`. The client checks the existing credential
format. The server's standard Home issuer supplies `chat`, `conversation:read`,
and `conversation:write`; the claim response does not enumerate capabilities.
The temporary secret expires after five minutes, is single-use, and allows five
failed attempts under the existing server policy.

## Credential handoff and later validation

After pairing, the CLI keeps the credential in a closure and waits. **No M4.6
test runs automatically.** Keep this client terminal open as well as the service
startup terminal.

Only after validation is separately authorized, choose `before`, `resume-before`,
or `after` and enter an absolute external journal path. The CLI invokes the
existing `runValidation` function directly, passing the credential through an
ordinary in-memory options object. It does not set `process.env`, spawn a validator
child, export a shell variable, print the credential, or save it. `resume-before`
selects the validator's documented recovery mode. Follow `m46ProductionE2E.md`
for state-path rules, recovery, and a separately authorized Core restart.

`quit` ends the in-memory session; it does not revoke the credential on the
server. Closing the terminal or restarting this client loses access to the
credential. This temporary utility cannot transfer it to an unrelated existing
terminal. Review the issued credential's status before authorizing another claim.

## Semantic recall action (separate authorization required)

The updated menu adds `recall` alongside `before`, `resume-before`, `after`, and
`quit`. The currently running older client cannot load this update. Keep it open;
launching the new client and pairing it again each require separate approval.
Development and mock tests do not authorize any live recall request.

Once explicitly authorized in an updated paired client, `recall` creates a fresh
conversation, confirms that it is empty, then sends these as two separate
authenticated message requests using that same conversation ID:

1. "My favorite fictional planet is Krypton. Please remember that for this conversation."
2. "What fictional planet did I tell you was my favorite?"

Each message request contains only `message`. The second request contains no
answer, hints, history, or system instructions. The existing Core conversation
service loads saved history into the model context; no production behavior is
changed. The client verifies the first turn is persisted before asking the second
question, then retrieves and compares the exact IDs, roles, content, and order
of all four messages with the two turn responses.

The terminal shows the actual follow-up model response with terminal control
characters escaped, plus a case-insensitive whole-word check for Krypton and a
separate persistence result. Mentioning Krypton alone is not a full semantic
assessment: inspect the actual wording for negation, ambiguity, or an incorrect
claim. No live result exists until the operator authorizes and performs the test.

Recall does not use or change the M4.6 restart journal, and does not send requests
to any existing conversation. It holds test state in memory and permits only one
attempt per updated client session, including after failure. Network failures
are not automatically retried. A fresh conversation ID is reported on failure
when available, for later authorized investigation. There is no durable recovery
file or automatic cleanup for recall; do not authorize another attempt blindly.

TLS uses Node's built-in HTTPS client, explicit local CA trust and
`rejectUnauthorized: true`, with normal hostname/IP verification. There is no
redirect following, transport downgrade, or automatic retry. Responses have a
size limit and a 15-second absolute deadline. Error output is fixed text, never
server-provided messages or raw exceptions. A dropped response can mean a
credential was issued but not received: do not blindly claim again. This client
cannot reconcile that outcome through the existing API.

Secrets necessarily exist briefly in JavaScript/HTTPS memory. Clearing references
is not guaranteed memory zeroization. This is intended for a trusted local
terminal/process, not protection against administrators, memory inspection,
terminal capture software, or a compromised Node runtime. No credential persistence
or Windows certificate-store changes are introduced.

## Mock tests

```text
node --test scripts/m46PairingClient.test.js scripts/m46SemanticRecall.test.js
```

Tests inject HTTPS, terminal input, trust inspection, and validator functions.
They make no network requests, read no production secrets, issue no credentials,
write no databases, and do not execute production validation. The CLI is not
invoked against NOVA during preparation.
