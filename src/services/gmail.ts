import { google, gmail_v1 } from "googleapis";
import fs from "fs";
import path from "path";
import { env } from "../config/env";
import { getDb } from "../models/database";
import {
  Invoice,
  createInvoice,
  updateInvoice,
  getInvoiceByMessageId,
  isMessageDeleted,
  findByVendorAndNumber,
  latestPaymentAccountForVendor,
  paymentAccount,
  PROFORMA_SKIP_VENDORS,
  isProforma,
  rememberProforma,
} from "../models/invoice";
import { listRules } from "../models/rule";
import { createReceipt, getReceiptByMessageId } from "../models/receipt";
import { createNotification } from "../models/notification";
import { parseInvoicePdf, ParsedInvoice, amountFromText, paymentRefFromText } from "./pdf-parser";
import {
  matchRule,
  matchReceiptRule,
  resolveVendorName,
  displayName,
  extractInvoiceNumberFromSubject,
  extractAmountFromSubject,
  extractReferenceFromSubject,
  htmlToText,
  isLinkOnlyNotice,
  isReminder,
  SenderRule,
} from "./invoice-extract";

const LABEL_AFTER_PROCESS = "Processed/Invoices";
const LABEL_RECEIPTS = "Processed/Receipts";

// Suppliers that invoice us in EUR even when the PDF only mentions PLN
const EUR_VENDORS = ["DTFtransfer.com", "Fancywork DTF", "Feelgood SP", "Helios Advertising"];

const oauth2Client = new google.auth.OAuth2(
  env.gmailClientId,
  env.gmailClientSecret,
  `${env.publicUrl}/auth/google/callback`
);
oauth2Client.setCredentials({ refresh_token: env.gmailRefreshToken });

const gmail = google.gmail({ version: "v1", auth: oauth2Client });

/** "new" looks at recent mail only; "all" re-reads every mail from every sender. */
export type PollMode = "new" | "all";

export interface PollStatus {
  running: boolean;
  mode: PollMode | null;
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  done: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  error: string | null;
}

const status: PollStatus = {
  running: false, mode: null, startedAt: null, finishedAt: null,
  total: 0, done: 0, created: 0, updated: 0, skipped: 0, failed: 0, error: null,
};

// Messages we looked at and decided not to import (no rule match / no PDF).
// Remembered for the lifetime of the process so they are not fetched on every poll.
const ignoredMessageIds = new Set<string>();

export function getPollStatus(): PollStatus {
  return { ...status };
}

export function isGmailConfigured(): boolean {
  return !!(env.gmailClientId && env.gmailClientSecret && env.gmailRefreshToken);
}

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[], name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

async function getOrCreateLabel(labelName: string): Promise<string> {
  const res = await gmail.users.labels.list({ userId: "me" });
  const existing = res.data.labels?.find((l) => l.name === labelName);
  if (existing) return existing.id!;

  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: { name: labelName, labelListVisibility: "labelShow", messageListVisibility: "show" },
  });
  return created.data.id!;
}

async function downloadPdfAttachment(
  messageId: string,
  parts: gmail_v1.Schema$MessagePart[]
): Promise<{ filename: string; data: Buffer } | null> {
  for (const part of parts) {
    // Some senders (Blue Water's NoReply) attach PDFs as application/octet-stream
    const isPdf =
      part.mimeType === "application/pdf" ||
      (part.mimeType === "application/octet-stream" && part.filename?.toLowerCase().endsWith(".pdf"));
    if (isPdf && part.body?.attachmentId) {
      const attachment = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: part.body.attachmentId,
      });
      return { filename: part.filename || "invoice.pdf", data: Buffer.from(attachment.data.data!, "base64") };
    }
    if (part.parts) {
      const nested = await downloadPdfAttachment(messageId, part.parts);
      if (nested) return nested;
    }
  }
  return null;
}

