import { env } from "../config/env";
import { BankRow, balanceHistory, bankDataRange, bankRowsSince, latestBalances } from "../models/bank";
import { customerInvoiceCount, customerInvoicesBetween, listUnpaidCustomerInvoices } from "../models/fortnox";
import { Invoice, invoicesReceivedBetween, listUnpaidInvoices, payableAmount, today } from "../models/invoice";
import { Receipt, listReceipts } from "../models/receipt";
import { ShopifyPayout, listPayouts } from "../models/shopify";
import { getPendingBalance, vatOf } from "./shopify";
import { receiptInputVat } from "./voucher";

/**
 * Rolling cash flow: the bank balance, what is known to come in and go out, and the VAT that has
 * built up. Everything here is a preliminary figure for planning, not bookkeeping.
 */

// ---- Dates (plain YYYY-MM-DD strings) ----

const DAY = 86400000;
const pad = (n: number) => String(n).padStart(2, "0");
const toTime = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const addDays = (d: string, n: number) => new Date(toTime(d) + n * DAY).toISOString().slice(0, 10);
const weekday = (d: string) => new Date(toTime(d)).getUTCDay();
const mondayOf = (d: string) => addDays(d, -((weekday(d) + 6) % 7));
const round = (n: number) => Math.round(n * 100) / 100;

function isoWeek(d: string): number {
  const thursday = addDays(mondayOf(d), 3);
  const jan1 = `${thursday.slice(0, 4)}-01-01`;
  return Math.floor((toTime(thursday) - toTime(jan1)) / (7 * DAY)) + 1;
}

// ---- VAT periods ----

export interface Quarter {
  key: string;
  label: string;
  months: string;
  start: string;
  end: string;
  dueDate: string;
}

const QUARTER_MONTHS = ["jan–mar", "apr–jun", "jul–sep", "okt–dec"];

/** Quarterly VAT is due the 12th of the second month after the quarter, in August the 17th. A weekend moves it to Monday. */
export function vatDueDate(year: number, quarter: number): string {
  const [y, m, d] = quarter === 1 ? [year, 5, 12] : quarter === 2 ? [year, 8, 17] : quarter === 3 ? [year, 11, 12] : [year + 1, 2, 12];
  let due = `${y}-${pad(m)}-${pad(d)}`;
  while (weekday(due) === 0 || weekday(due) === 6) due = addDays(due, 1);
  return due;
}

function makeQuarter(year: number, quarter: number): Quarter {
  const firstMonth = (quarter - 1) * 3 + 1;
  const next = quarter === 4 ? `${year + 1}-01-01` : `${year}-${pad(firstMonth + 3)}-01`;
  return {
    key: `${year}Q${quarter}`,
    label: `Q${quarter} ${year}`,
    months: QUARTER_MONTHS[quarter - 1],
    start: `${year}-${pad(firstMonth)}-01`,
    end: addDays(next, -1),
    dueDate: vatDueDate(year, quarter),
  };
}

/** The quarter holding the date, then `count - 1` earlier ones. */
export function recentQuarters(date: string, count: number): Quarter[] {
  let year = Number(date.slice(0, 4));
  let quarter = Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1;
  const quarters: Quarter[] = [];
  for (let i = 0; i < count; i++) {
    quarters.push(makeQuarter(year, quarter));
    if (--quarter === 0) { quarter = 4; year--; }
  }
  return quarters;
}

// ---- Bank rows ----

export type BankCategory = "shopify" | "customers" | "otherIn" | "suppliers" | "card" | "tax" | "otherOut";

export function bankCategory(row: Pick<BankRow, "amount" | "name" | "message">): BankCategory {
  const text = `${row.name} ${row.message}`;
  if (row.amount > 0) {
    if (/stripe|shopify/i.test(text)) return "shopify";
    if (/bankgiroins|\bBG\s*INS/i.test(text)) return "customers";
    return "otherIn";
  }
  if (/skatteverket/i.test(text)) return "tax";
  if (/kortk[öo]p/i.test(text)) return "card";
  if (/avgifter\s+nordea/i.test(text)) return "otherOut";
  return "suppliers";
}

