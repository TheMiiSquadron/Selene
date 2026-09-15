import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOST_SCRIPT = fileURLToPath(new URL("./awarenessHost.py", import.meta.url));
export const AWARENESS_POLL_MS = 1500;
const ALLOWED_POLICIES = new Set(["allow", "ask", "deny"]);
const SELENE_WINDOW_TITLES = new Set([
  "Selene Panel",
  "Selene Command Panel",
  "Selene Pebble",
  "Selene Setup",
]);

function normalizePolicy(value) {
  const policy = String(value ?? "").trim().toLowerCase();
  return ALLOWED_POLICIES.has(policy) ? policy : "deny";
}

function normalizeForeground(value, observedAt) {
  if (!value || typeof value !== "object" || value.ok === false) return null;

  return {
    process: String(value.process ?? "").trim(),
    title: String(value.title ?? "").trim(),
    observedAt,
  };
}

function sameForeground(a, b) {
  return Boolean(a && b) && a.process === b.process && a.title === b.title;
}

export function isSeleneOwnedForeground(value) {
  const title = String(value?.title ?? "").trim();
  return SELENE_WINDOW_TITLES.has(title);
}

export function readWindowsForeground() {
  return new Promise((resolve) => {
    const child = spawn("python", [HOST_SCRIPT], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.on("error", (error) => {
      resolve({ ok: false, message: error.message });
    });

    child.on("close", () => {
      try {
        resolve(JSON.parse(stdout || "{}"));
      } catch {
        resolve({ ok: false, message: "Foreground observer returned invalid data." });
      }
    });
  });
}

export function createAwarenessService({
  readForeground = readWindowsForeground,
  now = () => new Date(),
  pollMs = AWARENESS_POLL_MS,
} = {}) {
  let policy = "deny";
  let currentForeground = null;
  let lastExternalForeground = null;
  let lastChange = null;
  let lastError = null;
  let timer = null;
  let pollInFlight = false;

  function enabled() {
    return policy === "allow";
  }

  function clearForeground() {
    currentForeground = null;
    lastExternalForeground = null;
    lastChange = null;
    lastError = null;
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    clearForeground();
  }

  async function pollOnce() {
    if (!enabled()) {
      clearForeground();
      return getState();
    }

    if (pollInFlight) {
      return getState();
    }

    pollInFlight = true;
    try {
      const observedAt = now().toISOString();
      const nextForeground = normalizeForeground(await readForeground(), observedAt);

      if (!nextForeground) {
        lastError = {
          message: "Foreground information is unavailable.",
          observedAt,
        };
        currentForeground = null;
        lastChange = null;
        return getState();
      }

      lastError = null;

      if (!sameForeground(currentForeground, nextForeground)) {
        currentForeground = nextForeground;
        lastChange = {
          event: "foreground_changed",
          process: nextForeground.process,
          title: nextForeground.title,
          timestamp: observedAt,
        };
      } else {
        currentForeground = nextForeground;
      }

      if (!isSeleneOwnedForeground(nextForeground)) {
        lastExternalForeground = nextForeground;
      }

      return getState();
    } finally {
      pollInFlight = false;
    }
  }

  function start() {
    if (!enabled() || timer) return;

    void pollOnce();
    timer = setInterval(() => {
      void pollOnce();
    }, pollMs);
  }

  function configure({ activeWindowName, startPolling = true } = {}) {
    policy = normalizePolicy(activeWindowName);

    if (enabled()) {
      if (startPolling) {
        start();
      }
    } else {
      stop();
    }

    return getState();
  }

  function getState() {
    if (!enabled()) {
      return {
        ok: true,
        enabled: false,
        policy,
        foreground: null,
        currentForeground: null,
        lastExternalForeground: null,
        lastChange: null,
        message: "Active Window awareness is disabled.",
      };
    }

    const foreground = isSeleneOwnedForeground(currentForeground) && lastExternalForeground
      ? lastExternalForeground
      : currentForeground;

    return {
      ok: true,
      enabled: true,
      policy,
      foreground,
      currentForeground,
      lastExternalForeground,
      lastChange,
      lastError,
      pollMs,
    };
  }

  return {
    configure,
    getState,
    pollOnce,
    start,
    stop,
  };
}

export const awarenessService = createAwarenessService();
