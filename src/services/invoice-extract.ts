/**
 * Pure helpers that interpret an invoice e-mail (subject + sender).
 * Kept free of I/O so they are easy to test against real subject lines.
 */

export interface SenderRule {
  from_address: string;
  subject_contains: string | null;
  vendor_name: string | null;
}

// A mail must look like it is about an invoice before we even consider it
// ("fv" = Polish shorthand for faktura; "brak płatności", "zaległości", "wezwanie" are Polish reminder wordings)
const INVOICE_KEYWORDS = /faktur|\bfv\b|invoice|rechnung|creditnote|kreditnota|pro\s*forma|bifogas|payment|zapłat|płatno|zaległ|wezwanie|należno|zahlung/i;

// Mail that asks for payment of something we should already have, rather than a new invoice.
// Fancywork's staff send manual reminders with just "FV WDT <number>" as subject.
const REMINDER_KEYWORDS = /zahlungserinnerung|\boutstanding\b|przypomnienie|påminnelse|\breminder\b|\boverdue\b|mahnung|brak\s+płatno|zaległ|wezwanie|należno|^\s*fv\s+wdt\b/i;

// Ordered from most to least specific. First match wins.
const INVOICE_NUMBER_PATTERNS: RegExp[] = [
  // Fancywork: "Faktura 8/4/2026/WDT/DTF za druki DTF z dnia ..."
  /Faktura\s+([\d/]+\/[A-Z]+(?:\/[A-Z]+)?)\s+za\b/i,
  // Fancywork reminders: "Brak płatności za 21/4/2026/WDT/DTF z dnia ...", "FV WDT 2/8/2026/WDT/DTF"
  /Brak\s+płatno\S*\s+za\s+([\d/]+\/[A-Z]+(?:\/[A-Z]+)?)/i,
  /^\s*FV\s+WDT\s+([\d/]+\/[A-Z]+(?:\/[A-Z]+)?)/i,
  // Blue Water Shipping: "Invoice/Creditnote 16276606 from Blue Water"
  /Invoice\/Creditnote\s+(\d+)/i,
  // DTFtransfer: "Rechnung (Ref ZB/2026/03/614)", "Zahlungserinnerung (Ref ...)"
  /\(Ref\.?\s+([^)]+)\)/i,
  // inFakt (DTFtransfer, Helios): "Invoice 586/12/2025/ZB from ...", "Faktura 39/05/2021 od ..."
  /(?:Invoice|Faktura)\s+(\d[\w/]*\/[\w/]+)\s+(?:from|od)\b/i,
  // inFakt reminder: "Przypomnienie o zapłacie faktury nr 39/05/2021"
  /faktury\s+nr\s+([\w/]+\d[\w/]*)/i,
  // Feelgood: "Pro forma PROF 24/2026", "Faktura FD 118/3/2026"
  /Pro\s*forma\s+(PROF\s+\d[\d/]*)/i,
  /Faktura\s+([A-Z]{1,5}\s+\d[\d/]*)/,
  // Helios: "Payment of € 228,75 is outstanding for FV/03/26/024"
  /outstanding\s+for\s+([A-Z]{1,5}\/[\d/]+)/i,
  // Helios: "WDT to Invoice 15/08/2021" (also seen as "WDT too Invoice")
  /WDT\s+too?\s+Invoice\s+(\d[\d/]*)/i,
  // Fortnox: "Faktura 1045 bifogas"
  /Faktura\s+(\d+)\s+bifogas/i,
  // Generic fallbacks – the token must contain a digit
  /(?:Faktura|Fakturanr\.?|Invoice(?:\s+(?:no\.?|number|nr\.?|#))?|Rechnung(?:\s+Nr\.?)?)\s*:?\s+#?([A-Z0-9][\w/.-]*\d[\w/.-]*)/i,
];

export function looksLikeInvoiceMail(subject: string): boolean {
  return INVOICE_KEYWORDS.test(subject);
}

export function isReminder(subject: string): boolean {
  return REMINDER_KEYWORDS.test(subject);
}

export function extractInvoiceNumberFromSubject(subject: string): string | null {
  for (const pattern of INVOICE_NUMBER_PATTERNS) {
    const match = subject.match(pattern);
    if (match) return match[1].replace(/\s+/g, " ").trim();
  }
  return null;
}

export function emailAddress(fromHeader: string): string {
  const angle = fromHeader.match(/<([^>]+)>/);
  return (angle ? angle[1] : fromHeader).trim().toLowerCase();
}

export function displayName(fromHeader: string): string {
  const name = fromHeader.replace(/<[^>]*>/, "").replace(/"/g, "").trim();
  return name || emailAddress(fromHeader);
}

export function matchRule(fromHeader: string, subject: string, rules: SenderRule[]): SenderRule | null {
  if (!looksLikeInvoiceMail(subject)) return null;
  const address = emailAddress(fromHeader);
  const subjectLower = subject.toLowerCase();
  return (
    rules.find((rule) => {
      const wanted = rule.from_address.toLowerCase();
      // "@example.com" matches every sender on that domain
      const senderMatches = wanted.startsWith("@") ? address.endsWith(wanted) : address === wanted;
      // A subject filter ("Faktura") keeps order mail out, but must not hide the vendor's reminders
      const subjectMatches =
        !rule.subject_contains || subjectLower.includes(rule.subject_contains.toLowerCase()) || isReminder(subject);
      return senderMatches && subjectMatches;
    }) || null
  );
}

/** Receipt rules only look at the sender and an optional subject filter – a receipt rarely says "invoice". */
export function matchReceiptRule(fromHeader: string, subject: string, rules: SenderRule[]): SenderRule | null {
  const address = emailAddress(fromHeader);
  const subjectLower = subject.toLowerCase();
  return (
    rules.find((rule) => {
      const wanted = rule.from_address.toLowerCase();
      const senderMatches = wanted.startsWith("@") ? address.endsWith(wanted) : address === wanted;
      return senderMatches && (!rule.subject_contains || subjectLower.includes(rule.subject_contains.toLowerCase()));
    }) || null
  );
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>|<\/(?:p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&euro;/g, "€")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n");
}

/**
 * Google Ads on automatic payments mails "Ditt faktureringsdokument är klart" with the invoice
 * number and a link to the portal – never the PDF itself.
 */
export function isLinkOnlyNotice(subject: string, text: string): boolean {
  return /^\s*Google Ads\b/i.test(subject) && /faktureringsdokument|billing document/i.test(`${subject}\n${text}`);
}

/** "order number DISTRI-ORD08544", "Receipt #12345", "faktura 4567890123" */
export function extractReferenceFromSubject(subject: string): string | null {
  const m =
    subject.match(/order\s+(?:number|no\.?|nr\.?|#)\s*:?\s*([A-Z0-9][\w-]{2,})/i) ||
    subject.match(/(?:invoice|faktura|kvitto|receipt|transaction|transaktion)\s*(?:number|no\.?|nr\.?|#|id)?\s*:?\s*([A-Z0-9][\w-]{3,})/i) ||
    subject.match(/#\s?([A-Z0-9][\w-]{3,})/i);
  return m ? m[1] : null;
}

export function resolveVendorName(fromHeader: string, subject: string, rule: SenderRule | null): string {
  // inFakt is an invoicing platform shared by several suppliers – the subject tells them apart
  if (emailAddress(fromHeader).endsWith("@infakt.pl")) {
    if (/DTFTRANSFER/i.test(subject)) return "DTFtransfer.com";
    if (/HELIOS/i.test(subject)) return "Helios Advertising";
    const sender = subject.match(/\b(?:from|od)\s+(.+?)\s+(?:to|do)\s+/i);
    if (sender) return sender[1].trim();
  }
  return rule?.vendor_name || displayName(fromHeader);
}

/** "in Höhe von 17,98 €" / "Payment of € 228,75 is outstanding" */
export function extractAmountFromSubject(subject: string): number | null {
  const match =
    subject.match(/in Höhe von\s+([\d.,]+)\s*€/i) ||
    subject.match(/Payment of\s*€\s*([\d.,]+)/i);
  if (!match) return null;
  let num = match[1];
  if (num.includes(",")) num = num.replace(/\./g, "").replace(",", ".");
  const value = parseFloat(num);
  return isNaN(value) ? null : value;
}
