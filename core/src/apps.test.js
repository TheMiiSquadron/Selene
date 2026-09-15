import test from "node:test";
import assert from "node:assert/strict";
import {
  loadAuthorityConfig,
  saveAuthorityConfig,
  setDefaultAuthority,
} from "./authority.js";
import {
  BUILTIN_APPS,
  applyApplicationPermissionPatch,
  isApplicationEnabled,
  listApplicationsForSetup,
  mergeAppRegistries,
  normalizeAppEntry,
  resolveApprovedApp,
  sanitizePermissionMap,
} from "./apps.js";
import { appLaunchFailure, buildLaunchCommand, openApp } from "./tools.js";

const apps = {
  calculator: {
    id: "calculator",
    name: "Calculator",
    aliases: ["calc"],
    source: "builtin",
    launch: {
      type: "exe",
      target: "C:\\Windows\\System32\\calc.exe",
    },
  },
  notepad: {
    id: "notepad",
    name: "Notepad",
    aliases: ["notepad"],
    source: "builtin",
    launch: {
      type: "exe",
      target: "C:\\Windows\\System32\\notepad.exe",
    },
  },
  steam: {
    id: "steam",
    name: "Steam",
    aliases: ["steam"],
    source: "start-menu",
    launch: {
      type: "shortcut",
      target: "C:\\Users\\alexm\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Steam.lnk",
    },
  },
};

test("sanitizePermissionMap keeps only boolean permission values", () => {
  assert.deepEqual(sanitizePermissionMap({
    Calculator: true,
    steam: false,
    discord: "yes",
  }), {
    calculator: true,
    steam: false,
  });
});

test("applications are enabled by default unless explicitly disabled", () => {
  assert.equal(isApplicationEnabled("calculator", {}), true);
  assert.equal(isApplicationEnabled("steam", { steam: false }), false);
});

test("permission patch resolves aliases without mutating app registry data", () => {
  const { permissions, unknown } = applyApplicationPermissionPatch(
    apps,
    {},
    { calc: false, missing: true },
  );

  assert.deepEqual(permissions, { calculator: false });
  assert.deepEqual(unknown, ["missing"]);
  assert.equal(apps.calculator.launch.target, "C:\\Windows\\System32\\calc.exe");
});

test("application listing does not expose executable targets", async () => {
  const listed = await listApplicationsForSetup({
    calculator: apps.calculator,
    steam: apps.steam,
  }, { steam: false });

  assert.deepEqual(listed, [
    {
      id: "calculator",
      canonicalName: "calculator",
      name: "Calculator",
      aliases: ["calculator", "calc"],
      enabled: true,
      allowed: true,
      type: "exe",
      source: "builtin",
      launchType: "exe",
      available: true,
    },
    {
      id: "steam",
      canonicalName: "steam",
      name: "Steam",
      aliases: ["steam"],
      enabled: false,
      allowed: false,
      type: "shortcut",
      source: "start-menu",
      launchType: "shortcut",
      available: false,
    },
  ]);
  assert.equal("target" in listed[0], false);
});

test("alias resolution works with normalized entries", () => {
  const resolved = applyApplicationPermissionPatch(apps, {}, { calc: false });
  assert.deepEqual(resolved.permissions, { calculator: false });
});

test("curated built-ins merge cleanly with discovered apps", () => {
  const merged = mergeAppRegistries(BUILTIN_APPS, {
    notepad: {
      id: "notepad",
      name: "Notepad Shortcut",
      aliases: ["notes"],
      source: "start-menu",
      launch: {
        type: "shortcut",
        target: "C:\\Start\\Notepad.lnk",
      },
    },
  });

  assert.equal(merged.notepad.name, "Notepad Shortcut");
  assert.equal(merged.notepad.launch.type, "shortcut");
  assert.deepEqual(merged.notepad.aliases, ["notepad", "notes"]);
});

test("curated built-ins can override legacy registry entries when merged last", () => {
  const merged = mergeAppRegistries({
    notepad: {
      type: "command",
      target: "notepad.exe",
      aliases: [],
    },
  }, BUILTIN_APPS);

  assert.equal(merged.notepad.source, "builtin");
  assert.equal(merged.notepad.launch.target, "C:\\Windows\\System32\\notepad.exe");
});

