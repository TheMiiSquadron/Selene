const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PAIRING_CHANNELS,
  registerPairingIpcHandlers,
} = require("./pairingIpc.cjs");

function createFakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) {
      assert.equal(handlers.has(channel), false);
      handlers.set(channel, handler);
    },
    invoke(channel, event = {}, ...args) {
      const handler = handlers.get(channel);
      assert.equal(typeof handler, "function");
      return handler(event, ...args);
    },
  };
}

function activeSession(id = "session-1") {
  return {
    id,
    createdAt: "2026-09-23T00:00:00.000Z",
    expiresAt: "2026-09-23T00:05:00.000Z",
    failedAttempts: 0,
    failedAttemptsRemaining: 5,
  };
}

test("registers only narrow pairing IPC handlers", () => {
  const ipcMain = createFakeIpcMain();
  registerPairingIpcHandlers({
    ipcMain,
    coreLifecycle: {
      getAdminChannelStatus: () => ({ ready: false }),
    },
  });

  assert.deepEqual([...ipcMain.handlers.keys()].sort(), [
    PAIRING_CHANNELS.CANCEL,
    PAIRING_CHANNELS.START,
    PAIRING_CHANNELS.START_SECURE_CORE,
    PAIRING_CHANNELS.STATUS,
  ].sort());
});

test("pairing handlers reject non-panel senders", async () => {
  const ipcMain = createFakeIpcMain();
  let called = false;
  registerPairingIpcHandlers({
    ipcMain,
    isAllowedSender: () => false,
    coreLifecycle: {
      getAdminChannelStatus: () => ({ ready: true }),
      startPairing: async () => {
        called = true;
        return {};
      },
    },
  });

  const response = await ipcMain.invoke(PAIRING_CHANNELS.START, {});

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "PAIRING_IPC_FORBIDDEN");
  assert.equal(called, false);
});

test("pairing handlers reject renderer-supplied policy parameters", async () => {
  const ipcMain = createFakeIpcMain();
  let called = false;
  registerPairingIpcHandlers({
    ipcMain,
    isAllowedSender: () => true,
    coreLifecycle: {
      getAdminChannelStatus: () => ({ ready: true }),
      startPairing: async () => {
        called = true;
        return {};
      },
    },
  });

  const response = await ipcMain.invoke(
    PAIRING_CHANNELS.START,
    {},
    { ttlMs: 60000, action: "pairing.start" },
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "INVALID_PAIRING_REQUEST");
  assert.equal(called, false);
});

test("unavailable or external Core cannot start pairing through the UI bridge", async () => {
  const ipcMain = createFakeIpcMain();
  let called = false;
  registerPairingIpcHandlers({
    ipcMain,
    isAllowedSender: () => true,
    coreLifecycle: {
      getAdminChannelStatus: () => ({ state: "unavailable", ready: false }),
      checkAvailability: async () => ({ state: "unavailable", reachable: false }),
      startPairing: async () => {
        called = true;
        return {};
      },
    },
  });

  const status = await ipcMain.invoke(PAIRING_CHANNELS.STATUS, {});
  const start = await ipcMain.invoke(PAIRING_CHANNELS.START, {});

  assert.equal(status.available, false);
  assert.equal(status.state, "no-core");
  assert.equal(status.canStartSecureCore, true);
  assert.equal(start.available, false);
  assert.equal(called, false);
});

test("explicit Start Secure Core invokes exactly one narrow lifecycle request", async () => {
  const ipcMain = createFakeIpcMain();
  let startCalls = 0;
  registerPairingIpcHandlers({
    ipcMain,
    isAllowedSender: () => true,
    coreLifecycle: {
      getAdminChannelStatus: () => ({ state: "unavailable", ready: false }),
      checkAvailability: async () => ({ state: "unavailable", reachable: false }),
      startSecureCore: async () => {
        startCalls += 1;
        return { ok: true, state: "secure-core-ready" };
      },
    },
  });

  const response = await ipcMain.invoke(PAIRING_CHANNELS.START_SECURE_CORE, {});

  assert.equal(startCalls, 1);
  assert.equal(response.ok, true);
  assert.equal(response.available, true);
  assert.equal(response.state, "ready");
});

