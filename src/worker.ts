import cron from "node-cron";
import { env } from "./config/env";
import { getDb } from "./models/database";
import { pollGmail } from "./services/gmail";
import gmailRules from "./config/gmail-rules.json";

// Initialize DB
getDb();

const interval = gmailRules.poll_interval_minutes || 15;

console.log(`[Worker] Starting Gmail poller (every ${interval} minutes)`);

// Schedule polling
cron.schedule(`*/${interval} * * * *`, async () => {
  try {
    await pollGmail();
  } catch (err) {
    console.error("[Worker] Poll failed:", err);
  }
});

// Run immediately on start
(async () => {
  try {
    console.log("[Worker] Running initial poll...");
    await pollGmail();
  } catch (err) {
    console.error("[Worker] Initial poll failed:", err);
  }
})();
