import fs from "fs";
import pdfParse from "pdf-parse";
import { Receipt } from "../models/receipt";
import { htmlToText } from "./invoice-extract";

/**
 * A suggested Fortnox voucher for a card receipt, to copy by hand until vouchers can be sent
 * over the Fortnox API. Accounts follow the BAS chart; the bookkeeper confirms them per source.
 */

export interface VoucherRow {
  account: string;
  name: string;
  side: "debit" | "credit";
  // null while the amount in SEK is unknown
  amount: number | null;
}

export interface VoucherSuggestion {
  date: string;
  text: string;
  treatment: string;
  rows: VoucherRow[];
  notes: string[];
  // Amounts in SEK are known – otherwise the rows only show which accounts to use
  complete: boolean;
}

const ACCOUNT_NAMES: Record<string, string> = {
  "1930": "Företagskonto/checkkonto/affärskonto",
  "2614": "Utgående moms omvänd skattskyldighet, 25 %",
  "2641": "Debiterad ingående moms",
  "2645": "Beräknad ingående moms på förvärv från utlandet",
  "4515": "Inköp av varor från annat EU-land, 25 %",
  "4535": "Inköp av tjänster från annat EU-land, 25 %",
  "4598": "Justering, omvänd moms",
  "5710": "Frakter och transporter",
  "5910": "Annonsering",
  "6540": "IT-tjänster",
  "6990": "Övriga externa kostnader",
};

// What each receipt source is: the cost account and where the seller is
const SOURCE_RULES: Record<string, { account: string; kind: "service" | "goods"; origin: "eu" | "se" }> = {
  "Meta Ads": { account: "5910", kind: "service", origin: "eu" }, // Meta Platforms Ireland
  "Google Ads": { account: "5910", kind: "service", origin: "eu" }, // Google Ireland
  Google: { account: "6540", kind: "service", origin: "eu" }, // Google Workspace, Google Ireland
  Anthropic: { account: "6540", kind: "service", origin: "eu" }, // Anthropic Ireland
  Distribold: { account: "4515", kind: "goods", origin: "eu" }, // 3D&I BV, Netherlands
  PostNord: { account: "5710", kind: "service", origin: "se" }, // PostNord Sverige AB, 25 % VAT
};

// The company card is drawn straight from the business account
const PAYMENT_ACCOUNT = "1930";

const REVERSE_CHARGE = /article\s*196|reverse[\s-]*charge|omv[äa]nd\s+skattskyldighet|customer to account for any vat|mottagaren betala moms/i;
// Stripe PDFs extract some spaces and hyphens as NUL ("VAT - Sweden \u000025%")
const SWEDISH_VAT_CHARGED = /VAT[\s\u0000]*-[\s\u0000]*Sweden[\s\u0000]*25\s*%|moms\s*\(?\s*25\s*%\s*\)?\s*(?:p[åa]\s*)?[\d$€]/i;

/**
 * Deductible VAT on a card purchase, in SEK. Reverse charge nets to zero, and Swedish VAT
 * charged by a foreign seller cannot be deducted. Null while the SEK amount is unknown.
 */
export function receiptInputVat(receipt: Receipt): number | null {
  if (receipt.source && SOURCE_RULES[receipt.source]?.origin === "eu") return 0;
  const sek = receipt.bank_amount ?? (!receipt.currency || receipt.currency === "SEK" ? receipt.amount : null);
  return sek == null ? null : Math.round(sek * 20) / 100;
}

async function documentText(receipt: Receipt): Promise<string> {
  if (!receipt.file_path || !fs.existsSync(receipt.file_path)) return "";
  try {
    if (receipt.file_kind === "pdf") return (await pdfParse(fs.readFileSync(receipt.file_path))).text;
    return htmlToText(fs.readFileSync(receipt.file_path, "utf8"));
  } catch {
    return "";
  }
}

const round = (n: number) => Math.round(n * 100) / 100;

const debit = (account: string, amount: number | null): VoucherRow => ({ account, name: ACCOUNT_NAMES[account] || "", side: "debit", amount });
const credit = (account: string, amount: number | null): VoucherRow => ({ account, name: ACCOUNT_NAMES[account] || "", side: "credit", amount });

