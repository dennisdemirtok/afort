import { google, gmail_v1 } from "googleapis";
import fs from "fs";
import path from "path";
import { env } from "../config/env";
import { getDb } from "../models/database";
import {
  createInvoice,
  updateInvoice,
  getInvoiceByMessageId,
  isMessageDeleted,
  findByVendorAndNumber,
} from "../models/invoice";
import { listRules } from "../models/rule";
import { createNotification } from "../models/notification";
import { parseInvoicePdf, ParsedInvoice } from "./pdf-parser";
import {
  matchRule,
  resolveVendorName,
  extractInvoiceNumberFromSubject,
  extractAmountFromSubject,
  isReminder,
} from "./invoice-extract";

const LABEL_AFTER_PROCESS = "Processed/Invoices";

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

function savePdf(messageId: string, filename: string, data: Buffer, receivedAt: Date): string {
  // Filed by the month the mail arrived, so re-reading the mailbox is idempotent
  const monthDir = `${receivedAt.getFullYear()}-${String(receivedAt.getMonth() + 1).padStart(2, "0")}`;
  const saveDir = path.join(env.invoicesDir, monthDir);
  fs.mkdirSync(saveDir, { recursive: true });
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const pdfPath = path.join(saveDir, `${messageId}_${safeName}`);
  fs.writeFileSync(pdfPath, data);
  return pdfPath;
}

type Outcome = "created" | "updated" | "skipped";

async function processMessage(messageId: string, mode: PollMode, labelId: string | null): Promise<Outcome> {
  const existing = getInvoiceByMessageId(messageId);
  if (existing && mode === "new") return "skipped";
  if (isMessageDeleted(messageId) || ignoredMessageIds.has(messageId)) return "skipped";

  const full = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  const headers = full.data.payload?.headers || [];
  const from = getHeader(headers, "From");
  const subject = getHeader(headers, "Subject");
  const dateHeader = getHeader(headers, "Date");
  const receivedAt = dateHeader && !isNaN(Date.parse(dateHeader))
    ? new Date(dateHeader)
    : new Date(Number(full.data.internalDate) || Date.now());

  const rule = matchRule(from, subject, listRules());
  if (!rule) {
    ignoredMessageIds.add(messageId);
    return "skipped";
  }

  const attachment = await downloadPdfAttachment(messageId, full.data.payload?.parts || []);
  if (!attachment) {
    ignoredMessageIds.add(messageId);
    return "skipped";
  }

  // A PDF we cannot read should still show up, so that it can be filled in by hand
  let parsed: ParsedInvoice = {
    vendorName: null, invoiceNumber: null, amount: null, currency: null,
    dueDate: null, ocr: null, bankgiro: null, plusgiro: null, iban: null,
  };
  try {
    parsed = await parseInvoicePdf(attachment.data);
  } catch (err) {
    console.error(`[Gmail] Could not read PDF in ${messageId} (${subject}):`, err);
  }

  const vendorName = resolveVendorName(from, subject, rule);
  // The subject line is more reliable than the PDF, which often yields customer numbers
  const invoiceNumber = extractInvoiceNumberFromSubject(subject) || parsed.invoiceNumber;
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
    const reminder = isReminder(subject);
    const sameAmount = same.some((s) => s.amount != null && amount != null && Math.abs(s.amount - amount) < 0.005);
    if (same.length > 0 && (reminder || sameAmount)) {
      getDb().prepare("INSERT OR IGNORE INTO deleted_messages (gmail_message_id) VALUES (?)").run(messageId);
      if (reminder && mode === "new") {
        const unpaid = same.find((s) => s.status !== "paid");
        if (unpaid) {
          createNotification(
            "reminder",
            `Betalningspåminnelse från ${vendorName}`,
            `Faktura ${invoiceNumber} är inte markerad som betald`,
            `/invoices/${unpaid.id}`
          );
        }
      }
      await markProcessed(messageId, labelId);
      return "skipped";
    }
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

    const rules = listRules();
    const senders = [...new Set(rules.map((r) => r.from_address.toLowerCase()))];
    const messageIds = new Set<string>();

    // One search per sender – large OR queries silently drop results in the Gmail API.
    // "new" does not rely on the unread flag: a mail opened on the phone is still imported.
    for (const sender of senders) {
      const query = [
        `from:${sender.replace(/^@/, "")}`,
        "has:attachment",
        "filename:pdf",
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
    const labelId = messageIds.size > 0 ? await getOrCreateLabel(LABEL_AFTER_PROCESS).catch(() => null) : null;

    for (const messageId of messageIds) {
      // One broken mail must never stop the rest from being imported
      try {
        const outcome = await processMessage(messageId, mode, labelId);
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
