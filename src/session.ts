import { readFileSync } from "fs";
import { Snake } from "tgsnake";
import readline from "readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

(async () => {
  console.log("Loading interactive example...");
  const bot = new Snake({
    apiHash: readFileSync("./api_hash").toString(),
    apiId: parseInt(readFileSync("./api_id").toString()),
    session: "",
    tgsnakeLog: false,
    logger: "error",
    storeSession: false,
  });

  await bot.start();

  console.log(`Check your Saved Message!`); // Save this string to avoid logging in again
  await bot.client.sendMessage("me", { message: `${bot.client.session.save()}` });
  await bot.disconnect();
  process.exit(0);
})();