/** Reverse charge: the buyer accounts for the VAT – booked as both output and input VAT. */
function reverseChargeRows(kind: "service" | "goods", cost: string, amount: number | null, vat: number | null): VoucherRow[] {
  // Goods: 4515 is the cost account itself (ruta 20). Services: the cost account plus 4535/4598 for ruta 21.
  const purchase = kind === "goods" ? [debit(cost, amount)] : [debit(cost, amount), debit("4535", amount), credit("4598", amount)];
  return [...purchase, debit("2645", vat), credit("2614", vat), credit(PAYMENT_ACCOUNT, amount)];
}

export async function suggestVoucher(receipt: Receipt): Promise<VoucherSuggestion> {
  const notes: string[] = [];
  const rule = receipt.source ? SOURCE_RULES[receipt.source] : undefined;
  const text = await documentText(receipt);

  // What was actually drawn in SEK; a SEK receipt is its own amount
  const sek = receipt.bank_amount ?? (!receipt.currency || receipt.currency === "SEK" ? receipt.amount : null);
  if (sek == null) {
    notes.push(receipt.amount == null
      ? "Beloppet saknas på kvittot – fyll i det ovan."
      : `Kvittot är i ${receipt.currency}. Ladda upp Nordea-filen under Bankutdrag så fylls beloppet i SEK i.`);
  }
  if (receipt.bank_text && /kortköp\s+GOOGLE/i.test(receipt.bank_text)) notes.push(`Betalt i flera dragningar: ${receipt.bank_text}`);

  const cost = rule?.account || "6990";
  const amount = sek;
  const vat = amount != null ? round(amount * 0.25) : null;
  let treatment: string;
  let rows: VoucherRow[];

  if (rule && rule.origin === "eu" && REVERSE_CHARGE.test(text)) {
    treatment = rule.kind === "goods" ? "Varor från EU – omvänd skattskyldighet" : "Tjänst från EU – omvänd skattskyldighet";
    rows = reverseChargeRows(rule.kind, cost, amount, vat);
    notes.push(rule.kind === "goods"
      ? "4515 ger ruta 20 i momsdeklarationen, 2614/2645 ruta 30 och 48."
      : "4535/4598 ger ruta 21 i momsdeklarationen, 2614/2645 ruta 30 och 48.");
  } else if (rule && rule.origin === "eu" && SWEDISH_VAT_CHARGED.test(text)) {
    treatment = "Utländsk säljare har debiterat svensk moms";
    rows = [debit(cost, amount), credit(PAYMENT_ACCOUNT, amount)];
    notes.push("Säljaren har lagt på svensk moms som på en privatperson (momsnumret saknades). Den momsen går normalt inte att dra av – hela beloppet blir kostnad. Stäm av med bokföraren.");
  } else if (rule && rule.origin === "eu") {
    treatment = rule.kind === "goods" ? "Varor från EU – omvänd skattskyldighet (antaget)" : "Tjänst från EU – omvänd skattskyldighet (antaget)";
    rows = reverseChargeRows(rule.kind, cost, amount, vat);
    notes.push("Kvittot nämner inte omvänd skattskyldighet – kontrollera att säljaren inte har debiterat moms.");
  } else {
    // A Swedish seller (or an unknown source): 25 % VAT included in the amount
    treatment = rule ? "Svensk moms 25 %" : "Okänd källa – svensk moms 25 % antagen";
    const vatIncluded = amount != null ? round(amount * 0.2) : null;
    const net = amount != null && vatIncluded != null ? round(amount - vatIncluded) : null;
    rows = [debit(cost, net), debit("2641", vatIncluded), credit(PAYMENT_ACCOUNT, amount)];
    if (!rule) notes.push("Källan har inget konto ännu – 6990 är en platshållare. Kontrollera konto och moms.");
  }

  return {
    date: (receipt.received_at || "").slice(0, 10),
    text: [receipt.source, receipt.reference].filter(Boolean).join(" "),
    treatment,
    rows,
    notes,
    complete: amount != null,
  };
}
