import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runModelRoleTest,
  runNovaCommand,
} from "./commandPipeline.js";
import {
  applyApplicationPermissionPatch,
  listApplicationsForDiagnostics,
  listApplicationsForSetup,
  loadApplicationPermissions,
  loadApps,
  saveApplicationPermissions,
} from "./apps.js";
import { getModelStatus } from "./lmStudio.js";
import {
  elevateAuthority,
  getAuthorityState,
  resetAuthority,
  setDefaultAuthority,
} from "./authority.js";
import {
  deleteMemoryEntry,
  readMemory,
  setMemoryEntry,
  MemoryValidationError,
} from "./memory.js";
import {
  ModelProfileError,
  normalizeModelRole,
} from "./modelProfiles.js";
import { ModelManagerError } from "./modelManager.js";
import {
  notificationService,
  NotificationValidationError,
} from "./notifications.js";
import { awarenessService } from "./awareness.js";
import { startCompanionServer } from "./companionServer.js";
import { createGatewayCredentialStore } from "./gatewayCredentialStore.js";
import { createLocalPairingAdministration } from "./pairingAdministration.js";

const HOST = "127.0.0.1";
const PORT = 3030;
const MAX_BODY_BYTES = 16 * 1024;
const PACKAGE_URL = new URL("../package.json", import.meta.url);

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.setEncoding("utf-8");

    request.on("data", (chunk) => {
      body += chunk;

      if (Buffer.byteLength(body, "utf-8") > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });

    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });

    request.on("error", reject);
  });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function getCoreVersion() {
  try {
    const pkg = JSON.parse(await readFile(PACKAGE_URL, "utf-8"));
    return String(pkg.version ?? "unknown");
  } catch {
    return "unknown";
  }
}

async function handleStatus(_request, response) {
  const [coreVersion, modelStatus] = await Promise.all([
    getCoreVersion(),
    getModelStatus(),
  ]);

  sendJson(response, 200, {
    ok: true,
    coreVersion,
    lmStudio: modelStatus.reachable,
    model: modelStatus.model,
    activeModel: modelStatus.model,
    models: modelStatus.models,
    modelSelectionEnabled: false,
    port: PORT,
  });
}

async function handleApplications(_request, response) {
  try {
    const [apps, permissions] = await Promise.all([
      loadApps(),
      loadApplicationPermissions(),
    ]);

    sendJson(response, 200, {
      ok: true,
      applications: await listApplicationsForSetup(apps, permissions),
    });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      message: error.message,
    });
  }
}

async function handleApplicationPermissions(request, response) {
  let payload;

  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { ok: false, message: error.message });
    return;
  }

  if (!isPlainObject(payload) || !isPlainObject(payload.applications)) {
    sendJson(response, 400, {
      ok: false,
      message: 'Expected JSON body with "applications" object.',
    });
    return;
  }

  const invalid = Object.entries(payload.applications)
    .filter(([, enabled]) => typeof enabled !== "boolean")
    .map(([name]) => name);

  if (invalid.length) {
    sendJson(response, 400, {
      ok: false,
      message: `Application permissions must be boolean values: ${invalid.join(", ")}.`,
    });
    return;
  }

  try {
    const [apps, currentPermissions] = await Promise.all([
      loadApps(),
      loadApplicationPermissions(),
    ]);
    const { permissions, unknown } = applyApplicationPermissionPatch(
      apps,
      currentPermissions,
      payload.applications,
    );

    if (unknown.length) {
      sendJson(response, 400, {
        ok: false,
        message: `Unknown application(s): ${unknown.join(", ")}.`,
      });
      return;
    }

    const saved = await saveApplicationPermissions(permissions);
    sendJson(response, 200, {
      ok: true,
      applications: await listApplicationsForSetup(apps, saved),
    });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      message: error.message,
    });
  }
}

async function handleAuthorityDefault(request, response) {
  let payload;

  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { ok: false, message: error.message });
    return;
  }

  const level = Number(payload?.level);
  if (!Number.isInteger(level) || level < 1 || level > 10) {
    sendJson(response, 400, { ok: false, message: "Expected level integer from 1 to 10." });
    return;
  }

  const config = await setDefaultAuthority(level);
  sendJson(response, 200, {
    ok: true,
    defaultLevel: config.defaultLevel,
    currentLevel: config.currentLevel,
  });
}

