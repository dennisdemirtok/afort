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
  // Swedish: "Att betala: 12 345,67" or "Total: 12345.67" or "Summa: 1 234,00 SEK"
  const patterns = [
    /(?:att\s+betala|total(?:t|belopp)?|summa|amount\s+due|belopp)\s*:?\s*([\d\s]+[.,]\d{2})/i,
    /(?:att\s+betala|total|summa)\s*[\s:]\s*(?:SEK|EUR|USD)?\s*([\d\s]+[.,]\d{2})/i,
    /([\d\s]+[.,]\d{2})\s*(?:SEK|EUR|USD)\s*$/m,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const numStr = match[1].replace(/\s/g, "").replace(",", ".");
      const val = parseFloat(numStr);
      if (!isNaN(val) && val > 0) return val;
    }
  }
  return null;
}

function extractDueDate(text: string): string | null {
  // "Förfallodatum: 2026-04-30" or "Due date: 30/04/2026" or "Förfaller: 2026-04-30"
  const patterns = [
    /(?:förfallo(?:datum|dag)|förfaller|due\s*date|betalningsdag)\s*:?\s*(\d{4}-\d{2}-\d{2})/i,
    /(?:förfallo(?:datum|dag)|förfaller|due\s*date)\s*:?\s*(\d{2}[./-]\d{2}[./-]\d{4})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const raw = match[1];
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
      // Convert DD/MM/YYYY or DD.MM.YYYY
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
  const match = text.match(/(?:fakturanr|faktura\s*nr|invoice\s*(?:no|number|#))\s*:?\s*([A-Z0-9-]{2,20})/i);
  return match ? match[1] : null;
}

function extractVendorName(text: string): string | null {
  // First non-empty line is often the company name
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length > 0 && lines[0].length < 60) return lines[0];
  return null;
}

function extractCurrency(text: string): string | null {
  if (/\bEUR\b/.test(text)) return "EUR";
  if (/\bUSD\b/.test(text)) return "USD";
  if (/\bSEK\b/.test(text)) return "SEK";
  return null;
}
