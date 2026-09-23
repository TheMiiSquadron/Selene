import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  GATEWAY_CREDENTIAL_DATABASE_FILENAME,
  createGatewayCredentialStore,
  resolveDefaultGatewayCredentialDatabasePath,
} from "./gatewayCredentialStore.js";

export const GATEWAY_SECURITY_DIRECTORY_NAME = "security";
export const GATEWAY_SECURITY_PARENT_DIRECTORY_NAME = "Selene";
export const GATEWAY_RUNTIME_TOCTOU_LIMITATION =
  "Gateway credential runtime uses path-based verification before node:sqlite opens the database; this reduces accidental path-substitution risk but cannot eliminate TOCTOU races.";

const APPROVED_SYSTEM_SIDS = Object.freeze(["S-1-5-18", "S-1-5-32-544"]);
const FULL_CONTROL = 2032127;
const CHAT_CAPABILITY = "chat";
const DISPLAY_NAME_MAX_LENGTH = 80;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const SID_PATTERN = /^S-1-5-21-(?:\d+-){3}\d+$/u;

export class GatewayCredentialRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = "GatewayCredentialRuntimeError";
  }
}

function fail(message) {
  throw new GatewayCredentialRuntimeError(message);
}

function samePath(left, right) {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function resolveProductionPaths() {
  const databasePath = resolveDefaultGatewayCredentialDatabasePath();
  const securityDirectory = dirname(databasePath);
  if (!isAbsolute(databasePath) || !isAbsolute(securityDirectory)) {
    fail("Gateway credential production paths must be absolute.");
  }
  return Object.freeze({
    securityDirectory,
    databasePath,
    sidecarPaths: Object.freeze([
      `${databasePath}-wal`,
      `${databasePath}-shm`,
      `${databasePath}-journal`,
    ]),
  });
}

function assertNoSymbolicPathComponents(pathValue) {
  let current = resolve(pathValue);
  const visited = [];

  while (current !== dirname(current)) {
    visited.push(current);
    current = dirname(current);
  }
  visited.push(current);

  for (const pathPart of visited.reverse()) {
    if (!existsSync(pathPart)) continue;
    const stat = lstatSync(pathPart);
    if (stat.isSymbolicLink()) {
      fail("Gateway credential storage paths must not contain symbolic links or junctions.");
    }
  }
}

function assertPathDoesNotSubstitute(pathValue) {
  const realPath = realpathSync.native(pathValue);
  if (!samePath(realPath, pathValue)) {
    fail("Gateway credential storage path must not resolve through a substituted path.");
  }
}

function assertSecurityDirectory(securityDirectory) {
  let stat;
  try {
    stat = lstatSync(securityDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("Gateway credential security directory must already exist.");
    }
    fail("Gateway credential security directory is not accessible.");
  }

  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("Gateway credential security path must be an existing directory.");
  }

  assertNoSymbolicPathComponents(securityDirectory);
  assertPathDoesNotSubstitute(securityDirectory);
}

function assertDatabaseFile(databasePath) {
  let stat;
  try {
    stat = lstatSync(databasePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("Gateway credential database must already exist.");
    }
    fail("Gateway credential database is not accessible.");
  }

  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("Gateway credential database must be an existing regular file.");
  }

  assertNoSymbolicPathComponents(databasePath);
  assertPathDoesNotSubstitute(databasePath);
}

function assertOptionalSidecarFile(sidecarPath) {
  if (!existsSync(sidecarPath)) return;
  const stat = lstatSync(sidecarPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("Gateway credential SQLite sidecars must be regular files.");
  }
  assertNoSymbolicPathComponents(sidecarPath);
  assertPathDoesNotSubstitute(sidecarPath);
}

const ACL_INSPECTION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$itemPath = $env:SELENE_GATEWAY_ACL_PATH
$acl = Get-Acl -LiteralPath $itemPath
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) |
  ForEach-Object {
    [pscustomobject]@{
      sid = $_.IdentityReference.Value
      type = $_.AccessControlType.ToString()
      rights = [int]$_.FileSystemRights
      inherited = $_.IsInherited
      inheritance = [int]$_.InheritanceFlags
      propagation = [int]$_.PropagationFlags
    }
  })
