// Temporary operator-run client. Importing it never contacts Selene.
import https from "node:https";
import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { getCACertificates } from "node:tls";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { configuration, runValidation } from "./m46ProductionE2E.js";
import { runSemanticRecall } from "./m46SemanticRecall.js";

export const ORIGIN = "https://127.0.0.1:8787";
export const CA_PATH = "C:\\Users\\alexm\\AppData\\Local\\Selene\\tls\\m46\\ca.pem";
const DEVICE_NAME = "NOVA M4.6 Validation";
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const CREDENTIAL = /^selene_gateway_v1\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/i;
export class PairingClientError extends Error {}
function check(value, message) { if (!value) throw new PairingClientError(message); }
function validSecret(value) {
  return typeof value === "string" && SECRET.test(value)
    && Buffer.from(value, "base64url").toString("base64url") === value;
}

export function prepareRuntime({ env = process.env, execArgs = process.execArgv,
  readCa = readFileSync, verifyTrust = (ca) => {
    const fingerprint = new X509Certificate(ca).fingerprint256;
    return getCACertificates("extra").some((pem) => new X509Certificate(pem).fingerprint256 === fingerprint);
  },
} = {}) {
  try {
    configuration({ ...env, SELENE_M46_URL: ORIGIN, SELENE_M46_BEARER: "runtime_check_only" }, execArgs);
    check(!env.NODE_DEBUG && !env.NODE_DEBUG_NATIVE, "Disable Node debug logging before entering secrets.");
    check(typeof env.NODE_EXTRA_CA_CERTS === "string"
      && resolve(env.NODE_EXTRA_CA_CERTS).toLowerCase() === resolve(CA_PATH).toLowerCase(),
    "Set NODE_EXTRA_CA_CERTS to the M4.6 public CA before launching this client.");
    const ca = readCa(CA_PATH);
    check(ca.length > 0 && verifyTrust(ca), "The M4.6 CA was not loaded by Node at startup. Relaunch with NODE_EXTRA_CA_CERTS configured.");
    return ca;
  } catch (error) {
    if (error instanceof PairingClientError) throw error;
    throw new PairingClientError("TLS runtime preflight failed. Check the CA file and use a clean Node invocation with certificate verification enabled.");
  }
}

export function readHiddenSecret({ input = process.stdin, output = process.stdout, visible = false } = {}) {
  check(input.isTTY && output.isTTY && typeof input.setRawMode === "function",
    "An interactive terminal is required; redirected input and command-line secrets are not supported.");
  check(!input.isRaw, "Terminal is already in raw mode. Use a fresh terminal.");
  return new Promise((resolveSecret, reject) => {
    let secret = "";
    const wasPaused = input.isPaused();
    function finish(error) {
      input.off("data", onData); input.off("error", onError); input.off("end", onEnd);
      input.setRawMode(false);
      if (wasPaused) input.pause();
      output.write("\n");
      const result = secret; secret = "";
      if (error) reject(error); else resolveSecret(result);
    }
    function onError() { finish(new PairingClientError("Secret input failed; no claim was sent.")); }
    function onEnd() { finish(new PairingClientError("Secret input ended; no claim was sent.")); }
    function onData(data) {
      for (const char of data.toString("utf8")) {
        if (char === "\u0003" || char === "\u0004") { finish(new PairingClientError("Cancelled; no claim was sent.")); return; }
        if (char === "\r" || char === "\n") {
          finish(validSecret(secret) ? null : new PairingClientError("Invalid pairing-secret format; no claim was sent.")); return;
        }
        if (char === "\b" || char === "\u007f") {
          if (secret.length) { secret = secret.slice(0, -1); if (visible) output.write("\b \b"); }
          continue;
        }
        if (!/[A-Za-z0-9_-]/.test(char) || secret.length >= 43) {
          finish(new PairingClientError("Unexpected secret input; no claim was sent.")); return;
        }
        secret += char;
        if (visible) output.write(char);
      }
    }
    output.write(`Pairing secret (${visible ? "visible" : "hidden"}; Enter to submit one claim, Ctrl+C to cancel): `);
    input.setRawMode(true);
    input.on("data", onData); input.once("error", onError); input.once("end", onEnd); input.resume();
  });
}

