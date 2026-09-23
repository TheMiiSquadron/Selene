import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLS_MANIFEST_VERSION, TlsConfigurationError, validateTlsConfiguration } from "./tlsConfiguration.js";

const HOST = "nova.test.example";
const GENERATION = "a".repeat(32);
const USER_SID = "S-1-5-21-1-2-3-1001";
const FULL_CONTROL = 2032127;

function der(tag, ...parts) {
  const body = Buffer.concat(parts.map((part) => Buffer.from(part)));
  const length = body.length < 128 ? Buffer.from([body.length])
    : body.length < 256 ? Buffer.from([0x81, body.length])
      : Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}

function certificate({ san = HOST, from = "20200101000000Z", to = "20400101000000Z" } = {}) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const seq = (...values) => der(0x30, ...values);
  const oid = (...bytes) => der(0x06, Buffer.from(bytes));
  const algorithm = seq(oid(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b), der(0x05));
  const name = seq(der(0x31, seq(oid(0x55, 0x04, 0x03), der(0x0c, Buffer.from("irrelevant-cn")))));
  const validity = seq(der(0x18, Buffer.from(from)), der(0x18, Buffer.from(to)));
  const extensions = der(0xa3, seq(seq(oid(0x55, 0x1d, 0x11), der(0x04,
    seq(der(0x82, Buffer.from(san)))))));
  const serialBytes = randomBytes(16);
  if (serialBytes[0] === 0) serialBytes[0] = 1;
  const serial = serialBytes[0] & 0x80
    ? Buffer.concat([Buffer.from([0]), serialBytes])
    : serialBytes;
  const tbs = seq(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial),
    algorithm, name, validity, name, publicKey, extensions);
  const pem = seq(tbs, algorithm,
    der(0x03, Buffer.from([0]), sign("RSA-SHA256", tbs, privateKey)))
    .toString("base64").match(/.{1,64}/g).join("\n");
  return { cert: `-----BEGIN CERTIFICATE-----\n${pem}\n-----END CERTIFICATE-----\n`, key };
}

function approvedAcl(path) {
  const directory = !/\.(crt|key)$/.test(path);
  return {
    protected: true, canonical: true, userSid: USER_SID, ownerSid: USER_SID,
    rules: [USER_SID, "S-1-5-18", "S-1-5-32-544"].map((sid) => ({
      sid, type: "Allow", rights: FULL_CONTROL, inherited: false,
      inheritance: directory ? 3 : 0, propagation: 0,
    })),
  };
}

async function fixture(t, certOptions) {
  const root = await mkdtemp(join(tmpdir(), "selene-tls-config-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generationPath = join(root, GENERATION);
  await mkdir(generationPath);
  const material = certificate(certOptions);
  const certPath = join(generationPath, `${HOST}.crt`);
  const keyPath = join(generationPath, `${HOST}.key`);
  await writeFile(certPath, material.cert);
  await writeFile(keyPath, material.key);
  const manifest = {
    version: TLS_MANIFEST_VERSION, hostname: HOST, generation: GENERATION,
    fingerprint: new X509Certificate(material.cert).fingerprint256,
  };
  const validate = (options = {}) => validateTlsConfiguration({
    manifest, tlsRoot: root, expectedHostname: HOST, inspectAcl: approvedAcl,
    now: () => new Date("2026-09-22T00:00:00Z"), ...options,
  });
  return { root, generationPath, certPath, keyPath, material, manifest, validate };
}

test("valid offline generation returns one derived certificate/key pair", async (t) => {
  const f = await fixture(t);
  const result = f.validate();
  assert.equal(result.certPath, f.certPath);
  assert.equal(result.keyPath, f.keyPath);
  assert.equal(result.fingerprint, f.manifest.fingerprint);
  assert.equal(Object.isFrozen(result), true);
});

test("manifest rejects unknown fields, versions, hosts, identifiers and fingerprints", async (t) => {
  const f = await fixture(t);
  for (const change of [
    { version: 2 }, { hostname: "other.test.example" }, { extra: true },
    { generation: "../escape" }, { generation: "C:\\absolute" },
    { generation: "a/b" }, { generation: "a".repeat(31) },
    { fingerprint: "00".repeat(32) },
  ]) {
    assert.throws(() => f.validate({ manifest: { ...f.manifest, ...change } }),
      TlsConfigurationError);
  }
  assert.throws(() => f.validate({ tlsRoot: "relative/path" }), TlsConfigurationError);
});

test("missing, empty, malformed, expired and wrong-SAN material fails closed", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.validate({ now: () => new Date("2041-01-01") }), TlsConfigurationError);
  assert.throws(() => f.validate({ now: () => new Date("2019-01-01") }), TlsConfigurationError);
  await writeFile(f.certPath, "broken");
  assert.throws(() => f.validate(), TlsConfigurationError);
  await writeFile(f.certPath, "");
  assert.throws(() => f.validate(), TlsConfigurationError);
  await rm(f.certPath);
  assert.throws(() => f.validate(), TlsConfigurationError);
  const wrong = await fixture(t, { san: "wrong.test.example" });
  assert.throws(() => wrong.validate(), TlsConfigurationError);
});

