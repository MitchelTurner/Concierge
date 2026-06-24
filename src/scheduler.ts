import cron, { type ScheduledTask } from "node-cron";
import { dailyTimeToCron, type Config } from "./config.js";

/**
 * Schedule the daily nudge. Fires once a day at config.dailyTime in the
 * configured timezone and calls `send` (which builds + delivers the message).
 */
export function startScheduler(
  config: Config,
  send: () => Promise<void>
): ScheduledTask {
  const expression = dailyTimeToCron(config.dailyTime);

  const task = cron.schedule(
    expression,
    () => {
      send().catch((err) => {
        console.error("[scheduler] failed to send daily message:", err);
      });
    },
    { timezone: config.tz }
  );

  console.log(
    `[scheduler] daily nudge scheduled at ${config.dailyTime} (${config.tz}) [cron: "${expression}"]`
  );

  return task;
}
