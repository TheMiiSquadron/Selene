import { execFileSync } from "node:child_process";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createSecureContext } from "node:tls";

export const TLS_MANIFEST_VERSION = 1;
const GENERATION_PATTERN = /^[0-9a-f]{32}$/;
const FINGERPRINT_PATTERN = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)+$/;
const APPROVED_SYSTEM_SIDS = ["S-1-5-18", "S-1-5-32-544"];

export class TlsConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "TlsConfigurationError";
  }
}

function fail(message) {
  throw new TlsConfigurationError(message);
}

function within(path, root) {
  const difference = relative(root, path);
  return difference === "" || (difference !== ".."
    && !difference.startsWith(`..${sep}`) && !isAbsolute(difference));
}

function assertPlainFileOrDirectory(path, directory) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    fail("TLS storage contains an unexpected file type or link.");
  }
}

function assertPlainAncestors(path) {
  let cursor = path;
  for (;;) {
    assertPlainFileOrDirectory(cursor, true);
    const parent = resolve(cursor, "..");
    if (parent === cursor) return;
    cursor = parent;
  }
}

function assertAcl(result, directory) {
  if (!result || result.protected !== true || result.canonical !== true
    || typeof result.userSid !== "string" || !/^S-1-5-21-(?:\d+-){3}\d+$/.test(result.userSid)
    || result.ownerSid !== result.userSid || !Array.isArray(result.rules)
    || result.rules.length !== 3) {
    fail("TLS storage permissions are not restricted.");
  }
  const expected = new Set([result.userSid, ...APPROVED_SYSTEM_SIDS]);
  for (const rule of result.rules) {
    if (!rule || !expected.delete(rule.sid) || rule.type !== "Allow"
      || rule.rights !== 2032127 || rule.inherited !== false
      || rule.inheritance !== (directory ? 3 : 0)
      || rule.propagation !== 0) {
      fail("TLS storage permissions are not restricted.");
    }
  }
  if (expected.size !== 0) fail("TLS storage permissions are not restricted.");
}

const ACL_INSPECTION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$itemPath = $env:SELENE_TLS_ACL_INSPECTION_PATH
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

/** Read-only Windows ACL inspection. The path is passed in the child environment,
 * never interpolated into executable PowerShell source. */
export function inspectWindowsTlsAcl(path) {
  if (process.platform !== "win32") fail("Windows ACL inspection is required.");
  try {
    const encoded = Buffer.from(ACL_INSPECTION_SCRIPT, "utf16le").toString("base64");
    const output = execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded,
    ], {
      env: { ...process.env, SELENE_TLS_ACL_INSPECTION_PATH: path },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(output);
  } catch {
    fail("Unable to verify TLS storage permissions.");
  }
}

/**
 * Validate an offline TLS manifest and its generation. No listeners, files, or
 * environment settings are changed. The caller supplies the trusted TLS root
 * and expected hostname; neither comes from the manifest. Tests may inject a
 * read-only ACL inspector. A successful result is not an activation decision.
 */
export function validateTlsConfiguration({
  manifest, tlsRoot, expectedHostname,
  inspectAcl = inspectWindowsTlsAcl,
  now = () => new Date(),
} = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
    || Object.keys(manifest).sort().join(",")
      !== "fingerprint,generation,hostname,version"
    || manifest.version !== TLS_MANIFEST_VERSION
    || typeof expectedHostname !== "string"
    || !HOSTNAME_PATTERN.test(expectedHostname)
    || manifest.hostname !== expectedHostname
    || typeof manifest.generation !== "string"
    || !GENERATION_PATTERN.test(manifest.generation)
    || typeof manifest.fingerprint !== "string"
    || !FINGERPRINT_PATTERN.test(manifest.fingerprint)
    || typeof tlsRoot !== "string" || !isAbsolute(tlsRoot)
    || typeof inspectAcl !== "function") {
    fail("Invalid TLS configuration manifest or trusted inputs.");
  }

  const root = resolve(tlsRoot);
  const generationPath = join(root, manifest.generation);
  const certPath = join(generationPath, `${expectedHostname}.crt`);
  const keyPath = join(generationPath, `${expectedHostname}.key`);
  if (!within(generationPath, root) || !within(certPath, root)
    || !within(keyPath, root)) {
    fail("TLS generation escapes its root.");
  }

  try {
    const actualRoot = realpathSync(root);
    assertPlainAncestors(root);
    assertPlainFileOrDirectory(generationPath, true);
    assertPlainFileOrDirectory(certPath, false);
    assertPlainFileOrDirectory(keyPath, false);
    for (const path of [generationPath, certPath, keyPath]) {
      if (!within(realpathSync(path), actualRoot)) fail("TLS generation escapes its root.");
    }
    for (const [path, directory] of [
      [root, true], [generationPath, true], [certPath, false], [keyPath, false],
    ]) {
      assertAcl(inspectAcl(path), directory);
    }

    const cert = readFileSync(certPath);
    const key = readFileSync(keyPath);
    if (!cert.length || !key.length) fail("TLS material is empty.");
    const leaf = new X509Certificate(cert);
    const current = now();
    const currentMs = current instanceof Date ? current.getTime() : NaN;
    const validFrom = Date.parse(leaf.validFrom);
    const validTo = Date.parse(leaf.validTo);
    if (!Number.isFinite(currentMs) || !Number.isFinite(validFrom)
      || !Number.isFinite(validTo) || currentMs < validFrom || currentMs >= validTo
      || !leaf.checkHost(expectedHostname, { subject: "never", wildcards: false })
      || leaf.fingerprint256 !== manifest.fingerprint
      || !leaf.checkPrivateKey(createPrivateKey(key))) {
      fail("TLS certificate validation failed.");
    }
    createSecureContext({ cert, key });
    return Object.freeze({
      hostname: expectedHostname,
      generation: manifest.generation,
      fingerprint: leaf.fingerprint256,
      validTo: leaf.validTo,
      certPath,
      keyPath,
    });
  } catch (error) {
    if (error instanceof TlsConfigurationError) throw error;
    fail("TLS configuration validation failed.");
  }
}
