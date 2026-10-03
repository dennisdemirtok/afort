import pdfParse from "pdf-parse";

export interface ParsedInvoice {
  vendorName: string | null;
  invoiceNumber: string | null;
  issueDate: string | null;
  amount: number | null;
  currency: string | null;
  dueDate: string | null;
  ocr: string | null;
  bankgiro: string | null;
  plusgiro: string | null;
  iban: string | null;
}

export async function parseInvoicePdf(pdfBuffer: Buffer): Promise<ParsedInvoice> {
  const data = await pdfParse(pdfBuffer);
  const text = data.text;

  return {
    vendorName: extractVendorName(text),
    invoiceNumber: extractInvoiceNumber(text),
    issueDate: extractIssueDate(text),
    amount: extractAmount(text),
    currency: extractCurrency(text),
    dueDate: extractDueDate(text),
    ocr: extractOcr(text),
    bankgiro: extractBankgiro(text),
    plusgiro: extractPlusgiro(text),
    iban: extractIban(text),
  };
}

/** Amount and currency out of any text – used for receipts that arrive as HTML mail. */
export function amountFromText(text: string): { amount: number | null; currency: string | null } {
  return { amount: extractAmount(text), currency: extractCurrency(text) };
}

function extractAmount(text: string): number | null {
  // BWS: "Amount\n3.070,96 SEK0,00 SEK0,00 SEK3.070,96 SEK" — last number on the line after "Amount"
  // The line after "Amount" has 4 SEK amounts concatenated, last one is the total
  const bwsAmountMatch = text.match(/\bAmount\s*\n\s*([\d.,]+)\s*SEK[\d.,]*\s*SEK[\d.,]*\s*SEK([\d.,]+)\s*SEK/i);
  if (bwsAmountMatch) {
    const numStr = bwsAmountMatch[2].replace(/\./g, "").replace(",", ".");
    const val = parseFloat(numStr);
    if (!isNaN(val) && val > 0) return val;
  }

  const patterns = [
    // Meta ads receipts: "Paid\nSEK20.00" (currency before the amount)
    /\bPaid\s*\n\s*(?:SEK|EUR|USD|DKK|GBP|€|\$|£)\s?([\d,.]*\d[.,]\d{2})/,
    // Google invoices: "Totalt i EUR" with the value on the next line: "16,20 €"
    /Totalt\s+i\s+(?:EUR|SEK|USD|DKK|GBP)\s*\n\s*([\d\s.,]*\d[.,]\d{2})\s*(?:€|kr|\$|£)?/i,
    // Polish Fancywork: "DO ZAPŁATY: €52,48" or "POZOSTAŁO DO ZAPŁATY: €52,48"
    /(?:DO ZAPŁATY|POZOSTAŁO DO ZAPŁATY)\s*:?\s*€?\s*([\d\s]+[.,]\d{2})/i,
    // Polish: "Brutto (EUR)\n52,48" — total at bottom
    /Brutto\s*\(EUR\)\s*\n?\s*([\d\s]+[.,]\d{2})/i,
    // Receipts: "Amount paid: €123.45", "Betalt belopp: 123,45 kr", "Total charged $12.00"
    /(?:amount\s*paid|amount\s*charged|total\s*charged|paid\s*amount|betalt\s*belopp|debiterat\s*belopp|totalt\s*belopp|grand\s*total)\s*:?\s*(?:EUR|DKK|SEK|USD|GBP|€|\$|£)?\s*([\d\s,.]+\d{2})/i,
    // English: "Total Amount: 1,234.56 EUR/DKK", "Total: €52.48"
    /(?:total\s*amount|amount\s*due|total)\s*:?\s*(?:EUR|DKK|SEK|USD|GBP|€|\$|£)?\s*([\d\s,.]+\d{2})/i,
    // Swedish: "Att betala: 12 345,67" or "Summa: 1 234,00 SEK"
    /(?:att\s+betala|total(?:t|belopp)?|summa|belopp)\s*:?\s*([\d\s]+[.,]\d{2})/i,
    // Generic: amount followed by currency at end of line
    /([\d\s]+[.,]\d{2})\s*(?:SEK|EUR|USD|DKK)\s*$/m,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      // Handle both 1.234,56 (EU) and 1,234.56 (US) formats
      let numStr = match[1].replace(/\s/g, "");
      // If comma is the decimal separator (EU format: 52,48 or 1.234,56)
      if (numStr.includes(",") && (!numStr.includes(".") || numStr.lastIndexOf(",") > numStr.lastIndexOf("."))) {
        numStr = numStr.replace(/\./g, "").replace(",", ".");
      }
      const val = parseFloat(numStr);
      if (!isNaN(val) && val > 0) return val;
    }
  }
  return null;
}

function extractDueDate(text: string): string | null {
  const patterns = [
    // Polish Fancywork: "Termin płatności:\n7 dni (2026-04-15)" (may be split across lines)
    /Termin p[łl]atno[śs]ci\s*:?[\s\S]*?\((\d{4}-\d{2}-\d{2})\)/i,
    // Swedish: "Förfallodatum: 2026-04-30"
    /(?:förfallo(?:datum|dag)|förfaller|due\s*date|betalningsdag)\s*:?\s*(\d{4}-\d{2}-\d{2})/i,
    // English: "Due Date: 30/04/2026" or "Payment due: 2026-04-30"
    /(?:due\s*date|payment\s*due)\s*:?\s*(\d{4}-\d{2}-\d{2})/i,
    /(?:due\s*date|payment\s*due)\s*:?\s*(\d{2}[./-]\d{2}[./-]\d{4})/i,
    // Generic ISO date after "due" keyword
    /(?:förfaller|due|termin)\s*.*?(\d{4}-\d{2}-\d{2})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const raw = match[1];
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
      const parts = raw.split(/[./-]/);
      if (parts.length === 3) return `${parts[2]}-${parts[1]}-${parts[0]}`;
    }
  }
  return null;
}

