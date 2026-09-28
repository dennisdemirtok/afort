import fs from "fs";
import { getDb } from "../models/database";
import { parseInvoicePdf } from "./pdf-parser";

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
