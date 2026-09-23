import {
  GatewayCredentialRuntimeError,
  setupProductionGatewayCredentialStorage,
} from "../src/gatewayCredentialRuntime.js";

try {
  const result = setupProductionGatewayCredentialStorage();
  console.log("Gateway credential storage is ready.");
  console.log(`Security directory: ${result.securityDirectory}`);
  console.log(`Database: ${result.databasePath}`);
  console.log(result.limitation);
} catch (error) {
  const message = error instanceof GatewayCredentialRuntimeError
    ? error.message
    : "Gateway credential storage setup failed.";
  console.error(message);
  process.exitCode = 1;
}