test("mismatched private key and wrong fingerprint fail closed", async (t) => {
  const f = await fixture(t);
  const other = certificate();
  await writeFile(f.keyPath, other.key);
  assert.throws(() => f.validate(), TlsConfigurationError);
  await writeFile(f.keyPath, f.material.key);
  const fingerprint = "00:".repeat(31) + "00";
  assert.throws(() => f.validate({ manifest: { ...f.manifest, fingerprint } }),
    TlsConfigurationError);
});

test("all four ACLs are checked and weakened permissions fail closed", async (t) => {
  const f = await fixture(t);
  const visited = [];
  f.validate({ inspectAcl(path) { visited.push(path); return approvedAcl(path); } });
  assert.deepEqual(visited, [f.root, f.generationPath, f.certPath, f.keyPath]);
  for (const pathToWeaken of visited) {
    for (const mutation of [
      (a) => { a.protected = false; },
      (a) => { a.rules.push({ ...a.rules[0], sid: "S-1-1-0" }); },
      (a) => { a.rules[0].rights = 1; },
      (a) => { a.rules[0].inherited = true; },
    ]) {
      assert.throws(() => f.validate({ inspectAcl(path) {
        const acl = approvedAcl(path);
        if (path === pathToWeaken) mutation(acl);
        return acl;
      } }), TlsConfigurationError);
    }
  }
  assert.throws(() => f.validate({ inspectAcl() { throw new Error("denied"); } }),
    TlsConfigurationError);
});

test("generation links are rejected", async (t) => {
  const f = await fixture(t);
  const linkedRoot = await mkdtemp(join(tmpdir(), "selene-tls-link-test-"));
  t.after(() => rm(linkedRoot, { recursive: true, force: true }));
  const link = join(linkedRoot, GENERATION);
  try {
    await symlink(f.generationPath, link, "junction");
  } catch (error) {
    t.skip(`Junction creation unavailable: ${error.code}`);
    return;
  }
  assert.throws(() => f.validate({ tlsRoot: linkedRoot }), TlsConfigurationError);
});

test("certificate-file symbolic links are rejected", async (t) => {
  const f = await fixture(t);
  const target = join(f.root, "replacement.crt");
  await writeFile(target, f.material.cert);
  await rm(f.certPath);
  try {
    await symlink(target, f.certPath, "file");
  } catch (error) {
    t.skip(`File symbolic links unavailable: ${error.code}`);
    return;
  }
  assert.throws(() => f.validate(), TlsConfigurationError);
});

test("incorrect ACL owner, protection, and file flags are rejected", async (t) => {
  const f = await fixture(t);
  for (const [pathToWeaken, mutation] of [
    [f.root, (acl) => { acl.ownerSid = "S-1-5-18"; }],
    [f.generationPath, (acl) => { acl.canonical = false; }],
    [f.certPath, (acl) => { acl.rules[0].inheritance = 3; }],
    [f.keyPath, (acl) => { acl.rules[0].propagation = 1; }],
    [f.keyPath, (acl) => { acl.rules[0].type = "Deny"; }],
  ]) {
    assert.throws(() => f.validate({ inspectAcl(path) {
      const acl = approvedAcl(path);
      if (path === pathToWeaken) mutation(acl);
      return acl;
    } }), TlsConfigurationError);
  }
});
