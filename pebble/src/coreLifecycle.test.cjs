const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const path = require("node:path");
const {
  OWNED_CORE_ADMIN_IPC_ARG,
  createCoreLifecycle,
  resolveLaunchConfiguration,
} = require("./coreLifecycle.cjs");

class FakeChild extends EventEmitter {
  constructor({
    pid = 4242,
    killError = null,
    killReturn = true,
    exitOnKill = true,
  } = {}) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.killError = killError;
    this.killReturn = killReturn;
    this.exitOnKill = exitOnKill;
    this.killed = false;
    this.killCount = 0;
  }

  kill() {
    this.killed = true;
    this.killCount += 1;
    if (this.killError) throw this.killError;
    if (!this.killReturn) return false;
    if (!this.exitOnKill) return true;
    queueMicrotask(() => {
      this.exitCode = 0;
      this.signalCode = null;
      this.emit("exit", 0, null);
    });
    return true;
  }

  exitUnexpectedly(code = 1, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

function okResponse() {
  return { ok: true, status: 200 };
}

test("reports Core unavailable without launching", async () => {
  const lifecycle = createCoreLifecycle({
    fetchImpl: async () => {
      throw new Error("connection refused");
    },
  });

  const status = await lifecycle.checkAvailability();

  assert.equal(status.state, "unavailable");
  assert.equal(status.reachable, false);
  assert.equal(status.owned, false);
});

test("detects externally managed Core without spawning another process", async () => {
  let spawnCalls = 0;
  const lifecycle = createCoreLifecycle({
    fetchImpl: async () => okResponse(),
    spawnImpl: () => {
      spawnCalls += 1;
      throw new Error("should not spawn");
    },
    launchConfiguration: {
      executable: path.resolve("C:/trusted/node.exe"),
      args: [path.resolve("C:/trusted/Selene/core/src/server.js")],
      cwd: path.resolve("C:/trusted/Selene/core/src"),
    },
  });

  const status = await lifecycle.startOwnedCore();

  assert.equal(status.state, "externally-managed");
  assert.equal(status.reachable, true);
  assert.equal(status.owned, false);
  assert.equal(spawnCalls, 0);
});

test("launches and shuts down only an owned Core process", async () => {
  let child;
  let spawned = false;
  const lifecycle = createCoreLifecycle({
    pollIntervalMs: 0,
    fetchImpl: async () => {
      if (spawned) return okResponse();
      throw new Error("offline");
    },
    spawnImpl: (executable, args, options) => {
      spawned = true;
      child = new FakeChild({ pid: 5001 });
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      assert.deepEqual(args, [path.resolve("C:/trusted/Selene/core/src/server.js")]);
      assert.equal(executable, path.resolve("C:/trusted/node.exe"));
      return child;
    },
    launchConfiguration: {
      executable: path.resolve("C:/trusted/node.exe"),
      args: [path.resolve("C:/trusted/Selene/core/src/server.js")],
      cwd: path.resolve("C:/trusted/Selene/core/src"),
    },
  });

  const started = await lifecycle.startOwnedCore();
  assert.equal(started.state, "reachable-with-owned-child");
  assert.equal(started.owned, true);
  assert.equal(started.pid, 5001);
  assert.equal(started.responderOwnership, "unverified");

  const stopped = await lifecycle.shutdownOwnedCore();
  assert.equal(stopped.state, "owned-stopped");
  assert.equal(child.killed, true);
  assert.equal(lifecycle.getOwnershipSnapshot().owned, false);
});

test("does not terminate externally managed Core", async () => {
  let spawnCalls = 0;
  const lifecycle = createCoreLifecycle({
    fetchImpl: async () => okResponse(),
    spawnImpl: () => {
      spawnCalls += 1;
      return new FakeChild();
    },
    launchConfiguration: {
      executable: path.resolve("C:/trusted/node.exe"),
      args: [path.resolve("C:/trusted/Selene/core/src/server.js")],
      cwd: path.resolve("C:/trusted/Selene/core/src"),
    },
  });

  assert.equal((await lifecycle.checkAvailability()).state, "externally-managed");
  const shutdown = await lifecycle.shutdownOwnedCore();

  assert.equal(shutdown.state, "no-owned-core");
  assert.equal(shutdown.owned, false);
  assert.equal(spawnCalls, 0);
});

test("records unexpected owned Core exit", async () => {
  let child;
  let spawned = false;
  const lifecycle = createCoreLifecycle({
    fetchImpl: async () => {
      if (spawned && child?.exitCode === null) return okResponse();
      throw new Error("offline");
    },
    spawnImpl: () => {
      spawned = true;
      child = new FakeChild({ pid: 5002 });
      return child;
    },
    launchConfiguration: {
      executable: path.resolve("C:/trusted/node.exe"),
      args: [path.resolve("C:/trusted/Selene/core/src/server.js")],
      cwd: path.resolve("C:/trusted/Selene/core/src"),
    },
  });

  assert.equal((await lifecycle.startOwnedCore()).state, "reachable-with-owned-child");
  child.exitUnexpectedly(9, null);

  const status = await lifecycle.checkAvailability();
  assert.equal(status.state, "owned-exited");
  assert.deepEqual(status.lastExit, { code: 9, signal: null });
});

test("reports startup failure without shell fallback", async () => {
  const lifecycle = createCoreLifecycle({
    fetchImpl: async () => {
      throw new Error("offline");
    },
    spawnImpl: () => {
      throw new Error("spawn denied");
    },
    launchConfiguration: {
      executable: path.resolve("C:/trusted/node.exe"),
      args: [path.resolve("C:/trusted/Selene/core/src/server.js")],
      cwd: path.resolve("C:/trusted/Selene/core/src"),
    },
  });

  const status = await lifecycle.startOwnedCore();

  assert.equal(status.state, "startup-failed");
  assert.equal(status.failure.operation, "startup");
  assert.match(status.failure.reason, /spawn denied/);
});

test("concurrent owned launch attempts share one spawn", async () => {
  let spawnCalls = 0;
  let child;
  let reachable = false;
  const lifecycle = createCoreLifecycle({
    startupTimeoutMs: 100,
    pollIntervalMs: 5,
    fetchImpl: async () => {
      if (reachable) return okResponse();
      throw new Error("offline");
    },
    spawnImpl: () => {
      spawnCalls += 1;
      child = new FakeChild({ pid: 6001 });
      setTimeout(() => {
        reachable = true;
      }, 10);
      return child;
    },
    launchConfiguration: {
      executable: path.resolve("C:/trusted/node.exe"),
      args: [path.resolve("C:/trusted/Selene/core/src/server.js")],
      cwd: path.resolve("C:/trusted/Selene/core/src"),
    },
  });

  const [first, second] = await Promise.all([
    lifecycle.startOwnedCore(),
    lifecycle.startOwnedCore(),
  ]);

  assert.equal(spawnCalls, 1);
  assert.equal(first.state, "reachable-with-owned-child");
  assert.equal(second.state, "reachable-with-owned-child");
  assert.equal(child.killCount, 0);
});

test("startup timeout attempts cleanup and blocks another launch while child remains", async () => {
  let spawnCalls = 0;
  let child;
  const lifecycle = createCoreLifecycle({
    startupTimeoutMs: 5,
    pollIntervalMs: 1,
    cleanupTimeoutMs: 5,
    fetchImpl: async () => {
      throw new Error("offline");
    },
    spawnImpl: () => {
      spawnCalls += 1;
      child = new FakeChild({ pid: 6002, exitOnKill: false });
      return child;
    },
    launchConfiguration: {
      executable: path.resolve("C:/trusted/node.exe"),
      args: [path.resolve("C:/trusted/Selene/core/src/server.js")],
      cwd: path.resolve("C:/trusted/Selene/core/src"),
    },
  });

  const failed = await lifecycle.startOwnedCore();
  const second = await lifecycle.startOwnedCore();

  assert.equal(failed.state, "startup-failed");
  assert.equal(failed.cleanup.state, "startup-cleanup-timeout");
  assert.equal(failed.owned, true);
  assert.equal(child.killed, true);
  assert.equal(spawnCalls, 1);
  assert.equal(second.state, "owned-stopping");
});

test("shutdown timeout is bounded and leaves ownership marked active", async () => {
  let child;
  let reachable = false;
  const lifecycle = createCoreLifecycle({
    shutdownTimeoutMs: 5,
    pollIntervalMs: 1,
    fetchImpl: async () => {
      if (reachable) return okResponse();
      throw new Error("offline");
    },
    spawnImpl: () => {
      child = new FakeChild({ pid: 6003, exitOnKill: false });
      reachable = true;
      return child;
    },
    launchConfiguration: {
      executable: path.resolve("C:/trusted/node.exe"),
      args: [path.resolve("C:/trusted/Selene/core/src/server.js")],
      cwd: path.resolve("C:/trusted/Selene/core/src"),
    },
  });

  await lifecycle.startOwnedCore();
  reachable = false;
  const shutdown = await lifecycle.shutdownOwnedCore();

  assert.equal(shutdown.state, "shutdown-timeout");
  assert.equal(shutdown.owned, true);
  assert.equal(child.killed, true);
  assert.equal(lifecycle.getOwnershipSnapshot().owned, true);
});

test("kill returning false reports shutdown failure without clearing ownership", async () => {
  let child;
  let spawned = false;
  const lifecycle = createCoreLifecycle({
    fetchImpl: async () => {
      if (spawned) return okResponse();
      throw new Error("offline");
    },
    spawnImpl: () => {
      spawned = true;
      child = new FakeChild({ pid: 6004, killReturn: false });
      return child;
    },
    launchConfiguration: {
      executable: path.resolve("C:/trusted/node.exe"),
      args: [path.resolve("C:/trusted/Selene/core/src/server.js")],
      cwd: path.resolve("C:/trusted/Selene/core/src"),
    },
  });

  await lifecycle.startOwnedCore();
  const shutdown = await lifecycle.shutdownOwnedCore();

  assert.equal(shutdown.state, "shutdown-failed");
  assert.equal(shutdown.failure.reason, "KILL_RETURNED_FALSE");
  assert.equal(lifecycle.getOwnershipSnapshot().owned, true);
});

test("repeated concurrent shutdown calls are deduplicated", async () => {
  let child;
  let spawned = false;
  const lifecycle = createCoreLifecycle({
    fetchImpl: async () => {
      if (spawned) return okResponse();
      throw new Error("offline");
    },
    spawnImpl: () => {
      spawned = true;
      child = new FakeChild({ pid: 6005 });
      return child;
    },
    launchConfiguration: {
      executable: path.resolve("C:/trusted/node.exe"),
      args: [path.resolve("C:/trusted/Selene/core/src/server.js")],
      cwd: path.resolve("C:/trusted/Selene/core/src"),
    },
  });

  await lifecycle.startOwnedCore();
  const [first, second] = await Promise.all([
    lifecycle.shutdownOwnedCore(),
    lifecycle.shutdownOwnedCore(),
  ]);
  const third = await lifecycle.shutdownOwnedCore();

  assert.equal(child.killCount, 1);
  assert.equal(first.state, "owned-stopped");
  assert.equal(second.state, "owned-stopped");
  assert.equal(third.state, "no-owned-core");
});

test("reachable HTTP while an owned child exists is not reported as verified child identity", async () => {
  let child;
  let spawned = false;
  const lifecycle = createCoreLifecycle({
    fetchImpl: async () => {
      if (spawned) return okResponse();
      throw new Error("offline");
    },
    spawnImpl: () => {
      spawned = true;
      child = new FakeChild({ pid: 6006 });
      return child;
    },
    launchConfiguration: {
      executable: path.resolve("C:/trusted/node.exe"),
      args: [path.resolve("C:/trusted/Selene/core/src/server.js")],
      cwd: path.resolve("C:/trusted/Selene/core/src"),
    },
  });

  await lifecycle.startOwnedCore();
  const status = await lifecycle.checkAvailability();

  assert.equal(child.exitCode, null);
  assert.equal(status.state, "reachable-with-owned-child");
  assert.equal(status.owned, true);
  assert.equal(status.responderOwnership, "unverified");
});

test("reports launch unavailable when no trusted executable is configured", async () => {
  const lifecycle = createCoreLifecycle({
    fetchImpl: async () => {
      throw new Error("offline");
    },
    launchConfiguration: null,
  });

  const status = await lifecycle.startOwnedCore();

  assert.equal(status.state, "startup-failed");
  assert.equal(status.failure.reason, "OWNED_LAUNCH_UNCONFIGURED");
});

test("admin IPC owned launch uses fixed non-secret flag and inherited stdio only when explicitly enabled", async () => {
  let child;
  let spawned = false;
  let adminFactoryCalls = 0;
  const lifecycle = createCoreLifecycle({
    fetchImpl: async () => {
      if (spawned) return okResponse();
      throw new Error("offline");
    },
    spawnImpl: (executable, args, options) => {
      spawned = true;
      child = new FakeChild({ pid: 7001 });
      assert.equal(executable, path.resolve("C:/trusted/node.exe"));
      assert.deepEqual(args, [
        path.resolve("C:/trusted/Selene/core/src/server.js"),
        OWNED_CORE_ADMIN_IPC_ARG,
      ]);
      assert.deepEqual(options.stdio, ["ignore", "ignore", "ignore", "pipe", "ipc"]);
      assert.equal(Object.hasOwn(options, "env"), false);
      assert.equal(JSON.stringify(args).includes("ERERER"), false);
      return child;
    },
    createCoreAdminChannel: ({ child: adminChild }) => {
      adminFactoryCalls += 1;
      assert.equal(adminChild, child);
      return {
        close() {},
        getStatus() {
          return { state: "ready", ready: true };
        },
      };
    },
    launchConfiguration: {
      executable: path.resolve("C:/trusted/node.exe"),
      args: [path.resolve("C:/trusted/Selene/core/src/server.js")],
      cwd: path.resolve("C:/trusted/Selene/core/src"),
    },
  });

  const started = await lifecycle.startOwnedCore({ enableAdminChannel: true });
  const snapshot = lifecycle.getOwnershipSnapshot();

  assert.equal(started.state, "reachable-with-owned-child");
  assert.equal(started.responderOwnership, "unverified");
  assert.equal(adminFactoryCalls, 1);
  assert.deepEqual(snapshot.adminChannel, { state: "ready", ready: true });
});

test("external Core does not receive an admin channel or capability", async () => {
  let spawnCalls = 0;
  let adminFactoryCalls = 0;
  const lifecycle = createCoreLifecycle({
    fetchImpl: async () => okResponse(),
    spawnImpl: () => {
      spawnCalls += 1;
      return new FakeChild();
    },
    createCoreAdminChannel: () => {
      adminFactoryCalls += 1;
      throw new Error("should not create admin channel");
    },
    launchConfiguration: {
      executable: path.resolve("C:/trusted/node.exe"),
      args: [path.resolve("C:/trusted/Selene/core/src/server.js")],
      cwd: path.resolve("C:/trusted/Selene/core/src"),
    },
  });

  const status = await lifecycle.startOwnedCore({ enableAdminChannel: true });

  assert.equal(status.state, "externally-managed");
  assert.equal(spawnCalls, 0);
  assert.equal(adminFactoryCalls, 0);
  assert.equal(lifecycle.getOwnershipSnapshot().adminChannel.state, "unavailable");
});

test("owned shutdown closes admin channel without changing responder ownership semantics", async () => {
  let child;
  let spawned = false;
  let adminClosed = false;
  const lifecycle = createCoreLifecycle({
    fetchImpl: async () => {
      if (spawned) return okResponse();
      throw new Error("offline");
    },
    spawnImpl: () => {
      spawned = true;
      child = new FakeChild({ pid: 7002 });
      return child;
    },
    createCoreAdminChannel: () => ({
      close() {
        adminClosed = true;
      },
      getStatus() {
        return { state: "ready", ready: true };
      },
    }),
    launchConfiguration: {
      executable: path.resolve("C:/trusted/node.exe"),
      args: [path.resolve("C:/trusted/Selene/core/src/server.js")],
      cwd: path.resolve("C:/trusted/Selene/core/src"),
    },
  });

  const started = await lifecycle.startOwnedCore({ enableAdminChannel: true });
  assert.equal(started.responderOwnership, "unverified");
  const stopped = await lifecycle.shutdownOwnedCore();

  assert.equal(stopped.state, "owned-stopped");
  assert.equal(adminClosed, true);
  assert.equal(child.killed, true);
});

test("rejects relative owned-launch paths", () => {
  assert.throws(
    () => resolveLaunchConfiguration({ nodeExecutable: "node.exe" }),
    /absolute path/,
  );
});
