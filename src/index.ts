import { loadConfig } from "./config.js";
import { initDb } from "./db.js";
import { createBot } from "./bot.js";
import { startScheduler } from "./scheduler.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();

  initDb();
  console.log("[db] ready");

  const { bot, sendDailyMessage } = createBot(config);

  startScheduler(config, sendDailyMessage);

  // Web dashboard is opt-in: only started when a password is configured, so
  // it can never be exposed to the internet unauthenticated.
  if (config.dashboardPassword) {
    startServer(config);
  } else {
    console.log(
      "[web] dashboard disabled (set DASHBOARD_PASSWORD to enable it)"
    );
  }

  // Launch the bot (long-running). A launch failure must NOT take down the web
  // dashboard, so we never exit the process here — we log and, for transient
  // errors (e.g. a 409 Conflict during an overlapping deploy), retry with
  // backoff. dropPendingUpdates clears any stale getUpdates offset.
  let attempt = 0;
  const launchBot = (): void => {
    attempt += 1;
    bot
      .launch({ dropPendingUpdates: true }, () => {
        console.log("[bot] online and listening for commands");
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        const isConflict = /\b409\b/.test(msg) || /conflict/i.test(msg);
        const isAuth = /\b401\b/.test(msg) || /unauthorized/i.test(msg);
        console.error(`[bot] failed to launch (attempt ${attempt}): ${msg}`);

        if (isAuth) {
          console.error(
            "[bot] TELEGRAM_BOT_TOKEN looks wrong (from @BotFather). Not retrying; the web dashboard stays up."
          );
          return;
        }
        if (isConflict) {
          console.error(
            "[bot] 409 = another instance is polling this token. Usually an overlapping Railway deploy still shutting down, or a duplicate service/deployment. Ensure only ONE instance runs."
          );
        }
        const delaySec = Math.min(60, 2 ** Math.min(attempt, 5));
        console.error(`[bot] retrying in ${delaySec}s (web dashboard unaffected)...`);
        setTimeout(launchBot, delaySec * 1000);
      });
  };
  launchBot();

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
