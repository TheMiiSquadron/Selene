import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  createGatewayCredentialStore,
  resolveDefaultGatewayCredentialDatabasePath,
} from "./gatewayCredentialStore.js";

export const PRODUCTION_WRITES_DISABLED_MESSAGE =
  "Gateway credential write operations are disabled until file-identity and one-time delivery safeguards are approved.";
export const CREDENTIAL_DELIVERY_FAILED_MESSAGE =
  "Gateway credential delivery failed; the newly issued credential was revoked.";
export const CREDENTIAL_DELIVERY_UNRESOLVED_MESSAGE =
  "Gateway credential delivery failed and the newly issued credential could not be revoked; an active credential may remain.";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHAT_CAPABILITY = "chat";

export class GatewayProvisioningError extends Error {
  constructor(message) {
    super(message);
    this.name = "GatewayProvisioningError";
  }
}

function samePath(left, right) {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function assertAbsolutePath(pathValue, label) {
  if (typeof pathValue !== "string" || !pathValue.trim() || !isAbsolute(pathValue)) {
    throw new GatewayProvisioningError(`${label} must be an absolute path.`);
  }
  return resolve(pathValue.trim());
}

function assertCredentialId(credentialId) {
  if (typeof credentialId !== "string" || !UUID_PATTERN.test(credentialId.trim())) {
    throw new GatewayProvisioningError("Credential ID must be a UUID.");
  }
  return credentialId.trim().toLowerCase();
}

function assertNoSymbolicPathComponents(databasePath) {
  let current = resolve(databasePath);
  const visited = [];

  while (current !== dirname(current)) {
    visited.push(current);
    current = dirname(current);
  }
  visited.push(current);

  for (const pathPart of visited.reverse()) {
    const stat = lstatSync(pathPart);
    if (stat.isSymbolicLink()) {
      throw new GatewayProvisioningError(
        "Gateway credential database path must not contain symbolic links or junctions.",
      );
    }
  }
}

function inspectDatabasePath(databasePath) {
  const stat = lstatSync(databasePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new GatewayProvisioningError(
      "Gateway credential database must already exist as a regular file.",
    );
  }

  assertNoSymbolicPathComponents(databasePath);

  const realDatabasePath = realpathSync.native(databasePath);
  if (!samePath(realDatabasePath, databasePath)) {
    throw new GatewayProvisioningError(
      "Gateway credential database path must not resolve through a substituted path.",
    );
  }
}

function defaultSecurityInspector({ databasePath }) {
  try {
    inspectDatabasePath(databasePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new GatewayProvisioningError(
        "Gateway credential database must already exist as a regular file.",
      );
    }
    if (error instanceof GatewayProvisioningError) throw error;
    throw new GatewayProvisioningError("Gateway credential database path is not accessible.");
  }

  return Object.freeze({
    filesystemIdentityVerified: false,
    message:
      "Pre-open filesystem checks cannot eliminate path-substitution races with Node's SQLite API.",
  });
}

export function resolveProductionGatewayCredentialDatabasePath(env = process.env) {
  return resolveDefaultGatewayCredentialDatabasePath(env);
}

function openProductionGatewayCredentialStore({
  createStore = createGatewayCredentialStore,
  env = process.env,
} = {}) {
  const expectedDatabasePath = resolveProductionGatewayCredentialDatabasePath(env);
  const resolvedDatabasePath = assertAbsolutePath(
    expectedDatabasePath,
    "Gateway credential database path",
  );

  const inspection = defaultSecurityInspector({
    databasePath: resolvedDatabasePath,
    expectedDatabasePath: resolvedDatabasePath,
  });

  const store = createStore({ databasePath: resolvedDatabasePath });
  return Object.freeze({
    store,
    databasePath: resolvedDatabasePath,
    inspection,
  });
}

function publicCredential(credential) {
  return Object.freeze({
    id: credential.id,
    homeId: credential.homeId,
    displayName: credential.displayName,
    capabilities: Object.freeze([...credential.capabilities]),
    createdAt: credential.createdAt,
    revokedAt: credential.revokedAt,
  });
}

export function formatCredentialForListing(credential) {
  return Object.freeze({
    id: credential.id,
    homeId: credential.homeId,
    displayName: credential.displayName,
    capabilities: credential.capabilities.join(", "),
    createdAt: credential.createdAt,
    revokedAt: credential.revokedAt ?? "Active",
  });
}

export function listGatewayCredentials() {
  const opened = openProductionGatewayCredentialStore();
  try {
    return opened.store.listCredentials().map(formatCredentialForListing);
  } finally {
    opened.store.close();
  }
}

export function issueGatewayCredential({
  homeId,
  displayName,
  deliverCredential,
  capabilities = [CHAT_CAPABILITY],
} = {}) {
  validateIssueRequestShape({ homeId, displayName, deliverCredential, capabilities });
  throw new GatewayProvisioningError(PRODUCTION_WRITES_DISABLED_MESSAGE);
}

export function revokeGatewayCredential({ credentialId } = {}) {
  assertCredentialId(credentialId);
  throw new GatewayProvisioningError(PRODUCTION_WRITES_DISABLED_MESSAGE);
}

function validateIssueRequestShape({
  deliverCredential,
  capabilities = [CHAT_CAPABILITY],
} = {}) {
  if (
    !Array.isArray(capabilities)
    || capabilities.length !== 1
    || capabilities[0] !== CHAT_CAPABILITY
  ) {
    throw new GatewayProvisioningError(
      "Initial Gateway credential provisioning is restricted to the chat capability.",
    );
  }

  if (typeof deliverCredential !== "function") {
    throw new GatewayProvisioningError(
      "A deliberate one-time credential delivery callback is required for issuance.",
    );
  }
}
