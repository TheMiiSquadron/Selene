import test from "node:test";
import assert from "node:assert/strict";
import {
  elevateAuthority,
  loadAuthorityConfig,
  saveAuthorityConfig,
  setDefaultAuthority,
} from "./authority.js";
import {
  loadApplicationPermissions,
  saveApplicationPermissions,
} from "./apps.js";
import { tryFastRoute } from "./router.js";

function awarenessState(state) {
  let reads = 0;
  return {
    service: {
      getState() {
        reads += 1;
        return state;
      },
    },
    get reads() {
      return reads;
    },
  };
}

function createInputAdapter() {
  return {
    typed: [],
    shortcuts: [],
    failType: false,
    failShortcut: false,
    async typeText(text, options = {}) {
      if (this.failType) {
        return { ok: false, focusMismatch: true, reason: "wrong window" };
      }
      this.typed.push({ text, options });
      return { ok: true };
    },
    async keyboardShortcut(shortcut, options = {}) {
      if (this.failShortcut) {
        return { ok: false, focusMismatch: true, reason: "wrong window" };
      }
      this.shortcuts.push({ shortcut, options });
      return { ok: true };
    },
  };
}

test("app opening at Level 4 succeeds before typing is blocked", async () => {
  const originalAuthority = await loadAuthorityConfig();
  const originalPermissions = await loadApplicationPermissions();
  const launched = [];

  try {
    await setDefaultAuthority(4);
    await saveApplicationPermissions({
      ...originalPermissions,
      notepad: true,
    });

    const result = await tryFastRoute("Open Notepad and type First blocked test", {
      launcher(command, args) {
        launched.push({ command, args });
        return { ok: true };
      },
      inputAdapter: createInputAdapter(),
    });

    assert.equal(result.handled, true);
    assert.equal(result.result.ok, false);
    assert.equal(result.result.needsApproval, true);
    assert.equal(result.result.action, "type_text");
    assert.equal(result.result.requiredLevel, 5);
    assert.equal(result.result.currentLevel, 4);
    assert.equal(result.result.continuationPending, true);
    assert.equal(launched.length, 1);
  } finally {
    await saveAuthorityConfig(originalAuthority);
    await saveApplicationPermissions(originalPermissions);
  }
});

test("multi-step execution stops at blocked action and one-action approval resumes typing", async () => {
  const originalAuthority = await loadAuthorityConfig();
  const originalPermissions = await loadApplicationPermissions();
  const adapter = createInputAdapter();
  const launched = [];
  const command = "Open Notepad and type Hello from Selene";

  try {
    await setDefaultAuthority(4);
    await saveApplicationPermissions({
      ...originalPermissions,
      notepad: true,
    });

    const blocked = await tryFastRoute(command, {
      launcher(commandName, args) {
        launched.push({ command: commandName, args });
        return { ok: true };
      },
      inputAdapter: adapter,
    });

    assert.equal(blocked.result.ok, false);
    assert.equal(blocked.result.action, "type_text");
    assert.equal(adapter.typed.length, 0);
    assert.equal(launched.length, 1);

    const elevated = await elevateAuthority({ level: 5, oneAction: true });
    const token = elevated.oneActionElevation.token;

    const resumed = await tryFastRoute(command, {
      authorityToken: token,
      launcher(commandName, args) {
        launched.push({ command: commandName, args });
        return { ok: true };
      },
      inputAdapter: adapter,
    });

    assert.equal(resumed.handled, true);
    assert.equal(resumed.result.ok, true);
    assert.deepEqual(resumed.result.completedActions, ["open_app", "type_text"]);
    assert.equal(adapter.typed.length, 1);
    assert.equal(adapter.typed[0].text, "Hello from Selene");
    assert.equal(adapter.typed[0].options.expectedWindowTitle, "Notepad");
    assert.equal(launched.length, 1);

    const blockedAgain = await tryFastRoute(command, {
      authorityToken: token,
      launcher(commandName, args) {
        launched.push({ command: commandName, args });
        return { ok: true };
      },
      inputAdapter: adapter,
    });

    assert.equal(blockedAgain.result.ok, false);
    assert.equal(blockedAgain.result.action, "plan");
    assert.equal(blockedAgain.result.continuationMissing, true);
  } finally {
    await saveAuthorityConfig(originalAuthority);
    await saveApplicationPermissions(originalPermissions);
  }
});

