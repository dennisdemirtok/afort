import dotenv from "dotenv";
import path from "path";

dotenv.config();

const databasePath = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "invoice.db");
const dataDir = path.dirname(databasePath);

export const env = {
  port: parseInt(process.env.PORT || "3000", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  // Railway sets RAILWAY_PUBLIC_DOMAIN; treat that as production too (HTTPS, secure cookies)
  isProduction: process.env.NODE_ENV === "production" || !!process.env.RAILWAY_PUBLIC_DOMAIN,
  publicUrl: process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${process.env.PORT || "3000"}`,

  // Gmail
  gmailClientId: process.env.GMAIL_CLIENT_ID || "",
  gmailClientSecret: process.env.GMAIL_CLIENT_SECRET || "",
  gmailRefreshToken: process.env.GMAIL_REFRESH_TOKEN || "",
  gmailUserEmail: process.env.GMAIL_USER_EMAIL || "",

  // Auth
  authToken: process.env.AUTH_TOKEN || "change-me",

  // Company
  companyName: process.env.COMPANY_NAME || "Flattered AB",
  debtorIban: process.env.DEBTOR_IBAN || "",
  debtorBic: process.env.DEBTOR_BIC || "NDEASESS",
  orgNumber: process.env.ORG_NUMBER || "",

  // Database & Paths - use /data on Railway (volume mount), ./data locally
  databasePath,

  // Paths - everything lives next to the database on the persistent volume
  invoicesDir: path.join(dataDir, "invoices"),
  paymentFilesDir: path.join(dataDir, "payment-files"),
  receiptsDir: path.join(dataDir, "receipts"),
  shopifyDir: path.join(dataDir, "shopify"),

  // Shopify Admin API (custom app in the store: read_shopify_payments_payouts + read_shopify_payments_accounts)
  shopifyStoreDomain: (process.env.SHOPIFY_STORE_DOMAIN || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""),
  shopifyAccessToken: (process.env.SHOPIFY_ACCESS_TOKEN || "").trim(),
  shopifyApiVersion: process.env.SHOPIFY_API_VERSION || "2026-07",

  // Claude API (optional)
  claudeApiKey: process.env.CLAUDE_API_KEY || "",
};
