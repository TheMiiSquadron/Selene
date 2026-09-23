const path = require("node:path");
const { spawn: defaultSpawn } = require("node:child_process");
const { createCoreAdminChannel: defaultCreateCoreAdminChannel } = require("./coreAdminChannel.cjs");

const DEFAULT_STARTUP_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_CLEANUP_TIMEOUT_MS = 2000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2000;
const OWNED_CORE_ADMIN_IPC_ARG = "--selene-owned-core-admin-ipc";

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function sanitizeMessage(error) {
  const message = String(error?.message ?? error ?? "").trim();
  return message || "Unknown error.";
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function buildStatus({
  state,
  reachable = false,
  owned = false,
  pid = null,
  message,
  details = {},
}) {
  return Object.freeze({
    state,
    reachable,
    owned,
    pid,
    message,
    ...details,
  });
}

function validateAbsolutePath(value, label) {
  const text = String(value ?? "");
  if (!path.isAbsolute(text)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return path.resolve(text);
}

function resolveLaunchConfiguration({
  repositoryRoot = path.resolve(__dirname, "..", ".."),
  nodeExecutable = null,
  coreScript = null,
} = {}) {
  if (!nodeExecutable) return null;

  const executable = validateAbsolutePath(nodeExecutable, "Core executable");
  const script = validateAbsolutePath(
    coreScript ?? path.join(repositoryRoot, "core", "src", "server.js"),
    "Core server script",
  );

  return Object.freeze({
    executable,
    args: Object.freeze([script]),
    cwd: path.dirname(script),
  });
}

function createCoreLifecycle({
  coreBaseUrl = "http://127.0.0.1:3030",
  fetchImpl = globalThis.fetch,
  spawnImpl = defaultSpawn,
  createCoreAdminChannel = defaultCreateCoreAdminChannel,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
  shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  launchConfiguration = resolveLaunchConfiguration(),
} = {}) {
  let ownedChild = null;
  let ownedChildStopping = false;
  let lastFailure = null;
  let lastExit = null;
  let startInProgress = null;
  let shutdownInProgress = null;
  let adminChannel = null;

  function hasOwnedChild() {
    return Boolean(ownedChild && ownedChild.exitCode === null && ownedChild.signalCode === null);
  }

  function attachChildLifecycle(child, sourceOperation = "runtime") {
    child.once("exit", (code, signal) => {
      lastExit = { code, signal };
      adminChannel?.close?.();
      adminChannel = null;
      ownedChildStopping = false;
      if (ownedChild === child) {
        ownedChild = null;
      }
    });

    child.once("error", (error) => {
      adminChannel?.close?.();
      adminChannel = null;
      lastFailure = {
        operation: sourceOperation,
        reason: sanitizeMessage(error),
      };
      ownedChildStopping = false;
      if (ownedChild === child) {
        ownedChild = null;
      }
    });
  }

  function describeReachable({ externallyManaged = false } = {}) {
    const childRunning = hasOwnedChild();
    const responderOwnership = childRunning ? "unverified" : "external";
    let state = "externally-managed";
    let message = "Selene Core is reachable and externally managed.";

    if (childRunning && externallyManaged) {
      state = "reachable-with-owned-child";
      message = "Selene Core is reachable, but the HTTP responder is not verified as Pebble's owned child.";
    }

    return buildStatus({
      state,
      reachable: true,
      owned: childRunning,
      pid: childRunning ? ownedChild.pid : null,
      message,
      details: {
        responderOwnership,
      },
    });
  }

  function waitForChildExit(child, timeoutMs, timeoutState) {
    return new Promise((resolve) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) {
        resolve(buildStatus({
          state: "owned-stopped",
          message: "Pebble-owned Core process already stopped.",
          details: { lastExit },
        }));
        return;
      }

      let settled = false;
      let timer;
      const finish = (status) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(status);
      };

      child.once("exit", (code, signal) => {
        lastExit = { code, signal };
        ownedChildStopping = false;
        if (ownedChild === child) {
          ownedChild = null;
        }
        finish(buildStatus({
          state: "owned-stopped",
          message: "Pebble-owned Core process stopped.",
          details: { lastExit },
        }));
      });

      timer = setTimeout(() => {
        lastFailure = {
          operation: timeoutState,
          reason: "OWNED_CORE_EXIT_TIMEOUT",
        };
        finish(buildStatus({
          state: timeoutState,
          owned: true,
          pid: child.pid,
          message: "Pebble-owned Core process did not exit before the timeout.",
          details: { failure: lastFailure },
        }));
      }, timeoutMs);
    });
  }

  async function requestOwnedChildStop(child, {
    operation,
    timeoutMs,
    timeoutState,
  }) {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      ownedChildStopping = false;
      if (ownedChild === child) ownedChild = null;
      return buildStatus({
        state: "owned-stopped",
        message: "Pebble-owned Core process already stopped.",
        details: { lastExit },
      });
    }

    ownedChildStopping = true;
    try {
      const signaled = child.kill();
      if (signaled === false) {
        lastFailure = {
          operation,
          reason: "KILL_RETURNED_FALSE",
        };
        return buildStatus({
          state: `${operation}-failed`,
          owned: true,
          pid: child.pid,
          message: "Pebble-owned Core process did not accept the stop signal.",
          details: { failure: lastFailure },
        });
      }
    } catch (error) {
      lastFailure = {
        operation,
        reason: sanitizeMessage(error),
      };
      return buildStatus({
        state: `${operation}-failed`,
        owned: true,
        pid: child.pid,
        message: "Pebble-owned Core process could not be signaled to stop.",
        details: { failure: lastFailure },
      });
    }

    return waitForChildExit(child, timeoutMs, timeoutState);
  }

  async function checkAvailability() {
    if (typeof fetchImpl !== "function") {
      return buildStatus({
        state: "unavailable",
        message: "Core availability cannot be checked because fetch is unavailable.",
        details: { reason: "FETCH_UNAVAILABLE" },
      });
    }

    try {
      const response = await fetchImpl(`${coreBaseUrl}/status`, {
        method: "GET",
      });
      if (!response?.ok) {
        return buildStatus({
          state: "unavailable",
          message: `Core returned HTTP ${response?.status ?? "unknown"}.`,
          details: { httpStatus: response?.status ?? null },
        });
      }

      return describeReachable({ externallyManaged: hasOwnedChild() });
    } catch (error) {
      if (hasOwnedChild()) {
        return buildStatus({
          state: ownedChildStopping ? "owned-stopping" : "owned-starting",
          owned: true,
          pid: ownedChild.pid,
          message: ownedChildStopping
            ? "Pebble-owned Core process is stopping and is not reachable."
            : "Pebble-owned Core process exists, but Core is not reachable yet.",
          details: { reason: sanitizeMessage(error) },
        });
      }

      return buildStatus({
        state: lastExit ? "owned-exited" : "unavailable",
        message: lastExit
          ? "Selene Core launched by Pebble exited."
          : "Selene Core is unavailable.",
        details: lastExit ? { lastExit } : { reason: sanitizeMessage(error) },
      });
    }
  }

  async function waitUntilReachable(deadlineMs) {
    while (Date.now() < deadlineMs) {
      const status = await checkAvailability();
      if (status.reachable) return status;
      if (!hasOwnedChild()) break;
      await delay(pollIntervalMs);
    }
    return checkAvailability();
  }

  async function startOwnedCore() {
    const options = isPlainObject(arguments[0]) ? arguments[0] : {};
    const enableAdminChannel = options.enableAdminChannel === true;
    if (startInProgress) return startInProgress;

    startInProgress = (async () => {
      if (hasOwnedChild() || ownedChildStopping) {
        return buildStatus({
          state: ownedChildStopping ? "owned-stopping" : "owned-starting",
          owned: true,
          pid: ownedChild?.pid ?? null,
          message: ownedChildStopping
            ? "Pebble-owned Core process is still stopping."
            : "Pebble already has an owned Core process.",
        });
      }

    const current = await checkAvailability();
    if (current.reachable) return current;

    if (!launchConfiguration) {
      lastFailure = {
        operation: "startup",
        reason: "OWNED_LAUNCH_UNCONFIGURED",
      };
      return buildStatus({
        state: "startup-failed",
        message: "Owned Core launch is not configured.",
        details: { failure: lastFailure },
      });
    }

    try {
      const args = enableAdminChannel
        ? [...launchConfiguration.args, OWNED_CORE_ADMIN_IPC_ARG]
        : launchConfiguration.args;
      const child = spawnImpl(
        launchConfiguration.executable,
        args,
        {
          cwd: launchConfiguration.cwd,
          shell: false,
          stdio: enableAdminChannel
            ? ["ignore", "ignore", "ignore", "pipe", "ipc"]
            : "ignore",
          windowsHide: true,
        },
      );

      ownedChild = child;
      ownedChildStopping = false;
      lastExit = null;
      lastFailure = null;
      attachChildLifecycle(child, "startup");
      if (enableAdminChannel) {
        adminChannel = createCoreAdminChannel({ child });
      }

      const reachable = await waitUntilReachable(Date.now() + startupTimeoutMs);
      if (reachable.reachable) return describeReachable({ externallyManaged: true });

      lastFailure = {
        operation: "startup",
        reason: "CORE_NOT_REACHABLE_AFTER_LAUNCH",
      };
      const cleanup = await requestOwnedChildStop(child, {
        operation: "startup-cleanup",
        timeoutMs: cleanupTimeoutMs,
        timeoutState: "startup-cleanup-timeout",
      });
      return buildStatus({
        state: "startup-failed",
        owned: hasOwnedChild(),
        pid: hasOwnedChild() ? ownedChild.pid : null,
        message: "Owned Core launch did not become reachable.",
        details: { failure: lastFailure, cleanup },
      });
    } catch (error) {
      ownedChild = null;
      ownedChildStopping = false;
      lastFailure = {
        operation: "startup",
        reason: sanitizeMessage(error),
      };
      return buildStatus({
        state: "startup-failed",
        message: "Owned Core launch failed.",
        details: { failure: lastFailure },
      });
    }
    })();

    try {
      return await startInProgress;
    } finally {
      startInProgress = null;
    }
  }

  async function shutdownOwnedCore() {
    if (shutdownInProgress) return shutdownInProgress;

    shutdownInProgress = (async () => {
    if (!hasOwnedChild()) {
      return buildStatus({
        state: "no-owned-core",
        message: "No Pebble-owned Core process is running.",
      });
    }

    const child = ownedChild;
    adminChannel?.close?.();
    adminChannel = null;
    return requestOwnedChildStop(child, {
      operation: "shutdown",
      timeoutMs: shutdownTimeoutMs,
      timeoutState: "shutdown-timeout",
    });
    })();

    try {
      return await shutdownInProgress;
    } finally {
      shutdownInProgress = null;
    }
  }

  function getOwnershipSnapshot() {
    return buildStatus({
      state: hasOwnedChild() ? "owned" : "not-owned",
      owned: hasOwnedChild(),
      pid: hasOwnedChild() ? ownedChild.pid : null,
      message: hasOwnedChild()
        ? "Pebble owns a Core process."
        : "Pebble does not own a Core process.",
      details: {
        stopping: ownedChildStopping,
        lastFailure,
        lastExit,
        adminChannel: adminChannel?.getStatus?.() ?? {
          state: "unavailable",
          ready: false,
        },
      },
    });
  }

  function getAdminChannelStatus() {
    return adminChannel?.getStatus?.() ?? {
      state: "unavailable",
      ready: false,
    };
  }

  function ensureReadyAdminChannel() {
    const status = getAdminChannelStatus();
    if (status.ready !== true || !adminChannel) {
      const error = new Error("Pebble-owned Core admin channel is not ready.");
      error.code = "ADMIN_CHANNEL_UNAVAILABLE";
      error.adminChannel = status;
      throw error;
    }
    return adminChannel;
  }

  async function getPairingStatus() {
    const result = await ensureReadyAdminChannel().getPairingStatus();
    return result.payload;
  }

  async function startPairing() {
    const result = await ensureReadyAdminChannel().startPairing();
    return result.payload;
  }

  async function cancelPairing() {
    const result = await ensureReadyAdminChannel().cancelPairing();
    return result.payload;
  }

  return Object.freeze({
    checkAvailability,
    startOwnedCore,
    shutdownOwnedCore,
    getOwnershipSnapshot,
    getAdminChannelStatus,
    getPairingStatus,
    startPairing,
    cancelPairing,
  });
}

module.exports = {
  OWNED_CORE_ADMIN_IPC_ARG,
  createCoreLifecycle,
  resolveLaunchConfiguration,
};