async function handleAuthorityElevate(request, response) {
  let payload;

  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { ok: false, message: error.message });
    return;
  }

  if (!isPlainObject(payload)) {
    sendJson(response, 400, { ok: false, message: "Expected JSON object." });
    return;
  }

  const level = Number(payload.level);
  if (!Number.isInteger(level) || level < 1 || level > 10) {
    sendJson(response, 400, { ok: false, message: "Expected level integer from 1 to 10." });
    return;
  }

  const type = String(payload.type ?? "").trim().toLowerCase();
  const oneAction = Boolean(payload.oneAction) || ["one_action", "one-action", "oneaction"].includes(type);

  try {
    const config = await elevateAuthority({
      level,
      minutes: payload.minutes,
      oneAction,
    });

    sendJson(response, 200, {
      ok: true,
      defaultLevel: config.defaultLevel,
      currentLevel: config.currentLevel,
      temporaryElevation: config.temporaryElevation,
      oneActionElevation: config.oneActionElevation
        ? {
            level: config.oneActionElevation.level,
            token: config.oneActionElevation.token,
            createdAt: config.oneActionElevation.createdAt,
          }
        : null,
    });
  } catch (error) {
    sendJson(response, 400, { ok: false, message: error.message });
  }
}

async function handleAuthorityReset(_request, response) {
  const config = await resetAuthority();
  sendJson(response, 200, {
    ok: true,
    defaultLevel: config.defaultLevel,
    currentLevel: config.currentLevel,
    temporaryElevation: config.temporaryElevation,
    oneActionElevation: null,
  });
}

async function handleCommand(request, response) {
  let payload;

  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { ok: false, message: error.message });
    return;
  }

  const text = String(payload?.text ?? "").trim();

  if (!text) {
    sendJson(response, 400, { ok: false, message: 'Expected JSON body with non-empty "text".' });
    return;
  }

  try {
    const result = await runNovaCommand(text, {
      authorityToken: typeof payload?.authorityToken === "string" ? payload.authorityToken : "",
    });
    sendJson(response, result.ok ? 200 : 400, {
      ...result,
      ok: result.ok,
      message: result.message,
    });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      message: error.message,
    });
  }
}

async function handleDebugModelTest(request, response, {
  modelRoleTester = runModelRoleTest,
} = {}) {
  let payload;

  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { ok: false, message: error.message });
    return;
  }

  const text = String(payload?.text ?? "").trim();
  if (!text) {
    sendJson(response, 400, { ok: false, message: 'Expected JSON body with non-empty "text".' });
    return;
  }

  let role;
  try {
    role = normalizeModelRole(payload?.role);
  } catch (error) {
    sendJson(response, 400, { ok: false, message: error.message });
    return;
  }

  if (!role) {
    sendJson(response, 400, { ok: false, message: 'Expected "role" to be one of: fast, primary, specialized.' });
    return;
  }

  try {
    const result = await modelRoleTester(text, role, {
      benchmarkEquivalent: payload?.benchmarkEquivalent === true,
    });
    sendJson(response, 200, result);
  } catch (error) {
    const status = error instanceof ModelProfileError ? 400 : 503;
    sendJson(response, status, {
      ok: false,
      message: error.message,
      ...(error instanceof ModelManagerError
        ? { debug: error.details }
        : {}),
      ...(error.seleneResidency
        ? { debug: error.seleneResidency }
        : {}),
    });
  }
}

async function handleMemoryRead(request, response) {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  const category = url.searchParams.get("category") ?? "";
  const key = url.searchParams.get("key") ?? "";

  try {
    sendJson(response, 200, {
      ok: true,
      category: category || null,
      key: key || null,
      memory: await readMemory(category, key),
    });
  } catch (error) {
    const status = error instanceof MemoryValidationError ? 400 : 500;
    sendJson(response, status, { ok: false, message: error.message });
  }
}

async function handleMemorySet(request, response) {
  let payload;

  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { ok: false, message: error.message });
    return;
  }

  if (!isPlainObject(payload)) {
    sendJson(response, 400, { ok: false, message: "Expected JSON object." });
    return;
  }

  try {
    const result = await setMemoryEntry(payload.category, payload.key, payload.value);
    sendJson(response, 200, {
      ok: true,
      category: result.category,
      key: result.key,
      value: result.value,
    });
  } catch (error) {
    const status = error instanceof MemoryValidationError ? 400 : 500;
    sendJson(response, status, { ok: false, message: error.message });
  }
}

async function handleMemoryDelete(request, response) {
  let payload;

  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { ok: false, message: error.message });
    return;
  }

  if (!isPlainObject(payload)) {
    sendJson(response, 400, { ok: false, message: "Expected JSON object." });
    return;
  }

  try {
    const result = await deleteMemoryEntry(payload.category, payload.key);
    sendJson(response, 200, {
      ok: true,
      category: result.category,
      key: result.key,
      deleted: result.deleted,
    });
  } catch (error) {
    const status = error instanceof MemoryValidationError ? 400 : 500;
    sendJson(response, status, { ok: false, message: error.message });
  }
}

async function handleCreateNotification(request, response) {
  let payload;

  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { ok: false, message: error.message });
    return;
  }

  if (!isPlainObject(payload)) {
    sendJson(response, 400, { ok: false, message: "Expected JSON object." });
    return;
  }

  try {
    const notification = notificationService.createProactiveNotification(payload.message);
    sendJson(response, 201, {
      ok: true,
      notification,
    });
  } catch (error) {
    const status = error instanceof NotificationValidationError ? 400 : 500;
    sendJson(response, status, { ok: false, message: error.message });
  }
}

