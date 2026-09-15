import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getModelId } from "./lmStudio.js";
import { runNovaCommand } from "./commandPipeline.js";
import { startCompanionServer } from "./companionServer.js";

async function main() {
  console.log("Selene Core v0.3.2");
  const companionServer = await startCompanionServer();
  let companionClosed = false;

  function closeCompanionServer() {
    return new Promise((resolve) => {
      if (!companionServer || companionClosed) {
        resolve();
        return;
      }

      companionServer.close(() => {
        companionClosed = true;
        resolve();
      });
    });
  }

  async function shutdown() {
    await closeCompanionServer();
    process.exit(0);
  }

  process.once("SIGINT", () => {
    shutdown();
  });

  process.once("SIGTERM", () => {
    shutdown();
  });

  console.log("Connecting to LM Studio...");

  let model;

  try {
    model = await getModelId();
  } catch (error) {
    console.error(error.message);
    await closeCompanionServer();
    return;
  }

  console.log(`Model: ${model}`);
  console.log("Aliases: enabled");
  console.log("Detached app output: suppressed");
  console.log('Type "exit" to quit.\n');

  const rl = readline.createInterface({ input, output });

  try {
    while (true) {
      const userText = (await rl.question("You > ")).trim();

      if (!userText) continue;
      if (["exit", "quit"].includes(userText.toLowerCase())) break;

      try {
        const response = await runNovaCommand(userText, { model });

        console.log(`Selene > ${response.message}`);

        if (response.route === "fast") {
          console.log(`[route=fast total=${response.totalMs.toFixed(0)} ms]\n`);
        } else {
          console.log(
            `[route=model first=${response.firstModelMs.toFixed(0)} ms tool=${response.toolMs.toFixed(0)} ms total=${response.totalMs.toFixed(0)} ms]\n`,
          );
        }
      } catch (error) {
        console.error(`Selene error > ${error.message}\n`);
      }
    }
  } finally {
    rl.close();
    await closeCompanionServer();
  }
}

main();
