/**
 * Entry point for the daily job. On Render it runs as a separate Cron Job service
 * (see README), not inside the web server, so a sleeping or restarting web process
 * can't skip it and two web instances can't run it twice.
 *
 *   node dist/jobs/daily.js
 */
import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { defaultSenders } from "../modules/notifications/channels";
import { runDailyJob } from "../modules/notifications/daily";

async function main() {
  const result = await runDailyJob(defaultSenders());
  logger.info(
    { status: result.status, libraries: result.libraries, failures: result.failures },
    "Daily job finished",
  );
  // ALREADY_RUNNING isn't a failure: the run in progress does the work.
  return result.status === "FAILED" ? 1 : 0;
}

main()
  .catch((err) => {
    logger.fatal({ err }, "Daily job crashed");
    return 1;
  })
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  });
