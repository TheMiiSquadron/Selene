import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayCredentialStore } from "../src/gatewayCredentialStore.js";
import {
  CREDENTIAL_DELIVERY_FAILED_MESSAGE,
  CREDENTIAL_DELIVERY_UNRESOLVED_MESSAGE,
  GatewayProvisioningError,
  formatCredentialForListing,
} from "../src/gatewayProvisioning.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHAT_CAPABILITY = "chat";
const DISPOSABLE_DATABASE_BRAND = Symbol("Selene disposable Gateway credential database");

function assertText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new GatewayProvisioningError(`${label} is required.`);
  }
  return value.trim();
}

function assertCredentialId(credentialId) {
  if (typeof credentialId !== "string" || !UUID_PATTERN.test(credentialId.trim())) {
    throw new GatewayProvisioningError("Credential ID must be a UUID.");
  }
  return credentialId.trim().toLowerCase();
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

function validateIssueRequest({
  homeId,
  displayName,
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

  return Object.freeze({
    homeId: assertText(homeId, "Home ID"),
    displayName: assertText(displayName, "Display name"),
    deliverCredential,
    capabilities,
  });
}

function issueCredentialWithRollback(store, issueRequest) {
  const issued = store.issueCredential({
    homeId: issueRequest.homeId,
    displayName: issueRequest.displayName,
    capabilities: issueRequest.capabilities,
  });
  const credential = publicCredential(issued.credential);

  try {
    issueRequest.deliverCredential(issued.bearerCredential, credential);
  } catch {
    try {
      if (store.revokeCredential(credential.id)) {
        throw new GatewayProvisioningError(CREDENTIAL_DELIVERY_FAILED_MESSAGE);
      }
    } catch (revocationError) {
      if (
        revocationError instanceof GatewayProvisioningError
        && revocationError.message === CREDENTIAL_DELIVERY_FAILED_MESSAGE
      ) {
        throw revocationError;
      }
    }

    throw new GatewayProvisioningError(CREDENTIAL_DELIVERY_UNRESOLVED_MESSAGE);
  }

  return credential;
}

function assertDisposableDatabase(disposableDatabase) {
  if (
    !disposableDatabase
    || disposableDatabase[DISPOSABLE_DATABASE_BRAND] !== true
    || typeof disposableDatabase.databasePath !== "string"
  ) {
    throw new GatewayProvisioningError(
      "A disposable Gateway credential database fixture is required.",
    );
  }

  return disposableDatabase.databasePath;
}

function openDisposableStore(disposableDatabase) {
  return createGatewayCredentialStore({
    databasePath: assertDisposableDatabase(disposableDatabase),
  });
}

export async function createDisposableGatewayCredentialDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "selene-provisioning-test-"));
  const databasePath = join(directory, "gateway-credentials.sqlite3");
  const store = createGatewayCredentialStore({ databasePath });
  store.close();
  return Object.freeze({
    [DISPOSABLE_DATABASE_BRAND]: true,
    directory,
    databasePath,
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  });
}

export function listDisposableGatewayCredentials({ disposableDatabase } = {}) {
  const store = openDisposableStore(disposableDatabase);
  try {
    return store.listCredentials().map(formatCredentialForListing);
  } finally {
    store.close();
  }
}

export function issueDisposableGatewayCredential({
  disposableDatabase,
  homeId,
  displayName,
  deliverCredential,
  capabilities = [CHAT_CAPABILITY],
} = {}) {
  const store = openDisposableStore(disposableDatabase);
  try {
    return issueCredentialWithRollback(
      store,
      validateIssueRequest({
        homeId,
        displayName,
        deliverCredential,
        capabilities,
      }),
    );
  } finally {
    store.close();
  }
}

export function revokeDisposableGatewayCredential({
  disposableDatabase,
  credentialId,
} = {}) {
  const store = openDisposableStore(disposableDatabase);
  try {
    return store.revokeCredential(assertCredentialId(credentialId));
  } finally {
    store.close();
  }
}

export function issueDisposableGatewayCredentialWithStoreForTesting({
  store,
  homeId,
  displayName,
  deliverCredential,
  capabilities = [CHAT_CAPABILITY],
} = {}) {
  if (!store || typeof store.issueCredential !== "function") {
    throw new GatewayProvisioningError("A disposable Gateway credential store is required.");
  }

  return issueCredentialWithRollback(
    store,
    validateIssueRequest({
      homeId,
      displayName,
      deliverCredential,
      capabilities,
    }),
  );
}
