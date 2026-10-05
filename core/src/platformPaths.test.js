import test from "node:test";
import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import {
  PlatformPathValidationError,
  resolveSeleneProductionDataDirectory,
} from "./platformPaths.js";

test("Windows production data directory preserves the LOCALAPPDATA Selene location", () => {
  const localAppData = "C:\\Users\\Selene\\AppData\\Local";

  assert.equal(
    resolveSeleneProductionDataDirectory({
      platform: "win32",
      env: { LOCALAPPDATA: localAppData },
    }),
    win32.resolve(localAppData, "Selene"),
  );
});

test("macOS production data directory uses Application Support beneath HOME", () => {
  const home = "/Users/selene";

  assert.equal(
    resolveSeleneProductionDataDirectory({
      platform: "darwin",
      env: { HOME: home },
    }),
    posix.resolve(home, "Library", "Application Support", "Selene"),
  );
});

test("production data directory fails closed when the required base path is missing", () => {
  assert.throws(
    () => resolveSeleneProductionDataDirectory({ platform: "win32", env: {} }),
    PlatformPathValidationError,
  );
  assert.throws(
    () => resolveSeleneProductionDataDirectory({ platform: "darwin", env: {} }),
    PlatformPathValidationError,
  );
});

test("production data directory rejects relative base paths", () => {
  assert.throws(
    () => resolveSeleneProductionDataDirectory({
      platform: "win32",
      env: { LOCALAPPDATA: "relative\\local" },
    }),
    PlatformPathValidationError,
  );
  assert.throws(
    () => resolveSeleneProductionDataDirectory({
      platform: "darwin",
      env: { HOME: "relative/home" },
    }),
    PlatformPathValidationError,
  );
});

test("unsupported platforms fail closed", () => {
  assert.throws(
    () => resolveSeleneProductionDataDirectory({
      platform: "linux",
      env: { HOME: "/home/selene" },
    }),
    PlatformPathValidationError,
  );
});
