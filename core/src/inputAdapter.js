import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveShortcut } from "./shortcuts.js";

const HOST_SCRIPT = fileURLToPath(new URL("./windowsInputHost.py", import.meta.url));
const DEFAULT_TIMEOUT_MS = 5000;

function parseHostOutput(stdout, fallback = {}) {
  try {
    return {
      ...fallback,
      ...JSON.parse(stdout || "{}"),
    };
  } catch {
    return {
      ok: false,
      malformedOutput: true,
      reason: "Windows input helper returned malformed output.",
    };
  }
}

function runInputHost(payload, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn("python.exe", [HOST_SCRIPT], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({
        ok: false,
        reason: "Windows input helper timed out.",
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: error.message });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const parsed = parseHostOutput(stdout, { ok: code === 0 });
      resolve({
        ...parsed,
        ok: parsed.ok === true && code === 0,
        code,
        reason: parsed.reason || (code === 0 ? "" : stderr.trim() || `Windows input helper exited with code ${code}.`),
      });
    });

    child.stdin.end(JSON.stringify(payload));
  });
}

export function createWindowsInputAdapter() {
  return {
    async activateWindow(targetWindow) {
      const target = String(targetWindow ?? "").trim();
      if (!target) {
        return { ok: false, reason: "No expected foreground window was provided." };
      }
      const numeric = Number(target);
      return runInputHost({
        mode: "activate",
        processId: Number.isInteger(numeric) ? numeric : undefined,
        title: Number.isInteger(numeric) ? undefined : target,
      });
    },

    async typeText(text, options = {}) {
      const literal = String(text ?? "");
      if (!literal) {
        return { ok: false, reason: "No text was provided." };
      }

      return runInputHost({
        mode: "type",
        text: literal,
        expectedProcessId: options.expectedProcessId,
        expectedWindowTitle: options.expectedWindowTitle,
      });
    },

    async keyboardShortcut(shortcut, options = {}) {
      const resolved = resolveShortcut(shortcut);
      if (!resolved) {
        return { ok: false, unsupportedShortcut: true, reason: "Unsupported keyboard shortcut." };
      }

      const sent = await runInputHost({
        mode: "shortcut",
        shortcut: resolved.id,
        expectedProcessId: options.expectedProcessId,
        expectedWindowTitle: options.expectedWindowTitle,
      });
      return {
        ...sent,
        shortcut: resolved.id,
        label: resolved.label,
      };
    },
  };
}

export const windowsInputAdapter = createWindowsInputAdapter();
