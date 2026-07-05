/**
 * Application entry point.
 *
 * Boots four long-lived subsystems in one process:
 *   1. PostgreSQL (schema + connection pool)
 *   2. Telegram bot (Telegraf long-polling)
 *   3. Per-user scheduler (timezone-aware daily nudge + evening check-in)
 *   4. Web dashboard (Express API + static HTML)
 *
 * The bot launch is retried on transient failures (e.g. Telegram 409 during deploy
 * overlap) but gives up on bad tokens so the dashboard keeps serving.
 */
import { loadConfig } from "./config.js";
import { initDb, closeDb, deleteExpiredSessions } from "./db.js";
import { createBot } from "./bot.js";
import { startInboxWatcher } from "./inbox.js";
import { startUserScheduler } from "./scheduler.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();

  await initDb();
  console.log("[db] ready");

  // Clean up expired sessions hourly.
  setInterval(
    () => {
      deleteExpiredSessions().catch((err) => {
        console.error("[auth] session cleanup failed:", err);
      });
    },
    60 * 60 * 1000
  );

  const { bot, sendDailyMessage, sendCheckinMessage, sendWeeklyReview, sendAlert, notifyReply } =
    createBot(config);

  startUserScheduler({
    sendDaily: sendDailyMessage,
    sendCheckin: sendCheckinMessage,
    sendWeekly: sendWeeklyReview,
    sendAlert,
  });

  startInboxWatcher(config, notifyReply);

  startServer(config);

  const MAX_LAUNCH_ATTEMPTS = 6;
  let attempt = 0;
  let onlineTimer: ReturnType<typeof setTimeout> | undefined;

  const launchBot = (): void => {
    attempt += 1;
    bot
      .launch({ dropPendingUpdates: true }, () => {
        onlineTimer = setTimeout(() => {
          console.log("[bot] online and listening for commands");
          attempt = 0;
        }, 4000);
      })
      .then(() => {
        if (onlineTimer) clearTimeout(onlineTimer);
      })
      .catch((err: unknown) => {
        if (onlineTimer) clearTimeout(onlineTimer);
        const msg = err instanceof Error ? err.message : String(err);
        const isConflict = /\b409\b/.test(msg) || /conflict/i.test(msg);
        const isAuth = /\b401\b/.test(msg) || /unauthorized/i.test(msg);
        console.error(`[bot] launch failed (attempt ${attempt}): ${msg}`);

        if (isAuth) {
          console.error(
            "[bot] TELEGRAM_BOT_TOKEN looks wrong (from @BotFather). Not retrying; the web dashboard stays up."
          );
          return;
        }
        if (attempt >= MAX_LAUNCH_ATTEMPTS) {
          console.error(
            `[bot] gave up after ${attempt} attempts; the web dashboard stays up. ` +
              (isConflict
                ? "Persistent 409 means a DUPLICATE instance is polling this token — stop the extra deployment/service so only ONE runs, then redeploy."
                : "Restart the service to try again.")
          );
          return;
        }
        if (isConflict) {
          console.error(
            "[bot] 409 = another instance is polling this token (overlapping deploy shutting down, or a duplicate service)."
          );
        }
        const delaySec = Math.min(60, 2 ** attempt);
        console.error(`[bot] retrying in ${delaySec}s (web dashboard unaffected)...`);
        setTimeout(launchBot, delaySec * 1000);
      });
  };
  launchBot();

  const shutdown = async (signal: string) => {
    console.log(`\n[concierge] received ${signal}, shutting down...`);
    if (onlineTimer) clearTimeout(onlineTimer);
    try {
      bot.stop(signal);
    } catch {
      // Bot may not be running.
    }
    await closeDb();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[concierge] fatal:", err.message ?? err);
  process.exit(1);
});