test("legacy app entries normalize to explicit launch schema", () => {
  assert.deepEqual(normalizeAppEntry("legacy app", {
    type: "path",
    target: "C:\\Apps\\Legacy.exe",
    aliases: ["legacy"],
  }), {
    id: "legacy app",
    name: "Legacy App",
    aliases: ["legacy app", "legacy"],
    source: "manual",
    launch: {
      type: "exe",
      target: "C:\\Apps\\Legacy.exe",
    },
  });
});

test("malformed app entries are skipped by merge", () => {
  const merged = mergeAppRegistries({
    broken: {
      id: "broken",
      aliases: ["broken"],
      launch: {
        type: "exe",
      },
    },
  });

  assert.deepEqual(merged, {});
});

test("launcher command is selected for each supported launch type", () => {
  assert.deepEqual(buildLaunchCommand({
    launch: { type: "exe", target: "C:\\App\\app.exe", args: ["--safe"] },
  }), {
    command: "C:\\App\\app.exe",
    args: ["--safe"],
    windowsHide: false,
  });

  assert.deepEqual(buildLaunchCommand({
    launch: { type: "shortcut", target: "C:\\App\\app.lnk" },
  }), {
    command: "cmd.exe",
    args: ["/d", "/c", "start", "", "C:\\App\\app.lnk"],
    windowsHide: true,
  });

  assert.deepEqual(buildLaunchCommand({
    launch: { type: "uri", target: "ms-settings:" },
  }), {
    command: "cmd.exe",
    args: ["/d", "/c", "start", "", "ms-settings:"],
    windowsHide: true,
  });
});

test("unknown launch types do not produce launch commands", () => {
  assert.equal(buildLaunchCommand({
    launch: { type: "shell", target: "anything" },
  }), null);
});

test("structured launch failures include app id and reason", () => {
  assert.deepEqual(appLaunchFailure("notepad", "Notepad", "Configured launch target could not be started."), {
    ok: false,
    action: "open_app",
    appId: "notepad",
    message: "Failed to open Notepad.",
    reason: "Configured launch target could not be started.",
  });
});

test("Notepad resolves to a concrete curated executable", () => {
  const resolved = mergeAppRegistries(BUILTIN_APPS).notepad;
  assert.equal(resolved.id, "notepad");
  assert.equal(resolved.name, "Notepad");
  assert.equal(resolved.launch.type, "exe");
  assert.match(resolved.launch.target, /\\Windows\\System32\\notepad\.exe$/i);
});

test("Firefox appears in the curated application registry", () => {
  const resolved = mergeAppRegistries(BUILTIN_APPS).firefox;

  assert.equal(resolved.id, "firefox");
  assert.equal(resolved.name, "Firefox");
  assert.equal(resolved.launch.type, "exe");
  assert.equal(resolved.launch.target, "C:\\Program Files\\Mozilla Firefox\\firefox.exe");
});

test("Firefox resolves by Firefox and Mozilla Firefox aliases only", () => {
  const registry = mergeAppRegistries(BUILTIN_APPS);

  assert.equal(resolveApprovedApp(registry, "Firefox").canonicalName, "firefox");
  assert.equal(resolveApprovedApp(registry, "Mozilla Firefox").canonicalName, "firefox");
  assert.equal(resolveApprovedApp(registry, "browser"), null);
});

test("disabled Firefox permission prevents launch", async () => {
  const originalAuthority = await loadAuthorityConfig();
  const launched = [];

  try {
    await setDefaultAuthority(4);

    const result = await openApp("Firefox", {
      apps: mergeAppRegistries(BUILTIN_APPS),
      permissions: { firefox: false },
      memoryService: {
        async readMemory() {
          return {};
        },
      },
      launcher(command, args) {
        launched.push({ command, args });
        return { ok: true };
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.disabled, true);
    assert.match(result.error, /firefox.*not enabled/i);
    assert.equal(launched.length, 0);
  } finally {
    await saveAuthorityConfig(originalAuthority);
  }
});
