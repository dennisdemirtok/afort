import fs from "fs";
import path from "path";
import { env } from "../config/env";
import { Receipt, createReceipt, updateReceipt, findReceiptByReference, isDocumentDeleted } from "../models/receipt";
import { createNotification } from "../models/notification";
import { parseInvoicePdf, ParsedInvoice } from "./pdf-parser";

export function isPdf(data: Buffer): boolean {
  return data.subarray(0, 5).toString("latin1") === "%PDF-";
}

async function tryParse(data: Buffer): Promise<ParsedInvoice | null> {
  try {
    return await parseInvoicePdf(data);
  } catch (err) {
    console.error("[Receipts] Could not read PDF:", err);
    return null;
  }
}

function savePdf(receipt: Receipt, filename: string, data: Buffer): string {
  // Filed by the month of the receipt, next to the mails from Gmail
  const date = receipt.received_at ? new Date(receipt.received_at) : new Date();
  const monthDir = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  const saveDir = path.join(env.receiptsDir, monthDir);
  fs.mkdirSync(saveDir, { recursive: true });
  const safeName = (filename.toLowerCase().endsWith(".pdf") ? filename : `${filename}.pdf`).replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = path.join(saveDir, `${receipt.id}_${safeName}`);
  fs.writeFileSync(filePath, data);
  return filePath;
}

/**
 * Stores a PDF as the receipt's document, replacing the copy of the mail. Amount and
 * reference are read from the PDF unless they were corrected by hand.
 */
export async function attachReceiptPdf(receipt: Receipt, data: Buffer, filename: string, parsed?: ParsedInvoice | null): Promise<Receipt> {
  if (!isPdf(data)) throw new Error("Filen är ingen PDF.");
  const filePath = savePdf(receipt, filename || "kvitto.pdf", data);
  const info = parsed === undefined ? await tryParse(data) : parsed;

  const patch: Partial<Receipt> = { file_path: filePath, file_kind: "pdf" };
  if (info && !receipt.manually_edited) {
    if (info.amount != null) patch.amount = info.amount;
    if (info.currency) patch.currency = info.currency;
  }
  if (!receipt.reference && info?.invoiceNumber) patch.reference = info.invoiceNumber;
  if (!receipt.payment_ref && info?.paymentRef) patch.payment_ref = info.paymentRef;

  const updated = updateReceipt(receipt.id, patch)!;
  // The mail copy is no longer shown; the mail itself is still in Gmail
  if (receipt.file_path && receipt.file_path !== filePath && receipt.file_kind === "html") {
    fs.rm(receipt.file_path, { force: true }, () => {});
  }
  return updated;
}

export interface ImportedDocument {
  status: "created" | "attached" | "exists" | "deleted";
  receipt: Receipt | null;
}

/**
 * A receipt or invoice that only exists as a PDF: fetched from Google Ads by the Chrome
 * extension, or downloaded from Meta and uploaded by hand. The reference (invoice number) is
 * given or read from the PDF; a PDF that is already stored, or was deleted, is skipped.
 */
export async function importReceiptPdf(input: {
  source: string;
  reference?: string | null;
  issuedAt?: string | null;
  data: Buffer;
  filename: string;
  notify?: boolean;
}): Promise<ImportedDocument> {
  if (!isPdf(input.data)) throw new Error("Filen är ingen PDF.");
  const parsed = await tryParse(input.data);
  const reference = input.reference || parsed?.invoiceNumber || null;

  if (reference && isDocumentDeleted(input.source, reference)) return { status: "deleted", receipt: null };
  const existing = reference ? findReceiptByReference(input.source, reference) : undefined;
  if (existing && existing.file_kind === "pdf") return { status: "exists", receipt: existing };

  const issued = input.issuedAt || parsed?.issueDate || null;
  const target = existing || createReceipt({
    source: input.source,
    subject: reference ? `${input.source} ${reference}` : input.filename,
    received_at: issued ? new Date(`${issued.slice(0, 10)}T12:00:00Z`).toISOString() : new Date().toISOString(),
    reference,
  });
  const receipt = await attachReceiptPdf(target, input.data, input.filename, parsed);
  if (input.notify) {
    const amountText = receipt.amount != null ? ` · ${receipt.amount.toFixed(2)} ${receipt.currency || ""}`.trimEnd() : "";
    createNotification("receipt", `Ny faktura från ${input.source}`, `${reference || input.filename}${amountText}`, `/receipts/${receipt.id}`);
  }
  return { status: existing ? "attached" : "created", receipt };
}