function extractOcr(text: string): string | null {
  const match = text.match(/(?:OCR|referens(?:nummer)?)\s*:?\s*(\d{5,25})/i);
  return match ? match[1] : null;
}

function extractBankgiro(text: string): string | null {
  const match =
    text.match(/(?:bankgiro|bg)\s*:?\s*(\d{3,4}-?\d{4})\b/i) ||
    // Blue Water: "55936546 (Bankgiro)"
    text.match(/\b(\d{3,4}-?\d{4})\s*\(Bankgiro\)/i);
  if (!match) return null;
  const digits = match[1].replace("-", "");
  return `${digits.slice(0, -4)}-${digits.slice(-4)}`;
}

function extractPlusgiro(text: string): string | null {
  const match = text.match(/(?:plusgiro|pg)\s*:?\s*(\d{2,6}-?\d{1})/i);
  return match ? match[1] : null;
}

function extractIban(text: string): string | null {
  const candidates: string[] = [];
  // "IBAN: DK12 3456 7890 1234 56" – groups may be separated by spaces
  const labelled = text.match(/\bIBAN\b[^\n]{0,12}?([A-Z]{2}\s?\d{2}(?:\s?[A-Z0-9]{2,4}){3,8})/i);
  if (labelled) candidates.push(labelled[1]);
  // Some layouts (Blue Water) put the labels and the values on separate lines
  for (const m of text.matchAll(/\b([A-Z]{2}\d{2}[A-Z0-9]{11,30})\b/g)) candidates.push(m[1]);
  // Polish invoices (Fancywork, inFakt): "Bank: 50 1140 2004 0000 3712 0700 7950" – a domestic
  // account number (NRB) is the IBAN without "PL"
  for (const m of text.matchAll(/(?:\b(?:bank|konto|konta|rachunek|rachunku|account)\b[^\n]{0,20}?|\bPL\s?)(\d{2}(?:\s?\d{4}){6})\b/gi)) {
    candidates.push("PL" + m[1]);
  }
  for (const candidate of candidates) {
    const iban = candidate.replace(/\s/g, "").toUpperCase();
    if (isValidIban(iban)) return iban;
  }
  return null;
}

/** ISO 13616 check digits – a misread account number must never end up in a payment file. */
export function isValidIban(iban: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const digits = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let remainder = 0;
  for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  return remainder === 1;
}

function extractInvoiceNumber(text: string): string | null {
  const patterns = [
    // Polish: "Nr: 8/4/2026/WDT/DTF"
    /Nr\s*:?\s*([\d/]+\/\w+(?:\/\w+)?)/i,
    // English: "Invoice No: INV-12345"
    // Meta ads: "Invoice no. FBADS-708-106565845"
    /(?:fakturanr|faktura\s*nr|fakturanummer|invoice\s*(?:no\.?|number|#))\s*:?\s*([A-Z0-9/-]{2,30})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "ma[jy]", "jun", "jul", "aug", "sep", "o[ck]t", "nov", "dec"];

/** "27 Sep 2026", "30 sep. 2026", "2026-09-27", "27.09.2026" → "2026-09-27" */
export function parseDateText(raw: string): string | null {
  const iso = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const numeric = raw.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (numeric) return `${numeric[3]}-${numeric[2].padStart(2, "0")}-${numeric[1].padStart(2, "0")}`;
  const named = raw.match(/(\d{1,2})\s+([a-zåäö]+)\.?,?\s+(\d{4})/i);
  if (!named) return null;
  const month = MONTHS.findIndex((m) => new RegExp(`^${m}`, "i").test(named[2]));
  return month < 0 ? null : `${named[3]}-${String(month + 1).padStart(2, "0")}-${named[1].padStart(2, "0")}`;
}

function extractIssueDate(text: string): string | null {
  const DATE = "(\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[./-]\\d{1,2}[./-]\\d{4}|\\d{1,2}\\s+[A-Za-zåäö]+\\.?,?\\s+\\d{4})";
  const match =
    // Meta ads: "Invoice/payment date\n27 Sep 2026, 07:31"
    text.match(new RegExp(`Invoice\\/payment\\s+date\\s*\\n?\\s*${DATE}`, "i")) ||
    text.match(new RegExp(`(?:invoice\\s*date|fakturadatum|date\\s*of\\s*issue|data\\s*wystawienia|rechnungsdatum)\\s*:?\\s*\\n?\\s*${DATE}`, "i"));
  return match ? parseDateText(match[1]) : null;
}

function extractVendorName(text: string): string | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length > 0 && lines[0].length < 60) return lines[0];
  return null;
}

function extractCurrency(text: string): string | null {
  // Check for explicit currency markers
  if (/DO ZAPŁATY.*€/i.test(text) || /\bBrutto\s*\(EUR\)/i.test(text) || /\bEUR\b/.test(text)) return "EUR";
  // Meta ads: "SEK20.00"
  const prefixed = text.match(/\b(SEK|DKK|USD|GBP)(?=\d)/);
  if (prefixed) return prefixed[1];
  if (/\bDKK\b/.test(text)) return "DKK";
  if (/\bUSD\b/.test(text)) return "USD";
  if (/\bSEK\b/.test(text)) return "SEK";
  if (/\bPLN\b/.test(text)) return "PLN";
  if (/\bGBP\b/.test(text)) return "GBP";
  if (/€/.test(text)) return "EUR";
  if (/\d\s*kr\b/i.test(text)) return "SEK";
  if (/\$/.test(text)) return "USD";
  if (/£/.test(text)) return "GBP";
  return null;
}
