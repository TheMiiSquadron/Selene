import { spawn } from "node:child_process";
import {
  elevateAuthority,
  loadAuthorityConfig,
  resetAuthority,
  saveAuthorityConfig,
  setDefaultAuthority,
} from "../src/authority.js";
import { runNovaCommand } from "../src/commandPipeline.js";

const DEFAULT_RUNS = 3;

function parseRuns() {
  const argIndex = process.argv.indexOf("--runs");
  const raw = argIndex >= 0 ? process.argv[argIndex + 1] : process.env.SELENE_STRESS_RUNS;
  const parsed = Number.parseInt(raw ?? DEFAULT_RUNS, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_RUNS;
  return Math.min(parsed, 20);
}

function shouldKeepWindows() {
  return process.argv.includes("--keep-windows");
}

function runFixedProcess(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
    });

    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
}

async function closeTestApps() {
  await runFixedProcess("taskkill.exe", ["/f", "/im", "notepad.exe"]);
  await runFixedProcess("taskkill.exe", ["/f", "/im", "CalculatorApp.exe"]);
  await runFixedProcess("taskkill.exe", ["/f", "/im", "Calculator.exe"]);
}

async function runCommand(text) {
  const result = await runNovaCommand(text);
  return {
    text,
    ok: result.ok,
    action: result.action,
    message: result.message,
    completedActions: result.completedActions,
    reason: result.reason ?? result.error ?? "",
  };
}

async function main() {
  const originalAuthority = await loadAuthorityConfig();
  const runs = parseRuns();
  const keepWindows = shouldKeepWindows();
  const results = [];

  try {
    await closeTestApps();
    await setDefaultAuthority(4);
    await elevateAuthority({ level: 5, minutes: 5 });

    for (let index = 1; index <= runs; index += 1) {
      const first = `Selene stress ${index}`;
      const replacement = `Selene replace ${index}`;

      results.push(await runCommand(`Open Notepad, type ${first}, then select all`));
      results.push(await runCommand(`Open Notepad, type ${replacement}, then select all`));
      results.push(await runCommand("Undo"));
      results.push(await runCommand("Redo"));

      if (!keepWindows) {
        await closeTestApps();
      }
    }

    const failures = results.filter((result) => !result.ok);
    console.table(results.map((result) => ({
      ok: result.ok,
      action: result.action,
      message: result.message,
      reason: result.reason,
    })));

    if (failures.length) {
      process.exitCode = 1;
    }
  } finally {
    await resetAuthority();
    await saveAuthorityConfig(originalAuthority);
    if (!keepWindows) {
      await closeTestApps();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
