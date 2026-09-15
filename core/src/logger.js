import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const LOG_PATH = resolve("logs", "nova.log");

export async function logEvent(event) {
  await mkdir(dirname(LOG_PATH), { recursive: true });
  await appendFile(
    LOG_PATH,
    JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n",
    "utf-8",
  );
}
