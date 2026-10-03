import { Router, Request, Response } from "express";
import multer from "multer";
import archiver from "archiver";
import crypto from "crypto";
import fs from "fs";
import {
  listInvoices,
  countInvoices,
  statusCounts,
  getStats,
  listVendors,
  getInvoiceById,
  updateInvoice,
  getInvoicesByIds,
  deleteInvoices,
  findRedundantDuplicateIds,
  findByVendorAndNumber,
  normalizeInvoiceNumber,
  findProformaRef,
  STATUSES,
  Invoice,
} from "../models/invoice";
import { listUnmatchedPayouts, markPayoutReceived, ShopifyPayout } from "../models/shopify";
import { Receipt, receiptsWithoutBankMatch, updateReceipt } from "../models/receipt";
import { listPaymentFiles, getPaymentFileById } from "../models/payment-file";
import {
  createUserWithPassword,
  listUsers,
  removeUser,
  getUserById,
  getUserByEmail,
  getAdminUser,
  verifyPassword,
  setPassword,
  generatePassword,
  ADMIN_EMAIL,
} from "../models/user";
import { listRules, createRule, deleteRule, ruleExists } from "../models/rule";
import { generatePain001, validateForPayment, paymentBlocker } from "../services/pain001";
import { getAuthUrl, exchangeCode, getPollStatus, isGmailConfigured } from "../services/gmail";
import { requireAdmin, currentUser, sessionCookieOptions, SESSION_COOKIE } from "../middleware/auth";
import { env } from "../config/env";
import { getDb } from "../models/database";
import { filtersFromQuery } from "./shared";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const PAGE_SIZE = 100;