async function listMessageIds(query: string, max: number): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: Math.min(100, max - ids.length),
      pageToken,
    });
    for (const msg of res.data.messages || []) ids.push(msg.id!);
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken && ids.length < max);
  return ids;
}

function saveFile(baseDir: string, messageId: string, filename: string, data: Buffer | string, receivedAt: Date): string {
  // Filed by the month the mail arrived, so re-reading the mailbox is idempotent
  const monthDir = `${receivedAt.getFullYear()}-${String(receivedAt.getMonth() + 1).padStart(2, "0")}`;
  const saveDir = path.join(baseDir, monthDir);
  fs.mkdirSync(saveDir, { recursive: true });
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = path.join(saveDir, `${messageId}_${safeName}`);
  fs.writeFileSync(filePath, data);
  return filePath;
}

function savePdf(messageId: string, filename: string, data: Buffer, receivedAt: Date): string {
  return saveFile(env.invoicesDir, messageId, filename, data, receivedAt);
}

/** The HTML (or plain text) body of a mail, for receipts that come without an attachment. */
function findBody(parts: gmail_v1.Schema$MessagePart[], mimeType: string): string | null {
  for (const part of parts) {
    if (part.mimeType === mimeType && part.body?.data) return Buffer.from(part.body.data, "base64").toString("utf8");
    if (part.parts) {
      const nested = findBody(part.parts, mimeType);
      if (nested) return nested;
    }
  }
  return null;
}

type Outcome = "created" | "updated" | "skipped";

interface Labels {
  invoices: string | null;
  receipts: string | null;
}

function forget(messageId: string) {
  getDb().prepare("INSERT OR IGNORE INTO deleted_messages (gmail_message_id) VALUES (?)").run(messageId);
}

/** A vendor is chasing an invoice we already have. */
function notifyReminder(vendorName: string, invoiceNumber: string, same: Invoice[]) {
  const unpaid = same.find((s) => s.status !== "paid");
  if (unpaid) {
    createNotification(
      "reminder",
      `Betalningspåminnelse från ${vendorName}`,
      `Faktura ${invoiceNumber} är inte markerad som betald`,
      `/invoices/${unpaid.id}`
    );
    return;
  }
  // We think it is paid, the vendor does not – the money may have gone to an old account
  createNotification(
    "warning",
    "Påminnelse om betald faktura",
    `${vendorName} påminner om ${invoiceNumber}, som är markerad betald hos oss – kontrollera att betalningen gick till rätt konto`,
    `/invoices/${same[0].id}`
  );
}

/**
 * A card receipt (Distribold, Google, Meta …): the PDF if there is one, otherwise the
 * mail body itself is kept as the document. Amount and reference are best effort and
 * can be corrected by hand.
 */
