import http from "node:http";
import { readFile } from "node:fs/promises";
import {
  CompanionChatValidationError,
  handleCompanionChat,
} from "./companionChat.js";

export const COMPANION_HOST = "127.0.0.1";
export const COMPANION_LAN_HOST = "0.0.0.0";
export const COMPANION_PORT = 8787;
export const COMPANION_MAX_BODY_BYTES = 32 * 1024;

const PACKAGE_URL = new URL("../package.json", import.meta.url);
const ALLOWED_ORIGINS = new Set([
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);

export function resolveCompanionHost(env = process.env) {
  return env.SELENE_COMPANION_LAN === "1"
    ? COMPANION_LAN_HOST
    : COMPANION_HOST;
}

function companionListeningMessage(host, port) {
  if (host === COMPANION_LAN_HOST) {
    return `Selene Companion API listening on port ${port} (LAN mode enabled).`;
  }

  if (host === COMPANION_HOST) {
    return `Selene Companion API listening on http://${host}:${port} (loopback only).`;
  }

  return `Selene Companion API listening on http://${host}:${port} (custom bind).`;
}

async function getCoreVersion() {
  try {
    const pkg = JSON.parse(await readFile(PACKAGE_URL, "utf-8"));
    return String(pkg.version ?? "unknown");
  } catch {
    return "unknown";
  }
}

function corsHeaders(request) {
  const origin = request.headers.origin;

  if (!ALLOWED_ORIGINS.has(origin)) {
    return {};
  }

  return {
      "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Vary": "Origin",
  };
}

function sendJson(request, response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    ...corsHeaders(request),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendNoContent(request, response) {
  response.writeHead(204, {
    ...corsHeaders(request),
    "Content-Length": 0,
  });
  response.end();
}

function sendError(request, response, statusCode, code, message) {
  sendJson(request, response, statusCode, {
    ok: false,
    error: {
      code,
      message,
    },
  });
}

function isJsonContentType(request) {
  const contentType = request.headers["content-type"];

  if (!contentType) {
    return false;
  }

  return String(contentType).toLowerCase().split(";")[0].trim() ===
    "application/json";
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;

    request.setEncoding("utf-8");

    request.on("data", (chunk) => {
      if (tooLarge) {
        return;
      }

      body += chunk;

      if (Buffer.byteLength(body, "utf-8") > COMPANION_MAX_BODY_BYTES) {
        tooLarge = true;
      }
    });

    request.on("end", () => {
      if (tooLarge) {
        reject(new CompanionChatValidationError(
          "REQUEST_TOO_LARGE",
          "Request body is too large.",
        ));
        return;
      }

      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new CompanionChatValidationError(
          "MALFORMED_JSON",
          "Request body must be valid JSON.",
        ));
      }
    });

    request.on("error", reject);
  });
}

async function handleChat(request, response, chatHandler) {
  if (!isJsonContentType(request)) {
    sendError(
      request,
      response,
      415,
      "UNSUPPORTED_CONTENT_TYPE",
      "Content-Type must be application/json.",
    );
    return;
  }

  let payload;

  try {
    payload = await readJsonBody(request);
  } catch (error) {
    if (error instanceof CompanionChatValidationError) {
      sendError(request, response, 400, error.code, error.message);
      return;
    }

    sendError(request, response, 400, "INVALID_REQUEST", "Request could not be read.");
    return;
  }

  try {
    const result = await chatHandler({
      message: payload?.message,
    });

    sendJson(request, response, 200, result);
  } catch (error) {
    if (error instanceof CompanionChatValidationError) {
      sendError(request, response, 400, error.code, error.message);
      return;
    }

    sendError(request, response, 500, "CHAT_FAILED", "Chat request failed.");
  }
}

export function createCompanionServer({
  host = COMPANION_HOST,
  port = COMPANION_PORT,
  machine = "NOVA",
  name = "Selene Core",
  chatHandler = handleCompanionChat,
} = {}) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);

    if (request.method === "OPTIONS") {
      sendNoContent(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(request, response, 200, {
        ok: true,
        name,
        machine,
        version: await getCoreVersion(),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      await handleChat(request, response, chatHandler);
      return;
    }

    if (url.pathname === "/api/chat") {
      sendError(
        request,
        response,
        405,
        "METHOD_NOT_ALLOWED",
        "POST /api/chat is required.",
      );
      return;
    }

    sendJson(request, response, 404, {
      ok: false,
      message: "Not found.",
    });
  });

  return server;
}

export function startCompanionServer({
  host,
  port = COMPANION_PORT,
  env = process.env,
  onListening = console.log,
  onError = console.error,
} = {}) {
  const bindHost = typeof host === "undefined"
    ? resolveCompanionHost(env)
    : host;
  const server = createCompanionServer({ host: bindHost, port });

  return new Promise((resolve) => {
    let settled = false;

    function settle(value) {
      if (settled) {
        return;
      }

      settled = true;
      resolve(value);
    }

    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        onError(
          `Selene Companion API could not start on http://${bindHost}:${port}: port is already in use.`,
        );
        settle(null);
        return;
      }

      onError(
        `Selene Companion API could not start on http://${bindHost}:${port}: ${error.message}`,
      );
      settle(null);
    });

    server.listen(port, bindHost, () => {
      const address = server.address();
      const listeningPort = typeof address === "object" && address
        ? address.port
        : port;
      onListening(companionListeningMessage(bindHost, listeningPort));
      settle(server);
    });
  });
}
