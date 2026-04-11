import { google, gmail_v1 } from "googleapis";
import fs from "fs";
import path from "path";
import { env } from "../config/env";
import { hasMessageId, createInvoice } from "../models/invoice";
import { parseInvoicePdf } from "./pdf-parser";
import gmailRules from "../config/gmail-rules.json";

const redirectUri = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/auth/google/callback`
  : "http://localhost:3000/auth/google/callback";

const oauth2Client = new google.auth.OAuth2(
  env.gmailClientId,
  env.gmailClientSecret,
  redirectUri
);

oauth2Client.setCredentials({ refresh_token: env.gmailRefreshToken });

const gmail = google.gmail({ version: "v1", auth: oauth2Client });

function buildSearchQuery(includeRead = false): string {
  const parts = ["has:attachment", "filename:pdf"];
  if (!includeRead) parts.unshift("is:unread");
  const fromAddresses = gmailRules.rules.map((r) => r.from).filter(Boolean);
  if (fromAddresses.length > 0) {
    parts.push(`{${fromAddresses.map((a) => `from:${a}`).join(" ")}}`);
  }
  return parts.join(" ");
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

function matchesRules(from: string, subject: string): boolean {
  return gmailRules.rules.some((rule: any) => {
    const fromMatch = !rule.from || from.toLowerCase().includes(rule.from.toLowerCase());
    let subjectMatch = true;
    if (rule.subject_contains) {
      subjectMatch = subject.toLowerCase().includes(rule.subject_contains.toLowerCase());
    }
    if (rule.subject_regex) {
      subjectMatch = new RegExp(rule.subject_regex).test(subject);
    }
    return fromMatch && subjectMatch;
  });
}

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[], name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

async function downloadPdfAttachment(
  messageId: string,
  parts: gmail_v1.Schema$MessagePart[]
): Promise<{ filename: string; data: Buffer } | null> {
  for (const part of parts) {
    if (part.mimeType === "application/pdf" && part.body?.attachmentId) {
      const attachment = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: part.body.attachmentId,
      });
      const data = Buffer.from(attachment.data.data!, "base64");
      return { filename: part.filename || "invoice.pdf", data };
    }
    if (part.parts) {
      const nested = await downloadPdfAttachment(messageId, part.parts);
      if (nested) return nested;
    }
  }
  return null;
}

export async function pollGmail(includeRead = false): Promise<number> {
  console.log(`[Gmail] Polling at ${new Date().toISOString()} (includeRead: ${includeRead})`);
  let processed = 0;

  const query = buildSearchQuery(includeRead);
  const res = await gmail.users.messages.list({ userId: "me", q: query, maxResults: 100 });

  if (!res.data.messages || res.data.messages.length === 0) {
    console.log("[Gmail] No new messages");
    return 0;
  }

  const labelId = await getOrCreateLabel(gmailRules.label_after_process);

  for (const msg of res.data.messages) {
    const messageId = msg.id!;

    if (hasMessageId(messageId)) {
      console.log(`[Gmail] Skipping already processed: ${messageId}`);
      continue;
    }

    const full = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
    const headers = full.data.payload?.headers || [];
    const from = getHeader(headers, "From");
    const subject = getHeader(headers, "Subject");
    const date = getHeader(headers, "Date");

    if (!matchesRules(from, subject)) {
      console.log(`[Gmail] Message ${messageId} doesn't match rules, skipping`);
      continue;
    }

    const attachment = await downloadPdfAttachment(messageId, full.data.payload?.parts || []);
    if (!attachment) {
      console.log(`[Gmail] No PDF attachment in ${messageId}`);
      continue;
    }

    // Save PDF
    const now = new Date();
    const monthDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const saveDir = path.join(env.invoicesDir, monthDir);
    fs.mkdirSync(saveDir, { recursive: true });

    const safeName = attachment.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const pdfPath = path.join(saveDir, `${messageId}_${safeName}`);
    fs.writeFileSync(pdfPath, attachment.data);

    // Parse PDF
    const parsed = await parseInvoicePdf(attachment.data);

    // Extract invoice number from subject line
    // Fancywork: "Faktura 8/4/2026/WDT/DTF za druki..."
    // BWS: "Invoice/Creditnote 16276606 from Blue Water"
    // DTFtransfer: "Rechnung (Ref ZB/2026/03/614)"
    // Feelgood: "Pro forma PROF 24/2026"
    // Helios: "Faktura 39/05/2021"
    // Aflasta/Fortnox: "Faktura 1045 bifogas"
    const subjectInvoiceMatch = subject.match(/Faktura\s+([\d/]+\/\w+(?:\/\w+)?)/i)
      || subject.match(/Invoice\/Creditnote\s+(\d+)/i)
      || subject.match(/Rechnung\s+\(Ref\s+([^)]+)\)/i)
      || subject.match(/Pro\s+forma\s+(PROF\s+[\d/]+)/i)
      || subject.match(/Faktura\s+([\d/]+(?:\/[\d/]+)*)/i)
      || subject.match(/Faktura\s+(\d+)\s+bifogas/i);
    // Subject line takes priority over PDF (PDF may extract customer numbers instead)
    const invoiceNumber = (subjectInvoiceMatch ? subjectInvoiceMatch[1] : null) || parsed.invoiceNumber;

    // Map email domains to company names
    const emailDomain = from.match(/@([^>]+)/)?.[1]?.toLowerCase() || "";
    const vendorMap: Record<string, string> = {
      "bws.dk": "Blue Water Shipping",
      "fancywork.pl": "Fancywork DTF",
      "dtftransfer.com": "DTFtransfer.com",
      "poczta.wfirma.pl": "Feelgood SP",
      "feelgood.pl": "Feelgood SP",
      "infakt.pl": "Helios Advertising",
      "fortnox.se": "Aflasta AB",
    };
    const fromName = vendorMap[emailDomain] || from.replace(/<.*>/, "").replace(/"/g, "").trim();

    createInvoice({
      gmail_message_id: messageId,
      sender: from,
      subject: subject,
      received_at: date ? new Date(date).toISOString() : null,
      vendor_name: fromName,
      invoice_number: invoiceNumber,
      amount: parsed.amount,
      currency: parsed.currency || "SEK",
      due_date: parsed.dueDate,
      ocr: parsed.ocr,
      bankgiro: parsed.bankgiro,
      plusgiro: parsed.plusgiro,
      iban: parsed.iban,
      pdf_path: pdfPath,
      status: "new",
    });

    // Mark as read + label
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: { removeLabelIds: ["UNREAD"], addLabelIds: [labelId] },
    });

    console.log(`[Gmail] Processed: ${subject} from ${from}`);
    processed++;
  }

  console.log(`[Gmail] Done. Processed ${processed} invoices.`);
  return processed;
}

export function getAuthUrl(): string {
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.modify"],
    prompt: "consent",
  });
}

export async function exchangeCode(code: string): Promise<string> {
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  return tokens.refresh_token || "";
}
