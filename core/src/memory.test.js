import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MemoryValidationError,
  createMemoryService,
  validateMemoryStore,
} from "./memory.js";

async function createTempMemoryService() {
  const directory = await mkdtemp(join(tmpdir(), "selene-memory-test-"));
  const memoryPath = join(directory, "memory.json");
  return createMemoryService({ memoryPath });
}

test("empty memory initializes correctly", async () => {
  const memory = await (await createTempMemoryService()).loadMemory();

  assert.deepEqual(memory, {
    preferences: {},
    appAliases: {},
  });
});

test("a preference can be written and read", async () => {
  const service = await createTempMemoryService();

  await service.setMemoryEntry("preferences", "tone", "minimal");

  assert.equal(await service.readMemory("preferences", "tone"), "minimal");
});

test("an app alias can be written and read", async () => {
  const service = await createTempMemoryService();

  await service.setMemoryEntry("appAliases", "browser", "Firefox");

  assert.equal(await service.readMemory("appAliases", "browser"), "Firefox");
});

test("values persist after recreating the memory service", async () => {
  const service = await createTempMemoryService();
  await service.setMemoryEntry("appAliases", "browser", "Firefox");

  const reloaded = createMemoryService({ memoryPath: service.memoryPath });

  assert.equal(await reloaded.readMemory("appAliases", "browser"), "Firefox");
});

test("an entry can be deleted", async () => {
  const service = await createTempMemoryService();
  await service.setMemoryEntry("appAliases", "browser", "Firefox");

  assert.deepEqual(await service.deleteMemoryEntry("appAliases", "browser"), {
    category: "appAliases",
    key: "browser",
    deleted: true,
  });
  assert.equal(await service.readMemory("appAliases", "browser"), null);
});

test("unknown categories are rejected", async () => {
  const service = await createTempMemoryService();

  await assert.rejects(
    service.setMemoryEntry("projects", "alpha", "nope"),
    MemoryValidationError,
  );
});

test("invalid input fails safely", async () => {
  const service = await createTempMemoryService();

  await assert.rejects(
    service.setMemoryEntry("preferences", "../secret", true),
    MemoryValidationError,
  );
  await assert.rejects(
    service.setMemoryEntry("appAliases", "browser", ""),
    /non-empty strings/,
  );
  await assert.rejects(
    service.setMemoryEntry("preferences", "large", "x".repeat(5000)),
    /4096 bytes/,
  );
});

test("a malformed memory file does not crash Core", async () => {
  const service = await createTempMemoryService();
  await writeFile(service.memoryPath, "{ not json", "utf-8");

  assert.deepEqual(await service.loadMemory(), {
    preferences: {},
    appAliases: {},
  });
});

test("malformed entries are skipped while valid entries survive", async () => {
  assert.deepEqual(validateMemoryStore({
    preferences: {
      good: { compact: true },
      "../bad": true,
    },
    appAliases: {
      browser: "Firefox",
      empty: "",
    },
    unknown: {
      ignored: true,
    },
  }), {
    preferences: {
      good: { compact: true },
    },
    appAliases: {
      browser: "Firefox",
    },
  });
});

test("writes use the expected JSON schema", async () => {
  const service = await createTempMemoryService();
  await service.setMemoryEntry("preferences", "routine.confirmations", "short");

  assert.deepEqual(JSON.parse(await readFile(service.memoryPath, "utf-8")), {
    preferences: {
      "routine.confirmations": "short",
    },
    appAliases: {},
  });
});