export function claimPairing(secret, { ca, request = https.request } = {}) {
  check(validSecret(secret), "Invalid pairing-secret format; no claim was sent.");
  check(ca?.length > 0, "Local CA is required before claiming.");
  return new Promise((resolveCredential, reject) => {
    let finished = false;
    let req;
    let timer;
    function fail(message) {
      if (finished) return;
      finished = true; clearTimeout(timer); req?.destroy(); reject(new PairingClientError(message));
    }
    try {
      const body = Buffer.from(JSON.stringify({ deviceName: DEVICE_NAME, secret }));
      secret = "";
      req = request(new URL("/api/pairing/claim", ORIGIN), {
        method: "POST", ca, rejectUnauthorized: true, agent: false,
        headers: { "Content-Type": "application/json", Accept: "application/json", "Content-Length": body.length },
      }, (response) => {
        if (finished) { response.destroy(); return; }
        const type = String(response.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        if (response.statusCode !== 200 || type !== "application/json"
          || response.headers["cache-control"] !== "no-store") {
          response.destroy(); fail("Pairing response rejected. Check the active session, TLS endpoint, and server status. No automatic retry was made."); return;
        }
        let bytes = 0;
        const chunks = [];
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 8192) { response.destroy(); fail("Pairing response exceeded the safe size limit. Outcome may be uncertain."); return; }
          chunks.push(chunk);
        });
        response.once("error", () => fail("Pairing response interrupted. Outcome may be uncertain; do not retry blindly."));
        response.once("aborted", () => fail("Pairing response aborted. Outcome may be uncertain; do not retry blindly."));
        response.once("end", () => {
          if (finished) return;
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            check(payload && Object.keys(payload).sort().join(",") === "credential,paired"
              && payload.paired === true && typeof payload.credential === "string" && CREDENTIAL.test(payload.credential)
              && validSecret(payload.credential.split(".").at(-1)), "Unexpected pairing response. Outcome may be uncertain; no automatic retry was made.");
            finished = true; clearTimeout(timer); resolveCredential(payload.credential);
          } catch { fail("Unexpected pairing response. Outcome may be uncertain; no automatic retry was made."); }
        });
      });
      req.once("error", () => fail("HTTPS pairing request failed. Check CA trust, hostname and connectivity. Outcome may be uncertain; no automatic retry was made."));
      // Absolute deadline, rather than a socket-idle timeout that a slow response can extend.
      timer = setTimeout(() => fail("Pairing request timed out. Outcome may be uncertain; do not retry blindly."), 15000);
      req.once("close", () => {
        if (!finished) fail("Pairing connection closed before completion. Outcome may be uncertain; do not retry blindly.");
      });
      req.end(body);
      // Buffer belongs to the HTTPS writer until it has been flushed; never log it.
    } catch { fail("Pairing request could not be prepared. No automatic retry was made."); }
  });
}

// Same-process handoff: no bearer in argv, process.env, stdout, or a file.
export function validatorSession(credential, { validate = runValidation, recallTest = runSemanticRecall, env = process.env } = {}) {
  check(CREDENTIAL.test(credential), "Invalid credential response; validator access unavailable.");
  let active = true;
  let recallAttempted = false;
  return {
    async recall() {
      check(active, "Credential session is closed.");
      check(!recallAttempted, "Recall was already attempted in this session. Inspect its outcome before authorizing another run.");
      recallAttempted = true;
      try { return await recallTest({ credential }); }
      catch (error) {
        const id = typeof error?.conversationId === "string" && /^[0-9a-f-]{36}$/i.test(error.conversationId)
          ? ` Fresh conversation ID: ${error.conversationId}.` : "";
        throw new PairingClientError(`Recall stopped; no automatic retry was made.${id}`);
      }
    },
    async run(phase, stateFile, resume = false) {
      check(active, "Credential session is closed. Pair again only after checking the previous credential's status.");
      check(["before", "after"].includes(phase), "Choose before or after.");
      try {
        return await validate({ phase, stateFile, resume, env: { ...env,
          SELENE_M46_URL: ORIGIN, SELENE_M46_BEARER: credential }, execArgs: process.execArgv });
      } catch { throw new PairingClientError("Validator did not complete. Preserve its journal and follow the M4.6 recovery guide; no automatic retry was made."); }
    },
    close() { active = false; credential = ""; },
  };
}

export async function main({ args = process.argv.slice(2), input = process.stdin, output = process.stdout,
  preflight = prepareRuntime, readSecret = readHiddenSecret, claim = claimPairing,
  makeSession = validatorSession, makeInterface = createInterface,
} = {}) {
  check(args.length === 0 || (args.length === 1 && args[0] === "--show-secret"),
    "Usage: node scripts/m46PairingClient.js [--show-secret] (no arguments other than this flag; never supply secrets on the command line).");
  check(input.isTTY && output.isTTY, "Run in an interactive terminal; redirection is not supported.");
  const ca = preflight();
  let secret = await readSecret({ input, output, visible: args[0] === "--show-secret" });
  let credential;
  try { credential = await claim(secret, { ca }); } finally { secret = ""; }
  const session = makeSession(credential); credential = "";
  const terminal = makeInterface({ input, output, historySize: 0 });
  output.write("Pairing succeeded. Credential held only in this process. No validation has run.\nKeep this terminal open; quitting loses the credential but does not revoke it.\n");
  try {
    while (true) {
      const command = (await terminal.question("Action [before / resume-before / after / recall / quit]: ")).trim();
      if (command === "quit") break;
      if (command === "recall") {
        try {
          const result = await session.recall();
          output.write(`Recall conversation: ${result.conversationId}\nActual model response: ${JSON.stringify(result.modelResponse)}\n`);
          output.write(`Response mentions Krypton: ${result.answerMentionsKrypton ? "YES" : "NO"}. Exact four-message persistence: verified.\nReview the actual wording to judge semantic correctness.\n`);
        } catch (error) {
          output.write(error instanceof PairingClientError ? `${error.message}\n` : "Recall stopped. Sensitive diagnostics withheld; inspect the fresh conversation before retrying.\n");
        }
        continue;
      }
      if (!["before", "resume-before", "after"].includes(command)) { output.write("Choose an action from the list.\n"); continue; }
      const path = (await terminal.question("Absolute M4.6 journal path (outside repository): ")).trim();
      if (!path) { output.write("A journal path is required.\n"); continue; }
      try {
        await session.run(command === "after" ? "after" : "before", path, command === "resume-before");
        output.write(command === "after" ? "AFTER passed.\n" : "BEFORE passed. Await a separately authorized Core restart before AFTER.\n");
      } catch { output.write("Validation stopped. Preserve the journal; consult the recovery guide before choosing another action.\n"); }
    }
  } finally { terminal.close(); session.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) {
    console.error(error instanceof PairingClientError ? error.message : "Pairing client stopped. Sensitive diagnostics withheld; inspect session status before retrying.");
    process.exitCode = 1;
  }
}
