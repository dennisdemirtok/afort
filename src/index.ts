import express, { Request, Response, NextFunction } from "express";
import path from "path";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import cron from "node-cron";
import { env } from "./config/env";
import { getDb } from "./models/database";
import { requireAuth } from "./middleware/auth";
import { pollGmail, isGmailConfigured } from "./services/gmail";
import { ensureAdminExists } from "./models/user";
import { repairInvoiceNumbersFromSubjects, repairInvalidIbans, removeProformaInvoices } from "./models/invoice";
import { backfillIbansFromPdfs, removeLinkOnlyReceipts } from "./services/maintenance";
import { isShopifyConfigured, syncShopifyPayouts } from "./services/shopify";
import { viewHelpers, buildIconFontUrl } from "./routes/shared";
import apiRoutes from "./routes/api";
import webRoutes from "./routes/web";
import receiptRoutes from "./routes/receipts";
import shopifyRoutes from "./routes/shopify";

const app = express();

// Railway terminates TLS in a proxy; without this every visitor shares one IP for rate limiting
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public"), { maxAge: env.isProduction ? "1h" : 0 }));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Available in every template
app.locals.h = viewHelpers;
app.locals.iconFontUrl = buildIconFontUrl(path.join(__dirname, "views"));
app.locals.assetVersion = Date.now().toString(36);
app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  res.locals.user = null;
  next();
});

getDb();
ensureAdminExists(env.authToken);
const repairedNumbers = repairInvoiceNumbersFromSubjects();
if (repairedNumbers > 0) console.log(`[AFORT] Repaired ${repairedNumbers} invoice numbers from subject lines`);
const clearedIbans = repairInvalidIbans();
if (clearedIbans > 0) console.log(`[AFORT] Cleared ${clearedIbans} invalid IBANs`);
const removedProformas = removeProformaInvoices();
if (removedProformas > 0) console.log(`[AFORT] Removed ${removedProformas} pro forma invoices (numbers kept for bank matching)`);
const removedNotices = removeLinkOnlyReceipts();
if (removedNotices > 0) console.log(`[AFORT] Removed ${removedNotices} Google Ads mails that only linked to the invoice`);
if (env.authToken === "change-me") {
  console.warn("[AFORT] AUTH_TOKEN is not set – the admin password is the insecure default.");
}

// Brute force protection for the login form
app.post("/login", rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).render("error", {
    title: "För många inloggningsförsök",
    message: "Vänta en kvart och försök igen.",
  }),
}));
app.use("/api/", rateLimit({ windowMs: 15 * 60 * 1000, max: 1500, standardHeaders: true, legacyHeaders: false }));

// Everything except the login page and the Google OAuth callback requires a session
const PUBLIC_PATHS = ["/login", "/auth/google/callback"];
app.use((req, res, next) => {
  if (PUBLIC_PATHS.includes(req.path)) return next();
  requireAuth(req, res, next);
});

app.use("/api", apiRoutes);
app.use("/", receiptRoutes);
app.use("/", shopifyRoutes);
app.use("/", webRoutes);

app.use((req: Request, res: Response) => {
  if (req.originalUrl.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.status(404).render("error", { title: "Sidan finns inte", message: "Adressen du försökte nå finns inte i AFORT." });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  console.error("[AFORT] Unhandled error:", err);
  if (res.headersSent) return;
  const tooLarge = err?.code === "LIMIT_FILE_SIZE";
  if (req.originalUrl.startsWith("/api/")) return res.status(tooLarge ? 413 : 500).json({ error: tooLarge ? "Filen är för stor" : "Internt fel" });
  res.status(tooLarge ? 413 : 500).render("error", {
    title: tooLarge ? "Filen är för stor" : "Något gick fel",
    message: tooLarge ? "Filen får vara högst 5 MB." : "Ett oväntat fel inträffade. Försök igen om en stund.",
  });
});

app.listen(env.port, () => {
  console.log(`[AFORT] Server running on port ${env.port} (${env.isProduction ? "production" : "development"})`);

  // Fill in bank accounts the parser used to miss – in the background, never blocking requests
  backfillIbansFromPdfs()
    .then((n) => { if (n > 0) console.log(`[AFORT] Filled in IBAN on ${n} invoices from their PDFs`); })
    .catch((err) => console.error("[AFORT] IBAN backfill failed:", err));

  if (isShopifyConfigured()) {
    // Shopify pays out a few times a week; once a day is plenty, plus once shortly after start
    cron.schedule("20 6 * * *", () => {
      syncShopifyPayouts().catch((err) => console.error("[Cron] Shopify sync failed:", err));
    });
    setTimeout(() => {
      syncShopifyPayouts().catch((err) => console.error("[AFORT] Initial Shopify sync failed:", err));
    }, 20000);
    console.log("[AFORT] Shopify payout sync scheduled daily");
  } else {
    console.warn("[AFORT] Shopify is not configured – payouts are not fetched.");
  }

  if (!isGmailConfigured()) {
    console.warn("[AFORT] Gmail is not configured – automatic fetching is off.");
    return;
  }

  // New invoices every 15 minutes, plus once shortly after start
  cron.schedule("*/15 * * * *", () => {
    pollGmail("new").catch((err) => console.error("[Cron] Poll failed:", err));
  });
  setTimeout(() => {
    pollGmail("new").catch((err) => console.error("[AFORT] Initial poll failed:", err));
  }, 10000);
  console.log("[AFORT] Gmail polling scheduled every 15 minutes");
});

export default app;