// ---- Currency ----

// Only used until a card purchase in the currency has shown what the bank actually charges
const FALLBACK_RATES: Record<string, number> = { EUR: 11, USD: 9.5, GBP: 12.7, DKK: 1.47, NOK: 0.95, PLN: 2.6 };

export interface SekRate {
  currency: string;
  rate: number;
  fromBank: boolean;
}

/** SEK per unit, from the latest card purchase in each currency. */
function sekRates(receipts: Receipt[]): Map<string, SekRate> {
  const rates = new Map<string, SekRate>(Object.entries(FALLBACK_RATES).map(([currency, rate]) => [currency, { currency, rate, fromBank: false }]));
  const matched = receipts
    .filter((r) => r.currency && r.currency !== "SEK" && r.amount && r.bank_amount && r.bank_date)
    .sort((a, b) => a.bank_date!.localeCompare(b.bank_date!));
  for (const r of matched) rates.set(r.currency!, { currency: r.currency!, rate: Math.round((r.bank_amount! / r.amount!) * 10000) / 10000, fromBank: true });
  return rates;
}

// ---- VAT per quarter ----

export interface VatQuarter extends Quarter {
  outputShopify: number;
  outputCustomers: number;
  customersFrom: "fortnox" | "bank";
  inputInvoices: number;
  inputReceipts: number;
  net: number;
  // Enough sales data to trust the figure
  complete: boolean;
  status: "building" | "due" | "paid" | "unpaid" | "past";
  paidAmount: number | null;
  paidDate: string | null;
}

export interface VatData {
  today: string;
  payouts: ShopifyPayout[];
  pendingVat: number;
  invoices: Pick<Invoice, "amount" | "currency" | "received_at" | "vat_amount">[];
  receipts: Receipt[];
  bankRows: BankRow[];
  bankRange: { from: string; to: string } | null;
  /** Null until Fortnox is connected and has delivered invoices */
  customerVat: ((q: Quarter) => number) | null;
  vatRate: number;
}

export function calculateVatQuarter(q: Quarter, data: VatData): VatQuarter & { assumedInvoices: number } {
  const within = (d: string | null | undefined) => !!d && d.slice(0, 10) >= q.start && d.slice(0, 10) <= q.end;

  let outputShopify = 0;
  for (const p of data.payouts) {
    if (!within(p.issued_at) || p.shopify_status === "FAILED" || p.shopify_status === "CANCELED") continue;
    outputShopify += vatOf((p.charges_gross || 0) - Math.abs(p.refunds_gross || 0), data.vatRate);
  }
  if (within(data.today)) outputShopify += data.pendingVat;

  const bankInPeriod = data.bankRows.filter((r) => within(r.date));
  const outputCustomers = data.customerVat
    ? data.customerVat(q)
    : vatOf(bankInPeriod.filter((r) => bankCategory(r) === "customers").reduce((sum, r) => sum + r.amount, 0), data.vatRate);

  let inputInvoices = 0;
  let assumedInvoices = 0;
  for (const inv of data.invoices) {
    if (!within(inv.received_at) || inv.amount == null) continue;
    // Foreign suppliers are reverse charge: the VAT goes in and out and nets to zero
    if (inv.currency !== "SEK") continue;
    if (inv.vat_amount != null) {
      inputInvoices += inv.vat_amount;
    } else {
      inputInvoices += inv.amount * 0.2;
      assumedInvoices++;
    }
  }
  const inputReceipts = data.receipts.filter((r) => within(r.received_at)).reduce((sum, r) => sum + (receiptInputVat(r) || 0), 0);

  const range = data.bankRange;
  const salesCovered = !!data.customerVat || (!!range && range.from <= addDays(q.start, 7) && range.to >= [addDays(q.end, -7), addDays(data.today, -14)].sort()[0]);

  const paid = data.bankRows
    .filter((r) => bankCategory(r) === "tax" && r.date > q.end && r.date <= addDays(q.dueDate, 10))
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  let status: VatQuarter["status"];
  if (data.today <= q.end) status = "building";
  else if (paid) status = "paid";
  else if (data.today <= q.dueDate) status = "due";
  else status = range && range.to >= q.dueDate ? "unpaid" : "past";

  const output = outputShopify + outputCustomers;
  const input = inputInvoices + inputReceipts;
  return {
    ...q,
    outputShopify: round(outputShopify),
    outputCustomers: round(outputCustomers),
    customersFrom: data.customerVat ? "fortnox" : "bank",
    inputInvoices: round(inputInvoices),
    inputReceipts: round(inputReceipts),
    net: round(output - input),
    complete: salesCovered,
    status,
    paidAmount: paid ? Math.abs(paid.amount) : null,
    paidDate: paid ? paid.date : null,
    assumedInvoices,
  };
}

