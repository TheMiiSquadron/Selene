import {
  GatewayProvisioningError,
  PRODUCTION_WRITES_DISABLED_MESSAGE,
  issueGatewayCredential,
  listGatewayCredentials,
  revokeGatewayCredential,
} from "../src/gatewayProvisioning.js";

function usage() {
  return [
    "Usage:",
    "  node scripts/gatewayProvisioning.js list",
    "  node scripts/gatewayProvisioning.js issue --home-id <home-id> --display-name <name>",
    "  node scripts/gatewayProvisioning.js revoke --id <credential-id>",
  ].join("\n");
}

function parseNamedArguments(args) {
  const parsed = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      typeof name !== "string"
      || !name.startsWith("--")
      || typeof value !== "string"
      || value.startsWith("--")
      || parsed.has(name)
    ) {
      throw new GatewayProvisioningError(usage());
    }
    parsed.set(name, value);
  }
  return parsed;
}

function printSafeError(error) {
  const message = error instanceof GatewayProvisioningError
    ? error.message
    : "Gateway provisioning command failed.";
  console.error(message);
}

const [command, ...args] = process.argv.slice(2);

try {
  if (command === "list" && args.length === 0) {
    console.table(listGatewayCredentials());
  } else if (command === "issue") {
    const parsed = parseNamedArguments(args);
    if (
      parsed.size !== 2
      || !parsed.has("--home-id")
      || !parsed.has("--display-name")
    ) {
      throw new GatewayProvisioningError(usage());
    }

    issueGatewayCredential({
      homeId: parsed.get("--home-id"),
      displayName: parsed.get("--display-name"),
      deliverCredential() {
        throw new GatewayProvisioningError(PRODUCTION_WRITES_DISABLED_MESSAGE);
      },
    });
  } else if (command === "revoke") {
    const parsed = parseNamedArguments(args);
    if (parsed.size !== 1 || !parsed.has("--id")) {
      throw new GatewayProvisioningError(usage());
    }

    const revoked = revokeGatewayCredential({
      credentialId: parsed.get("--id"),
    });
    console.log(revoked ? "Credential revoked." : "Credential was not active.");
  } else {
    throw new GatewayProvisioningError(usage());
  }
} catch (error) {
  printSafeError(error);
  process.exitCode = 1;
}
