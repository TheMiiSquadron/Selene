# Selene icon library

This directory is the shared source of truth for icons used by Selene Homes.
Place new SVG files in the category directories below using the listed
kebab-case filenames.

Navigation Set 1 uses Phosphor icons for Home, New Chat, Search, Projects,
Devices, Settings, and Sidebar. History is from Reicon. Both sources are
distributed under the MIT License; their notices are preserved in
`LICENSE.phosphor.txt` and `LICENSE.reicon.txt`.

## Navigation

Directory: `01-navigation/`

- `home.svg`
- `new-chat.svg`
- `search.svg`
- `projects.svg`
- `devices.svg`
- `settings.svg`
- `sidebar.svg`
- `history.svg`

## Conversation and composer

Directory: `02-conversation-composer/`

- `add.svg`
- `send.svg`
- `voice.svg`
- `attach.svg`
- `stop.svg`
- `copy.svg`
- `edit.svg`
- `retry.svg`
- `more.svg`
- `expand.svg`

## Constellation and devices

Directory: `03-constellation-devices/`

- `network.svg`
- `desktop.svg`
- `laptop.svg`
- `phone.svg`
- `watch.svg`
- `online.svg`
- `offline.svg`
- `pair.svg`
- `trusted.svg`
- `host.svg`

## AI and activity

Directory: `04-ai-activity/`

- `ai.svg`
- `model.svg`
- `activity.svg`
- `success.svg`
- `warning.svg`
- `privacy.svg`
- `approval.svg`
- `alerts.svg`
- `files.svg`
- `code.svg`

## Appearance and preferences

Directory: `05-appearance-preferences/`

- `theme.svg`
- `obsidian.svg`
- `ruby.svg`
- `sapphire.svg`
- `controls.svg`
- `profile.svg`
- `shortcuts.svg`
- `audio.svg`
- `display.svg`
- `about.svg`

## SVG contract

- Use a `24 24` view box.
- Use `currentColor` instead of fixed stroke or fill colors.
- Keep strokes and visual weight consistent across the complete set.
- Prefer simple SVG paths without embedded styles, scripts, raster images, or
  external references.
- Keep filenames lowercase and stable; Homes should reference these semantic
  names rather than vendor-specific names.
