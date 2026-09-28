import { getDb } from "./database";
import { v4 as uuidv4 } from "uuid";
import { extractInvoiceNumberFromSubject } from "../services/invoice-extract";

export interface Invoice {
  id: string;
  gmail_message_id: string | null;
  sender: string | null;
  subject: string | null;
  received_at: string | null;
  processed_at: string | null;
  vendor_name: string | null;
  invoice_number: string | null;
  amount: number | null;
  currency: string;
  due_date: string | null;
  ocr: string | null;
  bankgiro: string | null;
  plusgiro: string | null;
  iban: string | null;
  pdf_path: string | null;
  status: string;
  payment_file_id: string | null;
  paid_at: string | null;
  manually_edited: number;
  created_at: string;
}

export const STATUSES = ["new", "approved", "exported", "paid"] as const;
export type InvoiceStatus = (typeof STATUSES)[number];

export interface InvoiceFilters {
  status?: string;
  vendor?: string;
  q?: string;
  overdue?: boolean;
  duplicates?: boolean;
  date_from?: string;
  date_to?: string;
}

export interface Page {
  limit?: number;
  offset?: number;
}

export function today(): string {
  // Swedish local date, YYYY-MM-DD
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
}

export function isOverdue(inv: Pick<Invoice, "status" | "due_date">): boolean {
  return inv.status !== "paid" && !!inv.due_date && inv.due_date < today();
}