async function processReceipt(
  messageId: string,
  full: gmail_v1.Schema$Message,
  from: string,
  subject: string,
  receivedAt: Date,
  rule: SenderRule,
  mode: PollMode,
  labelId: string | null
): Promise<Outcome> {
  if (getReceiptByMessageId(messageId)) return "skipped";

  const parts = full.payload?.parts || (full.payload ? [full.payload] : []);
  const attachment = await downloadPdfAttachment(messageId, parts);
  const source = rule.vendor_name || displayName(from);

  let filePath: string;
  let fileKind: "pdf" | "html";
  let amount: number | null = null;
  let currency: string | null = null;
  let reference = extractReferenceFromSubject(subject);
  let paymentRef: string | null = null;

  if (attachment) {
    filePath = saveFile(env.receiptsDir, messageId, attachment.filename, attachment.data, receivedAt);
    fileKind = "pdf";
    try {
      const parsed = await parseInvoicePdf(attachment.data);
      amount = parsed.amount;
      currency = parsed.currency;
      reference = reference || parsed.invoiceNumber;
      paymentRef = parsed.paymentRef;
    } catch (err) {
      console.error(`[Gmail] Could not read receipt PDF in ${messageId} (${subject}):`, err);
    }
  } else {
    const html = findBody(parts, "text/html");
    const text = html ? null : findBody(parts, "text/plain");
    if (!html && !text) {
      ignoredMessageIds.add(messageId);
      return "skipped";
    }
    const bodyText = html ? htmlToText(html) : text || "";
    // Google Ads only mails a link to the invoice – useless as a receipt. The PDF comes in
    // through the Chrome extension (or an upload) instead.
    if (isLinkOnlyNotice(subject, bodyText)) {
      ignoredMessageIds.add(messageId);
      return "skipped";
    }
    const document = html || `<pre style="font-family:sans-serif;white-space:pre-wrap">${(text || "").replace(/</g, "&lt;")}</pre>`;
    filePath = saveFile(env.receiptsDir, messageId, "kvitto.html", document, receivedAt);
    fileKind = "html";
    const found = amountFromText(bodyText);
    amount = found.amount;
    currency = found.currency;
    paymentRef = paymentRefFromText(bodyText);
  }

  const receipt = createReceipt({
    gmail_message_id: messageId,
    source,
    sender: from,
    subject,
    received_at: receivedAt.toISOString(),
    amount,
    currency,
    reference,
    file_path: filePath,
    file_kind: fileKind,
    payment_ref: paymentRef,
  });
  await markProcessed(messageId, labelId);

  if (mode === "new") {
    const amountText = amount != null ? `${amount.toFixed(2)} ${currency || ""}`.trim() : "";
    createNotification("receipt", `Nytt kvitto från ${source}`, [reference, amountText].filter(Boolean).join(" · ") || subject.substring(0, 60), `/receipts/${receipt.id}`);
  }
  console.log(`[Gmail] Receipt: ${subject} (${source})`);
  return "created";
}

