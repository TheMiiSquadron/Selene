# Selene Core v0.3.2

## New in v0.3.2

- App aliases
- Cleaner detached app launches
- Suppresses child app stdout/stderr from Selene Core's terminal
- Discovery now writes aliases into `config/apps.json`

Examples:

- `vscode`, `vs code`, `code` -> Visual Studio Code
- `opera` -> Opera GX
- `chrome` -> Google Chrome
- `bambu` -> Bambu Studio
- `fl` -> FL Studio

## Update

Replace the project files, then run:

    npm run check
    npm run discover-apps
    npm start

## Local command server

Run:

    npm run server

Then send commands to:

    POST http://127.0.0.1:3030/command

Body:

    { "text": "Open Discord" }

Response:

    { "ok": true, "message": "Opened discord." }

Setup/status endpoints:

    GET http://127.0.0.1:3030/status
    GET http://127.0.0.1:3030/applications
    POST http://127.0.0.1:3030/applications/permissions
    GET http://127.0.0.1:3030/authority
    POST http://127.0.0.1:3030/authority/default
    POST http://127.0.0.1:3030/authority/elevate
    POST http://127.0.0.1:3030/authority/reset

The command server on port `3030` is privileged and remains loopback-only.

## Companion transport and LAN access

The non-privileged Companion API listens over HTTP on `127.0.0.1:8787` by
default. Optional HTTPS uses Node's built-in TLS server and the same routes on
port `8787`. Set all three variables before starting Core:

    $env:SELENE_COMPANION_HTTPS = "1"
    $env:SELENE_COMPANION_TLS_CERT_PATH = "C:\SeleneSecrets\cert.pem"
    $env:SELENE_COMPANION_TLS_KEY_PATH = "C:\SeleneSecrets\key.pem"
    npm start

The certificate may be a PEM chain; the key must be the matching PEM private
key. Both paths must be absolute and outside the repository, including through
symlinks. Protect the key with appropriate Windows filesystem permissions and
never commit either file. This step does not create, provision, install, or
renew production certificates. Invalid configuration or TLS material prevents
startup rather than falling back to HTTP. `SELENE_COMPANION_HTTPS` accepts only
`1` (HTTPS), `0` or unset/empty (HTTP). TLS paths are forbidden in HTTP mode.

To make only the Companion API reachable from trusted local devices, also set
the explicit LAN flag:

    $env:SELENE_COMPANION_LAN = "1"
    npm start

LAN mode binds Companion to `0.0.0.0:8787` with the selected protocol. Clients
must connect to NOVA's actual hostname or address, not `0.0.0.0`. HTTPS clients
must trust the issuing CA and use a hostname or IP address present in the
certificate's subject alternative names. The privileged Core server remains
loopback-only at `127.0.0.1:3030`.

Companion access is still unauthenticated. Legacy plaintext HTTP LAN mode
remains temporarily available for compatibility, but Gateway bearer credentials
must **never** be transmitted over plaintext HTTP. Do not configure clients to
disable certificate validation. Scope any external Windows Firewall rule to
TCP port `8787` on the Private profile and trusted local devices. Do not expose
ports `3030` or `1234`, and do not configure router port forwarding.

Application launch permissions are stored separately from discovered app paths in:

    config/applicationPermissions.json

Application discovery/path/alias data lives in:

    config/apps.json

App entries use an explicit launch schema:

    {
      "id": "notepad",
      "name": "Notepad",
      "aliases": ["notepad"],
      "source": "builtin",
      "launch": {
        "type": "exe",
        "target": "C:\\Windows\\System32\\notepad.exe"
      }
    }

Supported launch types are `exe`, `shortcut`, and `uri`. Selene launches only registry-defined targets and never falls back to arbitrary shell commands from model output.

Inspect the resolved development registry with:

    npm run inspect-apps

Or, while the local server is running:

    GET http://127.0.0.1:3030/debug/applications

Authority state is stored separately in:

    config/authority.json

Authority defaults to Level 4 - Assist. One-action elevation returns an `authorityToken`; pass it to `/command` as:

    { "text": "Open Calculator", "authorityToken": "<token>" }

## Interact v1

Selene Core includes the first Level 5 - Interact tools:

- `type_text`: types literal user-approved text into the foreground application.
- `keyboard_shortcut`: sends only an allowlisted shortcut.

The Windows input backend is isolated behind `src/inputAdapter.js` and currently uses a small Python/Win32 helper in `src/windowsInputHost.py` to activate visible windows and send native `SendInput` keystrokes. It does not use PowerShell, Command Prompt input, or arbitrary shell execution.

Allowlisted shortcuts are defined centrally in `src/shortcuts.js`:

    ctrl+a, ctrl+c, ctrl+v, ctrl+x, ctrl+z, ctrl+y, ctrl+s, ctrl+f,
    ctrl+n, ctrl+o, tab, shift+tab, enter, escape, up, down, left, right

The deterministic fast router supports:

    Type Hello from Selene
    Press ctrl+a
    Open Notepad and type Hello from Selene
    Open Notepad, type Hello from Selene, then select all
    Open Notepad, type Keyboard test, select all, then copy

Natural shortcut mappings include `Select all`, `Copy`, `Paste`, `Cut`, `Undo`, `Redo`, `Save`, and `Find`.

For multi-step commands, each action is authorized independently. At default Level 4, `Open Notepad, type Hello from Selene, then select all` opens Notepad, then stops before typing and returns `needsApproval: true` for `type_text` at Level 5. Core keeps a short-lived in-memory continuation so retrying the same command with a one-action Level 5 `authorityToken` resumes at the blocked step instead of repeating completed steps. One-action approval permits exactly one blocked Level 5 action; the next Level 5 step, such as `keyboard_shortcut`, requires a separate approval unless temporary Level 5 elevation is active.

Interaction logs store action metadata such as character count and target name; they do not store the literal typed text.

Core distinguishes dispatch success from visual verification. `type_text` and `keyboard_shortcut` can report that input was dispatched to a confirmed foreground target, but Selene does not claim the visible UI result was verified because screen vision is not implemented.

Run the bounded development stress pass with:

    npm run stress-interact

Optional:

    npm run stress-interact -- --runs 5
    npm run stress-interact -- --runs 5 --keep-windows

The stress script uses fixed Notepad/Calculator cleanup, temporary Level 5 elevation, repeated Notepad typing/select-all cycles, Undo/Redo shortcut checks, and no clipboard reads.

## Suggested tests

    Open VS Code
    Could you launch vscode for me?
    Open Chrome
    Open Opera
    Open Bambu
    Open FL
    Open Audacity

LM Studio, PowerShell, and AMD Adrenalin remain excluded from discovery.

## Identity Notes

Selene is the assistant/software identity. NOVA is the Windows PC Selene currently runs on.

Legacy compatibility names such as `runNovaCommand` and `logs/nova.log` are intentionally retained for now so existing local commands and integrations keep working.
