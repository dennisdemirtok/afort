import { getDb } from "./database";
import { today } from "./invoice";

export interface ShopifyPayout {
  id: string;
  gid: string | null;
  issued_at: string | null;
  shopify_status: string | null;
  transaction_type: string | null;
  net: number | null;
  currency: string | null;
  charges_gross: number | null;
  charges_fee: number | null;
  refunds_gross: number | null;
  refunds_fee: number | null;
  adjustments_gross: number | null;
  adjustments_fee: number | null;
  reserved_gross: number | null;
  reserved_fee: number | null;
  transaction_count: number | null;
  report_path: string | null;
  status: "new" | "received" | "booked";
  bank_date: string | null;
  synced_at: string | null;
  created_at: string;
}

export function getPayout(id: string): ShopifyPayout | undefined {
  return getDb().prepare("SELECT * FROM shopify_payouts WHERE id = ?").get(id) as ShopifyPayout | undefined;
}

export function listPayouts(limit = 500): ShopifyPayout[] {
  return getDb().prepare("SELECT * FROM shopify_payouts ORDER BY issued_at DESC LIMIT ?").all(limit) as ShopifyPayout[];
}

/** Payouts that have not been ticked off against the bank statement yet. */
export function listUnmatchedPayouts(): ShopifyPayout[] {
  return getDb().prepare("SELECT * FROM shopify_payouts WHERE bank_date IS NULL ORDER BY issued_at DESC").all() as ShopifyPayout[];
}

/** Inserts or refreshes what Shopify reports. Never touches the local status or bank match. */
export function upsertPayout(p: Omit<ShopifyPayout, "status" | "bank_date" | "created_at">): void {
  getDb().prepare(
    `INSERT INTO shopify_payouts (id, gid, issued_at, shopify_status, transaction_type, net, currency,
       charges_gross, charges_fee, refunds_gross, refunds_fee, adjustments_gross, adjustments_fee,
       reserved_gross, reserved_fee, transaction_count, report_path, synced_at)
     VALUES (@id, @gid, @issued_at, @shopify_status, @transaction_type, @net, @currency,
       @charges_gross, @charges_fee, @refunds_gross, @refunds_fee, @adjustments_gross, @adjustments_fee,
       @reserved_gross, @reserved_fee, @transaction_count, @report_path, @synced_at)
     ON CONFLICT(id) DO UPDATE SET
       gid = excluded.gid, issued_at = excluded.issued_at, shopify_status = excluded.shopify_status,
       transaction_type = excluded.transaction_type, net = excluded.net, currency = excluded.currency,
       charges_gross = excluded.charges_gross, charges_fee = excluded.charges_fee,
       refunds_gross = excluded.refunds_gross, refunds_fee = excluded.refunds_fee,
       adjustments_gross = excluded.adjustments_gross, adjustments_fee = excluded.adjustments_fee,
       reserved_gross = excluded.reserved_gross, reserved_fee = excluded.reserved_fee,
       transaction_count = excluded.transaction_count, report_path = excluded.report_path, synced_at = excluded.synced_at`
  ).run(p);
}

export function setPayoutStatus(id: string, status: ShopifyPayout["status"], bankDate?: string | null): boolean {
  const existing = getPayout(id);
  if (!existing) return false;
  const date = status === "new" ? null : bankDate === undefined ? existing.bank_date : bankDate;
  getDb().prepare("UPDATE shopify_payouts SET status = ?, bank_date = ? WHERE id = ?").run(status, date, id);
  return true;
}

export function markPayoutReceived(id: string, bankDate?: string): boolean {
  const existing = getPayout(id);
  if (!existing) return false;
  // A payout already booked stays booked; it just gets its bank date
  const status = existing.status === "booked" ? "booked" : "received";
  getDb().prepare("UPDATE shopify_payouts SET status = ?, bank_date = ? WHERE id = ?").run(status, bankDate || existing.bank_date || today(), id);
  return true;
}

export function payoutStats(): { count: number; unmatched: number; netThisYear: number; feesThisYear: number; currency: string | null } {
  const year = today().slice(0, 4);
  const row = getDb().prepare(
    `SELECT COUNT(*) AS count,
            SUM(CASE WHEN bank_date IS NULL THEN 1 ELSE 0 END) AS unmatched,
            SUM(CASE WHEN substr(issued_at, 1, 4) = ? THEN net ELSE 0 END) AS net,
            SUM(CASE WHEN substr(issued_at, 1, 4) = ? THEN COALESCE(charges_fee, 0) + COALESCE(refunds_fee, 0) + COALESCE(adjustments_fee, 0) ELSE 0 END) AS fees,
            MAX(currency) AS currency
     FROM shopify_payouts`
  ).get(year, year) as any;
  return { count: row.count || 0, unmatched: row.unmatched || 0, netThisYear: row.net || 0, feesThisYear: row.fees || 0, currency: row.currency || null };
}
