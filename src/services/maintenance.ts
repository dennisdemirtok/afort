import fs from "fs";
import { getDb, getMeta, setMeta } from "../models/database";
import { parseInvoicePdf, paymentRefFromText } from "./pdf-parser";
import { htmlToText, isLinkOnlyNotice } from "./invoice-extract";

/**
 * Older parser versions did not read the bank account out of Polish invoices.
 * Reads the stored PDFs again and fills in IBAN where it is still empty.
 * Never overwrites anything and skips invoices edited by hand.
 */
export async function backfillIbansFromPdfs(): Promise<number> {
  const db = getDb();
  const rows = db.prepare(
    "SELECT id, pdf_path FROM invoices WHERE iban IS NULL AND pdf_path IS NOT NULL AND COALESCE(manually_edited, 0) = 0"
  ).all() as { id: string; pdf_path: string }[];

  const update = db.prepare("UPDATE invoices SET iban = ? WHERE id = ? AND iban IS NULL");
  let filled = 0;
  for (const row of rows) {
    if (!fs.existsSync(row.pdf_path)) continue;
    try {
      const parsed = await parseInvoicePdf(fs.readFileSync(row.pdf_path));
      if (parsed.iban && update.run(parsed.iban, row.id).changes > 0) filled++;
    } catch (err: any) {
      console.error(`[AFORT] Could not read ${row.pdf_path}:`, err?.message || err);
    }
  }
  return filled;
}

/**
 * Google Ads "Ditt faktureringsdokument är klart" mails imported as receipts before such
 * link-only notices were skipped. They only hold a link, so they are removed; the invoice
 * itself comes in as a PDF through the Chrome extension.
 */
export function removeLinkOnlyReceipts(): number {
  const db = getDb();
  const rows = db.prepare(
    "SELECT id, gmail_message_id, subject, file_path FROM receipts WHERE file_kind = 'html' AND subject LIKE 'Google Ads%'"
  ).all() as { id: string; gmail_message_id: string | null; subject: string; file_path: string | null }[];

  const forget = db.prepare("INSERT OR IGNORE INTO deleted_messages (gmail_message_id) VALUES (?)");
  const del = db.prepare("DELETE FROM receipts WHERE id = ?");
  let removed = 0;
  for (const row of rows) {
    if (!row.file_path || !fs.existsSync(row.file_path)) continue;
    if (!isLinkOnlyNotice(row.subject, htmlToText(fs.readFileSync(row.file_path, "utf8")))) continue;
    if (row.gmail_message_id) forget.run(row.gmail_message_id);
    del.run(row.id);
    fs.rmSync(row.file_path, { force: true });
    removed++;
  }
  return removed;
}

/**
 * Receipts stored before Meta's "Reference number" was read: reads it from the stored PDF or
 * mail so the receipts can be matched to their card purchases. Runs once.
 */
export async function backfillPaymentRefs(): Promise<number> {
  if (getMeta("payment_refs_backfilled")) return 0;
  const db = getDb();
  const rows = db.prepare(
    "SELECT id, file_path, file_kind FROM receipts WHERE payment_ref IS NULL AND file_path IS NOT NULL"
  ).all() as { id: string; file_path: string; file_kind: string }[];

  const update = db.prepare("UPDATE receipts SET payment_ref = ? WHERE id = ? AND payment_ref IS NULL");
  let filled = 0;
  for (const row of rows) {
    if (!fs.existsSync(row.file_path)) continue;
    try {
      const ref = row.file_kind === "pdf"
        ? (await parseInvoicePdf(fs.readFileSync(row.file_path))).paymentRef
        : paymentRefFromText(htmlToText(fs.readFileSync(row.file_path, "utf8")));
      if (ref && update.run(ref, row.id).changes > 0) filled++;
    } catch (err: any) {
      console.error(`[AFORT] Could not read ${row.file_path}:`, err?.message || err);
    }
  }
  setMeta("payment_refs_backfilled", new Date().toISOString());
  return filled;
}