// ---- Forecast ----

export interface CashItem {
  date: string;
  // SEK: positive in, negative out
  amount: number;
  kind: "shopify" | "customer" | "supplier" | "vat";
  label: string;
  // The amount in the invoice's own currency, when that is not SEK
  original: string | null;
  href: string | null;
  flag: string | null;
}

export interface ForecastWeek {
  week: number;
  from: string;
  to: string;
  shopify: number;
  customer: number;
  supplier: number;
  vat: number;
  net: number;
  balance: number;
  trend: number | null;
}

export interface Forecast {
  weeks: ForecastWeek[];
  known: { date: string; value: number }[];
  trend: { date: string; value: number }[] | null;
}

export function buildForecast(input: { today: string; opening: number; items: CashItem[]; weeklyNet: number | null; weeks: number }): Forecast {
  const { today: start, opening, items, weeklyNet } = input;
  const first = mondayOf(start);
  const sumUntil = (date: string, kinds?: CashItem["kind"][]) =>
    items.filter((i) => i.date <= date && (!kinds || kinds.includes(i.kind))).reduce((sum, i) => sum + i.amount, 0);
  const trendAt = (date: string) =>
    weeklyNet == null ? null : round(opening + (weeklyNet / 7) * ((toTime(date) - toTime(start)) / DAY) + sumUntil(date, ["vat"]));

  const weeks: ForecastWeek[] = [];
  for (let i = 0; i < input.weeks; i++) {
    const from = addDays(first, i * 7);
    const to = addDays(from, 6);
    const inWeek = items.filter((item) => (i === 0 ? item.date <= to : item.date >= from && item.date <= to));
    const total = (kind: CashItem["kind"]) => round(inWeek.filter((item) => item.kind === kind).reduce((sum, item) => sum + item.amount, 0));
    weeks.push({
      week: isoWeek(from),
      from,
      to,
      shopify: total("shopify"),
      customer: total("customer"),
      supplier: total("supplier"),
      vat: total("vat"),
      net: round(inWeek.reduce((sum, item) => sum + item.amount, 0)),
      balance: round(opening + sumUntil(to)),
      trend: trendAt(to),
    });
  }

  const last = weeks[weeks.length - 1].to;
  const known: Forecast["known"] = [];
  const trend: NonNullable<Forecast["trend"]> = [];
  for (let d = start; d <= last; d = addDays(d, 1)) {
    known.push({ date: d, value: round(opening + sumUntil(d)) });
    const value = trendAt(d);
    if (value != null) trend.push({ date: d, value });
  }
  return { weeks, known, trend: weeklyNet == null ? null : trend };
}

/** Average net per week over the last eight full weeks, VAT payments left out. Null without eight weeks of statements. */
export function averageWeeklyNet(rows: BankRow[], todayDate: string, range: { from: string } | null): number | null {
  const to = addDays(mondayOf(todayDate), -1);
  const from = addDays(to, -55);
  if (!range || range.from > addDays(from, 7)) return null;
  return round(rows.filter((r) => r.date >= from && r.date <= to && bankCategory(r) !== "tax").reduce((sum, r) => sum + r.amount, 0) / 8);
}

// ---- The page ----

