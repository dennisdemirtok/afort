import { getDb } from "./database";
import { v4 as uuidv4 } from "uuid";

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
  created_at: string;
}

export interface InvoiceFilters {
  status?: string;
  vendor?: string;
  date_from?: string;
  date_to?: string;
}

export function createInvoice(data: Partial<Invoice>): Invoice {
  const db = getDb();
  const id = data.id || uuidv4();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO invoices (id, gmail_message_id, sender, subject, received_at, processed_at,
      vendor_name, invoice_number, amount, currency, due_date, ocr, bankgiro, plusgiro, iban,
      pdf_path, status, payment_file_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id, data.gmail_message_id || null, data.sender || null, data.subject || null,
    data.received_at || null, data.processed_at || now,
    data.vendor_name || null, data.invoice_number || null,
    data.amount || null, data.currency || "SEK",
    data.due_date || null, data.ocr || null, data.bankgiro || null,
    data.plusgiro || null, data.iban || null, data.pdf_path || null,
    data.status || "new", data.payment_file_id || null
  );

  return getInvoiceById(id)!;
}

export function getInvoiceById(id: string): Invoice | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM invoices WHERE id = ?").get(id) as Invoice | undefined;
}

export function listInvoices(filters: InvoiceFilters = {}): Invoice[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: any[] = [];

  if (filters.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (filters.vendor) {
    conditions.push("vendor_name LIKE ?");
    params.push(`%${filters.vendor}%`);
  }
  if (filters.date_from) {
    conditions.push("due_date >= ?");
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    conditions.push("due_date <= ?");
    params.push(filters.date_to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM invoices ${where} ORDER BY received_at DESC, created_at DESC`).all(...params) as Invoice[];
}

export function updateInvoice(id: string, data: Partial<Invoice>): Invoice | undefined {
  const db = getDb();
  const fields: string[] = [];
  const params: any[] = [];

  const allowed = [
    "vendor_name", "invoice_number", "amount", "currency", "due_date",
    "ocr", "bankgiro", "plusgiro", "iban", "status", "payment_file_id",
  ];

  for (const key of allowed) {
    if (key in data) {
      fields.push(`${key} = ?`);
      params.push((data as any)[key]);
    }
  }

  if (fields.length === 0) return getInvoiceById(id);

  params.push(id);
  db.prepare(`UPDATE invoices SET ${fields.join(", ")} WHERE id = ?`).run(...params);
  return getInvoiceById(id);
}

export function hasMessageId(gmailMessageId: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT 1 FROM invoices WHERE gmail_message_id = ?").get(gmailMessageId);
  return !!row;
}

export function getInvoicesByIds(ids: string[]): Invoice[] {
  const db = getDb();
  const placeholders = ids.map(() => "?").join(",");
  return db.prepare(`SELECT * FROM invoices WHERE id IN (${placeholders})`).all(...ids) as Invoice[];
}
