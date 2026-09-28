import { getDb } from "./database";
import { v4 as uuidv4 } from "uuid";
import { today } from "./invoice";

export interface Receipt {
  id: string;
  gmail_message_id: string | null;
  source: string | null;
  sender: string | null;
  subject: string | null;
  received_at: string | null;
  amount: number | null;
  currency: string | null;
  reference: string | null;
  file_path: string | null;
  file_kind: "pdf" | "html" | null;
  status: "new" | "booked";
  booked_at: string | null;
  note: string | null;
  manually_edited: number;
  created_at: string;
}

export interface ReceiptFilters {
  source?: string;
  status?: string;
  month?: string; // YYYY-MM
  q?: string;
}

const EDITABLE = ["source", "amount", "currency", "reference", "status", "booked_at", "note", "manually_edited", "file_path", "file_kind", "subject", "received_at"] as const;

function where(filters: ReceiptFilters): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.source) { conditions.push("source = ?"); params.push(filters.source); }
  if (filters.status) { conditions.push("status = ?"); params.push(filters.status); }
  if (filters.month) { conditions.push("substr(received_at, 1, 7) = ?"); params.push(filters.month); }
  if (filters.q) {
    const like = `%${filters.q}%`;
    conditions.push("(source LIKE ? OR reference LIKE ? OR subject LIKE ? OR note LIKE ?)");
    params.push(like, like, like, like);
  }
  return { sql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

export function createReceipt(data: Partial<Receipt>): Receipt {
  const db = getDb();
  const id = uuidv4();
  db.prepare(
    `INSERT INTO receipts (id, gmail_message_id, source, sender, subject, received_at, amount, currency, reference, file_path, file_kind, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, data.gmail_message_id || null, data.source || null, data.sender || null, data.subject || null,
    data.received_at || null, data.amount ?? null, data.currency || null, data.reference || null,
    data.file_path || null, data.file_kind || null, data.status || "new"
  );
  return getReceiptById(id)!;
}

export function getReceiptById(id: string): Receipt | undefined {
  return getDb().prepare("SELECT * FROM receipts WHERE id = ?").get(id) as Receipt | undefined;
}

export function getReceiptByMessageId(messageId: string): Receipt | undefined {
  return getDb().prepare("SELECT * FROM receipts WHERE gmail_message_id = ?").get(messageId) as Receipt | undefined;
}

export function listReceipts(filters: ReceiptFilters = {}, limit = 500): Receipt[] {
  const w = where(filters);
  return getDb().prepare(`SELECT * FROM receipts ${w.sql} ORDER BY received_at DESC LIMIT ?`).all(...w.params, limit) as Receipt[];
}

export function getReceiptsByIds(ids: string[]): Receipt[] {
  if (ids.length === 0) return [];
  return getDb().prepare(`SELECT * FROM receipts WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY received_at DESC`).all(...ids) as Receipt[];
}

export function updateReceipt(id: string, data: Partial<Receipt>): Receipt | undefined {
  const existing = getReceiptById(id);
  if (!existing) return undefined;
  const patch: Record<string, unknown> = {};
  for (const key of EDITABLE) if (key in data && (data as any)[key] !== undefined) patch[key] = (data as any)[key];
  if (patch.status && patch.status !== existing.status) {
    patch.booked_at = patch.status === "booked" ? existing.booked_at || today() : null;
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) return existing;
  getDb().prepare(`UPDATE receipts SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => patch[k]), id);
  return getReceiptById(id);
}

export function setReceiptStatusBulk(ids: string[], status: "new" | "booked"): number {
  let n = 0;
  for (const id of ids) if (updateReceipt(id, { status })) n++;
  return n;
}

/** Removes receipts and remembers the mails so they are never imported again. */
export function deleteReceipts(ids: string[]): number {
  const db = getDb();
  const rows = getReceiptsByIds(ids);
  const forget = db.prepare("INSERT OR IGNORE INTO deleted_messages (gmail_message_id) VALUES (?)");
  const del = db.prepare("DELETE FROM receipts WHERE id = ?");
  db.transaction(() => {
    for (const r of rows) {
      if (r.gmail_message_id) forget.run(r.gmail_message_id);
      del.run(r.id);
    }
  })();
  return rows.length;
}

export function listReceiptSources(): string[] {
  return (getDb().prepare("SELECT DISTINCT source FROM receipts WHERE source IS NOT NULL ORDER BY source").all() as { source: string }[]).map((r) => r.source);
}

export function listReceiptMonths(): string[] {
  return (getDb().prepare("SELECT DISTINCT substr(received_at, 1, 7) AS m FROM receipts WHERE received_at IS NOT NULL ORDER BY m DESC").all() as { m: string }[]).map((r) => r.m);
}

export function receiptCounts(): { total: number; unbooked: number } {
  const row = getDb().prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS unbooked FROM receipts").get() as any;
  return { total: row.total || 0, unbooked: row.unbooked || 0 };
}