export interface MonthFlow {
  month: string;
  shopify: number;
  customers: number;
  otherIn: number;
  suppliers: number;
  card: number;
  tax: number;
  otherOut: number;
  net: number;
}

export interface CashflowOverview {
  today: string;
  cash: number | null;
  cashDate: string | null;
  cashAgeDays: number | null;
  vatToPay: number;
  afterVat: number | null;
  lowest: ForecastWeek | null;
  quarters: VatQuarter[];
  forecast: Forecast | null;
  items: CashItem[];
  history: { date: string; balance: number }[];
  months: MonthFlow[];
  weeklyNet: number | null;
  rates: SekRate[];
  notes: string[];
  bankRange: { from: string; to: string } | null;
  settledInvoices: number;
}

const FORECAST_WEEKS = 16; // long enough to always include the next VAT payment
const HISTORY_DAYS = 90;

export function cashflowOverview(settled: { invoiceIds: Set<string>; payoutIds: Set<string> }): CashflowOverview {
  const now = today();
  const quarters = recentQuarters(now, 4);
  const bankRange = bankDataRange();
  const bankRows = bankRowsSince(quarters[quarters.length - 1].start);
  const receipts = listReceipts({}, 5000);
  const payouts = listPayouts(5000);
  const pending = getPendingBalance();
  const rates = sekRates(receipts);
  const notes: string[] = [];

  const fortnoxHasData = customerInvoiceCount() > 0;
  const quarterResults = quarters.map((q) =>
    calculateVatQuarter(q, {
      today: now,
      payouts,
      pendingVat: pending?.vat || 0,
      invoices: invoicesReceivedBetween(q.start, q.end),
      receipts,
      bankRows,
      bankRange,
      customerVat: fortnoxHasData
        ? (period) => customerInvoicesBetween(period.start, period.end).reduce((sum, i) => sum + (i.total_vat || 0) * i.sek_rate, 0)
        : null,
      vatRate: env.shopifyVatRate,
    })
  );

  const balances = latestBalances();
  const cash = balances.length ? round(balances.reduce((sum, b) => sum + b.balance, 0)) : null;
  const cashDate = balances.length ? balances.map((b) => b.date).sort()[0] : null;

  const openQuarters = quarterResults.filter((q) => q.complete && (q.status === "building" || q.status === "due") && q.net > 0);
  const vatToPay = round(openQuarters.reduce((sum, q) => sum + q.net, 0));

  // ---- What is known to come in and go out ----
  const items: CashItem[] = [];

  let settledInvoices = 0;
  let withoutAmount = 0;
  for (const inv of listUnpaidInvoices()) {
    if (inv.amount == null) { withoutAmount++; continue; }
    if (inv.amount < 0) continue; // credit notes are deducted from their invoice
    if (settled.invoiceIds.has(inv.id)) { settledInvoices++; continue; }
    const payable = payableAmount(inv);
    if (payable == null || payable <= 0) continue;
    const rate = inv.currency === "SEK" ? 1 : rates.get(inv.currency)?.rate;
    if (rate == null) { notes.push(`${inv.vendor_name} ${inv.invoice_number}: ingen kurs för ${inv.currency}, räknas inte med.`); continue; }
    const overdue = !!inv.due_date && inv.due_date < now;
    items.push({
      date: !inv.due_date || overdue ? now : inv.due_date,
      amount: -round(payable * rate),
      kind: "supplier",
      label: `${inv.vendor_name || "Okänd leverantör"} ${inv.invoice_number || ""}`.trim(),
      original: inv.currency === "SEK" ? null : `${payable.toLocaleString("sv-SE", { minimumFractionDigits: 2 })} ${inv.currency}`,
      href: `/invoices/${inv.id}`,
      flag: overdue ? "Förfallen" : inv.due_date ? null : "Saknar förfallodag",
    });
  }
  if (withoutAmount) notes.push(`Obetalda fakturor utan belopp räknas inte med: ${withoutAmount} st.`);

  for (const c of listUnpaidCustomerInvoices()) {
    const overdue = !!c.due_date && c.due_date < now;
    items.push({
      date: !c.due_date || overdue ? now : c.due_date,
      amount: round((c.balance || 0) * c.sek_rate),
      kind: "customer",
      label: `${c.customer_name || "Kund"}, faktura ${c.document_number}`,
      original: c.currency && c.currency !== "SEK" ? `${(c.balance || 0).toLocaleString("sv-SE", { minimumFractionDigits: 2 })} ${c.currency}` : null,
      href: null,
      flag: overdue ? "Förfallen" : null,
    });
  }

  // A payout the statement has not reached yet is on its way; an older one without a match is not counted
  for (const p of payouts) {
    if (p.bank_date || settled.payoutIds.has(p.id) || p.net == null || !p.issued_at) continue;
    if (p.shopify_status === "FAILED" || p.shopify_status === "CANCELED") continue;
    const issued = p.issued_at.slice(0, 10);
    if (!bankRange || issued < bankRange.to) continue;
    items.push({ date: issued > now ? issued : now, amount: p.net, kind: "shopify", label: `Shopify-utbetalning #${p.id}`, original: null, href: "/shopify", flag: null });
  }

  if (pending && pending.net > 0) {
    // Shopify pays out on a fixed weekday; the money it holds arrives with the next one
    const lastPayout = payouts.map((p) => (p.issued_at || "").slice(0, 10)).filter(Boolean).sort().pop();
    let next = lastPayout ? addDays(lastPayout, 7) : addDays(now, 7);
    while (next < now) next = addDays(next, 7);
    items.push({ date: next, amount: round(pending.net), kind: "shopify", label: `Shopify, väntande försäljning (${pending.count} transaktioner)`, original: null, href: "/shopify", flag: null });
  }

  for (const q of openQuarters) {
    items.push({ date: q.dueDate, amount: -q.net, kind: "vat", label: `Moms ${q.label}${q.status === "building" ? " (hittills)" : ""}`, original: null, href: null, flag: null });
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);

  // ---- Forecast and history ----
  const weeklyNet = averageWeeklyNet(bankRows, now, bankRange);
  const forecast = cash == null ? null : buildForecast({ today: now, opening: cash, items, weeklyNet, weeks: FORECAST_WEEKS });
  const lowest = forecast ? forecast.weeks.reduce((min, w) => (w.balance < min.balance ? w : min), forecast.weeks[0]) : null;

  const months = new Map<string, MonthFlow>();
  for (const r of bankRows) {
    const month = r.date.slice(0, 7);
    if (!months.has(month)) months.set(month, { month, shopify: 0, customers: 0, otherIn: 0, suppliers: 0, card: 0, tax: 0, otherOut: 0, net: 0 });
    const m = months.get(month)!;
    m[bankCategory(r)] += r.amount;
    m.net += r.amount;
  }

  if (!fortnoxHasData) notes.unshift("Kundfakturorna kommer från bankgiroinsättningar med 25 % moms antagen, tills Fortnox är kopplat.");
  const assumed = quarterResults.reduce((sum, q) => sum + q.assumedInvoices, 0);
  if (assumed) notes.push(`Svenska fakturor där AFORT inte kan läsa momsen: ${assumed} st. På dem är 25 % moms antagen.`);
  const usedRates = [...rates.values()].filter((r) => items.some((i) => i.original?.endsWith(r.currency)));
  if (usedRates.some((r) => !r.fromBank)) notes.push("Kursen för utländska fakturor är ett schablonvärde tills ett kortköp i samma valuta har matchats mot banken.");

  return {
    today: now,
    cash,
    cashDate,
    cashAgeDays: cashDate ? Math.round((toTime(now) - toTime(cashDate)) / DAY) : null,
    vatToPay,
    afterVat: cash == null ? null : round(cash - vatToPay),
    lowest,
    quarters: quarterResults,
    forecast,
    items,
    history: balanceHistory(addDays(now, -HISTORY_DAYS), now),
    months: [...months.values()].sort((a, b) => b.month.localeCompare(a.month)).slice(0, 6),
    weeklyNet,
    rates: usedRates,
    notes,
    bankRange,
    settledInvoices,
  };
}