test("multi-step continuation supports two separate Level 5 approvals", async () => {
  const originalAuthority = await loadAuthorityConfig();
  const originalPermissions = await loadApplicationPermissions();
  const adapter = createInputAdapter();
  const launched = [];
  const command = "Open Notepad, type Hello, then select all";

  try {
    await setDefaultAuthority(4);
    await saveApplicationPermissions({
      ...originalPermissions,
      notepad: true,
    });

    const first = await tryFastRoute(command, {
      launcher(commandName, args) {
        launched.push({ command: commandName, args });
        return { ok: true, processId: 1234 };
      },
      inputAdapter: adapter,
    });

    assert.equal(first.result.ok, false);
    assert.equal(first.result.action, "type_text");
    assert.equal(first.result.requiredLevel, 5);
    assert.equal(adapter.typed.length, 0);
    assert.equal(adapter.shortcuts.length, 0);
    assert.equal(launched.length, 1);

    const typeApproval = await elevateAuthority({ level: 5, oneAction: true });
    const afterType = await tryFastRoute(command, {
      authorityToken: typeApproval.oneActionElevation.token,
      launcher(commandName, args) {
        launched.push({ command: commandName, args });
        return { ok: true, processId: 1234 };
      },
      inputAdapter: adapter,
    });

    assert.equal(afterType.result.ok, false);
    assert.equal(afterType.result.action, "keyboard_shortcut");
    assert.equal(afterType.result.requiredLevel, 5);
    assert.equal(adapter.typed.length, 1);
    assert.equal(adapter.typed[0].text, "Hello");
    assert.equal(adapter.shortcuts.length, 0);
    assert.equal(launched.length, 1);

    const shortcutApproval = await elevateAuthority({ level: 5, oneAction: true });
    const afterShortcut = await tryFastRoute(command, {
      authorityToken: shortcutApproval.oneActionElevation.token,
      launcher(commandName, args) {
        launched.push({ command: commandName, args });
        return { ok: true, processId: 1234 };
      },
      inputAdapter: adapter,
    });

    assert.equal(afterShortcut.result.ok, true);
    assert.deepEqual(afterShortcut.result.completedActions, [
      "open_app",
      "type_text",
      "keyboard_shortcut",
    ]);
    assert.equal(adapter.typed.length, 1);
    assert.deepEqual(adapter.shortcuts, [{
      shortcut: "ctrl+a",
      options: {
        expectedWindowTitle: "Notepad",
        expectedProcessId: 1234,
      },
    }]);
    assert.equal(launched.length, 1);
  } finally {
    await saveAuthorityConfig(originalAuthority);
    await saveApplicationPermissions(originalPermissions);
  }
});

test("temporary Level 5 elevation permits multiple Level 5 plan steps", async () => {
  const originalAuthority = await loadAuthorityConfig();
  const originalPermissions = await loadApplicationPermissions();
  const adapter = createInputAdapter();
  const launched = [];
  const command = "Open Notepad, type Keyboard test, select all, then copy";

  try {
    await setDefaultAuthority(4);
    await elevateAuthority({ level: 5, minutes: 5 });
    await saveApplicationPermissions({
      ...originalPermissions,
      notepad: true,
    });

    const result = await tryFastRoute(command, {
      launcher(commandName, args) {
        launched.push({ command: commandName, args });
        return { ok: true, processId: 5678 };
      },
      inputAdapter: adapter,
    });

    assert.equal(result.handled, true);
    assert.equal(result.result.ok, true);
    assert.deepEqual(result.result.completedActions, [
      "open_app",
      "type_text",
      "keyboard_shortcut",
      "keyboard_shortcut",
    ]);
    assert.equal(adapter.typed[0].text, "Keyboard test");
    assert.deepEqual(adapter.shortcuts.map((item) => item.shortcut), ["ctrl+a", "ctrl+c"]);
    assert.equal(launched.length, 1);
  } finally {
    await saveAuthorityConfig(originalAuthority);
    await saveApplicationPermissions(originalPermissions);
  }
});