async function processMessage(messageId: string, mode: PollMode, labels: Labels): Promise<Outcome> {
  const existing = getInvoiceByMessageId(messageId);
  if (existing && mode === "new") return "skipped";
  if (isMessageDeleted(messageId) || ignoredMessageIds.has(messageId)) return "skipped";
  if (!existing && getReceiptByMessageId(messageId)) return "skipped";

  const full = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  const headers = full.data.payload?.headers || [];
  const from = getHeader(headers, "From");
  const subject = getHeader(headers, "Subject");
  const dateHeader = getHeader(headers, "Date");
  const receivedAt = dateHeader && !isNaN(Date.parse(dateHeader))
    ? new Date(dateHeader)
    : new Date(Number(full.data.internalDate) || Date.now());

  const rule = matchRule(from, subject, listRules("invoice"));
  if (!rule) {
    const receiptRule = matchReceiptRule(from, subject, listRules("receipt"));
    if (receiptRule) return processReceipt(messageId, full.data, from, subject, receivedAt, receiptRule, mode, labels.receipts);
    ignoredMessageIds.add(messageId);
    return "skipped";
  }
  const labelId = labels.invoices;

  const attachment = await downloadPdfAttachment(messageId, full.data.payload?.parts || []);
  if (!attachment) {
    ignoredMessageIds.add(messageId);
    return "skipped";
  }

  // A PDF we cannot read should still show up, so that it can be filled in by hand
  let parsed: ParsedInvoice = {
    vendorName: null, invoiceNumber: null, issueDate: null, paymentRef: null, amount: null, currency: null,
    dueDate: null, ocr: null, bankgiro: null, plusgiro: null, iban: null,
  };
  try {
    parsed = await parseInvoicePdf(attachment.data);
  } catch (err) {
    console.error(`[Gmail] Could not read PDF in ${messageId} (${subject}):`, err);
  }

  const vendorName = resolveVendorName(from, subject, rule);
  const subjectNumber = extractInvoiceNumberFromSubject(subject);
  const reminder = isReminder(subject);
  // The subject line is more reliable than the PDF, which often yields customer numbers
  const invoiceNumber = subjectNumber || parsed.invoiceNumber;
  const amount = parsed.amount ?? extractAmountFromSubject(subject);
  let currency = parsed.currency || "SEK";
  if (EUR_VENDORS.includes(vendorName) && (!parsed.currency || parsed.currency === "PLN")) currency = "EUR";

  const fields = {
    sender: from,
    subject,
    received_at: receivedAt.toISOString(),
    vendor_name: vendorName,
    invoice_number: invoiceNumber,
    amount,
    currency,
    due_date: parsed.dueDate,
    ocr: parsed.ocr,
    bankgiro: parsed.bankgiro,
    plusgiro: parsed.plusgiro,
    iban: parsed.iban,
  };

  // Feelgood sends a pro forma first and the real invoice (FD …) after delivery – keep only the latter,
  // but remember the pro forma number so that the bank payment can still be matched
  if (PROFORMA_SKIP_VENDORS.includes(vendorName) && isProforma(subject, invoiceNumber)) {
    rememberProforma(vendorName, invoiceNumber, amount, currency, receivedAt.toISOString());
    forget(messageId);
    await markProcessed(messageId, labelId);
    return "skipped";
  }

  // Re-reading a mail we already have: refresh what the parser produced, keep status and manual edits
  if (existing) {
    const pdfPath = savePdf(messageId, attachment.filename, attachment.data, receivedAt);
    if (existing.manually_edited) {
      updateInvoice(existing.id, { pdf_path: pdfPath });
    } else {
      updateInvoice(existing.id, { ...fields, pdf_path: pdfPath });
    }
    return "updated";
  }

  // Reminders and forwarded copies of an invoice we already have must not become new invoices
  if (invoiceNumber) {
    const same = findByVendorAndNumber(vendorName, invoiceNumber);
    const sameAmount = same.some((s) => s.amount != null && amount != null && Math.abs(s.amount - amount) < 0.005);
    if (same.length > 0 && (reminder || sameAmount)) {
      forget(messageId);
      if (reminder && mode === "new") notifyReminder(vendorName, invoiceNumber, same);
      await markProcessed(messageId, labelId);
      return "skipped";
    }
  }

  // A reminder that names no invoice ("Wezwanie do zapłaty") carries a statement, not an
  // invoice – point the user to the mail instead of inventing an invoice from it
  if (reminder && !subjectNumber) {
    forget(messageId);
    if (mode === "new") {
      createNotification(
        "reminder",
        `Betalningskrav från ${vendorName}`,
        `"${subject.substring(0, 80)}" – öppna mailet i Gmail för att se vilka fakturor som avses`,
        "/invoices?status=new"
      );
    }
    await markProcessed(messageId, labelId);
    return "skipped";
  }

  const pdfPath = savePdf(messageId, attachment.filename, attachment.data, receivedAt);
  const invoice = createInvoice({ gmail_message_id: messageId, ...fields, pdf_path: pdfPath, status: "new" });

  await markProcessed(messageId, labelId);

  if (mode === "new") {
    const amountText = amount != null ? `${amount.toFixed(2)} ${currency}` : "";
    createNotification(
      "new_invoice",
      `Ny faktura från ${vendorName}`,
      [invoiceNumber, amountText].filter(Boolean).join(" · ") || subject.substring(0, 60),
      `/invoices/${invoice.id}`
    );

    // Paying to an account the vendor never used before deserves a second look
    const account = paymentAccount(fields);
    const previous = latestPaymentAccountForVendor(vendorName, invoice.id, fields.received_at);
    const previousAccount = previous ? paymentAccount(previous) : null;
    if (account && previousAccount && previousAccount !== account) {
      createNotification(
        "warning",
        `Nytt bankkonto hos ${vendorName}`,
        `Faktura ${invoiceNumber || ""} anger ${account}, tidigare ${previousAccount}. Kontrollera innan betalning.`,
        `/invoices/${invoice.id}`
      );
    }
  }

  console.log(`[Gmail] Imported: ${subject} (${vendorName})`);
  return "created";
}

