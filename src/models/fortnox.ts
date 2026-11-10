import { getDb } from "./database";

/** Customer invoices in Fortnox: the money the company has invoiced by hand. */
export interface CustomerInvoice {
  document_number: string;
  customer_name: string | null;
  invoice_date: string | null;
  due_date: string | null;
  // When it was paid in full
  final_pay_date: string | null;
  total: number | null;
  total_vat: number | null;
  balance: number | null;
  currency: string | null;
  // SEK per unit of the invoice's currency
  sek_rate: number;
  cancelled: number;
  synced_at: string | null;
}

export function upsertCustomerInvoice(i: Omit<CustomerInvoice, "total_vat">): void {
  // The list from Fortnox has no VAT; it is fetched once per invoice and must survive a refresh
  getDb().prepare(
    `INSERT INTO customer_invoices (document_number, customer_name, invoice_date, due_date, final_pay_date, total, balance, currency, sek_rate, cancelled, synced_at)
     VALUES (@document_number, @customer_name, @invoice_date, @due_date, @final_pay_date, @total, @balance, @currency, @sek_rate, @cancelled, @synced_at)
     ON CONFLICT(document_number) DO UPDATE SET
       customer_name = excluded.customer_name, invoice_date = excluded.invoice_date, due_date = excluded.due_date,
       final_pay_date = excluded.final_pay_date, total = excluded.total, balance = excluded.balance, currency = excluded.currency,
       sek_rate = excluded.sek_rate, cancelled = excluded.cancelled, synced_at = excluded.synced_at`
  ).run(i);
}

export function customerInvoicesWithoutVat(): string[] {
  return (getDb().prepare("SELECT document_number FROM customer_invoices WHERE total_vat IS NULL AND cancelled = 0").all() as { document_number: string }[])
    .map((r) => r.document_number);
}

export function setCustomerInvoiceVat(documentNumber: string, vat: number): void {
  getDb().prepare("UPDATE customer_invoices SET total_vat = ? WHERE document_number = ?").run(vat, documentNumber);
}

/** Whatever Fortnox no longer lists as unpaid has been paid. */
export function markOthersPaid(unpaidNumbers: string[]): void {
  const db = getDb();
  db.transaction(() => {
    db.exec("CREATE TEMP TABLE IF NOT EXISTS still_unpaid (document_number TEXT PRIMARY KEY); DELETE FROM still_unpaid;");
    const add = db.prepare("INSERT OR IGNORE INTO still_unpaid VALUES (?)");
    for (const n of unpaidNumbers) add.run(n);
    db.exec("UPDATE customer_invoices SET balance = 0 WHERE document_number NOT IN (SELECT document_number FROM still_unpaid)");
  })();
}

export function listUnpaidCustomerInvoices(): CustomerInvoice[] {
  return getDb().prepare("SELECT * FROM customer_invoices WHERE cancelled = 0 AND COALESCE(balance, 0) != 0 ORDER BY due_date").all() as CustomerInvoice[];
}

/** Invoices paid in full within the period – the cash method's output VAT. */
export function customerInvoicesPaidBetween(from: string, to: string): CustomerInvoice[] {
  return getDb().prepare(
    "SELECT * FROM customer_invoices WHERE cancelled = 0 AND COALESCE(balance, 0) = 0 AND final_pay_date BETWEEN ? AND ?"
  ).all(from, to) as CustomerInvoice[];
}

export function customerInvoiceCount(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM customer_invoices").get() as { n: number }).n;
}
