# Selene Pebble

Windows desktop overlay prototype for Selene, the local assistant running on the Windows PC named NOVA.

This is intentionally only the visual and interaction layer:

- transparent always-on-top overlay window
- 26x26 cursor-following glass pebble rendered with the UseJarvis CSS visual implementation
- canonical Pebble states: `idle`, `working`, `success`, `asking`, `error`, and `proactive`
- click the pebble to toggle a stationary command panel near the bottom-right of the primary display
- cursor-follow freezes while the pointer is hovering the pebble, matching the UseJarvis disc-hover behavior
- `Enter` in the command input posts to Selene Core at `http://127.0.0.1:3030/command`
- first-run Selene Setup v1 opens in a dedicated window and stores local preferences outside the repository

It does not implement LM Studio logic, Selene actions, screen awareness, or any Jarvis backend logic.

## Run

```powershell
npm install
npm start
```

Force Setup during development:

```powershell
npm run setup
```

or:

```powershell
$env:NOVA_FORCE_SETUP = "1"
npm start
```

## Prototype Behavior

- Electron polls the Windows cursor position and eases the transparent pebble overlay toward it with a `0.20` interpolation factor.
- The command panel is a separate fixed-position window anchored above the taskbar; it does not move with the pebble.
- The command panel reports its rendered height to the main process and resizes upward between a sensible minimum and maximum height. Long responses scroll only inside the message area.
- The renderer uses the exact 26x26 `.pebble`, `.gd`, `.in`, and `.ring` CSS from `Jarvis-Pebble-Reference/ui/src/ambient/pebble.css`.
- The panel uses the same UseJarvis light-glass thread styling: `color-mix` translucent raise background, 18px backdrop blur, `.5px` rule border, asymmetric corners, inset highlight, and soft shadow.
- Press `Enter` in the input to send the text to Selene Core. Success shows the returned message, clears the input, flashes `success`, then returns to `idle`. Failure shows the error, uses `error`, then returns to `idle`.
- If Core returns `needsApproval`, the panel shows a compact approval card, sets the Pebble to `asking`, and waits for Allow once, Allow temporarily, or Deny.
- Legacy state names `thinking` and `done` are still accepted and map to `working` and `success`.
- Press `Esc` or the `x` button to close the input panel.

Development authority inspection is available from the command panel devtools console:

```js
await window.SelenePanelDebug.getAuthority()
```

## Selene Setup v1

- Setup uses a normal centered Electron window, not the command panel.
- Configuration is saved to the OS app-data folder at `Selene Pebble/config.json`.
- If an older `NOVA Pebble/config.json` exists, Selene reads it once and writes the migrated configuration to the Selene path.
- Setup currently uses `POST /command` for the test command.
- Setup reads Selene Core endpoints for `GET /status`, `GET /applications`, and `POST /applications/permissions`.
- Model/provider status and application launch permissions remain owned by Selene Core; Pebble only displays and submits them through IPC.

## Reference Boundary

The visual language and cursor-follow behavior are adapted from the Jarvis Pebble reference project. Selene-specific backend integration remains owned by Selene Core.

## Legacy Names

Some compatibility identifiers still use `nova`, including IPC channel names, DOM IDs, `NOVA_FORCE_SETUP`, and temporary runtime cache names. These are retained to avoid breaking working local integrations during the identity migration.
