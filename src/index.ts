import express from "express";
import path from "path";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import cron from "node-cron";
import { env } from "./config/env";
import { getDb } from "./models/database";
import { requireAuth } from "./middleware/auth";
import { pollGmail } from "./services/gmail";
import apiRoutes from "./routes/api";
import webRoutes from "./routes/web";

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// Rate limiting
app.use("/api/", rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

// View engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Initialize DB
getDb();

// Public routes
app.get("/login", (req, res, next) => next());
app.post("/login", (req, res, next) => next());
app.get("/auth/google", (req, res, next) => next());
app.get("/auth/google/callback", (req, res, next) => next());

// Auth for everything else
app.use((req, res, next) => {
  if (["/login", "/auth/google", "/auth/google/callback"].includes(req.path)) return next();
  if (req.path.startsWith("/css/") || req.path.startsWith("/js/")) return next();
  requireAuth(req, res, next);
});

// Routes
app.use("/api", apiRoutes);
app.use("/", webRoutes);

app.listen(env.port, () => {
  console.log(`[AFORT] Server running on port ${env.port}`);
  console.log(`[AFORT] Environment: ${env.nodeEnv}`);

  // Start automatic Gmail polling every 15 minutes
  cron.schedule("*/15 * * * *", async () => {
    try {
      const count = await pollGmail();
      if (count > 0) console.log(`[Cron] Polled ${count} new invoices`);
    } catch (err) {
      console.error("[Cron] Poll failed:", err);
    }
  });
  console.log("[AFORT] Gmail polling scheduled every 15 minutes");

  // Run initial poll on startup (after 10 sec delay to let server stabilize)
  setTimeout(async () => {
    try {
      const count = await pollGmail();
      console.log(`[AFORT] Initial poll: ${count} new invoices`);
    } catch (err) {
      console.error("[AFORT] Initial poll failed:", err);
    }
  }, 10000);
});

export default app;
