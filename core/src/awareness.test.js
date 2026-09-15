import test from "node:test";
import assert from "node:assert/strict";
import {
  AWARENESS_POLL_MS,
  createAwarenessService,
  isSeleneOwnedForeground,
} from "./awareness.js";

function clock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 28, 12, 0, tick++));
}

test("awareness disabled exposes no foreground data", async () => {
  let reads = 0;
  const service = createAwarenessService({
    now: clock(),
    readForeground: async () => {
      reads += 1;
      return { ok: true, process: "Code.exe", title: "Secret title" };
    },
  });

  service.configure({ activeWindowName: "deny", startPolling: false });
  const state = await service.pollOnce();

  assert.equal(reads, 0);
  assert.equal(state.enabled, false);
  assert.equal(state.foreground, null);
  assert.equal(state.lastChange, null);
});

test("awareness enabled returns a valid current-state structure", async () => {
  const service = createAwarenessService({
    now: clock(),
    readForeground: async () => ({
      ok: true,
      process: "Code.exe",
      title: "main.cjs - Selene Pebble - Visual Studio Code",
    }),
  });

  service.configure({ activeWindowName: "allow", startPolling: false });
  const state = await service.pollOnce();

  assert.equal(state.enabled, true);
  assert.equal(state.policy, "allow");
  assert.equal(state.pollMs, AWARENESS_POLL_MS);
  assert.deepEqual(state.foreground, {
    process: "Code.exe",
    title: "main.cjs - Selene Pebble - Visual Studio Code",
    observedAt: "2026-08-28T12:00:00.000Z",
  });
});

test("foreground change updates current state", async () => {
  const observations = [
    { ok: true, process: "Chrome.exe", title: "Selene" },
    { ok: true, process: "Code.exe", title: "main.cjs - Visual Studio Code" },
  ];
  const service = createAwarenessService({
    now: clock(),
    readForeground: async () => observations.shift(),
  });

  service.configure({ activeWindowName: "allow", startPolling: false });
  await service.pollOnce();
  const state = await service.pollOnce();

  assert.deepEqual(state.foreground, {
    process: "Code.exe",
    title: "main.cjs - Visual Studio Code",
    observedAt: "2026-08-28T12:00:01.000Z",
  });
  assert.deepEqual(state.lastChange, {
    event: "foreground_changed",
    process: "Code.exe",
    title: "main.cjs - Visual Studio Code",
    timestamp: "2026-08-28T12:00:01.000Z",
  });
});

test("same foreground state does not create unnecessary change events", async () => {
  const service = createAwarenessService({
    now: clock(),
    readForeground: async () => ({
      ok: true,
      process: "Code.exe",
      title: "Same title",
    }),
  });

  service.configure({ activeWindowName: "allow", startPolling: false });
  await service.pollOnce();
  const firstChange = service.getState().lastChange;
  const state = await service.pollOnce();

  assert.equal(state.foreground.observedAt, "2026-08-28T12:00:01.000Z");
  assert.deepEqual(state.lastChange, firstChange);
});

test("window-title-only change is recognized", async () => {
  const observations = [
    { ok: true, process: "Code.exe", title: "awareness.js - Visual Studio Code" },
    { ok: true, process: "Code.exe", title: "server.js - Visual Studio Code" },
  ];
  const service = createAwarenessService({
    now: clock(),
    readForeground: async () => observations.shift(),
  });

  service.configure({ activeWindowName: "allow", startPolling: false });
  await service.pollOnce();
  const state = await service.pollOnce();

  assert.equal(state.lastChange.process, "Code.exe");
  assert.equal(state.lastChange.title, "server.js - Visual Studio Code");
});

test("observer errors fail safely", async () => {
  const service = createAwarenessService({
    now: clock(),
    readForeground: async () => ({ ok: false, message: "No foreground window." }),
  });

  service.configure({ activeWindowName: "allow", startPolling: false });
  const state = await service.pollOnce();

  assert.equal(state.enabled, true);
  assert.equal(state.foreground, null);
  assert.equal(state.lastChange, null);
  assert.equal(state.lastError.message, "Foreground information is unavailable.");
});

test("no historical activity log is created", async () => {
  const service = createAwarenessService({
    now: clock(),
    readForeground: async () => ({ ok: true, process: "Code.exe", title: "Now" }),
  });

  service.configure({ activeWindowName: "allow", startPolling: false });
  const state = await service.pollOnce();

  assert.equal("history" in state, false);
  assert.equal("events" in state, false);
});

