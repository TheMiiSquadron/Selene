import test from "node:test";
import assert from "node:assert/strict";
import {
  createModelManager,
  ModelManagerError,
  parseLmsPs,
} from "./modelManager.js";

const profiles = {
  roles: {
    fast: {
      model: "google/gemma-4-26b-a4b",
      apiId: "selene-gemma4-26b-a4b",
      residency: {
        modelKey: "google/gemma-4-26b-a4b",
        apiId: "selene-gemma4-26b-a4b",
        gpu: "max",
        contextLength: 16384,
        loadTimeoutMs: 25,
        pollIntervalMs: 1,
      },
      settings: {},
    },
    primary: {
      model: "meta/muse-glimmer",
      apiId: "selene-muse-glimmer-30b",
      residency: {
        modelKey: "meta/muse-glimmer",
        apiId: "selene-muse-glimmer-30b",
        gpu: "max",
        contextLength: 16384,
        loadTimeoutMs: 25,
        pollIntervalMs: 1,
      },
      settings: {},
    },
    specialized: {
      model: "",
      fallbackToDefault: true,
      residency: {
        modelKey: "",
        apiId: "",
        gpu: "",
        contextLength: null,
      },
      settings: {},
    },
  },
};

function psOutput(residents) {
  const lines = [
    "IDENTIFIER               MODEL                     STATUS    SIZE        CONTEXT    PARALLEL    DEVICE    TTL",
  ];

  for (const resident of residents) {
    lines.push([
      resident.identifier,
      resident.modelKey,
      resident.status ?? "IDLE",
      resident.size ?? "17.99 GB",
      String(resident.context ?? 16384),
      String(resident.parallel ?? 4),
      resident.device ?? "Local",
      resident.ttl ?? "",
    ].join("    "));
  }

  return `\n${lines.join("\n")}\n`;
}

function createMockLms(initialResidents = [], {
  failLoad = false,
  failUnload = false,
  loadDoesNotAppear = false,
} = {}) {
  const calls = [];
  const residents = [...initialResidents];

  async function runLms(args) {
    calls.push(args);

    if (args[0] === "ps") {
      return {
        ok: true,
        status: 0,
        stdout: psOutput(residents),
        stderr: "",
      };
    }

    if (args[0] === "unload") {
      if (failUnload) {
        return {
          ok: false,
          status: 1,
          stdout: "",
          stderr: "unload failed",
        };
      }

      residents.length = 0;
      return { ok: true, status: 0, stdout: "", stderr: "" };
    }

    if (args[0] === "load") {
      if (failLoad) {
        return {
          ok: false,
          status: 1,
          stdout: "",
          stderr: "load failed",
        };
      }

      if (!loadDoesNotAppear) {
        const identifierIndex = args.indexOf("--identifier");
        const contextIndex = args.indexOf("--context-length");
        residents.push({
          identifier: args[identifierIndex + 1],
          modelKey: args[1],
          status: "IDLE",
          context: Number.parseInt(args[contextIndex + 1], 10),
        });
      }

      return { ok: true, status: 0, stdout: "", stderr: "" };
    }

    return {
      ok: false,
      status: 1,
      stdout: "",
      stderr: `unexpected lms command: ${args.join(" ")}`,
    };
  }

  return { calls, residents, runLms };
}

test("parseLmsPs reads resident model rows", () => {
  const rows = parseLmsPs(psOutput([
    {
      identifier: "selene-gemma4-26b-a4b",
      modelKey: "google/gemma-4-26b-a4b",
      status: "IDLE",
      context: 16384,
    },
  ]));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].identifier, "selene-gemma4-26b-a4b");
  assert.equal(rows[0].modelKey, "google/gemma-4-26b-a4b");
  assert.equal(rows[0].status, "IDLE");
  assert.equal(rows[0].context, 16384);
});

test("fast request when Gemma is already resident does not reload", async () => {
  const lms = createMockLms([
    {
      identifier: "selene-gemma4-26b-a4b",
      modelKey: "google/gemma-4-26b-a4b",
    },
  ]);
  const manager = createModelManager({
    loadProfiles: async () => profiles,
    runLms: lms.runLms,
  });

  const residency = await manager.ensureRoleReady("fast");

  assert.equal(residency.modelAlreadyLoaded, true);
  assert.equal(residency.residentIdentifierAfter, "selene-gemma4-26b-a4b");
  assert.deepEqual(lms.calls.map((args) => args[0]), ["ps"]);
});

