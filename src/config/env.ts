import dotenv from "dotenv";
import path from "path";

dotenv.config();

export const env = {
  port: parseInt(process.env.PORT || "3000", 10),
  nodeEnv: process.env.NODE_ENV || "development",

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
  databasePath: process.env.DATABASE_PATH || path.join(process.cwd(), "data", "invoice.db"),

  // Paths - derive from DATABASE_PATH parent directory
  invoicesDir: path.join(path.dirname(process.env.DATABASE_PATH || path.join(process.cwd(), "data", "invoice.db")), "invoices"),
  paymentFilesDir: path.join(path.dirname(process.env.DATABASE_PATH || path.join(process.cwd(), "data", "invoice.db")), "payment-files"),

  // Claude API (optional)
  claudeApiKey: process.env.CLAUDE_API_KEY || "",
};