test("renderer cannot provide executable paths, arguments, or arbitrary lifecycle operations", async () => {
  const ipcMain = createFakeIpcMain();
  let startCalls = 0;
  registerPairingIpcHandlers({
    ipcMain,
    isAllowedSender: () => true,
    coreLifecycle: {
      getAdminChannelStatus: () => ({ state: "unavailable", ready: false }),
      checkAvailability: async () => ({ state: "unavailable", reachable: false }),
      startSecureCore: async () => {
        startCalls += 1;
        return { ok: true };
      },
    },
  });

  const response = await ipcMain.invoke(PAIRING_CHANNELS.START_SECURE_CORE, {}, {
    executable: "C:/untrusted/node.exe",
    args: ["evil.js"],
    operation: "shutdownOwnedCore",
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "INVALID_PAIRING_REQUEST");
  assert.equal(startCalls, 0);
  assert.equal(ipcMain.handlers.has("nova-panel:lifecycle"), false);
});

test("external Core exposes Check Again only and never launches or terminates Core", async () => {
  const ipcMain = createFakeIpcMain();
  let startCalls = 0;
  let shutdownCalls = 0;
  registerPairingIpcHandlers({
    ipcMain,
    isAllowedSender: () => true,
    coreLifecycle: {
      getAdminChannelStatus: () => ({ state: "unavailable", ready: false }),
      checkAvailability: async () => ({ state: "externally-managed", reachable: true, owned: false }),
      startSecureCore: async () => {
        startCalls += 1;
        return { ok: true };
      },
      shutdownOwnedCore: async () => {
        shutdownCalls += 1;
        return {};
      },
    },
  });

  const status = await ipcMain.invoke(PAIRING_CHANNELS.STATUS, {});
  const start = await ipcMain.invoke(PAIRING_CHANNELS.START_SECURE_CORE, {});

  assert.equal(status.state, "external-core");
  assert.equal(status.canStartSecureCore, false);
  assert.equal(status.canCheckAgain, true);
  assert.equal(start.state, "external-core");
  assert.equal(startCalls, 0);
  assert.equal(shutdownCalls, 0);
});

test("failed Secure Core launch remains sanitized and pairing unavailable", async () => {
  const ipcMain = createFakeIpcMain();
  registerPairingIpcHandlers({
    ipcMain,
    isAllowedSender: () => true,
    coreLifecycle: {
      getAdminChannelStatus: () => ({ state: "unavailable", ready: false }),
      checkAvailability: async () => ({ state: "unavailable", reachable: false }),
      startSecureCore: async () => ({
        ok: false,
        state: "authentication-failed",
        message: "Secure Core could not establish an authenticated admin channel.",
      }),
    },
  });

  const response = await ipcMain.invoke(PAIRING_CHANNELS.START_SECURE_CORE, {});

  assert.equal(response.ok, false);
  assert.equal(response.available, false);
  assert.equal(response.state, "secure-core-failed");
  assert.doesNotMatch(JSON.stringify(response), /capability|hmac|tag|bootstrap/i);
});

test("ready authenticated channel enables explicit start without logging or status secret", async () => {
  const ipcMain = createFakeIpcMain();
  const calls = [];
  const pairingSecret = "A".repeat(43);
  registerPairingIpcHandlers({
    ipcMain,
    isAllowedSender: () => true,
    coreLifecycle: {
      getAdminChannelStatus: () => ({ state: "ready", ready: true }),
      getPairingStatus: async () => ({ ok: true, session: activeSession() }),
      startPairing: async () => {
        calls.push("start");
        return {
          ok: true,
          pairingSecret,
          session: activeSession(),
        };
      },
    },
  });

  const start = await ipcMain.invoke(PAIRING_CHANNELS.START, {});
  const status = await ipcMain.invoke(PAIRING_CHANNELS.STATUS, {});

  assert.deepEqual(calls, ["start"]);
  assert.equal(start.pairingSecret, pairingSecret);
  assert.equal(status.pairingSecret, undefined);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(pairingSecret));
});

test("cancel clears through narrow authenticated operation and exposes no old secret", async () => {
  const ipcMain = createFakeIpcMain();
  const pairingSecret = "B".repeat(43);
  registerPairingIpcHandlers({
    ipcMain,
    isAllowedSender: () => true,
    coreLifecycle: {
      getAdminChannelStatus: () => ({ state: "ready", ready: true }),
      startPairing: async () => ({
        ok: true,
        pairingSecret,
        session: activeSession(),
      }),
      cancelPairing: async () => ({
        ok: true,
        cancelled: true,
        status: { ok: true, session: null },
      }),
    },
  });

  const start = await ipcMain.invoke(PAIRING_CHANNELS.START, {});
  const cancel = await ipcMain.invoke(PAIRING_CHANNELS.CANCEL, {});

  assert.equal(start.pairingSecret, pairingSecret);
  assert.equal(cancel.cancelled, true);
  assert.equal(cancel.session, null);
  assert.doesNotMatch(JSON.stringify(cancel), new RegExp(pairingSecret));
});

test("failed cancel is sanitized and does not falsely report success", async () => {
  const ipcMain = createFakeIpcMain();
  registerPairingIpcHandlers({
    ipcMain,
    isAllowedSender: () => true,
    coreLifecycle: {
      getAdminChannelStatus: () => ({ state: "ready", ready: true }),
      cancelPairing: async () => {
        const error = new Error("database secret should not appear");
        error.code = "CHANNEL_CLOSED";
        throw error;
      },
    },
  });

  const response = await ipcMain.invoke(PAIRING_CHANNELS.CANCEL, {});

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "CHANNEL_CLOSED");
  assert.match(response.message, /could not be confirmed/i);
  assert.doesNotMatch(JSON.stringify(response), /database secret/);
});
