import dotenv from "dotenv";
import path from "path";

dotenv.config();

/** "viwrsi-jk", "viwrsi-jk.myshopify.com" or an admin URL → "viwrsi-jk.myshopify.com" */
function normalizeShopDomain(value: string): string {
  let v = value.trim().toLowerCase().replace(/^https?:\/\//, "");
  const adminStore = v.match(/admin\.shopify\.com\/store\/([a-z0-9-]+)/);
  if (adminStore) return `${adminStore[1]}.myshopify.com`;
  v = v.replace(/\/.*$/, "");
  if (v && !v.includes(".")) v = `${v}.myshopify.com`;
  return v;
}

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

  // Shopify Admin API: a Dev Dashboard app installed on the store (read_shopify_payments_payouts +
  // read_shopify_payments_accounts). Client ID + secret are exchanged for a 24-hour token.
  // SHOPIFY_ACCESS_TOKEN still works for an old admin-created custom app.
  shopifyStoreDomain: normalizeShopDomain(process.env.SHOPIFY_STORE_DOMAIN || ""),
  shopifyClientId: (process.env.SHOPIFY_CLIENT_ID || "").trim(),
  shopifyClientSecret: (process.env.SHOPIFY_CLIENT_SECRET || "").trim(),
  shopifyAccessToken: (process.env.SHOPIFY_ACCESS_TOKEN || "").trim(),
  shopifyApiVersion: process.env.SHOPIFY_API_VERSION || "2026-07",
  // All Shopify sales carry Swedish VAT at this rate; the VAT is derived from the gross amounts
  shopifyVatRate: Number.isFinite(parseFloat(process.env.SHOPIFY_VAT_RATE || "")) ? parseFloat(process.env.SHOPIFY_VAT_RATE!) : 25,

  // Claude API (optional)
  claudeApiKey: process.env.CLAUDE_API_KEY || "",
};