async function markProcessed(messageId: string, labelId: string | null) {
  try {
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: { removeLabelIds: ["UNREAD"], addLabelIds: labelId ? [labelId] : [] },
    });
  } catch (err) {
    // Not being able to label a mail must never lose the invoice
    console.error(`[Gmail] Could not label ${messageId}:`, err);
  }
}

/**
 * Looks for invoice mail and imports it. Only one run at a time: a second call
 * while a run is in progress returns immediately with { busy: true }.
 */
export async function pollGmail(mode: PollMode = "new"): Promise<PollStatus & { busy?: boolean }> {
  if (status.running) return { ...status, busy: true };

  Object.assign(status, {
    running: true, mode, startedAt: new Date().toISOString(), finishedAt: null,
    total: 0, done: 0, created: 0, updated: 0, skipped: 0, failed: 0, error: null,
  });

  try {
    if (!isGmailConfigured()) throw new Error("Gmail är inte konfigurerat (GMAIL_CLIENT_ID / GMAIL_REFRESH_TOKEN saknas)");

    const invoiceSenders = [...new Set(listRules("invoice").map((r) => r.from_address.toLowerCase()))];
    const receiptSenders = [...new Set(listRules("receipt").map((r) => r.from_address.toLowerCase()))];
    const messageIds = new Set<string>();

    // One search per sender – large OR queries silently drop results in the Gmail API.
    // "new" does not rely on the unread flag: a mail opened on the phone is still imported.
    // Receipts may arrive without an attachment (the mail itself is the receipt).
    const searches = [
      ...invoiceSenders.map((sender) => ({ sender, attachment: true })),
      ...receiptSenders.map((sender) => ({ sender, attachment: false })),
    ];
    for (const { sender, attachment } of searches) {
      const query = [
        `from:${sender.replace(/^@/, "")}`,
        attachment ? "has:attachment filename:pdf" : "",
        mode === "new" ? "newer_than:30d" : "",
      ].filter(Boolean).join(" ");
      try {
        for (const id of await listMessageIds(query, mode === "new" ? 100 : 1000)) messageIds.add(id);
      } catch (err: any) {
        console.error(`[Gmail] Search failed for ${sender}:`, err?.message || err);
        status.error = `Sökning misslyckades för ${sender}: ${err?.message || err}`;
      }
    }

    status.total = messageIds.size;
    const labels: Labels = { invoices: null, receipts: null };
    if (messageIds.size > 0) {
      labels.invoices = await getOrCreateLabel(LABEL_AFTER_PROCESS).catch(() => null);
      if (receiptSenders.length) labels.receipts = await getOrCreateLabel(LABEL_RECEIPTS).catch(() => null);
    }

    for (const messageId of messageIds) {
      // One broken mail must never stop the rest from being imported
      try {
        const outcome = await processMessage(messageId, mode, labels);
        status[outcome]++;
      } catch (err: any) {
        status.failed++;
        console.error(`[Gmail] Failed to process ${messageId}:`, err?.message || err);
      }
      status.done++;
    }

    if (mode === "all") {
      createNotification(
        "info",
        "Omläsning av Gmail klar",
        `${status.created} nya, ${status.updated} uppdaterade${status.failed ? `, ${status.failed} misslyckades` : ""}`,
        "/invoices"
      );
    }
    console.log(`[Gmail] ${mode} poll done: ${status.created} created, ${status.updated} updated, ${status.skipped} skipped, ${status.failed} failed`);
  } catch (err: any) {
    status.error = err?.message || String(err);
    console.error("[Gmail] Poll failed:", status.error);
  } finally {
    status.running = false;
    status.finishedAt = new Date().toISOString();
  }

  return { ...status };
}

// ---- OAuth (connecting the Gmail account) ----

export function getAuthUrl(state: string): string {
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.modify"],
    prompt: "consent",
    state,
  });
}

export async function exchangeCode(code: string): Promise<string> {
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  return tokens.refresh_token || "";
}
