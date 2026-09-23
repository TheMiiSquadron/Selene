import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMemoryService } from "./memory.js";
import { loadModelProfiles } from "./modelProfiles.js";

const execFileAsync = promisify(execFile);
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(SRC_DIR, "..");
const REPO_DIR = resolve(CORE_DIR, "..");

const EXPECTED_PATHS = {
  modelProfiles: resolve(CORE_DIR, "config", "modelProfiles.json"),
  apps: resolve(CORE_DIR, "config", "apps.json"),
  applicationPermissions: resolve(CORE_DIR, "config", "applicationPermissions.json"),
  authority: resolve(CORE_DIR, "config", "authority.json"),
  memory: resolve(CORE_DIR, "config", "memory.json"),
  discoverApps: resolve(CORE_DIR, "config", "apps.json"),
  log: resolve(CORE_DIR, "logs", "nova.log"),
};

async function importCanonicalPathsFrom(cwd) {
  const code = `
    import { DEFAULT_MODEL_PROFILE_PATH } from ${JSON.stringify(pathToFileURL(join(SRC_DIR, "modelProfiles.js")).href)};
    import { APPS_PATH, APP_PERMISSIONS_PATH } from ${JSON.stringify(pathToFileURL(join(SRC_DIR, "apps.js")).href)};
    import { AUTHORITY_PATH } from ${JSON.stringify(pathToFileURL(join(SRC_DIR, "authority.js")).href)};
    import { DEFAULT_MEMORY_PATH } from ${JSON.stringify(pathToFileURL(join(SRC_DIR, "memory.js")).href)};
    import { DISCOVER_APPS_PATH } from ${JSON.stringify(pathToFileURL(join(SRC_DIR, "discoverApps.js")).href)};
    import { LOG_PATH } from ${JSON.stringify(pathToFileURL(join(SRC_DIR, "logger.js")).href)};

    console.log(JSON.stringify({
      modelProfiles: DEFAULT_MODEL_PROFILE_PATH,
      apps: APPS_PATH,
      applicationPermissions: APP_PERMISSIONS_PATH,
      authority: AUTHORITY_PATH,
      memory: DEFAULT_MEMORY_PATH,
      discoverApps: DISCOVER_APPS_PATH,
      log: LOG_PATH
    }));
  `;

  const { stdout } = await execFileAsync(process.execPath, [
    "--input-type=module",
    "--eval",
    code,
  ], {
    cwd,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });

  return JSON.parse(stdout);
}

test("Core application paths are stable from the Core root cwd", async () => {
  assert.deepEqual(await importCanonicalPathsFrom(CORE_DIR), EXPECTED_PATHS);
});

test("Core application paths are stable from the Core src cwd", async () => {
  assert.deepEqual(await importCanonicalPathsFrom(SRC_DIR), EXPECTED_PATHS);
});

test("Core application paths are stable from an unrelated cwd", async () => {
  const directory = await mkdtemp(join(tmpdir(), "selene-paths-cwd-"));
  try {
    assert.deepEqual(await importCanonicalPathsFrom(directory), EXPECTED_PATHS);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("model profile custom path injection remains intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "selene-model-profiles-"));
  const profilePath = join(directory, "custom-modelProfiles.json");

  try {
    await writeFile(profilePath, JSON.stringify({
      roles: {
        fast: { model: "custom-fast" },
        primary: { model: "custom-primary" },
        specialized: { fallbackToDefault: true },
      },
    }), "utf-8");

    const loaded = await loadModelProfiles({ profilePath });
    assert.equal(loaded.roles.fast.model, "custom-fast");
    assert.equal(loaded.roles.primary.model, "custom-primary");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("memory custom path injection remains intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "selene-memory-paths-"));
  const memoryPath = join(directory, "custom-memory.json");

  try {
    const service = createMemoryService({ memoryPath });
    assert.equal(service.memoryPath, resolve(memoryPath));

    await service.setMemoryEntry("preferences", "path.test", { ok: true });
    assert.deepEqual(JSON.parse(await readFile(memoryPath, "utf-8")), {
      preferences: {
        "path.test": { ok: true },
      },
      appAliases: {},
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