test("Level 5 plan executes actions in exact order", async () => {
  const originalAuthority = await loadAuthorityConfig();
  const originalPermissions = await loadApplicationPermissions();
  const order = [];
  const adapter = {
    async typeText(text, options = {}) {
      order.push({ action: "type_text", text, options });
      return { ok: true };
    },
    async keyboardShortcut(shortcut, options = {}) {
      order.push({ action: "keyboard_shortcut", shortcut, options });
      return { ok: true };
    },
  };

  try {
    await setDefaultAuthority(5);
    await saveApplicationPermissions({
      ...originalPermissions,
      notepad: true,
    });

    const result = await tryFastRoute("Open Notepad, type Hello, then select all", {
      launcher() {
        order.push({ action: "open_app" });
        return { ok: true, processId: 1111 };
      },
      inputAdapter: adapter,
    });

    assert.equal(result.result.ok, true);
    assert.deepEqual(order.map((item) => item.action), [
      "open_app",
      "type_text",
      "keyboard_shortcut",
    ]);
  } finally {
    await saveAuthorityConfig(originalAuthority);
    await saveApplicationPermissions(originalPermissions);
  }
});

test("expired temporary Level 5 elevation falls back to approval", async () => {
  const originalAuthority = await loadAuthorityConfig();
  const originalPermissions = await loadApplicationPermissions();
  const adapter = createInputAdapter();

  try {
    await saveAuthorityConfig({
      defaultLevel: 4,
      currentLevel: 4,
      temporaryElevation: {
        level: 5,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
      oneActionElevation: null,
      alwaysConfirmActions: [],
      updatedAt: null,
    });
    await saveApplicationPermissions({
      ...originalPermissions,
      notepad: true,
    });

    const result = await tryFastRoute("Open Notepad, type Hello, then select all", {
      launcher() {
        return { ok: true, processId: 2222 };
      },
      inputAdapter: adapter,
    });

    assert.equal(result.result.ok, false);
    assert.equal(result.result.action, "type_text");
    assert.equal(result.result.requiredLevel, 5);
    assert.equal(adapter.typed.length, 0);
  } finally {
    await saveAuthorityConfig(originalAuthority);
    await saveApplicationPermissions(originalPermissions);
  }
});

test("expired continuation fails safely and does not replay completed steps", async () => {
  const originalAuthority = await loadAuthorityConfig();
  const originalPermissions = await loadApplicationPermissions();
  const adapter = createInputAdapter();
  const launched = [];
  const command = "Open Notepad, type Expiring, then select all";

  try {
    await setDefaultAuthority(4);
    await saveApplicationPermissions({
      ...originalPermissions,
      notepad: true,
    });

    const first = await tryFastRoute(command, {
      launcher() {
        launched.push("open_app");
        return { ok: true, processId: 3333 };
      },
      inputAdapter: adapter,
    });

    assert.equal(first.result.action, "type_text");

    const approval = await elevateAuthority({ level: 5, oneAction: true });
    const retry = await tryFastRoute(command, {
      authorityToken: approval.oneActionElevation.token,
      nowMs: Date.now() + 6 * 60_000,
      launcher() {
        launched.push("open_app");
        return { ok: true, processId: 3333 };
      },
      inputAdapter: adapter,
    });

    assert.equal(retry.result.ok, false);
    assert.equal(retry.result.continuationExpired, true);
    assert.equal(adapter.typed.length, 0);
    assert.equal(launched.length, 1);
  } finally {
    await saveAuthorityConfig(originalAuthority);
    await saveApplicationPermissions(originalPermissions);
  }
});

test("missing continuation after restart fails safely", async () => {
  const originalAuthority = await loadAuthorityConfig();

  try {
    await setDefaultAuthority(4);
    const approval = await elevateAuthority({ level: 5, oneAction: true });

    const retry = await tryFastRoute("Open Notepad, type Missing continuation, then select all", {
      authorityToken: approval.oneActionElevation.token,
      launcher() {
        throw new Error("should not launch");
      },
      inputAdapter: createInputAdapter(),
    });

    assert.equal(retry.result.ok, false);
    assert.equal(retry.result.continuationMissing, true);
  } finally {
    await saveAuthorityConfig(originalAuthority);
  }
});

test("a different command cannot consume another command's continuation", async () => {
  const originalAuthority = await loadAuthorityConfig();
  const originalPermissions = await loadApplicationPermissions();
  const adapter = createInputAdapter();

  try {
    await setDefaultAuthority(4);
    await saveApplicationPermissions({
      ...originalPermissions,
      notepad: true,
    });

    await tryFastRoute("Open Notepad, type First command, then select all", {
      launcher() {
        return { ok: true, processId: 4444 };
      },
      inputAdapter: adapter,
    });

    const approval = await elevateAuthority({ level: 5, oneAction: true });
    const different = await tryFastRoute("Open Notepad, type Different command, then select all", {
      authorityToken: approval.oneActionElevation.token,
      launcher() {
        throw new Error("should not launch");
      },
      inputAdapter: adapter,
    });

    assert.equal(different.result.ok, false);
    assert.equal(different.result.continuationMissing, true);
    assert.equal(adapter.typed.length, 0);
  } finally {
    await saveAuthorityConfig(originalAuthority);
    await saveApplicationPermissions(originalPermissions);
  }
});

test("failed non-approval step clears continuation and does not advance", async () => {
  const originalAuthority = await loadAuthorityConfig();
  const originalPermissions = await loadApplicationPermissions();
  const adapter = createInputAdapter();
  const command = "Open Notepad, type Closes before typing, then select all";

  try {
    await setDefaultAuthority(5);
    await saveApplicationPermissions({
      ...originalPermissions,
      notepad: true,
    });
    adapter.failType = true;

    const failed = await tryFastRoute(command, {
      launcher() {
        return { ok: true, processId: 5555 };
      },
      inputAdapter: adapter,
    });

    assert.equal(failed.result.ok, false);
    assert.equal(failed.result.action, "type_text");
    assert.equal(adapter.shortcuts.length, 0);

    const approval = await elevateAuthority({ level: 5, oneAction: true });
    adapter.failType = false;
    const retry = await tryFastRoute(command, {
      authorityToken: approval.oneActionElevation.token,
      launcher() {
        throw new Error("should not relaunch after failed continuation");
      },
      inputAdapter: adapter,
    });

    assert.equal(retry.result.ok, false);
    assert.equal(retry.result.continuationMissing, true);
  } finally {
    await saveAuthorityConfig(originalAuthority);
    await saveApplicationPermissions(originalPermissions);
  }
});

test("straightforward natural shortcut requests route deterministically", async () => {
  const originalAuthority = await loadAuthorityConfig();
  const adapter = createInputAdapter();

  try {
    await setDefaultAuthority(5);

    const requests = [
      ["Select all", "ctrl+a"],
      ["Copy", "ctrl+c"],
      ["Paste", "ctrl+v"],
      ["Undo", "ctrl+z"],
      ["Redo", "ctrl+y"],
      ["Save", "ctrl+s"],
      ["Find", "ctrl+f"],
    ];

    for (const [command, shortcut] of requests) {
      const result = await tryFastRoute(command, {
        inputAdapter: adapter,
      });

      assert.equal(result.handled, true);
      assert.equal(result.result.ok, true);
      assert.equal(result.result.shortcut, shortcut);
    }

    assert.deepEqual(adapter.shortcuts.map((item) => item.shortcut), requests.map(([, shortcut]) => shortcut));
  } finally {
    await saveAuthorityConfig(originalAuthority);
  }
});

test("type routes strip common instruction wrappers without inventing content", async () => {
  const originalAuthority = await loadAuthorityConfig();
  const adapter = createInputAdapter();

  try {
    await setDefaultAuthority(5);

    const requests = [
      ["Type the words Hello from Selene", "Hello from Selene"],
      ["Type the phrase \"Hello from Selene\"", "Hello from Selene"],
      ["Type a note saying Hello from Selene", "Hello from Selene"],
      ["Type saying Hello from Selene", "Hello from Selene"],
      ["Type Hello from Selene into Notepad", "Hello from Selene"],
    ];

    for (const [command, expectedText] of requests) {
      const result = await tryFastRoute(command, {
        inputAdapter: adapter,
      });

      assert.equal(result.handled, true);
      assert.equal(result.result.ok, true);
      assert.equal(adapter.typed.at(-1).text, expectedText);
    }
  } finally {
    await saveAuthorityConfig(originalAuthority);
  }
});

test("multi-step type plans strip instruction wrappers", async () => {
  const originalAuthority = await loadAuthorityConfig();
  const originalPermissions = await loadApplicationPermissions();
  const adapter = createInputAdapter();

  try {
    await setDefaultAuthority(5);
    await saveApplicationPermissions({
      ...originalPermissions,
      notepad: true,
    });

    const result = await tryFastRoute("Open Notepad, type the words Hello from Selene, then select all", {
      launcher() {
        return { ok: true, processId: 2468 };
      },
      inputAdapter: adapter,
    });

    assert.equal(result.handled, true);
    assert.equal(result.result.ok, true);
    assert.equal(adapter.typed[0].text, "Hello from Selene");
    assert.equal(adapter.shortcuts[0].shortcut, "ctrl+a");
  } finally {
    await saveAuthorityConfig(originalAuthority);
    await saveApplicationPermissions(originalPermissions);
  }
});

test("explicit What app am I in query returns current awareness state", async () => {
  const awareness = awarenessState({
    enabled: true,
    policy: "allow",
    foreground: {
      process: "Code.exe",
      title: "main.cjs - Selene Pebble - Visual Studio Code",
      observedAt: "2026-08-28T12:00:00.000Z",
    },
  });

  const result = await tryFastRoute("What app am I in?", {
    awarenessService: awareness.service,
  });

  assert.equal(result.handled, true);
  assert.equal(result.result.action, "awareness_query");
  assert.equal(result.result.foreground.application, "Visual Studio Code");
  assert.equal(result.result.foreground.process, "Code.exe");
  assert.match(result.result.message, /Visual Studio Code/);
  assert.equal(awareness.reads, 1);
});

test("What window is active returns title when available", async () => {
  const awareness = awarenessState({
    enabled: true,
    policy: "allow",
    foreground: {
      process: "firefox.exe",
      title: "Selene docs - Mozilla Firefox",
      observedAt: "2026-08-28T12:00:00.000Z",
    },
  });

  const result = await tryFastRoute("What window is active?", {
    awarenessService: awareness.service,
  });

  assert.equal(result.handled, true);
  assert.equal(result.result.foreground.application, "Firefox");
  assert.equal(result.result.message, "You're currently in Firefox - Selene docs - Mozilla Firefox.");
});

test("disabled awareness returns a privacy-aware response", async () => {
  const awareness = awarenessState({
    enabled: false,
    policy: "deny",
    foreground: null,
  });

  const result = await tryFastRoute("Which application is in the foreground?", {
    awarenessService: awareness.service,
  });

  assert.equal(result.handled, true);
  assert.equal(result.result.awarenessEnabled, false);
  assert.equal(result.result.message, "I can't see the active window because Active Window awareness is disabled.");
});

test("ask policy behaves as unavailable for explicit awareness queries", async () => {
  const awareness = awarenessState({
    enabled: false,
    policy: "ask",
    foreground: null,
  });

  const result = await tryFastRoute("What am I currently using?", {
    awarenessService: awareness.service,
  });

  assert.equal(result.handled, true);
  assert.equal(result.result.awarenessEnabled, false);
  assert.match(result.result.message, /awareness is disabled/);
});

test("missing foreground state fails gracefully", async () => {
  const awareness = awarenessState({
    enabled: true,
    policy: "allow",
    foreground: null,
  });

  const result = await tryFastRoute("What is the active window?", {
    awarenessService: awareness.service,
  });

  assert.equal(result.handled, true);
  assert.equal(result.result.awarenessEnabled, true);
  assert.equal(result.result.message, "I can't determine the active window right now.");
});

test("friendly process-name mapping works for known executables", async () => {
  const awareness = awarenessState({
    enabled: true,
    policy: "allow",
    foreground: {
      process: "chrome.exe",
      title: "",
      observedAt: "2026-08-28T12:00:00.000Z",
    },
  });

  const result = await tryFastRoute("What application am I using?", {
    awarenessService: awareness.service,
  });

  assert.equal(result.handled, true);
  assert.equal(result.result.foreground.application, "Google Chrome");
  assert.equal(result.result.message, "You're currently in Google Chrome.");
});

test("unknown executables fall back safely to process name", async () => {
  const awareness = awarenessState({
    enabled: true,
    policy: "allow",
    foreground: {
      process: "ObscureApp.exe",
      title: "",
      observedAt: "2026-08-28T12:00:00.000Z",
    },
  });

  const result = await tryFastRoute("Which app is in the foreground?", {
    awarenessService: awareness.service,
  });

  assert.equal(result.handled, true);
  assert.equal(result.result.foreground.application, "ObscureApp.exe");
  assert.equal(result.result.message, "You're currently in ObscureApp.exe.");
});

test("normal unrelated commands do not consume awareness", async () => {
  const awareness = awarenessState({
    enabled: true,
    policy: "allow",
    foreground: {
      process: "Code.exe",
      title: "Not consumed",
      observedAt: "2026-08-28T12:00:00.000Z",
    },
  });

  const result = await tryFastRoute("Tell me something interesting", {
    awarenessService: awareness.service,
  });

  assert.equal(result.handled, false);
  assert.equal(awareness.reads, 0);
});

test("What am I working on triggers the context route", async () => {
  const awareness = awarenessState({
    enabled: true,
    policy: "allow",
    foreground: {
      process: "Code.exe",
      title: "router.js - Selene Core - Visual Studio Code",
      observedAt: "2026-08-28T12:00:00.000Z",
    },
  });

  const result = await tryFastRoute("What am I working on?", {
    awarenessService: awareness.service,
  });

  assert.equal(result.handled, true);
  assert.equal(result.result.action, "awareness_context_query");
  assert.equal(result.result.awarenessEnabled, true);
  assert.equal(awareness.reads, 1);
});

test("VS Code context parsing mentions app, workspace, and open file cautiously", async () => {
  const awareness = awarenessState({
    enabled: true,
    policy: "allow",
    foreground: {
      process: "Code.exe",
      title: "router.js - Selene Core - Visual Studio Code",
      observedAt: "2026-08-28T12:00:00.000Z",
    },
  });

  const result = await tryFastRoute("What project am I in?", {
    awarenessService: awareness.service,
  });

  assert.equal(result.handled, true);
  assert.match(result.result.message, /^It looks like/);
  assert.match(result.result.message, /Visual Studio Code/);
  assert.match(result.result.message, /Selene Core/);
  assert.match(result.result.message, /router\.js/);
});

test("Chrome context parsing strips the browser suffix", async () => {
  const awareness = awarenessState({
    enabled: true,
    policy: "allow",
    foreground: {
      process: "chrome.exe",
      title: "Selene roadmap - Google Chrome",
      observedAt: "2026-08-28T12:00:00.000Z",
    },
  });

  const result = await tryFastRoute("What am I looking at?", {
    awarenessService: awareness.service,
  });

  assert.equal(result.handled, true);
  assert.equal(result.result.message, "It looks like you're viewing 'Selene roadmap' in Google Chrome.");
});

test("Firefox context parsing handles a normal Firefox title", async () => {
  const awareness = awarenessState({
    enabled: true,
    policy: "allow",
    foreground: {
      process: "firefox.exe",
      title: "Selene roadmap \u2014 Mozilla Firefox",
      observedAt: "2026-08-28T12:00:00.000Z",
    },
  });

  const result = await tryFastRoute("What am I working in?", {
    awarenessService: awareness.service,
  });

  assert.equal(result.handled, true);
  assert.equal(result.result.message, "It looks like you're viewing 'Selene roadmap' in Firefox.");
});

test("Notepad context parsing identifies the document title", async () => {
  const awareness = awarenessState({
    enabled: true,
    policy: "allow",
    foreground: {
      process: "notepad.exe",
      title: "notes.txt - Notepad",
      observedAt: "2026-08-28T12:00:00.000Z",
    },
  });

  const result = await tryFastRoute("What am I doing?", {
    awarenessService: awareness.service,
  });

  assert.equal(result.handled, true);
  assert.equal(result.result.message, "It looks like you're working in Notepad, with notes.txt open.");
});

test("Discord context parsing produces current-view wording", async () => {
  const awareness = awarenessState({
    enabled: true,
    policy: "allow",
    foreground: {
      process: "Discord.exe",
      title: "Yapping | Shed. - Discord",
      observedAt: "2026-08-28T12:00:00.000Z",
    },
  });

  const result = await tryFastRoute("What am I doing right now?", {
    awarenessService: awareness.service,
  });

  assert.equal(result.handled, true);
  assert.equal(result.result.message, "You're in Discord, on 'Yapping | Shed.'.");
});

test("unknown application context falls back safely", async () => {
  const awareness = awarenessState({
    enabled: true,
    policy: "allow",
    foreground: {
      process: "ExampleApp.exe",
      title: "Mystery document",
      observedAt: "2026-08-28T12:00:00.000Z",
    },
  });

  const result = await tryFastRoute("What am I looking at?", {
    awarenessService: awareness.service,
  });

  assert.equal(result.handled, true);
  assert.equal(result.result.message, "You're currently in ExampleApp.exe, on 'Mystery document'.");
});

test("empty window title falls back to application-only context wording", async () => {
  const awareness = awarenessState({
    enabled: true,
    policy: "allow",
    foreground: {
      process: "ExampleApp.exe",
      title: "",
      observedAt: "2026-08-28T12:00:00.000Z",
    },
  });

  const result = await tryFastRoute("What am I working on?", {
    awarenessService: awareness.service,
  });

  assert.equal(result.handled, true);
  assert.equal(result.result.message, "You're currently using ExampleApp.exe.");
});

test("disabled awareness blocks context interpretation", async () => {
  const awareness = awarenessState({
    enabled: false,
    policy: "deny",
    foreground: null,
  });

  const result = await tryFastRoute("What am I working on?", {
    awarenessService: awareness.service,
  });

  assert.equal(result.handled, true);
  assert.equal(result.result.awarenessEnabled, false);
  assert.equal(result.result.message, "I can't tell what you're working on because Active Window awareness is disabled.");
});

test("ask policy remains unavailable for context interpretation", async () => {
  const awareness = awarenessState({
    enabled: false,
    policy: "ask",
    foreground: null,
  });

  const result = await tryFastRoute("What am I doing right now?", {
    awarenessService: awareness.service,
  });

  assert.equal(result.handled, true);
  assert.equal(result.result.awarenessEnabled, false);
  assert.match(result.result.message, /awareness is disabled/);
});

test("missing foreground state fails gracefully for context interpretation", async () => {
  const awareness = awarenessState({
    enabled: true,
    policy: "allow",
    foreground: null,
  });

  const result = await tryFastRoute("What project am I in?", {
    awarenessService: awareness.service,
  });

  assert.equal(result.handled, true);
  assert.equal(result.result.awarenessEnabled, true);
  assert.equal(result.result.message, "I can't determine what you're working on right now.");
});

test("unrelated normal queries do not consume context awareness", async () => {
  const awareness = awarenessState({
    enabled: true,
    policy: "allow",
    foreground: {
      process: "Code.exe",
      title: "router.js - Selene Core - Visual Studio Code",
      observedAt: "2026-08-28T12:00:00.000Z",
    },
  });

  const result = await tryFastRoute("What should I do?", {
    awarenessService: awareness.service,
  });

  assert.equal(result.handled, false);
  assert.equal(awareness.reads, 0);
});

test("Now what am I looking at routes to context awareness", async () => {
  const adapter = createInputAdapter();
  const awareness = awarenessState({
    enabled: true,
    policy: "allow",
    foreground: {
      process: "firefox.exe",
      title: "Selene roadmap - Mozilla Firefox",
      observedAt: "2026-08-28T12:00:00.000Z",
    },
  });

  const result = await tryFastRoute("Now what am I looking at?", {
    awarenessService: awareness.service,
    inputAdapter: adapter,
  });

  assert.equal(result.handled, true);
  assert.equal(result.result.action, "awareness_context_query");
  assert.equal(adapter.typed.length, 0);
});

test("Okay, what am I looking at routes to context awareness", async () => {
  const adapter = createInputAdapter();
  const awareness = awarenessState({
    enabled: true,
    policy: "allow",
    foreground: {
      process: "chrome.exe",
      title: "Selene roadmap - Google Chrome",
      observedAt: "2026-08-28T12:00:00.000Z",
    },
  });

  const result = await tryFastRoute("Okay, what am I looking at?", {
    awarenessService: awareness.service,
    inputAdapter: adapter,
  });

  assert.equal(result.handled, true);
  assert.equal(result.result.action, "awareness_context_query");
  assert.equal(adapter.typed.length, 0);
});

test("Okay, now what am I working on routes to context awareness", async () => {
  const adapter = createInputAdapter();
  const awareness = awarenessState({
    enabled: true,
    policy: "allow",
    foreground: {
      process: "Code.exe",
      title: "router.js - Selene Core - Visual Studio Code",
      observedAt: "2026-08-28T12:00:00.000Z",
    },
  });

  const result = await tryFastRoute("Okay, now what am I working on?", {
    awarenessService: awareness.service,
    inputAdapter: adapter,
  });

  assert.equal(result.handled, true);
  assert.equal(result.result.action, "awareness_context_query");
  assert.equal(adapter.typed.length, 0);
});

test("So what app am I in routes to active-window awareness", async () => {
  const awareness = awarenessState({
    enabled: true,
    policy: "allow",
    foreground: {
      process: "Code.exe",
      title: "router.js - Selene Core - Visual Studio Code",
      observedAt: "2026-08-28T12:00:00.000Z",
    },
  });

  const result = await tryFastRoute("So what app am I in?", {
    awarenessService: awareness.service,
  });

  assert.equal(result.handled, true);
  assert.equal(result.result.action, "awareness_query");
});

test("explicit Type hello world still reaches normal typing behavior", async () => {
  const originalAuthority = await loadAuthorityConfig();
  const adapter = createInputAdapter();

  try {
    await setDefaultAuthority(5);

    const result = await tryFastRoute("Type hello world", {
      inputAdapter: adapter,
    });

    assert.equal(result.handled, true);
    assert.equal(result.result.action, "type_text");
    assert.equal(adapter.typed.length, 1);
    assert.equal(adapter.typed[0].text, "hello world");
  } finally {
    await saveAuthorityConfig(originalAuthority);
  }
});

test("Firefox foreground followed by Selene Panel answers with Firefox context", async () => {
  const awareness = awarenessState({
    enabled: true,
    policy: "allow",
    foreground: {
      process: "firefox.exe",
      title: "Selene roadmap - Mozilla Firefox",
      observedAt: "2026-08-28T12:00:00.000Z",
    },
    currentForeground: {
      process: "electron.exe",
      title: "Selene Panel",
      observedAt: "2026-08-28T12:00:01.000Z",
    },
    lastExternalForeground: {
      process: "firefox.exe",
      title: "Selene roadmap - Mozilla Firefox",
      observedAt: "2026-08-28T12:00:00.000Z",
    },
  });

  const result = await tryFastRoute("What am I looking at?", {
    awarenessService: awareness.service,
  });

  assert.equal(result.handled, true);
  assert.equal(result.result.message, "It looks like you're viewing 'Selene roadmap' in Firefox.");
});

test("VS Code foreground followed by Selene Panel answers with VS Code context", async () => {
  const awareness = awarenessState({
    enabled: true,
    policy: "allow",
    foreground: {
      process: "Code.exe",
      title: "router.js - Selene Core - Visual Studio Code",
      observedAt: "2026-08-28T12:00:00.000Z",
    },
    currentForeground: {
      process: "electron.exe",
      title: "Selene Panel",
      observedAt: "2026-08-28T12:00:01.000Z",
    },
    lastExternalForeground: {
      process: "Code.exe",
      title: "router.js - Selene Core - Visual Studio Code",
      observedAt: "2026-08-28T12:00:00.000Z",
    },
  });

  const result = await tryFastRoute("Now what am I working on?", {
    awarenessService: awareness.service,
  });

  assert.equal(result.handled, true);
  assert.match(result.result.message, /Visual Studio Code/);
  assert.match(result.result.message, /Selene Core/);
  assert.match(result.result.message, /router\.js/);
});