function flash(path: string, kind: "ok" | "err", message: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(message)}`;
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return typeof value === "string" && value ? [value] : [];
}

/** Only same-site paths are accepted as a post-login destination. */
function safeNext(value: unknown): string {
  return typeof value === "string" && /^\/(?!\/)/.test(value) ? value : "/invoices";
}

// ==================== Login ====================

router.get("/login", (req: Request, res: Response) => {
  res.render("login", { error: !!req.query.error, next: safeNext(req.query.next) });
});

router.post("/login", (req: Request, res: Response) => {
  const email = String(req.body.email || "").trim();
  const password = String(req.body.password || "");
  const next = safeNext(req.body.next);

  let user = email && password ? verifyPassword(email, password) : null;

  // AUTH_TOKEN is the master key for the built-in admin account (recovery if the password is lost)
  if (!user && email.toLowerCase() === ADMIN_EMAIL && password && password === env.authToken) {
    user = getAdminUser() || null;
  }

  if (!user) return res.redirect(`/login?error=1${next !== "/invoices" ? `&next=${encodeURIComponent(next)}` : ""}`);

  res.cookie(SESSION_COOKIE, user.token, sessionCookieOptions());
  res.redirect(next);
});

router.get("/logout", (_req: Request, res: Response) => {
  res.clearCookie(SESSION_COOKIE);
  res.redirect("/login");
});

// ==================== Gmail OAuth ====================

// The callback is reachable without a session (Google redirects to it), so the
// flow is tied to the admin who started it through a one-time state value.
const oauthStates = new Map<string, number>();

router.get("/auth/google", requireAdmin, (_req: Request, res: Response) => {
  const state = crypto.randomBytes(16).toString("hex");
  oauthStates.set(state, Date.now() + 10 * 60 * 1000);
  res.redirect(getAuthUrl(state));
});

router.get("/auth/google/callback", async (req: Request, res: Response) => {
  const state = String(req.query.state || "");
  const expires = oauthStates.get(state);
  oauthStates.delete(state);
  if (!expires || expires < Date.now()) {
    return res.status(400).render("error", {
      title: "Ogiltig förfrågan",
      message: "Anslutningen till Gmail måste startas från Inställningar. Försök igen därifrån.",
    });
  }
  try {
    const refreshToken = await exchangeCode(String(req.query.code || ""));
    res.render("auth-success", { refreshToken });
  } catch (err: any) {
    res.status(500).render("error", { title: "Gmail-anslutningen misslyckades", message: err.message });
  }
});

// ==================== Invoices ====================

router.get("/", (_req: Request, res: Response) => res.redirect("/invoices"));

router.get("/invoices", (req: Request, res: Response) => {
  const filters = filtersFromQuery(req.query);
  const total = countInvoices(filters);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1));

  res.render("invoices", {
    invoices: listInvoices(filters, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    filters,
    counts: statusCounts(filters),
    stats: getStats(),
    vendors: listVendors(),
    total,
    page,
    pages,
    pageSize: PAGE_SIZE,
    ok: req.query.ok || null,
    err: req.query.err || null,
  });
});

// Several PDFs as one ZIP file
router.post("/invoices/download-zip", (req: Request, res: Response) => {
  const invoices = getInvoicesByIds(asArray(req.body.ids)).filter((inv) => inv.pdf_path && fs.existsSync(inv.pdf_path));
  if (invoices.length === 0) return res.redirect(flash("/invoices", "err", "Inga PDF:er hittades för de valda fakturorna."));

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename=fakturor_${new Date().toISOString().slice(0, 10)}.zip`);

  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("error", (err) => {
    console.error("[ZIP]", err);
    res.end();
  });
  archive.pipe(res);

  const used = new Set<string>();
  for (const inv of invoices) {
    const base = [inv.vendor_name, inv.invoice_number, (inv.received_at || "").slice(0, 10)]
      .filter(Boolean)
      .join("_")
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/-+/g, "-") || inv.id;
    let name = `${base}.pdf`;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}.pdf`;
    used.add(name);
    archive.file(inv.pdf_path!, { name });
  }
  archive.finalize();
});

router.get("/invoices/:id", (req: Request, res: Response) => {
  const invoice = getInvoiceById(req.params.id);
  if (!invoice) return res.status(404).render("error", { title: "Fakturan hittades inte", message: "Den kan ha tagits bort." });

  const duplicates = invoice.vendor_name && invoice.invoice_number
    ? findByVendorAndNumber(invoice.vendor_name, invoice.invoice_number, invoice.id)
    : [];

  res.render("invoice-detail", {
    invoice,
    duplicates,
    hasPdf: !!invoice.pdf_path && fs.existsSync(invoice.pdf_path),
    ok: req.query.ok || null,
    err: req.query.err || null,
  });
});

// Save the edit form. Empty fields are cleared, so a wrongly parsed value can be removed.
router.post("/invoices/:id", (req: Request, res: Response) => {
  const invoice = getInvoiceById(req.params.id);
  if (!invoice) return res.status(404).render("error", { title: "Fakturan hittades inte", message: "Den kan ha tagits bort." });

  const text = (key: string) => {
    const value = String(req.body[key] ?? "").trim();
    return value === "" ? null : value;
  };

  const data: Partial<Invoice> = { manually_edited: 1 };
  for (const key of ["vendor_name", "invoice_number", "due_date", "ocr", "bankgiro", "plusgiro", "iban"] as const) {
    if (key in req.body) (data as any)[key] = text(key);
  }
  if ("amount" in req.body) {
    const raw = String(req.body.amount).replace(/\s/g, "").replace(",", ".");
    const amount = raw === "" ? null : parseFloat(raw);
    if (amount !== null && isNaN(amount)) return res.redirect(flash(`/invoices/${invoice.id}`, "err", "Beloppet är inte ett giltigt tal."));
    data.amount = amount;
  }
  if (text("currency")) data.currency = text("currency")!.toUpperCase();
  if (data.iban) data.iban = data.iban.replace(/\s/g, "").toUpperCase();
  if (data.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(data.due_date)) {
    return res.redirect(flash(`/invoices/${invoice.id}`, "err", "Förfallodatum måste anges som ÅÅÅÅ-MM-DD."));
  }
  const status = text("status");
  if (status && (STATUSES as readonly string[]).includes(status)) data.status = status;

  updateInvoice(invoice.id, data);
  res.redirect(flash(`/invoices/${invoice.id}`, "ok", "Ändringarna är sparade."));
});

router.post("/invoices/:id/status", (req: Request, res: Response) => {
  const status = String(req.body.status || "");
  if (!(STATUSES as readonly string[]).includes(status)) return res.redirect(`/invoices/${req.params.id}`);
  updateInvoice(req.params.id, { status });
  res.redirect(`/invoices/${req.params.id}`);
});

router.post("/invoices/:id/delete", requireAdmin, (req: Request, res: Response) => {
  deleteInvoices([req.params.id]);
  res.redirect(flash("/invoices", "ok", "Fakturan är raderad och hämtas inte in igen."));
});

router.get("/invoices/:id/pdf", (req: Request, res: Response) => {
  const invoice = getInvoiceById(req.params.id);
  if (!invoice?.pdf_path || !fs.existsSync(invoice.pdf_path)) {
    return res.status(404).render("error", { title: "PDF saknas", message: "Filen finns inte kvar på servern. Läs om fakturorna från Gmail under Inställningar." });
  }
  if (req.query.inline === "1") {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline");
    return fs.createReadStream(invoice.pdf_path).pipe(res);
  }
  const name = [invoice.vendor_name, invoice.invoice_number].filter(Boolean).join("_").replace(/[^\p{L}\p{N}._-]+/gu, "-") || "faktura";
  res.download(invoice.pdf_path, `${name}.pdf`);
});

// ==================== Payment files ====================

router.get("/payment-files", (req: Request, res: Response) => {
  res.render("payment-files", { files: listPaymentFiles(), ok: req.query.ok || null });
});

router.get("/payment-files/create", (req: Request, res: Response) => {
  const invoices = listInvoices({ status: "approved" }).map((inv) => ({ ...inv, blocker: paymentBlocker(inv) }));
  res.render("create-payment", {
    invoices,
    configured: !!env.debtorIban,
    err: req.query.err || null,
  });
});

router.post("/payment-files/create", (req: Request, res: Response) => {
  const invoices = getInvoicesByIds(asArray(req.body.invoice_ids));
  const problems = validateForPayment(invoices);
  if (problems.length > 0) return res.redirect(flash("/payment-files/create", "err", problems.join(" ")));

  const execDate = /^\d{4}-\d{2}-\d{2}$/.test(req.body.execution_date) ? req.body.execution_date : new Date().toISOString().split("T")[0];
  const result = generatePain001(invoices, execDate);
  for (const inv of invoices) {
    updateInvoice(inv.id, { status: "exported", payment_file_id: result.paymentFile.id });
  }
  res.redirect(flash("/payment-files", "ok", `Betalfil skapad med ${invoices.length} betalningar. Ladda ner den och importera i Nordea.`));
});

router.get("/payment-files/:id/download", (req: Request, res: Response) => {
  const pf = getPaymentFileById(req.params.id);
  if (!pf || !fs.existsSync(pf.file_path)) return res.status(404).render("error", { title: "Filen hittades inte", message: "Betalfilen finns inte kvar på servern." });
  res.download(pf.file_path, pf.filename);
});

// ==================== Account (own password) ====================

router.get("/account", (req: Request, res: Response) => {
  res.render("account", { ok: req.query.ok || null, err: req.query.err || null });
});

router.post("/account/password", (req: Request, res: Response) => {
  const user = currentUser(res)!;
  const { current, password, confirm } = req.body;

  const currentOk = !!verifyPassword(user.email, String(current || "")) || (user.email === ADMIN_EMAIL && current === env.authToken);
  if (!currentOk) return res.redirect(flash("/account", "err", "Nuvarande lösenord stämmer inte."));
  if (typeof password !== "string" || password.length < 8) return res.redirect(flash("/account", "err", "Det nya lösenordet måste vara minst 8 tecken."));
  if (password !== confirm) return res.redirect(flash("/account", "err", "Lösenorden matchar inte."));

  setPassword(user.id, password);
  res.cookie(SESSION_COOKIE, getUserById(user.id)!.token, sessionCookieOptions());
  res.redirect(flash("/account", "ok", "Lösenordet är bytt."));
});

// ==================== Settings (admin) ====================

router.get("/settings", requireAdmin, (req: Request, res: Response) => {
  res.render("settings", {
    users: listUsers(),
    rules: listRules("invoice"),
    receiptRules: listRules("receipt"),
    duplicateCount: findRedundantDuplicateIds().length,
    pollStatus: getPollStatus(),
    gmailConfigured: isGmailConfigured(),
    gmailUser: env.gmailUserEmail,
    ok: req.query.ok || null,
    err: req.query.err || null,
  });
});

router.post("/settings/users/invite", requireAdmin, (req: Request, res: Response) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const role = req.body.role === "admin" ? "admin" : "viewer";
  if (!name || !email) return res.redirect(flash("/settings", "err", "Ange både namn och e-post."));
  if (getUserByEmail(email)) return res.redirect(flash("/settings", "err", `Det finns redan en användare med e-post ${email}.`));

  const tempPassword = generatePassword();
  const user = createUserWithPassword(name, email, tempPassword, role);
  res.render("invite-success", { user, tempPassword, mode: "invite", loginUrl: `${env.publicUrl}/login` });
});

router.post("/settings/users/:id/reset-password", requireAdmin, (req: Request, res: Response) => {
  const user = getUserById(req.params.id);
  if (!user) return res.redirect(flash("/settings", "err", "Användaren finns inte."));
  const tempPassword = generatePassword();
  setPassword(user.id, tempPassword);
  if (user.id === currentUser(res)?.id) res.cookie(SESSION_COOKIE, getUserById(user.id)!.token, sessionCookieOptions());
  res.render("invite-success", { user, tempPassword, mode: "reset", loginUrl: `${env.publicUrl}/login` });
});

router.post("/settings/users/:id/remove", requireAdmin, (req: Request, res: Response) => {
  removeUser(req.params.id);
  res.redirect(flash("/settings", "ok", "Användaren är borttagen."));
});

router.post("/settings/rules/add", requireAdmin, (req: Request, res: Response) => {
  const from = String(req.body.from || "").trim().toLowerCase();
  if (!/^[^\s@]*@[^\s@]+\.[^\s@]+$/.test(from)) {
    return res.redirect(flash("/settings", "err", "Ange en e-postadress (namn@foretag.se) eller en hel domän (@foretag.se)."));
  }
  const kind = req.body.kind === "receipt" ? "receipt" : "invoice";
  if (ruleExists(from, kind)) return res.redirect(flash("/settings", "err", `${from} finns redan som avsändare.`));
  createRule(from, req.body.subject_contains, req.body.vendor_name, kind);
  res.redirect(flash("/settings", "ok", `${from} tillagd. ${kind === "receipt" ? "Kvitton" : "Fakturor"} från de senaste 30 dagarna hämtas vid nästa kontroll.`));
});

router.post("/settings/rules/:id/remove", requireAdmin, (req: Request, res: Response) => {
  deleteRule(req.params.id);
  res.redirect(flash("/settings", "ok", "Avsändaren är borttagen. Redan hämtade fakturor ligger kvar."));
});

// ==================== Bank statement ====================

interface BankRow {
  date: string;
  amount: number;
  currency: string;
  name: string;
  message: string;
}

function decodeCsv(buffer: Buffer): string {
  let text = buffer.toString("utf-8");
  if (text.includes("�")) text = buffer.toString("latin1");
  return text.replace(/^﻿/, "");
}

export function parseBankCsv(csvText: string): BankRow[] {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(";").map((h) => h.trim().toLowerCase());
  const col = (name: string) => headers.indexOf(name);
  const iDate = col("datum"), iAmount = col("belopp"), iName = col("namn"), iMsg = col("meddelande"), iCur = col("valuta"), iDetails = col("ytterligare detaljer");
  if (iDate < 0 || iAmount < 0) return [];

  const rows: BankRow[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split(";").map((v) => v.trim());
    const amount = parseFloat((c[iAmount] || "").replace(/\s/g, "").replace(",", "."));
    if (isNaN(amount)) continue;
    rows.push({
      date: (c[iDate] || "").replace(/\//g, "-"),
      amount,
      currency: (iCur >= 0 && c[iCur]) || "SEK",
      name: (iName >= 0 && c[iName]) || (iDetails >= 0 && c[iDetails]) || "",
      message: (iMsg >= 0 && c[iMsg]) || "",
    });
  }
  return rows;
}

function namesOverlap(bankName: string, vendorName: string | null): boolean {
  const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4);
  const vendorWords = words(vendorName || "");
  return words(bankName).some((w) => vendorWords.some((v) => v.includes(w) || w.includes(v)));
}

interface BankMatch {
  row: BankRow;
  invoice: Invoice;
  exact: boolean;
  warnings: string[];
  /** Not pre-selected: the user has to tick it deliberately */
  risky: boolean;
  alreadyPaid: boolean;
}

export function matchBankRows(rows: BankRow[]): { matches: BankMatch[]; unmatched: BankRow[] } {
  const invoices = (getDb().prepare("SELECT * FROM invoices WHERE invoice_number IS NOT NULL").all() as Invoice[]);
  const byNumber = new Map<string, Invoice[]>();
  for (const inv of invoices) {
    const key = normalizeInvoiceNumber(inv.invoice_number!);
    if (!byNumber.has(key)) byNumber.set(key, []);
    byNumber.get(key)!.push(inv);
  }
  // Longest numbers first, so "16231059" wins over a short number that happens to be contained in it
  const keysByLength = [...byNumber.keys()].filter((k) => k.length >= 6).sort((a, b) => b.length - a.length);

  const matches: BankMatch[] = [];
  const unmatched: BankRow[] = [];
  const taken = new Set<string>();

  const pick = (candidates: Invoice[], row: BankRow): Invoice | undefined => {
    const free = candidates.filter((c) => !taken.has(c.id));
    return (
      free.find((c) => c.status !== "paid" && namesOverlap(row.name, c.vendor_name)) ||
      free.find((c) => c.status !== "paid") ||
      free.find((c) => namesOverlap(row.name, c.vendor_name)) ||
      free[0]
    );
  };

  for (const row of rows) {
    if (row.amount >= 0) continue; // only outgoing payments

    // "NR: 20/3/2026/WDT/DTF", "INVOICE ZB/2026/02/447", "NO 586/12/2025/ZB"
    const cleaned = row.message.replace(/^(?:nr|no|invoice|faktura|fakt|inv)[\s.:#]*/i, "").trim();
    const normalized = normalizeInvoiceNumber(cleaned);
    let invoice: Invoice | undefined;
    let exact = false;

    if (normalized && byNumber.has(normalized)) {
      invoice = pick(byNumber.get(normalized)!, row);
      exact = true;
    }
    if (!invoice && cleaned) {
      for (const token of cleaned.split(/[\s,;]+/)) {
        const key = normalizeInvoiceNumber(token);
        if (key.length >= 3 && byNumber.has(key)) {
          invoice = pick(byNumber.get(key)!, row);
          exact = !!invoice;
          if (invoice) break;
        }
      }
    }
    if (!invoice && normalized.length >= 6) {
      const key = keysByLength.find((k) => normalized.includes(k));
      if (key) invoice = pick(byNumber.get(key)!, row);
    }

    // The payment quotes a pro forma (Feelgood "PROF 790/2026"): the final invoice has
    // another number but the same vendor and amount
    let viaProforma = false;
    if (!invoice && cleaned) {
      const ref = findProformaRef(cleaned);
      if (ref && ref.amount != null) {
        const candidates = invoices.filter(
          (c) => !taken.has(c.id) && c.vendor_name === ref.vendor_name && c.amount != null && Math.abs(c.amount - ref.amount!) < 0.005
        );
        invoice = candidates.find((c) => c.status !== "paid") || candidates[0];
        viaProforma = !!invoice;
      }
    }

    if (!invoice) {
      unmatched.push(row);
      continue;
    }

    taken.add(invoice.id);
    const paid = Math.abs(row.amount);
    const warnings: string[] = [];
    if (viaProforma) warnings.push(`Betalningen anger pro forma – matchad mot slutfakturan ${invoice.invoice_number}`);
    const nameOk = !row.name || namesOverlap(row.name, invoice.vendor_name);
    if (!nameOk) warnings.push(`Mottagaren "${row.name}" liknar inte leverantören`);
    if (invoice.amount != null && invoice.currency === row.currency && Math.abs(invoice.amount - paid) > 1) {
      warnings.push("Beloppet skiljer sig från fakturan");
    }
    if (!exact && !viaProforma) warnings.push("Fakturanumret matchar bara delvis");

    matches.push({ row, invoice, exact: exact || viaProforma, warnings, risky: (!exact && !viaProforma) || !nameOk, alreadyPaid: invoice.status === "paid" });
  }

  return { matches, unmatched };
}

interface PayoutMatch {
  row: BankRow;
  payout: ShopifyPayout;
  exact: boolean;
}

/** Incoming rows that look like Shopify payouts: same amount, a few days after the payout was issued. */
export function matchPayoutRows(rows: BankRow[]): PayoutMatch[] {
  const payouts = listUnmatchedPayouts();
  if (payouts.length === 0) return [];
  const taken = new Set<string>();
  const matches: PayoutMatch[] = [];
  const dayDiff = (a: string, b: string) => Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86400000);
  for (const row of rows) {
    if (row.amount <= 0) continue;
    const mentionsShopify = /shopify/i.test(`${row.name} ${row.message}`);
    const candidates = payouts.filter((p) => {
      if (taken.has(p.id) || p.net == null || !p.issued_at) return false;
      if (Math.abs(p.net - row.amount) > 0.005) return false;
      if (p.currency && row.currency && p.currency !== row.currency) return false;
      const diff = dayDiff(row.date, p.issued_at.slice(0, 10));
      return diff >= -1 && diff <= 10;
    });
    const payout = candidates.find((p) => mentionsShopify) || (mentionsShopify ? candidates[0] : candidates.length === 1 ? candidates[0] : undefined);
    if (!payout) continue;
    taken.add(payout.id);
    matches.push({ row, payout, exact: mentionsShopify });
  }
  return matches;
}

// ---- Card purchases ↔ receipts ----

// How a receipt source shows up as a card purchase: "Kortköp 260927 FACEBK *KL2BT764J4"
const CARD_MERCHANTS: Record<string, RegExp> = {
  "Meta Ads": /\bFACEBK\b|\bMETA\b/i,
  Distribold: /3D&I|DISTRIBOLD/i,
  Google: /GOOGLE\s*\*(?!ADS)|GSUITE|WORKSPACE/i,
};
// Google Ads draws the card at a threshold during the month and the rest just after it ends;
// together those charges add up to the monthly invoice
const GOOGLE_ADS_CHARGE = /GOOGLE\s*\*\s*ADS/i;
// A foreign-currency receipt and the SEK amount drawn must give a plausible rate
const SEK_RATE: Record<string, [number, number]> = { EUR: [9.5, 13.5], USD: [8, 13], GBP: [11, 16], DKK: [1.25, 1.85], NOK: [0.8, 1.25], PLN: [2.2, 3.3] };

function isCardPurchase(row: BankRow): boolean {
  return row.amount < 0 && /kortk[öo]p/i.test(`${row.name} ${row.message}`);
}

/** "Kortköp 260927 …" → "2026-09-27"; otherwise the booking date */
function purchaseDate(row: BankRow): string {
  const m = row.name.match(/kortk[öo]p\s+(\d{2})(\d{2})(\d{2})\b/i);
  return m ? `20${m[1]}-${m[2]}-${m[3]}` : row.date;
}

interface ReceiptMatch {
  // One card purchase – or every Google Ads charge behind a monthly invoice
  rows: BankRow[];
  receipt: Receipt;
  sek: number;
  date: string;
  text: string;
  rate: number | null;
  exact: boolean;
  warnings: string[];
}

/** Indexes of amounts (in öre) that add up to the target, or null. Small inputs only. */
function subsetSum(amounts: number[], target: number): number[] | null {
  if (amounts.length > 18) return null;
  const pick: number[] = [];
  const search = (i: number, left: number): boolean => {
    if (left === 0) return true;
    if (i >= amounts.length || left < 0) return false;
    pick.push(i);
    if (search(i + 1, left - amounts[i])) return true;
    pick.pop();
    return search(i + 1, left);
  };
  return search(0, target) ? pick : null;
}

interface CardRow extends BankRow {
  googleAds: boolean;
}

export function matchReceiptRows(rows: BankRow[]): { matches: ReceiptMatch[]; unmatched: CardRow[] } {
  // Reservations ("Reserverat") have no date and may still change – they are matched once booked
  const cards = rows.filter((r) => isCardPurchase(r) && /^\d{4}-\d{2}-\d{2}$/.test(r.date));
  if (cards.length === 0) return { matches: [], unmatched: [] };
  const dates = cards.map(purchaseDate).sort();
  const shift = (date: string, days: number) => new Date(new Date(date).getTime() + days * 86400000).toISOString().slice(0, 10);
  const period = receiptsWithoutBankMatch(shift(dates[0], -10), shift(dates[dates.length - 1], 10));
  const receipts = period.filter((r) => r.source !== "Google Ads");
  const dayDiff = (a: string, b: string) => Math.abs(Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86400000));

  const taken = new Set<string>();
  const matches: ReceiptMatch[] = [];
  const unmatched: CardRow[] = [];

  for (const row of cards) {
    const text = `${row.name} ${row.message}`;
    const sek = Math.abs(row.amount);
    const date = purchaseDate(row);
    const free = receipts.filter((r) => !taken.has(r.id));

    // Meta prints the receipt's reference number on the card purchase
    let receipt = free.find((r) => r.payment_ref && text.toUpperCase().includes(r.payment_ref));
    const exact = !!receipt;
    let rate: number | null = null;

    if (!receipt) {
      const candidates = free
        .filter((r) => {
          const merchant = r.source ? CARD_MERCHANTS[r.source] : undefined;
          if (!(merchant ? merchant.test(text) : namesOverlap(text, r.source))) return false;
          if (dayDiff(date, (r.received_at || "").slice(0, 10)) > 5) return false;
          if (r.amount == null) return false;
          if (!r.currency || r.currency === "SEK") return Math.abs(r.amount - sek) < 0.5;
          const band = SEK_RATE[r.currency];
          return !!band && sek / r.amount >= band[0] && sek / r.amount <= band[1];
        })
        .sort((a, b) => dayDiff(date, (a.received_at || "").slice(0, 10)) - dayDiff(date, (b.received_at || "").slice(0, 10)));
      receipt = candidates[0];
    }

    if (!receipt) {
      unmatched.push({ ...row, googleAds: GOOGLE_ADS_CHARGE.test(text) });
      continue;
    }
    taken.add(receipt.id);
    const warnings: string[] = [];
    if (receipt.currency && receipt.currency !== "SEK" && receipt.amount) rate = Math.round((sek / receipt.amount) * 10000) / 10000;
    else if (receipt.amount != null && Math.abs(receipt.amount - sek) >= 0.5) warnings.push("Beloppet skiljer sig från kvittot");
    matches.push({ rows: [row], receipt, sek, date: row.date, text: row.name, rate, exact, warnings });
  }

  // Google Ads: the charges from the first of the invoice's month until a few days after it
  // that add up exactly to the invoice (100 + 500 + 634,08 = 1 234,08)
  const googleInvoices = period
    .filter((r) => r.source === "Google Ads" && r.amount != null && r.received_at)
    .sort((a, b) => (a.received_at! < b.received_at! ? -1 : 1));
  for (const invoice of googleInvoices) {
    const issued = invoice.received_at!.slice(0, 10);
    const pool = unmatched.filter((c) => c.googleAds && purchaseDate(c) >= `${issued.slice(0, 8)}01` && purchaseDate(c) <= shift(issued, 10));
    const subset = subsetSum(pool.map((c) => Math.round(-c.amount * 100)), Math.round(invoice.amount! * 100));
    if (!subset || subset.length === 0) continue;
    const charges = subset.map((i) => pool[i]).sort((a, b) => (a.date < b.date ? -1 : 1));
    for (const c of charges) unmatched.splice(unmatched.indexOf(c), 1);
    const amounts = charges.map((c) => Math.abs(c.amount).toFixed(2).replace(".", ",")).join(" + ");
    matches.push({
      rows: charges,
      receipt: invoice,
      sek: invoice.amount!,
      date: charges[charges.length - 1].date,
      text: `${charges.length} kortköp GOOGLE *ADS ${charges[0].date}–${charges[charges.length - 1].date}: ${amounts}`,
      rate: null,
      exact: true,
      warnings: [],
    });
  }
  return { matches, unmatched };
}

router.get("/bank-upload", (req: Request, res: Response) => {
  res.render("bank-upload", { result: null, err: req.query.err || null });
});

router.post("/bank-upload", upload.single("csvfile"), (req: Request, res: Response) => {
  if (!req.file) return res.redirect(flash("/bank-upload", "err", "Välj en CSV-fil först."));
  const rows = parseBankCsv(decodeCsv(req.file.buffer));
  if (rows.length === 0) {
    return res.redirect(flash("/bank-upload", "err", "Filen kunde inte läsas. Exportera kontoutdraget som CSV från Nordea (kolumnerna Datum och Belopp krävs)."));
  }
  const { matches, unmatched } = matchBankRows(rows);
  const cards = matchReceiptRows(rows);
  res.render("bank-upload", {
    result: {
      // multer hands over the name as latin1; restore å/ä/ö
      filename: Buffer.from(req.file.originalname, "latin1").toString("utf8"),
      payments: rows.filter((r) => r.amount < 0).length,
      toMark: matches.filter((m) => !m.alreadyPaid),
      alreadyPaid: matches.filter((m) => m.alreadyPaid),
      // Card purchases are listed with the receipts instead
      unmatched: unmatched.filter((r) => !isCardPurchase(r)),
      payouts: matchPayoutRows(rows),
      receiptMatches: cards.matches,
      cardsWithoutReceipt: cards.unmatched,
    },
    err: null,
  });
});

router.post("/bank-upload/apply", (req: Request, res: Response) => {
  let count = 0;
  for (const value of asArray(req.body.matches)) {
    const [id, date] = value.split("|");
    const paidAt = /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date : undefined;
    if (updateInvoice(id, { status: "paid", paid_at: paidAt })) count++;
  }
  let payoutCount = 0;
  for (const value of asArray(req.body.payouts)) {
    const [id, date] = value.split("|");
    if (markPayoutReceived(id, /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date : undefined)) payoutCount++;
  }
  let receiptCount = 0;
  for (const value of asArray(req.body.receipts)) {
    const [id, date, amount, ...text] = value.split("|");
    const sek = parseFloat(amount);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || isNaN(sek)) continue;
    if (updateReceipt(id, { bank_date: date, bank_amount: sek, bank_text: text.join("|").slice(0, 120) || null })) receiptCount++;
  }
  if (count === 0 && payoutCount === 0 && receiptCount === 0) return res.redirect(flash("/bank-upload", "err", "Inga betalningar var markerade."));
  const parts = [];
  if (count) parts.push(`${count} fakturor markerade som betalda`);
  if (payoutCount) parts.push(`${payoutCount} Shopify-utbetalningar bockade av`);
  if (receiptCount) parts.push(`${receiptCount} kvitton fick beloppet i SEK från banken`);
  res.redirect(flash(count ? "/invoices?status=paid" : payoutCount ? "/shopify" : "/receipts", "ok", parts.join(", ") + "."));
});

export default router;