[pscustomobject]@{
  protected = $acl.AreAccessRulesProtected
  canonical = $acl.AreAccessRulesCanonical
  userSid = $userSid
  ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  rules = $rules
} | ConvertTo-Json -Depth 4 -Compress
`;

const ACL_APPLY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$itemPath = $env:SELENE_GATEWAY_ACL_PATH
$isDirectory = $env:SELENE_GATEWAY_ACL_IS_DIRECTORY -eq '1'
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'
$admins = New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'
$acl = Get-Acl -LiteralPath $itemPath
$acl.SetOwner($current)
$acl.SetAccessRuleProtection($true, $false)
$existing = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
foreach ($rule in $existing) {
  [void]$acl.RemoveAccessRuleAll($rule)
}
$inheritance = [Security.AccessControl.InheritanceFlags]::None
if ($isDirectory) {
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
}
$propagation = [Security.AccessControl.PropagationFlags]::None
$rights = [Security.AccessControl.FileSystemRights]::FullControl
foreach ($sid in @($current, $system, $admins)) {
  $rule = New-Object Security.AccessControl.FileSystemAccessRule(
    $sid,
    $rights,
    $inheritance,
    $propagation,
    [Security.AccessControl.AccessControlType]::Allow
  )
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $itemPath -AclObject $acl
`;

function runPowerShellJson(script, env) {
  if (process.platform !== "win32") {
    fail("Windows ACL verification is required for Gateway credential storage.");
  }

  try {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const output = execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encoded,
    ], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output ? JSON.parse(output) : null;
  } catch {
    fail("Unable to verify Gateway credential storage permissions.");
  }
}

function runPowerShell(script, env) {
  if (process.platform !== "win32") {
    fail("Windows ACL configuration is required for Gateway credential storage setup.");
  }

  try {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encoded,
    ], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    fail("Unable to configure Gateway credential storage permissions.");
  }
}

export function inspectWindowsGatewayCredentialAcl(pathValue) {
  return runPowerShellJson(ACL_INSPECTION_SCRIPT, {
    SELENE_GATEWAY_ACL_PATH: pathValue,
  });
}

function applyWindowsGatewayCredentialAcl(pathValue, { directory }) {
  runPowerShell(ACL_APPLY_SCRIPT, {
    SELENE_GATEWAY_ACL_PATH: pathValue,
    SELENE_GATEWAY_ACL_IS_DIRECTORY: directory ? "1" : "0",
  });
}

function assertAclBase(result, { requireProtected }) {
  if (
    !result
    || (requireProtected && result.protected !== true)
    || (!requireProtected && typeof result.protected !== "boolean")
    || result.canonical !== true
    || typeof result.userSid !== "string"
    || !SID_PATTERN.test(result.userSid)
    || result.ownerSid !== result.userSid
    || !Array.isArray(result.rules)
    || result.rules.length !== 3
  ) {
    fail("Gateway credential storage permissions are not restricted.");
  }

}

function assertAclRules(result, {
  directory,
  inherited,
}) {
  const expected = new Set([result.userSid, ...APPROVED_SYSTEM_SIDS]);
  for (const rule of result.rules) {
    if (!rule || !expected.delete(rule.sid) || rule.type !== "Allow") {
      fail("Gateway credential storage permissions are not restricted.");
    }
    if (
      rule.rights !== FULL_CONTROL
      || rule.propagation !== 0
      || rule.inheritance !== (directory ? 3 : 0)
    ) {
      fail("Gateway credential storage permissions are not restricted.");
    }
    if (rule.inherited !== inherited) {
      fail("Gateway credential storage permissions are not restricted.");
    }
  }
  if (expected.size !== 0) {
    fail("Gateway credential storage permissions are not restricted.");
  }
}

function assertAcl(result, { directory }) {
  assertAclBase(result, { requireProtected: true });
  assertAclRules(result, { directory, inherited: false });
}

function assertSqliteSidecarAcl(result) {
  assertAclBase(result, { requireProtected: false });
  if (result.protected === true) {
    assertAclRules(result, { directory: false, inherited: false });
    return;
  }
  assertAclRules(result, { directory: false, inherited: true });
}

function verifyStoragePaths(paths, { inspectAcl = inspectWindowsGatewayCredentialAcl } = {}) {
  assertSecurityDirectory(paths.securityDirectory);
  assertDatabaseFile(paths.databasePath);
  for (const sidecarPath of paths.sidecarPaths) {
    assertOptionalSidecarFile(sidecarPath);
  }

  assertAcl(inspectAcl(paths.securityDirectory), { directory: true });
  assertAcl(inspectAcl(paths.databasePath), { directory: false });
  for (const sidecarPath of paths.sidecarPaths) {
    if (existsSync(sidecarPath)) {
      assertSqliteSidecarAcl(inspectAcl(sidecarPath));
    }
  }
}

