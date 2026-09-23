import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { coreLogPath } from "./paths.js";

export const LOG_PATH = coreLogPath("nova.log");

export async function logEvent(event) {
  await mkdir(dirname(LOG_PATH), { recursive: true });
  await appendFile(
    LOG_PATH,
    JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n",
    "utf-8",
  );
}
