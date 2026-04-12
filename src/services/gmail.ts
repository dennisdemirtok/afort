import { google, gmail_v1 } from "googleapis";
import fs from "fs";
import path from "path";
import { env } from "../config/env";
import { hasMessageId, createInvoice } from "../models/invoice";
import { parseInvoicePdf } from "./pdf-parser";
import { createNotification } from "../models/notification";
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
  // Global filter: subject must contain something invoice-related
  const invoiceKeywords = /faktura|invoice|rechnung|creditnote|pro\s*forma|bifogas|payment|zapłat/i;
  if (!invoiceKeywords.test(subject)) return false;

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
    const isPdf = part.mimeType === "application/pdf"
      || (part.mimeType === "application/octet-stream" && part.filename?.toLowerCase().endsWith(".pdf"));
    if (isPdf && part.body?.attachmentId) {
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

  // Search per sender to avoid Gmail API limitations with large OR groups
  const fromAddresses = gmailRules.rules.map((r: any) => r.from).filter(Boolean);
  const uniqueFroms = [...new Set(fromAddresses)];

  let allMessages: { id: string; threadId: string }[] = [];
  const seenIds = new Set<string>();

  for (const fromAddr of uniqueFroms) {
    const parts = ["has:attachment", "filename:pdf", `from:${fromAddr}`];
    if (!includeRead) parts.unshift("is:unread");
    const query = parts.join(" ");
    try {
      const res = await gmail.users.messages.list({ userId: "me", q: query, maxResults: 100 });
      if (res.data.messages) {
        for (const msg of res.data.messages) {
          if (!seenIds.has(msg.id!)) {
            seenIds.add(msg.id!);
            allMessages.push({ id: msg.id!, threadId: msg.threadId! });
          }
        }
      }
    } catch (err) {
      console.error(`[Gmail] Error searching from:${fromAddr}:`, err);
    }
  }

  if (allMessages.length === 0) {
    console.log("[Gmail] No new messages");
    return 0;
  }

  console.log(`[Gmail] Found ${allMessages.length} messages across ${uniqueFroms.length} senders`);

  const labelId = await getOrCreateLabel(gmailRules.label_after_process);

  for (const msg of allMessages) {
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
    const subjectInvoiceMatch =
      // Fancywork: "Faktura 8/4/2026/WDT/DTF za druki..."
      subject.match(/Faktura\s+([\d/]+\/\w+(?:\/\w+)?)\s+za/i)
      // BWS: "Invoice/Creditnote 16276606 from Blue Water"
      || subject.match(/Invoice\/Creditnote\s+(\d+)/i)
      // DTFtransfer new: "Rechnung (Ref ZB/2026/03/614)"
      || subject.match(/Rechnung\s+\(Ref\s+([^)]+)\)/i)
      // DTFtransfer new: "Zahlungserinnerung (Ref ZB/2026/01/395)"
      || subject.match(/Zahlungserinnerung\s+\(Ref\s+([^)]+)\)/i)
      // DTFtransfer old via infakt: "Invoice 586/12/2025/ZB from DTFTRANSFER"
      || subject.match(/Invoice\s+([\d/]+\/\w+)\s+from/i)
      // Feelgood: "Pro forma PROF 24/2026"
      || subject.match(/Pro\s+forma\s+(PROF\s+[\d/]+)/i)
      // Helios: "Payment of...outstanding for FV/03/26/024"
      || subject.match(/outstanding\s+for\s+(FV\/[\d/]+)/i)
      // Helios via infakt: "Faktura 39/05/2021 od"
      || subject.match(/Faktura\s+([\d/]+(?:\/[\d/]+)+)\s+od/i)
      // Aflasta/Fortnox: "Faktura 1045 bifogas"
      || subject.match(/Faktura\s+(\d+)\s+bifogas/i)
      // Generic fallback: "Faktura XXXX"
      || subject.match(/Faktura\s+([\w/.-]+\d[\w/.-]*)/i);
    // Subject line takes priority over PDF (PDF may extract customer numbers instead)
    const invoiceNumber = (subjectInvoiceMatch ? subjectInvoiceMatch[1] : null) || parsed.invoiceNumber;

    // Map email domains to company names
    const emailDomain = from.match(/@([\w.-]+)/)?.[1]?.toLowerCase() || "";
    const vendorMap: Record<string, string> = {
      "bws.dk": "Blue Water Shipping",
      "fancywork.pl": "Fancywork DTF",
      "dtftransfer.com": "DTFtransfer.com",
      "poczta.wfirma.pl": "Feelgood SP",
      "feelgood.pl": "Feelgood SP",
      "fortnox.se": "Aflasta AB",
      "sitodrukowy.pl": "Helios Advertising",
    };
    // infakt.pl is shared platform — check subject to distinguish vendor
    let fromName = vendorMap[emailDomain] || "";
    if (emailDomain === "infakt.pl") {
      if (/DTFTRANSFER/i.test(subject)) fromName = "DTFtransfer.com";
      else if (/HELIOS/i.test(subject)) fromName = "Helios Advertising";
      else fromName = from.replace(/<.*>/, "").replace(/"/g, "").trim();
    }
    if (!fromName) fromName = from.replace(/<.*>/, "").replace(/"/g, "").trim();

    // Override currency for vendors known to invoice in EUR
    const eurVendors = ["DTFtransfer.com", "Fancywork DTF", "Feelgood SP", "Helios Advertising"];
    let currency = parsed.currency || "SEK";
    if (eurVendors.includes(fromName) && (!currency || currency === "PLN")) {
      currency = "EUR";
    }
    // Also try to extract amount from subject for DTFtransfer: "in Höhe von 17,98 €"
    if (!parsed.amount && /in Höhe von\s+([\d.,]+)\s*€/i.test(subject)) {
      const m = subject.match(/in Höhe von\s+([\d.,]+)\s*€/i);
      if (m) parsed.amount = parseFloat(m[1].replace(",", "."));
    }

    createInvoice({
      gmail_message_id: messageId,
      sender: from,
      subject: subject,
      received_at: date ? new Date(date).toISOString() : null,
      vendor_name: fromName,
      invoice_number: invoiceNumber,
      amount: parsed.amount,
      currency,
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

    // Create notification for new invoice
    const amt = parsed.amount ? `${parsed.amount.toFixed(2)} ${currency}` : "";
    createNotification(
      "new_invoice",
      `Ny faktura fran ${fromName}`,
      invoiceNumber ? `${invoiceNumber}${amt ? " — " + amt : ""}` : amt || subject.substring(0, 50),
      `/invoices`
    );

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