function ensureWindowsGatewayCredentialAcl(pathValue, { directory }) {
  try {
    assertAcl(inspectWindowsGatewayCredentialAcl(pathValue), { directory });
    return;
  } catch {
    applyWindowsGatewayCredentialAcl(pathValue, { directory });
  }
  assertAcl(inspectWindowsGatewayCredentialAcl(pathValue), { directory });
}

function validateDisplayName(displayName) {
  if (typeof displayName !== "string") {
    fail("Device display name must be a string.");
  }
  const value = displayName.trim();
  if (
    !value
    || value.length > DISPLAY_NAME_MAX_LENGTH
    || CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    fail(`Device display name must be 1 to ${DISPLAY_NAME_MAX_LENGTH} characters without control characters.`);
  }
  return value;
}

function issueChatCredential(store, { displayName }) {
  const issued = store.issueCredential({
    homeId: `paired:${randomUUID()}`,
    displayName: validateDisplayName(displayName),
    capabilities: [CHAT_CAPABILITY],
  });

  return Object.freeze({
    bearerCredential: issued.bearerCredential,
    credential: Object.freeze({
      id: issued.credential.id,
      homeId: issued.credential.homeId,
      displayName: issued.credential.displayName,
      capabilities: Object.freeze([...issued.credential.capabilities]),
      createdAt: issued.credential.createdAt,
      revokedAt: issued.credential.revokedAt,
    }),
  });
}

/**
 * Explicit local setup for the production Gateway credential database.
 *
 * This creates the fixed `%LOCALAPPDATA%\Selene\security` directory and the
 * fixed Gateway credential database if they do not exist, applies restricted
 * Windows ACLs, initializes the existing v1 schema, closes the database, and
 * verifies the resulting storage. It is safe to rerun and does not delete or
 * rebuild existing credentials.
 */
export function setupProductionGatewayCredentialStorage() {
  const paths = resolveProductionPaths();

  mkdirSync(paths.securityDirectory, { recursive: true });
  assertSecurityDirectory(paths.securityDirectory);
  ensureWindowsGatewayCredentialAcl(paths.securityDirectory, { directory: true });

  const store = createGatewayCredentialStore({ databasePath: paths.databasePath });
  store.close();

  for (const filePath of [paths.databasePath, ...paths.sidecarPaths]) {
    if (existsSync(filePath)) {
      ensureWindowsGatewayCredentialAcl(filePath, { directory: false });
    }
  }

  verifyStoragePaths(paths);
  const verificationStore = createGatewayCredentialStore({ databasePath: paths.databasePath });
  verificationStore.close();
  verifyStoragePaths(paths);

  return Object.freeze({
    ok: true,
    securityDirectory: paths.securityDirectory,
    databasePath: paths.databasePath,
    limitation: GATEWAY_RUNTIME_TOCTOU_LIMITATION,
  });
}

/**
 * Opens the existing production Gateway credential database for the future
 * pairing-claim path. The returned object intentionally exposes only a narrow
 * chat credential issuer and close operation, not the full store. The path is
 * resolved internally and must already exist. Verification is path-based before
 * node:sqlite opens the database, so the residual TOCTOU limitation documented
 * by GATEWAY_RUNTIME_TOCTOU_LIMITATION still applies.
 */
export function openProductionGatewayCredentialIssuer() {
  const paths = resolveProductionPaths();
  verifyStoragePaths(paths);

  const store = createGatewayCredentialStore({ databasePath: paths.databasePath });
  let closed = false;

  return Object.freeze({
    issueChatCredentialForPairedDevice(options = {}) {
      if (closed) fail("Gateway credential issuer is closed.");
      return issueChatCredential(store, options);
    },
    close() {
      if (closed) return;
      closed = true;
      store.close();
    },
  });
}

export function getProductionGatewayCredentialStorageStatus() {
  const paths = resolveProductionPaths();
  try {
    verifyStoragePaths(paths);
    const store = createGatewayCredentialStore({ databasePath: paths.databasePath });
    store.close();
    return Object.freeze({
      ok: true,
      securityDirectory: paths.securityDirectory,
      databasePath: paths.databasePath,
      limitation: GATEWAY_RUNTIME_TOCTOU_LIMITATION,
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      securityDirectory: paths.securityDirectory,
      databasePath: paths.databasePath,
      error: error instanceof GatewayCredentialRuntimeError
        ? error.message
        : "Gateway credential storage is unavailable.",
      limitation: GATEWAY_RUNTIME_TOCTOU_LIMITATION,
    });
  }
}
