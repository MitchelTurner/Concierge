import { loadConfig } from "./config.js";
import { initDb } from "./db.js";
import { createBot } from "./bot.js";

/**
 * One-shot: build today's allocation, send it once, and exit. This is the
 * drop-in entry point for a GitHub Actions cron (npm run daily).
 */
async function runOnce(): Promise<void> {
  const config = loadConfig();
  initDb();

  const { sendDailyMessage } = createBot(config);
  await sendDailyMessage();
  console.log("[daily] sent today's allocation.");
}

runOnce()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[daily] failed:", err.message ?? err);
    process.exit(1);
  });
