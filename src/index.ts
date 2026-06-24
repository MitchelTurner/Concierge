import { loadConfig } from "./config.js";
import { initDb } from "./db.js";
import { createBot } from "./bot.js";
import { startScheduler } from "./scheduler.js";

async function main(): Promise<void> {
  const config = loadConfig();

  initDb();
  console.log("[db] ready");

  const { bot, sendDailyMessage } = createBot(config);

  startScheduler(config, sendDailyMessage);

  // Launch the bot (long-running). launch() resolves only when the bot stops,
  // so we don't await it here; we only catch a failed startup (e.g. bad token).
  bot
    .launch(() => {
      console.log("[bot] online and listening for commands");
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[bot] failed to launch: ${msg}`);
      console.error(
        "Check TELEGRAM_BOT_TOKEN is correct (from @BotFather). See README."
      );
      process.exit(1);
    });

  const shutdown = (signal: string) => {
    console.log(`\n[operator] received ${signal}, shutting down...`);
    bot.stop(signal);
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[operator] fatal:", err.message ?? err);
  process.exit(1);
});
