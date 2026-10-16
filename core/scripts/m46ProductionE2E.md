# M4.6 production conversation validation

This is an explicit, stateful production test. It creates one conversation and
two turns. Importing the script does not run it. Automated tests use disposable
filesystem fixtures and mocked HTTP/process inspection; they need no production
service, credential, or certificate.

## Prerequisites

- Run locally on NOVA/Windows with Node meeting `core/package.json` requirements.
- Core and Link must already be running as the same accessible Node process,
  listening on standard ports 3030 and 8787. This validator does not manage them.
- Set `SELENE_M46_URL` in the intended test shell to the direct HTTPS origin on
  port 8787. Its hostname must resolve only to this machine. Do not use a proxy.
- Supply `SELENE_M46_BEARER` securely in that shell with `chat`,
  `conversation:read`, and `conversation:write`. The validator never prints or
  records the credential. It does not issue or change credentials.
- The certificate must be valid for that hostname and trusted by Node. Existing
  `NODE_EXTRA_CA_CERTS` and supported Node CA-selection flags are respected.
  Certificate-verification bypasses, Node preloads, and unsupported launch flags
  are rejected. Redirects are errors. No custom insecure dispatcher is installed.
- Choose a new state filename in an existing writable, trusted directory outside
  the repository. Protect the directory using existing filesystem permissions.
  Paths through symlinks, junctions, substituted paths, and hard-linked state
  files are rejected. The validator does not change Windows ACLs.

Existing `SELENE_COMPANION_*` server configuration remains unchanged. These
instructions do not provision production transport or change environment settings.

## Phases

From `core/`, using your chosen absolute state path:

```text
node scripts/m46ProductionE2E.js before <state-file-outside-repo>
```

After BEFORE passes, have the operator stop and restart Core through the normal
approved lifecycle, preserving its configuration, user account, and databases.
Then run:

```text
node scripts/m46ProductionE2E.js after <same-state-file>
```

The state format is now an append-only, versioned JSON-lines journal. Old M4.6
state files are not accepted. Existing files are not overwritten. Each checkpoint
is flushed before a dependent write; conversation identity is recorded immediately
after creation returns. Exact message IDs, roles, content, and sequences are
recorded and compared, along with conversation identity.

Restart proof uses read-only Windows socket ownership and process start ticks.
Both listeners must have one Node owner. AFTER requires a later startup and proof
that the original process instance is gone, with stable ownership throughout the
phase. A changed PID, `/health`, or a software version alone is not sufficient.
Remote/macOS/proxied validation is unsupported until the architecture supplies an
appropriate authenticated startup identity. No identity endpoint was added.

## Recovery

- To resume an interrupted BEFORE, use `before <same-state-file> --resume` while
  the original Core process is still running. AFTER always reads the existing
  journal and may be repeated safely while the verified replacement process runs.
- A run reserves `<state-file>.lock`. If interruption leaves a lock, first verify
  that its validator process has exited. Only then may the operator remove that
  stale lock. Never remove a live run's lock or discard the recovery journal.
- If a message response was lost but the expected turn is now committed, retry
  recovery adopts the saved turn without sending another message. Repeating a
  completed AFTER verifies the saved final snapshot without adding a turn.
- If a request outcome is unknown and the expected turn is absent, recovery stops
  without resubmitting. Wait for outstanding model work to settle and retry the
  read/reconciliation. Definitive failure may require manual inspection and a new
  run; the API has no idempotency key or operation-status endpoint.
- A lost creation response cannot be mapped reliably to a conversation ID.
  Preserve the journal and locate the test conversation manually. This run never
  retries creation automatically. Test conversations are not automatically deleted.
- Truncated or malformed journals require manual inspection. The validator will
  not truncate, repair, or overwrite them. Another Core restart during recovery
  can invalidate the run's evidence and require a new state path.

Requests allow 660 seconds, exceeding Core's default 600-second model timeout.
A client timeout does not cancel server work. Changed server timeouts or very slow
models can still leave an uncertain outcome.

## Scope and limitations

The journal is local operator evidence, not a signed audit log. It must be stored
in a trusted directory; protect its message content as conversation data. Unix
creation mode is 0600; on Windows existing ACLs govern access. Path/identity checks
reduce accidental substitution risk but cannot eliminate hostile concurrent
filesystem races or local privileged tampering. There is no portable Windows
directory-handle-relative atomic path API in this implementation.

This verifies the listener-owner process restart and exact API-visible history,
not a machine reboot, power-loss durability, or semantic model recall. Pairing,
revocation, cross-owner isolation, authorization matrices, real certificate trust,
and the actual Windows observer must still be validated in the appropriate
approved production/device checks. Mocks are not production evidence.

Run isolated checks with `npm run test:m46`; `npm test` and `npm run check` also
include them. No automated test invokes the production validation phases on NOVA.