test("ask policy disables collection until a later explicit approval flow exists", async () => {
  let reads = 0;
  const service = createAwarenessService({
    now: clock(),
    readForeground: async () => {
      reads += 1;
      return { ok: true, process: "Code.exe", title: "Not collected" };
    },
  });

  service.configure({ activeWindowName: "ask", startPolling: false });
  const state = await service.pollOnce();

  assert.equal(reads, 0);
  assert.equal(state.enabled, false);
  assert.equal(state.policy, "ask");
  assert.equal(state.foreground, null);
});

test("Selene Panel is excluded narrowly in favor of last external foreground", async () => {
  const observations = [
    { ok: true, process: "firefox.exe", title: "Selene roadmap - Mozilla Firefox" },
    { ok: true, process: "electron.exe", title: "Selene Panel" },
  ];
  const service = createAwarenessService({
    now: clock(),
    readForeground: async () => observations.shift(),
  });

  service.configure({ activeWindowName: "allow", startPolling: false });
  await service.pollOnce();
  const state = await service.pollOnce();

  assert.equal(state.currentForeground.process, "electron.exe");
  assert.equal(state.currentForeground.title, "Selene Panel");
  assert.equal(state.lastExternalForeground.process, "firefox.exe");
  assert.equal(state.foreground.process, "firefox.exe");
});

test("other Electron applications are not automatically excluded", async () => {
  const service = createAwarenessService({
    now: clock(),
    readForeground: async () => ({
      ok: true,
      process: "electron.exe",
      title: "A Real Electron App",
    }),
  });

  service.configure({ activeWindowName: "allow", startPolling: false });
  const state = await service.pollOnce();

  assert.equal(state.currentForeground.process, "electron.exe");
  assert.equal(state.lastExternalForeground.process, "electron.exe");
  assert.equal(state.foreground.title, "A Real Electron App");
});

test("returning from Selene Panel to an external app updates context normally", async () => {
  const observations = [
    { ok: true, process: "firefox.exe", title: "Selene roadmap - Mozilla Firefox" },
    { ok: true, process: "electron.exe", title: "Selene Panel" },
    { ok: true, process: "Code.exe", title: "router.js - Selene Core - Visual Studio Code" },
  ];
  const service = createAwarenessService({
    now: clock(),
    readForeground: async () => observations.shift(),
  });

  service.configure({ activeWindowName: "allow", startPolling: false });
  await service.pollOnce();
  await service.pollOnce();
  const state = await service.pollOnce();

  assert.equal(state.currentForeground.process, "Code.exe");
  assert.equal(state.lastExternalForeground.process, "Code.exe");
  assert.equal(state.foreground.process, "Code.exe");
});

test("deny clears current foreground and last external foreground", async () => {
  const service = createAwarenessService({
    now: clock(),
    readForeground: async () => ({
      ok: true,
      process: "firefox.exe",
      title: "Selene roadmap - Mozilla Firefox",
    }),
  });

  service.configure({ activeWindowName: "allow", startPolling: false });
  await service.pollOnce();
  const disabled = service.configure({ activeWindowName: "deny", startPolling: false });

  assert.equal(disabled.foreground, null);
  assert.equal(disabled.currentForeground, null);
  assert.equal(disabled.lastExternalForeground, null);
});

test("ask exposes neither current foreground nor last external foreground", async () => {
  const service = createAwarenessService({
    now: clock(),
    readForeground: async () => ({
      ok: true,
      process: "firefox.exe",
      title: "Selene roadmap - Mozilla Firefox",
    }),
  });

  service.configure({ activeWindowName: "allow", startPolling: false });
  await service.pollOnce();
  const ask = service.configure({ activeWindowName: "ask", startPolling: false });

  assert.equal(ask.foreground, null);
  assert.equal(ask.currentForeground, null);
  assert.equal(ask.lastExternalForeground, null);
});

test("Selene-owned windows are identified by title, not by Electron process", () => {
  assert.equal(isSeleneOwnedForeground({
    process: "electron.exe",
    title: "Selene Panel",
  }), true);
  assert.equal(isSeleneOwnedForeground({
    process: "electron.exe",
    title: "Discord",
  }), false);
});
