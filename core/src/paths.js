import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CORE_SRC_DIR = dirname(fileURLToPath(import.meta.url));
export const CORE_ROOT_DIR = resolve(CORE_SRC_DIR, "..");

export function coreConfigPath(...segments) {
  return resolve(CORE_ROOT_DIR, "config", ...segments);
}

export function coreLogPath(...segments) {
  return resolve(CORE_ROOT_DIR, "logs", ...segments);
}
