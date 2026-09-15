import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadAuthorityConfig,
  saveAuthorityConfig,
  setDefaultAuthority,
} from "./authority.js";
import { createMemoryService } from "./memory.js";
import { tryFastRoute } from "./router.js";
import { openApp } from "./tools.js";

const apps = {
  chrome: {
    id: "chrome",
    name: "Chrome",
    aliases: ["browser"],
    source: "manual",
    launch: {
      type: "exe",
      target: "C:\\Windows\\System32\\notepad.exe",
    },
  },
  firefox: {
    id: "firefox",
    name: "Firefox",
    aliases: ["firefox"],
    source: "manual",
    launch: {
      type: "exe",
      target: "C:\\Windows\\System32\\notepad.exe",
    },
  },
};

function launcher(launched = []) {
  return (command, args) => {
    launched.push({ command, args });
    return { ok: true, processId: 1234 };
  };
}

function memoryService(appAliases = {}) {
  return {
    async readMemory(category) {
      assert.equal(category, "appAliases");
      return appAliases;
    },
  };
}

async function createTempMemoryService() {
  const directory = await mkdtemp(join(tmpdir(), "selene-memory-integration-"));
  return createMemoryService({ memoryPath: join(directory, "memory.json") });
}

test("with no remembered alias, Open browser preserves existing registry behavior", async () => {
  const originalAuthority = await loadAuthorityConfig();
  const launched = [];

  try {
    await setDefaultAuthority(4);

    const result = await openApp("browser", {
      apps,
      permissions: {},
      memoryService: memoryService({}),
      launcher: launcher(launched),
    });

    assert.equal(result.ok, true);
    assert.equal(result.appId, "chrome");
    assert.equal(result.appName, "Chrome");
    assert.equal(launched.length, 1);
  } finally {
    await saveAuthorityConfig(originalAuthority);
  }
});

test("appAliases.browser = Firefox makes Open browser resolve to Firefox", async () => {
  const originalAuthority = await loadAuthorityConfig();
  const launched = [];

  try {
    await setDefaultAuthority(4);

    const result = await openApp("browser", {
      apps,
      permissions: {},
      memoryService: memoryService({ browser: "Firefox" }),
      launcher: launcher(launched),
    });

    assert.equal(result.ok, true);
    assert.equal(result.appId, "firefox");
    assert.equal(result.appName, "Firefox");
    assert.equal(launched.length, 1);
  } finally {
    await saveAuthorityConfig(originalAuthority);
  }
});

test("application permissions are still enforced after memory alias resolution", async () => {
  const originalAuthority = await loadAuthorityConfig();
  const launched = [];

  try {
    await setDefaultAuthority(4);

    const result = await openApp("browser", {
      apps,
      permissions: { firefox: false },
      memoryService: memoryService({ browser: "Firefox" }),
      launcher: launcher(launched),
    });

    assert.equal(result.ok, false);
    assert.equal(result.disabled, true);
    assert.match(result.error, /firefox.*not enabled/i);
    assert.equal(launched.length, 0);
  } finally {
    await saveAuthorityConfig(originalAuthority);
  }
});

test("authority is still enforced before memory alias launch", async () => {
  const originalAuthority = await loadAuthorityConfig();
  const launched = [];

  try {
    await setDefaultAuthority(2);

    const result = await openApp("browser", {
      apps,
      permissions: {},
      memoryService: memoryService({ browser: "Firefox" }),
      launcher: launcher(launched),
    });

    assert.equal(result.ok, false);
    assert.equal(result.needsApproval, true);
    assert.equal(result.action, "open_app");
    assert.equal(result.requiredLevel, 3);
    assert.equal(launched.length, 0);
  } finally {
    await saveAuthorityConfig(originalAuthority);
  }
});

test("invalid remembered alias targets fail safely without model fallback", async () => {
  const originalAuthority = await loadAuthorityConfig();

  try {
    await setDefaultAuthority(4);

    const result = await tryFastRoute("Open browser", {
      apps,
      permissions: {},
      memoryService: memoryService({ browser: "Unregistered Browser" }),
      launcher: launcher(),
    });

    assert.equal(result.handled, true);
    assert.equal(result.result.ok, false);
    assert.equal(result.result.aliasResolutionFailed, true);
    assert.equal(result.result.memoryAlias.target, "Unregistered Browser");
    assert.match(result.result.reason, /approved application registry/i);
  } finally {
    await saveAuthorityConfig(originalAuthority);
  }
});

test("deleting an alias restores previous registry behavior", async () => {
  const originalAuthority = await loadAuthorityConfig();
  const service = await createTempMemoryService();
  const launched = [];

  try {
    await setDefaultAuthority(4);
    await service.setMemoryEntry("appAliases", "browser", "Firefox");
    await service.deleteMemoryEntry("appAliases", "browser");

    const result = await openApp("browser", {
      apps,
      permissions: {},
      memoryService: service,
      launcher: launcher(launched),
    });

    assert.equal(result.ok, true);
    assert.equal(result.appId, "chrome");
    assert.equal(launched.length, 1);
  } finally {
    await saveAuthorityConfig(originalAuthority);
  }
});

test("remembered app alias matching is case-insensitive", async () => {
  const originalAuthority = await loadAuthorityConfig();

  try {
    await setDefaultAuthority(4);

    const result = await openApp("BROWSER", {
      apps,
      permissions: {},
      memoryService: memoryService({ Browser: "Firefox" }),
      launcher: launcher(),
    });

    assert.equal(result.ok, true);
    assert.equal(result.appId, "firefox");
  } finally {
    await saveAuthorityConfig(originalAuthority);
  }
});