async function handleAcknowledgeNotification(_request, response, id) {
  try {
    const result = notificationService.acknowledgeNotification(id);
    sendJson(response, result.ok ? 200 : 404, result);
  } catch (error) {
    const status = error instanceof NotificationValidationError ? 400 : 500;
    sendJson(response, status, { ok: false, message: error.message });
  }
}

async function handleAwarenessConfig(request, response) {
  let payload;

  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { ok: false, message: error.message });
    return;
  }

  if (!isPlainObject(payload)) {
    sendJson(response, 400, { ok: false, message: "Expected JSON object." });
    return;
  }

  sendJson(response, 200, awarenessService.configure({
    activeWindowName: payload.activeWindowName,
  }));
}

export function createCoreServer({
  host = HOST,
  port = PORT,
  modelRoleTester = runModelRoleTest,
} = {}) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);

    if (request.method === "POST" && url.pathname === "/command") {
      await handleCommand(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/debug/model-test") {
      await handleDebugModelTest(request, response, { modelRoleTester });
      return;
    }

    if (request.method === "GET" && url.pathname === "/memory") {
      await handleMemoryRead(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/memory") {
      await handleMemorySet(request, response);
      return;
    }

    if (request.method === "DELETE" && url.pathname === "/memory") {
      await handleMemoryDelete(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/notifications") {
      await handleCreateNotification(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/notifications") {
      sendJson(response, 200, {
        ok: true,
        notifications: notificationService.getPendingNotifications(),
      });
      return;
    }

    const notificationAckMatch = url.pathname.match(/^\/notifications\/([^/]+)\/acknowledge$/);
    if (request.method === "POST" && notificationAckMatch) {
      await handleAcknowledgeNotification(request, response, decodeURIComponent(notificationAckMatch[1]));
      return;
    }

    if (request.method === "GET" && url.pathname === "/awareness") {
      sendJson(response, 200, awarenessService.getState());
      return;
    }

    if (request.method === "POST" && url.pathname === "/awareness/config") {
      await handleAwarenessConfig(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/status") {
      await handleStatus(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/applications") {
      await handleApplications(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/debug/applications") {
      const [apps, permissions] = await Promise.all([
        loadApps(),
        loadApplicationPermissions(),
      ]);
      sendJson(response, 200, {
        ok: true,
        applications: await listApplicationsForDiagnostics(apps, permissions),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/applications/permissions") {
      await handleApplicationPermissions(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/authority") {
      sendJson(response, 200, await getAuthorityState());
      return;
    }

    if (request.method === "POST" && url.pathname === "/authority/default") {
      await handleAuthorityDefault(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/authority/elevate") {
      await handleAuthorityElevate(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/authority/reset") {
      await handleAuthorityReset(request, response);
      return;
    }

    sendJson(response, 404, { ok: false, message: "Not found." });
  });
}

export function startCoreServer({
  host = HOST,
  port = PORT,
  onListening = console.log,
} = {}) {
  const server = createCoreServer({ host, port });

  server.listen(port, host, () => {
    onListening(`Selene Core command server listening on http://${host}:${port}`);
  });

  return server;
}

function stopRuntimeServices() {
  awarenessService.stop();
}

export async function startSeleneServers({
  env = process.env,
  corePort = PORT,
  companionPort,
  onCoreListening = console.log,
  onCompanionListening = console.log,
  onCompanionError = console.error,
  credentialStore = null,
  pairingAdministration = createLocalPairingAdministration(),
} = {}) {
  const companionServer = await startCompanionServer({
    port: companionPort,
    env,
    onListening: onCompanionListening,
    onError: onCompanionError,
    credentialStore,
  });
  if (!companionServer) {
    throw new Error("Selene Companion API failed to start.");
  }

  try {
    const server = startCoreServer({ port: corePort, onListening: onCoreListening });
    await new Promise((resolveListening, rejectListening) => {
      server.once("listening", resolveListening);
      server.once("error", rejectListening);
    });
    return { server, companionServer, pairingAdministration };
  } catch (error) {
    await new Promise((done) => companionServer.close(done));
    throw error;
  }
}

export async function closeSeleneServers({
  server,
  companionServer,
  pairingAdministration,
} = {}) {
  pairingAdministration?.shutdown?.();
  await Promise.all([
    companionServer
      ? new Promise((done) => companionServer.close(done))
      : Promise.resolve(),
    server
      ? new Promise((done) => server.close(done))
      : Promise.resolve(),
  ]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let listeners;
  let credentialStore;
  try {
    credentialStore = createGatewayCredentialStore();
    listeners = await startSeleneServers({ credentialStore });
  } catch (error) {
    credentialStore?.close();
    console.error(`Selene startup failed: ${error.message}`);
    process.exitCode = 1;
  }

  if (listeners) {
    const shutdown = async () => {
      stopRuntimeServices();
      await closeSeleneServers(listeners);
      credentialStore.close();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
}