function buildWhere(filters: InvoiceFilters, opts: { ignoreStatus?: boolean } = {}) {
  const conditions: string[] = [];
  const params: any[] = [];

  if (filters.status && !opts.ignoreStatus) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (filters.vendor) {
    conditions.push("vendor_name = ?");
    params.push(filters.vendor);
  }
  if (filters.q) {
    const like = `%${filters.q.replace(/[%_]/g, "")}%`;
    conditions.push("(vendor_name LIKE ? OR invoice_number LIKE ? OR subject LIKE ? OR ocr LIKE ?)");
    params.push(like, like, like, like);
  }
  if (filters.overdue) {
    conditions.push("status != 'paid' AND due_date IS NOT NULL AND due_date < ?");
    params.push(today());
  }
  if (filters.duplicates) {
    const ids = findRedundantDuplicateIds();
    if (ids.length === 0) {
      conditions.push("1 = 0");
    } else {
      conditions.push(`id IN (${ids.map(() => "?").join(",")})`);
      params.push(...ids);
    }
  }
  if (filters.date_from) {
    conditions.push("received_at >= ?");
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    conditions.push("received_at <= ?");
    params.push(filters.date_to + "T23:59:59");
  }

  return { where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

export function createInvoice(data: Partial<Invoice>): Invoice {
  const db = getDb();
  const id = data.id || uuidv4();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO invoices (id, gmail_message_id, sender, subject, received_at, processed_at,
      vendor_name, invoice_number, amount, currency, due_date, ocr, bankgiro, plusgiro, iban,
      pdf_path, status, payment_file_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, data.gmail_message_id || null, data.sender || null, data.subject || null,
    data.received_at || null, data.processed_at || now,
    data.vendor_name || null, data.invoice_number || null,
    data.amount ?? null, data.currency || "SEK",
    data.due_date || null, data.ocr || null, data.bankgiro || null,
    data.plusgiro || null, data.iban || null, data.pdf_path || null,
    data.status || "new", data.payment_file_id || null
  );

  return getInvoiceById(id)!;
}

export function getInvoiceById(id: string): Invoice | undefined {
  return getDb().prepare("SELECT * FROM invoices WHERE id = ?").get(id) as Invoice | undefined;
}

export function getInvoiceByMessageId(gmailMessageId: string): Invoice | undefined {
  return getDb().prepare("SELECT * FROM invoices WHERE gmail_message_id = ?").get(gmailMessageId) as Invoice | undefined;
}

export function listInvoices(filters: InvoiceFilters = {}, page: Page = {}): Invoice[] {
  const { where, params } = buildWhere(filters);
  let sql = `SELECT * FROM invoices ${where} ORDER BY received_at DESC, created_at DESC`;
  if (page.limit) {
    sql += " LIMIT ? OFFSET ?";
    params.push(page.limit, page.offset || 0);
  }
  return getDb().prepare(sql).all(...params) as Invoice[];
}

export function countInvoices(filters: InvoiceFilters = {}): number {
  const { where, params } = buildWhere(filters);
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM invoices ${where}`).get(...params) as { n: number }).n;
}

/** Number of invoices per status, honouring every filter except the status itself. */
export function statusCounts(filters: InvoiceFilters = {}): Record<string, number> {
  const { where, params } = buildWhere(filters, { ignoreStatus: true });
  const rows = getDb().prepare(`SELECT status, COUNT(*) AS n FROM invoices ${where} GROUP BY status`).all(...params) as { status: string; n: number }[];
  const counts: Record<string, number> = { all: 0, new: 0, approved: 0, exported: 0, paid: 0 };
  for (const r of rows) {
    counts[r.status] = (counts[r.status] || 0) + r.n;
    counts.all += r.n;
  }
  return counts;
}

export interface CurrencyTotal {
  currency: string;
  total: number;
}

export interface InvoiceStats {
  unpaidCount: number;
  unpaidTotals: CurrencyTotal[];
  overdueCount: number;
  overdueTotals: CurrencyTotal[];
  newCount: number;
  missingDataCount: number;
}

export function getStats(): InvoiceStats {
  const db = getDb();
  const t = today();

  const unpaid = db.prepare(
    "SELECT currency, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM invoices WHERE status != 'paid' GROUP BY currency ORDER BY total DESC"
  ).all() as { currency: string; n: number; total: number }[];

  const overdue = db.prepare(
    "SELECT currency, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM invoices WHERE status != 'paid' AND due_date IS NOT NULL AND due_date < ? GROUP BY currency ORDER BY total DESC"
  ).all(t) as { currency: string; n: number; total: number }[];

  const newCount = (db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE status = 'new'").get() as { n: number }).n;
  const missingDataCount = (db.prepare(
    "SELECT COUNT(*) AS n FROM invoices WHERE status != 'paid' AND (amount IS NULL OR invoice_number IS NULL)"
  ).get() as { n: number }).n;

  return {
    unpaidCount: unpaid.reduce((s, r) => s + r.n, 0),
    unpaidTotals: unpaid.filter((r) => r.total > 0).map((r) => ({ currency: r.currency, total: r.total })),
    overdueCount: overdue.reduce((s, r) => s + r.n, 0),
    overdueTotals: overdue.filter((r) => r.total > 0).map((r) => ({ currency: r.currency, total: r.total })),
    newCount,
    missingDataCount,
  };
}

export function listVendors(): string[] {
  const rows = getDb().prepare(
    "SELECT DISTINCT vendor_name FROM invoices WHERE vendor_name IS NOT NULL ORDER BY vendor_name COLLATE NOCASE"
  ).all() as { vendor_name: string }[];
  return rows.map((r) => r.vendor_name);
}

const EDITABLE_FIELDS = [
  "vendor_name", "invoice_number", "amount", "currency", "due_date",
  "ocr", "bankgiro", "plusgiro", "iban", "status", "payment_file_id",
  "paid_at", "manually_edited", "pdf_path", "sender", "subject", "received_at",
] as const;

export function updateInvoice(id: string, data: Partial<Invoice>): Invoice | undefined {
  const db = getDb();
  const existing = getInvoiceById(id);
  if (!existing) return undefined;

  const patch: Record<string, any> = {};
  for (const key of EDITABLE_FIELDS) {
    if (key in data && (data as any)[key] !== undefined) patch[key] = (data as any)[key];
  }

  // Keep paid_at in step with the status
  if (patch.status && patch.status !== existing.status) {
    if (patch.status === "paid") {
      if (!patch.paid_at) patch.paid_at = existing.paid_at || today();
    } else {
      patch.paid_at = null;
    }
  }

  const keys = Object.keys(patch);
  if (keys.length === 0) return existing;

  db.prepare(`UPDATE invoices SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
    ...keys.map((k) => patch[k]),
    id
  );
  return getInvoiceById(id);
}

export function setStatusBulk(ids: string[], status: InvoiceStatus): number {
  let changed = 0;
  const run = getDb().transaction(() => {
    for (const id of ids) {
      if (updateInvoice(id, { status })) changed++;
    }
  });
  run();
  return changed;
}

/**
 * Deletes invoices and remembers their Gmail message ids, so that the same
 * e-mail is never imported again (not even when all mail is re-read).
 */
export function deleteInvoices(ids: string[]): number {
  const db = getDb();
  let deleted = 0;
  const run = db.transaction(() => {
    const tombstone = db.prepare("INSERT OR IGNORE INTO deleted_messages (gmail_message_id) VALUES (?)");
    const remove = db.prepare("DELETE FROM invoices WHERE id = ?");
    for (const id of ids) {
      const inv = getInvoiceById(id);
      if (!inv) continue;
      if (inv.gmail_message_id) tombstone.run(inv.gmail_message_id);
      deleted += remove.run(id).changes;
    }
  });
  run();
  return deleted;
}

export function isMessageDeleted(gmailMessageId: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM deleted_messages WHERE gmail_message_id = ?").get(gmailMessageId);
}

export function hasMessageId(gmailMessageId: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM invoices WHERE gmail_message_id = ?").get(gmailMessageId);
}

export function getInvoicesByIds(ids: string[]): Invoice[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return getDb().prepare(`SELECT * FROM invoices WHERE id IN (${placeholders}) ORDER BY received_at DESC`).all(...ids) as Invoice[];
}

/** The account a vendor last asked us to pay to, so that a change can be flagged. */
export function latestPaymentAccountForVendor(
  vendorName: string,
  excludeId: string,
  receivedBefore: string | null
): Pick<Invoice, "id" | "invoice_number" | "iban" | "bankgiro" | "plusgiro"> | undefined {
  return getDb().prepare(
    `SELECT id, invoice_number, iban, bankgiro, plusgiro FROM invoices
     WHERE vendor_name = ? AND id != ? AND received_at < ?
       AND (iban IS NOT NULL OR bankgiro IS NOT NULL OR plusgiro IS NOT NULL)
     ORDER BY received_at DESC LIMIT 1`
  ).get(vendorName, excludeId, receivedBefore || "9999") as any;
}

export function paymentAccount(inv: Pick<Invoice, "iban" | "bankgiro" | "plusgiro">): string | null {
  return inv.iban || inv.bankgiro || inv.plusgiro || null;
}

export function normalizeInvoiceNumber(num: string): string {
  return num.replace(/\s+/g, "").toLowerCase();
}

/** Same vendor + same invoice number, optionally excluding one invoice. */
export function findByVendorAndNumber(vendorName: string, invoiceNumber: string, excludeId?: string): Invoice[] {
  const rows = getDb().prepare("SELECT * FROM invoices WHERE vendor_name = ? AND invoice_number IS NOT NULL").all(vendorName) as Invoice[];
  const wanted = normalizeInvoiceNumber(invoiceNumber);
  return rows.filter((r) => r.id !== excludeId && normalizeInvoiceNumber(r.invoice_number!) === wanted);
}

const STATUS_RANK: Record<string, number> = { new: 0, approved: 1, exported: 2, paid: 3 };

/**
 * Finds invoices that are redundant copies of another invoice: same vendor,
 * same invoice number and compatible amounts (equal, or missing on one side).
 * The best row of every group is kept (furthest status, edited by hand, has an
 * amount, oldest); the ids of the others are returned.
 */
export function findRedundantDuplicateIds(): string[] {
  const rows = getDb().prepare(
    "SELECT * FROM invoices WHERE vendor_name IS NOT NULL AND invoice_number IS NOT NULL"
  ).all() as Invoice[];

  const groups = new Map<string, Invoice[]>();
  for (const r of rows) {
    const key = `${r.vendor_name}|${normalizeInvoiceNumber(r.invoice_number!)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const redundant: string[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;

    const amounts = [...new Set(group.filter((g) => g.amount != null).map((g) => g.amount!.toFixed(2)))];
    // Different amounts under one number: not safe to call them duplicates of each other.
    // Compare only rows that share an amount; rows without an amount join when there is a single amount.
    const buckets = new Map<string, Invoice[]>();
    for (const inv of group) {
      const bucketKey = inv.amount != null ? inv.amount.toFixed(2) : amounts.length <= 1 ? amounts[0] || "none" : `solo-${inv.id}`;
      if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
      buckets.get(bucketKey)!.push(inv);
    }

    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue;
      const sorted = [...bucket].sort((a, b) =>
        (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0)
        || (b.manually_edited || 0) - (a.manually_edited || 0)
        || (b.amount != null ? 1 : 0) - (a.amount != null ? 1 : 0)
        || (a.received_at || "").localeCompare(b.received_at || "")
      );
      redundant.push(...sorted.slice(1).map((s) => s.id));
    }
  }
  return redundant;
}

/**
 * One-off style repair that is safe to run on every start: invoice numbers that
 * are obviously the result of a bad parse are replaced by the number in the
 * mail's subject line. Only touches rows that were never edited by hand, and
 * only when the current value is missing, has no digits ("FD"), or is a constant
 * that an old parser picked up from the PDF for many different invoices.
 */
export function repairInvoiceNumbersFromSubjects(): number {
  const db = getDb();
  const rows = db.prepare(
    "SELECT id, vendor_name, invoice_number, subject FROM invoices WHERE subject IS NOT NULL AND COALESCE(manually_edited, 0) = 0"
  ).all() as Pick<Invoice, "id" | "vendor_name" | "invoice_number" | "subject">[];

  const derived = new Map<string, string>();
  const variants = new Map<string, Set<string>>(); // vendor|current number -> distinct subject numbers
  for (const r of rows) {
    const fromSubject = extractInvoiceNumberFromSubject(r.subject!);
    if (!fromSubject) continue;
    derived.set(r.id, fromSubject);
    if (r.invoice_number) {
      const key = `${r.vendor_name}|${r.invoice_number}`;
      if (!variants.has(key)) variants.set(key, new Set());
      variants.get(key)!.add(normalizeInvoiceNumber(fromSubject));
    }
  }

  let repaired = 0;
  const update = db.prepare("UPDATE invoices SET invoice_number = ? WHERE id = ?");
  const run = db.transaction(() => {
    for (const r of rows) {
      const fromSubject = derived.get(r.id);
      if (!fromSubject || (r.invoice_number && normalizeInvoiceNumber(r.invoice_number) === normalizeInvoiceNumber(fromSubject))) continue;
      const current = r.invoice_number;
      const sharedByManyInvoices = !!current && (variants.get(`${r.vendor_name}|${current}`)?.size || 0) >= 3;
      if (!current || !/\d/.test(current) || sharedByManyInvoices) {
        update.run(fromSubject, r.id);
        repaired++;
      }
    }
  });
  run();
  return repaired;
}