test("fast request with wrong resident model unloads and loads Gemma", async () => {
  const lms = createMockLms([
    {
      identifier: "selene-muse-glimmer-30b",
      modelKey: "meta/muse-glimmer",
    },
  ]);
  const manager = createModelManager({
    loadProfiles: async () => profiles,
    runLms: lms.runLms,
  });

  const residency = await manager.ensureRoleReady("fast");

  assert.equal(residency.modelAlreadyLoaded, false);
  assert.equal(residency.residentIdentifierAfter, "selene-gemma4-26b-a4b");
  assert.deepEqual(lms.calls[1], ["unload", "--all"]);
  assert.deepEqual(lms.calls[2], [
    "load",
    "google/gemma-4-26b-a4b",
    "--identifier",
    "selene-gemma4-26b-a4b",
    "--gpu",
    "max",
    "--context-length",
    "16384",
    "--yes",
  ]);
});

test("primary request loads Muse, generates, then restores Gemma", async () => {
  const lms = createMockLms([
    {
      identifier: "selene-gemma4-26b-a4b",
      modelKey: "google/gemma-4-26b-a4b",
    },
  ]);
  const manager = createModelManager({
    loadProfiles: async () => profiles,
    runLms: lms.runLms,
  });

  const response = await manager.runWithRoleReady("primary", async ({ profile }) => {
    assert.equal(profile.apiId, "selene-muse-glimmer-30b");
    return "generated";
  });

  assert.equal(response.result, "generated");
  assert.equal(response.residency.recoveryAttempted, true);
  assert.equal(response.residency.recoverySucceeded, true);
  assert.equal(response.residency.residentIdentifierAfter, "selene-gemma4-26b-a4b");
  assert.deepEqual(lms.calls.filter((args) => args[0] === "load").map((args) => args[1]), [
    "meta/muse-glimmer",
    "google/gemma-4-26b-a4b",
  ]);
});

test("primary generation failure still attempts Gemma restore", async () => {
  const lms = createMockLms([
    {
      identifier: "selene-gemma4-26b-a4b",
      modelKey: "google/gemma-4-26b-a4b",
    },
  ]);
  const manager = createModelManager({
    loadProfiles: async () => profiles,
    runLms: lms.runLms,
  });

  await assert.rejects(
    () => manager.runWithRoleReady("primary", async () => {
      throw new Error("generation failed");
    }),
    /generation failed/,
  );

  assert.deepEqual(lms.calls.filter((args) => args[0] === "load").map((args) => args[1]), [
    "meta/muse-glimmer",
    "google/gemma-4-26b-a4b",
  ]);
});

test("simultaneous requests serialize and expose queueWaitMs", async () => {
  const lms = createMockLms([
    {
      identifier: "selene-gemma4-26b-a4b",
      modelKey: "google/gemma-4-26b-a4b",
    },
  ]);
  const manager = createModelManager({
    loadProfiles: async () => profiles,
    runLms: lms.runLms,
  });
  let releaseFirst;
  const firstDone = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const order = [];

  const first = manager.runWithRoleReady("fast", async () => {
    order.push("first-start");
    await firstDone;
    order.push("first-end");
    return "first";
  });

  const second = manager.runWithRoleReady("fast", async () => {
    order.push("second-start");
    return "second";
  });

  await Promise.resolve();
  releaseFirst();
  const results = await Promise.all([first, second]);

  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
  assert.equal(typeof results[1].residency.queueWaitMs, "number");
  assert.equal(lms.calls.filter((args) => args[0] === "load").length, 0);
});

test("load failure returns a clear model manager error", async () => {
  const lms = createMockLms([], { failLoad: true });
  const manager = createModelManager({
    loadProfiles: async () => profiles,
    runLms: lms.runLms,
  });

  await assert.rejects(
    () => manager.ensureRoleReady("fast"),
    ModelManagerError,
  );
});

test("unload failure returns a clear model manager error", async () => {
  const lms = createMockLms([
    {
      identifier: "other-model",
      modelKey: "other/model",
    },
  ], { failUnload: true });
  const manager = createModelManager({
    loadProfiles: async () => profiles,
    runLms: lms.runLms,
  });

  await assert.rejects(
    () => manager.ensureRoleReady("fast"),
    /Unable to unload/,
  );
});

test("waiting for residency times out if loaded model never appears", async () => {
  const lms = createMockLms([], { loadDoesNotAppear: true });
  let ticks = 0;
  const manager = createModelManager({
    loadProfiles: async () => profiles,
    runLms: lms.runLms,
    sleepFn: async () => {},
    now: () => BigInt(++ticks * 10_000_000),
  });

  await assert.rejects(
    () => manager.ensureRoleReady("fast"),
    /Timed out waiting/,
  );
});

test("unknown roles fail closed before lms load", async () => {
  const lms = createMockLms([]);
  const manager = createModelManager({
    loadProfiles: async () => profiles,
    runLms: lms.runLms,
  });

  await assert.rejects(
    () => manager.ensureRoleReady("gemma"),
    /Unknown model role/,
  );

  assert.equal(lms.calls.length, 0);
});
