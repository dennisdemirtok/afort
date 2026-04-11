import { Router, Request, Response } from "express";
import multer from "multer";
import { listInvoices, getInvoiceById, updateInvoice, getInvoicesByIds } from "../models/invoice";
import { listPaymentFiles, getPaymentFileById } from "../models/payment-file";
import { createUserWithPassword, listUsers, removeUserByEmail, ensureAdminExists, verifyPassword, generatePassword } from "../models/user";
import { generatePain001 } from "../services/pain001";
import { getAuthUrl, exchangeCode } from "../services/gmail";
import { env } from "../config/env";
import { getDb } from "../models/database";
import fs from "fs";
import path from "path";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Login page
router.get("/login", (req: Request, res: Response) => {
  res.render("login", { error: req.query.error || null });
});

router.post("/login", (req: Request, res: Response) => {
  const { email, password } = req.body;

  // Try email+password auth first
  if (email && password) {
    const user = verifyPassword(email, password);
    if (user) {
      res.cookie("auth_token", user.token, { httpOnly: true, sameSite: "strict", maxAge: 7 * 24 * 60 * 60 * 1000 });
      return res.redirect("/invoices");
    }
  }

  // Backward compat: password-only with authToken
  if (!email && password && password === env.authToken) {
    res.cookie("auth_token", env.authToken, { httpOnly: true, sameSite: "strict", maxAge: 7 * 24 * 60 * 60 * 1000 });
    return res.redirect("/invoices");
  }

  res.redirect("/login?error=1");
});

router.get("/logout", (req: Request, res: Response) => {
  res.clearCookie("auth_token");
  res.redirect("/login");
});

// OAuth flow
router.get("/auth/google", (_req: Request, res: Response) => {
  res.redirect(getAuthUrl());
});

router.get("/auth/google/callback", async (req: Request, res: Response) => {
  try {
    const code = req.query.code as string;
    const refreshToken = await exchangeCode(code);
    res.render("auth-success", { refreshToken });
  } catch (err: any) {
    res.status(500).send(`Auth error: ${err.message}`);
  }
});

// Dashboard / Invoice list
router.get("/", (_req: Request, res: Response) => res.redirect("/invoices"));

router.get("/invoices", (req: Request, res: Response) => {
  const q = req.query;
  const filters = {
    status: String(q.status || "") || undefined,
    vendor: String(q.vendor || "") || undefined,
    date_from: String(q.date_from || "") || undefined,
    date_to: String(q.date_to || "") || undefined,
  };
  const invoices = listInvoices(filters);
  const counts = {
    all: listInvoices().length,
    new: listInvoices({ status: "new" }).length,
    approved: listInvoices({ status: "approved" }).length,
    exported: listInvoices({ status: "exported" }).length,
    paid: listInvoices({ status: "paid" }).length,
  };
  res.render("invoices", { invoices, filters, counts });
});

// Invoice detail
router.get("/invoices/:id", (req: Request, res: Response) => {
  const invoice = getInvoiceById(req.params.id);
  if (!invoice) return res.status(404).render("error", { message: "Faktura hittades inte" });
  res.render("invoice-detail", { invoice });
});

// Update invoice (form)
router.post("/invoices/:id", (req: Request, res: Response) => {
  const data: any = {};
  for (const key of ["vendor_name", "invoice_number", "amount", "currency", "due_date", "ocr", "bankgiro", "plusgiro", "iban", "status"]) {
    if (req.body[key] !== undefined && req.body[key] !== "") {
      data[key] = key === "amount" ? parseFloat(req.body[key]) : req.body[key];
    }
  }
  updateInvoice(req.params.id, data);
  res.redirect(`/invoices/${req.params.id}`);
});

// Download PDF
router.get("/invoices/:id/pdf", (req: Request, res: Response) => {
  const invoice = getInvoiceById(req.params.id);
  if (!invoice?.pdf_path || !fs.existsSync(invoice.pdf_path)) {
    return res.status(404).render("error", { message: "PDF hittades inte" });
  }
  res.download(invoice.pdf_path);
});

// Payment files
router.get("/payment-files", (_req: Request, res: Response) => {
  const files = listPaymentFiles();
  res.render("payment-files", { files });
});

router.get("/payment-files/create", (req: Request, res: Response) => {
  const invoices = listInvoices({ status: "approved" });
  res.render("create-payment", { invoices });
});

router.post("/payment-files/create", (req: Request, res: Response) => {
  const ids = Array.isArray(req.body.invoice_ids) ? req.body.invoice_ids : [req.body.invoice_ids].filter(Boolean);
  if (ids.length === 0) return res.redirect("/payment-files/create");

  const execDate = req.body.execution_date || new Date().toISOString().split("T")[0];
  const invoices = getInvoicesByIds(ids);
  const result = generatePain001(invoices, execDate);

  for (const inv of invoices) {
    updateInvoice(inv.id, { status: "exported", payment_file_id: result.paymentFile.id });
  }

  res.redirect("/payment-files");
});

router.get("/payment-files/:id/download", (req: Request, res: Response) => {
  const pf = getPaymentFileById(req.params.id);
  if (!pf || !fs.existsSync(pf.file_path)) return res.status(404).render("error", { message: "Fil hittades inte" });
  res.download(pf.file_path, pf.filename);
});

// Settings
function loadRules(): any[] {
  const rulesPath = path.join(__dirname, "..", "config", "gmail-rules.json");
  try { return JSON.parse(fs.readFileSync(rulesPath, "utf-8")).rules; } catch { return []; }
}

