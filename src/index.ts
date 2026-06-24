import { loadConfig } from "./config.js";
import { initDb } from "./db.js";
import { createBot } from "./bot.js";
import { startScheduler, startCheckinScheduler } from "./scheduler.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();

  initDb();
  console.log("[db] ready");

  const { bot, sendDailyMessage, sendCheckinMessage } = createBot(config);

  startScheduler(config, sendDailyMessage);
  startCheckinScheduler(config, sendCheckinMessage);

  // Always start the web server (Railway needs a listening port for its domain).
  // The API stays fully locked until DASHBOARD_PASSWORD is set — without it,
  // every /api route returns 503 and no data is served, so this is safe.
  startServer(config);
  if (!config.dashboardPassword) {
    console.log(
      "[web] DASHBOARD_PASSWORD not set — dashboard is locked. Set it to log in and use the dashboard/AI agent."
    );
  }

  // Launch the bot (long-running). A launch failure must NOT take down the web
  // dashboard, so we never exit the process here. For transient errors (e.g. a
  // 409 Conflict while an old deploy is still shutting down) we retry with
  // backoff, but only a bounded number of times so two permanent instances
  // can't ping-pong forever. dropPendingUpdates clears any stale offset.
  //
  // Note: Telegraf fires the onLaunch callback right after getMe(), BEFORE
  // polling proves healthy, so we only declare "online" if polling stays up
  // for a few seconds (otherwise a 409 immediately follows a false "online").
  const MAX_LAUNCH_ATTEMPTS = 6;
  let attempt = 0;
  let onlineTimer: ReturnType<typeof setTimeout> | undefined;

  const launchBot = (): void => {
    attempt += 1;
    bot
      .launch({ dropPendingUpdates: true }, () => {
        onlineTimer = setTimeout(() => {
          console.log("[bot] online and listening for commands");
          attempt = 0; // stable — restore the full retry budget for later blips
        }, 4000);
      })
      .then(() => {
        // Resolves only when polling stops (our graceful shutdown).
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
                ? "Persistent 409 means a DUPLICATE instance is polling this token — stop the extra Railway deployment/service (or local run) so only ONE runs, then redeploy."
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

  const shutdown = (signal: string) => {
    console.log(`\n[operator] received ${signal}, shutting down...`);
    if (onlineTimer) clearTimeout(onlineTimer);
    try {
      bot.stop(signal);
    } catch {
      // Bot may not be running (launch failed/gave up) — fine.
    }
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[operator] fatal:", err.message ?? err);
  process.exit(1);
});
