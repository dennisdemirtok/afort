import pdfParse from "pdf-parse";

export interface ParsedInvoice {
  vendorName: string | null;
  invoiceNumber: string | null;
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
    amount: extractAmount(text),
    currency: extractCurrency(text),
    dueDate: extractDueDate(text),
    ocr: extractOcr(text),
    bankgiro: extractBankgiro(text),
    plusgiro: extractPlusgiro(text),
    iban: extractIban(text),
  };
}

function extractAmount(text: string): number | null {
  const patterns = [
    // Polish Fancywork: "DO ZAPŁATY: €52,48" or "POZOSTAŁO DO ZAPŁATY: €52,48"
    /(?:DO ZAPŁATY|POZOSTAŁO DO ZAPŁATY)\s*:?\s*€?\s*([\d\s]+[.,]\d{2})/i,
    // Polish: "Brutto (EUR)\n52,48" — total at bottom
    /Brutto\s*\(EUR\)\s*\n?\s*([\d\s]+[.,]\d{2})/i,
    // English: "Total Amount: 1,234.56 EUR/DKK"
    /(?:total\s*amount|amount\s*due|total)\s*:?\s*(?:EUR|DKK|SEK|USD)?\s*([\d\s,.]+\d{2})/i,
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
  const match = text.match(/(?:bankgiro|bg)\s*:?\s*(\d{3,4}-?\d{4})/i);
  return match ? match[1] : null;
}

function extractPlusgiro(text: string): string | null {
  const match = text.match(/(?:plusgiro|pg)\s*:?\s*(\d{2,6}-?\d{1})/i);
  return match ? match[1] : null;
}

function extractIban(text: string): string | null {
  const match = text.match(/(?:IBAN)\s*:?\s*([A-Z]{2}\d{2}[\s]?[\dA-Z]{4,30})/i);
  if (match) return match[1].replace(/\s/g, "").toUpperCase();
  return null;
}

function extractInvoiceNumber(text: string): string | null {
  const patterns = [
    // Polish: "Nr: 8/4/2026/WDT/DTF"
    /Nr\s*:?\s*([\d/]+\/\w+(?:\/\w+)?)/i,
    // English: "Invoice No: INV-12345"
    /(?:fakturanr|faktura\s*nr|invoice\s*(?:no|number|#))\s*:?\s*([A-Z0-9/-]{2,30})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return null;
}

function extractVendorName(text: string): string | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length > 0 && lines[0].length < 60) return lines[0];
  return null;
}

function extractCurrency(text: string): string | null {
  // Check for explicit currency markers
  if (/DO ZAPŁATY.*€/i.test(text) || /\bBrutto\s*\(EUR\)/i.test(text) || /\bEUR\b/.test(text)) return "EUR";
  if (/\bDKK\b/.test(text)) return "DKK";
  if (/\bUSD\b/.test(text)) return "USD";
  if (/\bSEK\b/.test(text)) return "SEK";
  if (/\bPLN\b/.test(text)) return "PLN";
  return null;
}
