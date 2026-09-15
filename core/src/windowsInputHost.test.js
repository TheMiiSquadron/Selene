import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

function runHost(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn("python.exe", ["src/windowsInputHost.py"], {
      cwd: new URL("..", import.meta.url),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `windowsInputHost exited with code ${code}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.end(JSON.stringify(payload));
  });
}

function diagnoseText(text) {
  return runHost({ mode: "diagnose_text", text });
}

function diagnoseShortcut(shortcut) {
  return runHost({ mode: "diagnose_shortcut", shortcut });
}

function expectedUtf16CodeUnits(text) {
  const encoded = Buffer.from(text, "utf16le");
  const units = [];
  for (let index = 0; index < encoded.length; index += 2) {
    units.push(encoded[index] | (encoded[index + 1] << 8));
  }
  return units;
}

function compactEvents(result) {
  return result.events.map((event) => ({
    vk: event.vk,
    scan: event.scan,
    flags: event.flags,
  }));
}

async function assertUnicodeEvents(text) {
  const result = await diagnoseText(text);
  const expectedUnits = expectedUtf16CodeUnits(text);

  assert.equal(result.ok, true);
  assert.equal(result.text, text);
  assert.deepEqual(result.codeUnits, expectedUnits);
  assert.equal(result.events.length, expectedUnits.length * 2);
  assert.equal(result.batches.length, expectedUnits.length);
  assert.equal(result.settleMilliseconds, 15);
  assert.equal(result.inputArray.length, expectedUnits.length * 2);
  assert.equal(result.inputSize, 40);

  for (const [unitIndex, codeUnit] of expectedUnits.entries()) {
    const downIndex = unitIndex * 2;
    const upIndex = downIndex + 1;

    assert.deepEqual(result.events[downIndex], {
      vk: 0,
      scan: codeUnit,
      flags: 4,
    });
    assert.deepEqual(result.events[upIndex], {
      vk: 0,
      scan: codeUnit,
      flags: 6,
    });

    assert.equal(result.inputArray[downIndex].scan, codeUnit);
    assert.equal(result.inputArray[downIndex].flags, 4);
    assert.equal(result.inputArray[upIndex].scan, codeUnit);
    assert.equal(result.inputArray[upIndex].flags, 6);
    assert.notEqual(result.inputArray[downIndex].address, result.inputArray[upIndex].address);
    assert.deepEqual(result.batches[unitIndex], [
      result.events[downIndex],
      result.events[upIndex],
    ]);
  }

  const addresses = new Set(result.inputArray.map((event) => event.address));
  assert.equal(addresses.size, result.inputArray.length);
}

test("diagnostic unicode SendInput events preserve Hello from Selene", async () => {
  await assertUnicodeEvents("Hello from Selene");
});

test("diagnostic unicode SendInput events preserve simple lowercase text", async () => {
  await assertUnicodeEvents("abcdef");
});

test("diagnostic unicode SendInput events preserve Selene", async () => {
  await assertUnicodeEvents("Selene");
});

test("diagnostic unicode SendInput events preserve numbers and spaces", async () => {
  await assertUnicodeEvents("Hello 123");
});

test("diagnostic unicode SendInput events preserve surrogate pairs", async () => {
  await assertUnicodeEvents("Moon 🌙");
});

test("diagnostic foreground unlock events use independent key objects", async () => {
  const result = await runHost({ mode: "diagnose_foreground_unlock" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.events, [
    { vk: 18, scan: 0, flags: 0 },
    { vk: 18, scan: 0, flags: 2 },
  ]);
  assert.equal(result.inputArray.length, 2);
  assert.deepEqual(compactEvents(result), result.events);
  assert.notEqual(result.inputArray[0].address, result.inputArray[1].address);
});

test("diagnostic shortcut events preserve Ctrl+A modifier order", async () => {
  const result = await diagnoseShortcut("ctrl+a");

  assert.equal(result.ok, true);
  assert.deepEqual(compactEvents(result), [
    { vk: 17, scan: 0, flags: 0 },
    { vk: 65, scan: 0, flags: 0 },
    { vk: 65, scan: 0, flags: 2 },
    { vk: 17, scan: 0, flags: 2 },
  ]);
});

test("diagnostic shortcut events preserve Shift+Tab modifier order", async () => {
  const result = await diagnoseShortcut("shift+tab");

  assert.equal(result.ok, true);
  assert.deepEqual(compactEvents(result), [
    { vk: 16, scan: 0, flags: 0 },
    { vk: 9, scan: 0, flags: 0 },
    { vk: 9, scan: 0, flags: 2 },
    { vk: 16, scan: 0, flags: 2 },
  ]);
});

test("diagnostic shortcut events preserve single-key shortcuts", async () => {
  const result = await diagnoseShortcut("enter");

  assert.equal(result.ok, true);
  assert.deepEqual(compactEvents(result), [
    { vk: 13, scan: 0, flags: 0 },
    { vk: 13, scan: 0, flags: 2 },
  ]);
});

test("diagnostic shortcut release runs after simulated modifier dispatch failure", async () => {
  const result = await runHost({
    mode: "diagnose_shortcut_release",
    shortcut: "ctrl+a",
    failAfterBatches: 1,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.batches, [
    [{ vk: 17, scan: 0, flags: 0 }],
    [{ vk: 17, scan: 0, flags: 2 }],
  ]);
});