function saveRules(rules: any[]) {
  const rulesPath = path.join(__dirname, "..", "config", "gmail-rules.json");
  const data = JSON.parse(fs.readFileSync(rulesPath, "utf-8"));
  data.rules = rules;
  fs.writeFileSync(rulesPath, JSON.stringify(data, null, 2), "utf-8");
}

router.get("/settings", (req: Request, res: Response) => {
  ensureAdminExists(env.authToken);
  const users = listUsers();
  const rules = loadRules();
  res.render("settings", { users, rules, success: req.query.success || null });
});

router.post("/settings/users/invite", (req: Request, res: Response) => {
  const { name, email } = req.body;
  if (!name || !email) return res.redirect("/settings");
  try {
    const tempPassword = generatePassword();
    const user = createUserWithPassword(name, email, tempPassword);
    res.render("invite-success", { user, tempPassword });
  } catch (err: any) {
    res.redirect(`/settings?success=Fel: ${err.message}`);
  }
});

router.post("/settings/users/remove", (req: Request, res: Response) => {
  removeUserByEmail(req.body.email);
  res.redirect("/settings?success=Anvandare borttagen");
});

router.post("/settings/rules/add", (req: Request, res: Response) => {
  const rules = loadRules();
  const newRule: any = { from: req.body.from, has_attachment: "pdf" };
  if (req.body.subject_contains) newRule.subject_contains = req.body.subject_contains;
  rules.push(newRule);
  saveRules(rules);
  res.redirect("/settings?success=Leverantor tillagd");
});

router.post("/settings/rules/remove", (req: Request, res: Response) => {
  const rules = loadRules();
  const idx = parseInt(req.body.index, 10);
  if (idx >= 0 && idx < rules.length) rules.splice(idx, 1);
  saveRules(rules);
  res.redirect("/settings?success=Leverantor borttagen");
});

// ==================== Bank Upload ====================

function parseCsvRows(csvText: string): Record<string, string>[] {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(";").map(h => h.trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(";");
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (cols[j] || "").trim();
    }
    rows.push(row);
  }
  return rows;
}

function parseSwedishAmount(val: string): number {
  // "-2159,86" -> -2159.86
  return parseFloat(val.replace(/\s/g, "").replace(",", "."));
}

function normalizeInvoiceNumber(num: string): string {
  return num.replace(/\s+/g, "").toLowerCase();
}

router.get("/bank-upload", (_req: Request, res: Response) => {
  res.render("bank-upload", { matches: null, unmatched: null });
});

router.post("/bank-upload", upload.single("csvfile"), (req: Request, res: Response) => {
  if (!req.file) return res.redirect("/bank-upload");

  const csvText = req.file.buffer.toString("utf-8");
  const rows = parseCsvRows(csvText);

  const db = getDb();
  const allInvoices = db.prepare("SELECT * FROM invoices WHERE status != 'paid'").all() as any[];

  // Build a map of normalized invoice numbers to invoices
  const invoiceMap = new Map<string, any>();
  for (const inv of allInvoices) {
    if (inv.invoice_number) {
      invoiceMap.set(normalizeInvoiceNumber(inv.invoice_number), inv);
    }
  }

  const matches: { invoice: any; bankRow: Record<string, string>; amount: number; date: string }[] = [];
  const unmatched: { bankRow: Record<string, string>; amount: number; date: string }[] = [];

  for (const row of rows) {
    const belopp = parseSwedishAmount(row["Belopp"] || "0");
    if (belopp >= 0) continue; // Only outgoing payments

    const meddelande = (row["Meddelande"] || "").trim();
    const datum = (row["Datum"] || "").trim();
    const amount = Math.abs(belopp);

    if (!meddelande) {
      unmatched.push({ bankRow: row, amount, date: datum });
      continue;
    }

    // Try to match message against invoice numbers
    // Strip "NR: " prefix for Fancywork
    let msg = meddelande.replace(/^NR:\s*/i, "").trim();

    let found = false;

    // Direct match
    const normalized = normalizeInvoiceNumber(msg);
    if (invoiceMap.has(normalized)) {
      matches.push({ invoice: invoiceMap.get(normalized)!, bankRow: row, amount, date: datum });
      found = true;
    }

    // Try partial matching: check if message contains an invoice number or vice versa
    if (!found) {
      for (const [key, inv] of invoiceMap.entries()) {
        if (normalized.includes(key) || key.includes(normalized)) {
          matches.push({ invoice: inv, bankRow: row, amount, date: datum });
          found = true;
          break;
        }
      }
    }

    // Try matching individual words/tokens in the message
    if (!found) {
      const tokens = msg.split(/[\s,;]+/).filter(t => t.length >= 3);
      for (const token of tokens) {
        const normToken = normalizeInvoiceNumber(token);
        if (invoiceMap.has(normToken)) {
          matches.push({ invoice: invoiceMap.get(normToken)!, bankRow: row, amount, date: datum });
          found = true;
          break;
        }
      }
    }

    if (!found) {
      unmatched.push({ bankRow: row, amount, date: datum });
    }
  }

  res.render("bank-upload", { matches, unmatched });
});

router.post("/bank-upload/apply", (req: Request, res: Response) => {
  const ids = req.body.invoice_ids;
  if (!ids) return res.redirect("/bank-upload");
  const idList = Array.isArray(ids) ? ids : [ids];
  for (const id of idList) {
    updateInvoice(id, { status: "paid" });
  }
  res.redirect("/invoices?status=paid");
});

export default router;
