import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  loadModelProfiles,
  normalizeModelRole,
  ModelProfileError,
} from "./modelProfiles.js";

const execFileAsync = promisify(execFile);
const DEFAULT_LOAD_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

function msSince(startNs) {
  return Number(process.hrtime.bigint() - startNs) / 1_000_000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ModelManagerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ModelManagerError";
    this.details = details;
  }
}

export function parseLmsPs(output = "") {
  const lines = String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const headerIndex = lines.findIndex((line) =>
    line.startsWith("IDENTIFIER") && line.includes("MODEL"),
  );

  if (headerIndex < 0) return [];

  return lines.slice(headerIndex + 1)
    .map((line) => {
      const columns = line.split(/\s{2,}/).map((column) => column.trim());
      if (columns.length < 3) return null;

      return {
        identifier: columns[0] ?? "",
        modelKey: columns[1] ?? "",
        status: columns[2] ?? "",
        size: columns[3] ?? "",
        context: columns[4] ? Number.parseInt(columns[4], 10) : null,
        parallel: columns[5] ? Number.parseInt(columns[5], 10) : null,
        device: columns[6] ?? "",
        ttl: columns[7] ?? "",
      };
    })
    .filter(Boolean);
}

async function defaultRunLms(args, { timeoutMs = DEFAULT_LOAD_TIMEOUT_MS } = {}) {
  try {
    const result = await execFileAsync("lms", args, {
      timeout: timeoutMs,
      windowsHide: true,
    });

    return {
      ok: true,
      status: 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } catch (error) {
    return {
      ok: false,
      status: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message,
      error: error.message,
    };
  }
}

function roleConfig(profiles, role) {
  const normalizedRole = normalizeModelRole(role);
  const profile = profiles?.roles?.[normalizedRole];
  if (!profile) {
    throw new ModelProfileError(`Unknown model role: ${normalizedRole}.`);
  }

  const residency = profile.residency ?? {};
  const modelKey = String(residency.modelKey || profile.model || "").trim();
  const apiId = String(residency.apiId || profile.apiId || modelKey).trim();

  if (!modelKey || !apiId) {
    throw new ModelProfileError(`Model role "${normalizedRole}" does not have residency configuration.`);
  }

  return {
    role: normalizedRole,
    modelKey,
    apiId,
    gpu: String(residency.gpu || "max").trim(),
    contextLength: residency.contextLength ?? 16384,
    loadTimeoutMs: residency.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS,
    pollIntervalMs: residency.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  };
}

function roleForResident(resident, profiles) {
  for (const role of Object.keys(profiles?.roles ?? {})) {
    const profile = profiles.roles[role];
    const residency = profile.residency ?? {};
    const modelKey = String(residency.modelKey || profile.model || "").trim();
    const apiId = String(residency.apiId || profile.apiId || modelKey).trim();
    if (resident.identifier === apiId || resident.modelKey === modelKey) return role;
  }

  return "";
}

function activeResidentFor(config, residents) {
  return residents.find((resident) =>
    resident.identifier === config.apiId || resident.modelKey === config.modelKey,
  ) ?? null;
}

function summarizeState(residents, profiles) {
  const active = residents[0] ?? null;
  return {
    loaded: residents.length > 0,
    residents: residents.map((resident) => ({
      ...resident,
      role: roleForResident(resident, profiles),
    })),
    activeRole: active ? roleForResident(active, profiles) : "",
    activeIdentifier: active?.identifier ?? "",
    activeModelKey: active?.modelKey ?? "",
  };
}

export function createModelManager({
  loadProfiles = loadModelProfiles,
  runLms = defaultRunLms,
  sleepFn = sleep,
  now = () => process.hrtime.bigint(),
} = {}) {
  let queue = Promise.resolve();

  async function runLmsChecked(args, options, failureMessage) {
    const result = await runLms(args, options);
    if (!result.ok) {
      throw new ModelManagerError(failureMessage, {
        command: ["lms", ...args],
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }

    return result;
  }

  async function readResidents(profiles) {
    const start = now();
    const result = await runLms(["ps"], { timeoutMs: 10_000 });
    const residencyCheckMs = msSince(start);

    if (!result.ok) {
      throw new ModelManagerError("Unable to inspect LM Studio model residency with lms ps.", {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        residencyCheckMs,
      });
    }

    return {
      residents: parseLmsPs(result.stdout),
      residencyCheckMs,
      state: summarizeState(parseLmsPs(result.stdout), profiles),
    };
  }

  async function getResidencyState() {
    const profiles = await loadProfiles();
    const { state, residencyCheckMs } = await readResidents(profiles);
    return { ...state, residencyCheckMs };
  }

  async function waitForResident(config) {
    const started = now();
    let lastState = null;

    while (msSince(started) <= config.loadTimeoutMs) {
      const profiles = await loadProfiles();
      const { residents, state } = await readResidents(profiles);
      lastState = state;

      if (activeResidentFor(config, residents)) {
        return state;
      }

      await sleepFn(config.pollIntervalMs);
    }

    throw new ModelManagerError(`Timed out waiting for model role "${config.role}" to become resident.`, {
      requestedRole: config.role,
      expectedIdentifier: config.apiId,
      expectedModelKey: config.modelKey,
      timeoutMs: config.loadTimeoutMs,
      residencyState: lastState,
    });
  }

  async function ensureRoleReadyUnlocked(role) {
    const profiles = await loadProfiles();
    const config = roleConfig(profiles, role);
    const before = await readResidents(profiles);
    const residentBefore = activeResidentFor(config, before.residents);

    const metadata = {
      requestedRole: config.role,
      residentRoleBefore: before.state.activeRole,
      residentIdentifierBefore: before.state.activeIdentifier,
      modelAlreadyLoaded: Boolean(residentBefore),
      modelLoadMs: 0,
      modelUnloadMs: 0,
      modelSwitchMs: 0,
      residencyCheckMs: before.residencyCheckMs,
      residencyState: before.state,
      profile: config,
    };

    if (residentBefore) {
      metadata.residentRoleAfter = before.state.activeRole;
      metadata.residentIdentifierAfter = before.state.activeIdentifier;
      return metadata;
    }

    const switchStart = now();

    if (before.residents.length) {
      const unloadStart = now();
      await runLmsChecked(["unload", "--all"], {}, "Unable to unload the currently resident LM Studio model.");
      metadata.modelUnloadMs = msSince(unloadStart);
    }

    const loadStart = now();
    await runLmsChecked([
      "load",
      config.modelKey,
      "--identifier",
      config.apiId,
      "--gpu",
      config.gpu,
      "--context-length",
      String(config.contextLength),
      "--yes",
    ], { timeoutMs: config.loadTimeoutMs }, `Unable to load model role "${config.role}".`);
    metadata.modelLoadMs = msSince(loadStart);

    const afterState = await waitForResident(config);
    metadata.modelSwitchMs = msSince(switchStart);
    metadata.residentRoleAfter = afterState.activeRole;
    metadata.residentIdentifierAfter = afterState.activeIdentifier;
    metadata.residencyState = afterState;

    return metadata;
  }

  async function restoreFastUnlocked() {
    const restoreStart = now();
    const metadata = await ensureRoleReadyUnlocked("fast");
    return {
      restoreFastMs: msSince(restoreStart),
      recoverySucceeded: true,
      residentRoleAfter: metadata.residentRoleAfter,
      residentIdentifierAfter: metadata.residentIdentifierAfter,
      residencyState: metadata.residencyState,
      restoreMetadata: metadata,
    };
  }

  async function runExclusive(fn) {
    const queuedAt = now();
    const previous = queue;
    let release;
    queue = new Promise((resolve) => {
      release = resolve;
    });

    await previous.catch(() => {});
    const queueWaitMs = msSince(queuedAt);

    try {
      return await fn(queueWaitMs);
    } finally {
      release();
    }
  }

  async function runWithRoleReady(role, fn) {
    return runExclusive(async (queueWaitMs) => {
      const ready = await ensureRoleReadyUnlocked(role);
      ready.queueWaitMs = queueWaitMs;
      let result;
      let restore = {
        restoreFastMs: 0,
        recoveryAttempted: false,
        recoverySucceeded: null,
      };

      try {
        result = await fn({
          profile: ready.profile,
          residency: ready,
        });
      } catch (error) {
        if (ready.requestedRole === "primary") {
          restore.recoveryAttempted = true;
          try {
            restore = {
              ...restore,
              ...await restoreFastUnlocked(),
            };
          } catch (restoreError) {
            restore.recoverySucceeded = false;
            restore.modelManagerError = restoreError.message;
          }
        }

        error.seleneResidency = {
          ...ready,
          ...restore,
        };
        throw error;
      }

      if (ready.requestedRole === "primary") {
        restore.recoveryAttempted = true;
        try {
          restore = {
            ...restore,
            ...await restoreFastUnlocked(),
          };
        } catch (error) {
          throw new ModelManagerError("Primary generation completed, but restoring the fast model failed.", {
            ...ready,
            ...restore,
            recoverySucceeded: false,
            modelManagerError: error.message,
          });
        }
      }

      return {
        result,
        residency: {
          ...ready,
          ...restore,
        },
      };
    });
  }

  async function ensureRoleReady(role) {
    return runExclusive(async (queueWaitMs) => ({
      ...await ensureRoleReadyUnlocked(role),
      queueWaitMs,
    }));
  }

  return {
    ensureRoleReady,
    getResidencyState,
    runWithRoleReady,
  };
}

export const modelManager = createModelManager();
