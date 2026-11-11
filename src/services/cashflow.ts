import { env } from "../config/env";
import { BankRow, balanceHistory, bankDataRange, bankRowsSince, latestBalances } from "../models/bank";
import { customerInvoiceCount, customerInvoicesPaidBetween, listUnpaidCustomerInvoices } from "../models/fortnox";
import { Invoice, invoicesReceivedBetween, listUnpaidInvoices, payableAmount, today } from "../models/invoice";
import { Receipt, listReceipts } from "../models/receipt";
import { ShopifyPayout, listPayouts } from "../models/shopify";
import { getPendingBalance, vatOf } from "./shopify";
import { receiptInputVat } from "./voucher";

/**
 * Rolling cash flow: the bank balance, what is known to come in and go out, and the VAT that has
 * built up. Everything here is a preliminary figure for planning, not bookkeeping.
 *
 * VAT follows the cash method, which Transfercraft uses: it belongs to the quarter in which the
 * money came in or went out, not the invoice date.
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
    // By the invoice date: AFORT's paid dates are only bank dates for invoices ticked off from a
    // statement, and suppliers are paid within weeks, so it is close to the cash method
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
  else status = range && range.from <= addDays(q.end, 1) && range.to >= q.dueDate ? "unpaid" : "past";

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
  // What the prognosis adds on top of the known items this week
  estimated: number;
  prognosis: number | null;
}

export interface Forecast {
  weeks: ForecastWeek[];
  known: { date: string; value: number }[];
  prognosis: { date: string; value: number }[] | null;
}

/** Known items give the "Kända poster" line; known plus estimated items give the prognosis. */
export function buildForecast(input: { today: string; opening: number; items: CashItem[]; estimates: CashItem[] | null; weeks: number }): Forecast {
  const { today: start, opening, items, estimates } = input;
  const first = mondayOf(start);
  const sum = (list: CashItem[], until: string) => list.filter((i) => i.date <= until).reduce((total, i) => total + i.amount, 0);
  const sumUntil = (date: string) => sum(items, date);
  const prognosisAt = (date: string) => (estimates ? round(opening + sumUntil(date) + sum(estimates, date)) : null);

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
      net: round(inWeek.reduce((total, item) => total + item.amount, 0)),
      balance: round(opening + sumUntil(to)),
      estimated: round((estimates || []).filter((e) => e.date >= from && e.date <= to).reduce((total, e) => total + e.amount, 0)),
      prognosis: prognosisAt(to),
    });
  }

  const last = weeks[weeks.length - 1].to;
  const known: Forecast["known"] = [];
  const prognosis: NonNullable<Forecast["prognosis"]> = [];
  for (let d = start; d <= last; d = addDays(d, 1)) {
    known.push({ date: d, value: round(opening + sumUntil(d)) });
    const value = prognosisAt(d);
    if (value != null) prognosis.push({ date: d, value });
  }
  return { weeks, known, prognosis: estimates ? prognosis : null };
}

/** What the prognosis rests on, per week, worked out from the last weeks' actual figures. */
export interface ForecastBasis {
  // Average Shopify payout over the last four weeks, and the first payout day that is not already known
  shopifyWeekly: number | null;
  firstEstimatedPayout: string | null;
  // Average paid customer invoices per week, counted from the day after the known invoices run out
  customersWeekly: number | null;
  customersFrom: "fortnox" | "bank";
  knownCustomersUntil: string;
  // Average paid to suppliers and by card per week (positive)
  costsWeekly: number | null;
  vatRate: number;
}

/**
 * The prognosis on top of the known items. Shopify: the average payout on every coming payout day.
 * Customers: once the invoices already sent run out, the average – or the known invoices if they are
 * more. Costs: the average, or the known invoices if they are more. The current week keeps to what is
 * known. The VAT on the estimated sales is added to its quarter, when that is due within the period.
 */
export function estimateItems(basis: ForecastBasis, items: CashItem[], todayDate: string, weeks: number): CashItem[] {
  const estimates: CashItem[] = [];
  const first = mondayOf(todayDate);
  const last = addDays(first, weeks * 7 - 1);
  const estimate = (date: string, amount: number, kind: CashItem["kind"], label: string) =>
    estimates.push({ date, amount: round(amount), kind, label, original: null, href: null, flag: null });

  if (basis.shopifyWeekly && basis.firstEstimatedPayout) {
    for (let day = basis.firstEstimatedPayout; day <= last; day = addDays(day, 7)) estimate(day, basis.shopifyWeekly, "shopify", "Shopify, beräknad utbetalning");
  }
  for (let i = 1; i < weeks; i++) {
    const from = addDays(first, i * 7);
    const to = addDays(from, 6);
    const known = (kind: CashItem["kind"]) => items.filter((item) => item.kind === kind && item.date >= from && item.date <= to).reduce((total, item) => total + item.amount, 0);
    const midweek = addDays(from, 2);
    if (basis.customersWeekly && from > basis.knownCustomersUntil && known("customer") < basis.customersWeekly) {
      estimate(midweek, basis.customersWeekly - known("customer"), "customer", "Kundfakturor, beräknat");
    }
    if (basis.costsWeekly && known("supplier") > -basis.costsWeekly) {
      estimate(midweek, -basis.costsWeekly - known("supplier"), "supplier", "Leverantörer och kort, beräknat");
    }
  }

  // Cash method: the VAT belongs to the quarter the money comes in
  const vatByQuarter = new Map<string, { quarter: Quarter; vat: number }>();
  for (const e of estimates) {
    if (e.amount <= 0) continue;
    const quarter = recentQuarters(e.date, 1)[0];
    const entry = vatByQuarter.get(quarter.key) || { quarter, vat: 0 };
    entry.vat += vatOf(e.amount, basis.vatRate);
    vatByQuarter.set(quarter.key, entry);
  }
  for (const { quarter, vat } of vatByQuarter.values()) {
    if (quarter.dueDate <= last) estimate(quarter.dueDate, -vat, "vat", `Moms på beräknad försäljning ${quarter.label}`);
  }
  return estimates.sort((a, b) => a.date.localeCompare(b.date));
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
  basis: ForecastBasis;
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
        ? (period) => customerInvoicesPaidBetween(period.start, period.end).reduce((sum, i) => sum + (i.total_vat || 0) * i.sek_rate, 0)
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

  // Shopify pays out on a fixed weekday; the money it holds arrives with the next one
  const paidOut = payouts.filter((p) => p.issued_at && p.net != null && p.shopify_status !== "FAILED" && p.shopify_status !== "CANCELED");
  const lastPayout = paidOut.map((p) => p.issued_at!.slice(0, 10)).sort().pop();
  let nextPayout = lastPayout ? addDays(lastPayout, 7) : addDays(now, 7);
  while (nextPayout < now) nextPayout = addDays(nextPayout, 7);
  const next = nextPayout;
  const pendingKnown = !!pending && pending.net > 0;
  if (pending && pendingKnown) {
    items.push({ date: next, amount: round(pending.net), kind: "shopify", label: `Shopify, väntande försäljning (${pending.count} transaktioner)`, original: null, href: "/shopify", flag: null });
  }

  for (const q of openQuarters) {
    items.push({ date: q.dueDate, amount: -q.net, kind: "vat", label: `Moms ${q.label}${q.status === "building" ? " (hittills)" : ""}`, original: null, href: null, flag: null });
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);

  // ---- Forecast and history ----
  // Four full weeks back from this Monday, for the averages that come from the statements
  const windowFrom = addDays(mondayOf(now), -28);
  const windowTo = addDays(mondayOf(now), -1);
  const statementsCover = !!bankRange && bankRange.from <= windowFrom;
  const inWindow = bankRows.filter((r) => r.date >= windowFrom && r.date <= windowTo);
  const firstPayout = paidOut.map((p) => p.issued_at!.slice(0, 10)).sort()[0];
  const recentPayouts = paidOut.filter((p) => p.issued_at!.slice(0, 10) > addDays(now, -28));
  const basis: ForecastBasis = {
    shopifyWeekly: firstPayout && firstPayout <= addDays(now, -28) ? round(recentPayouts.reduce((total, p) => total + p.net!, 0) / 4) : null,
    firstEstimatedPayout: lastPayout ? (pendingKnown ? addDays(next, 7) : next) : null,
    customersWeekly: fortnoxHasData
      ? round(customerInvoicesPaidBetween(addDays(now, -91), addDays(now, -1)).reduce((total, c) => total + (c.total || 0) * c.sek_rate, 0) / 13)
      : statementsCover ? round(inWindow.filter((r) => bankCategory(r) === "customers").reduce((total, r) => total + r.amount, 0) / 4) : null,
    customersFrom: fortnoxHasData ? "fortnox" : "bank",
    knownCustomersUntil: addDays(now, 30),
    costsWeekly: statementsCover
      ? round(-inWindow.filter((r) => ["suppliers", "card", "otherOut"].includes(bankCategory(r))).reduce((total, r) => total + r.amount, 0) / 4)
      : null,
    vatRate: env.shopifyVatRate,
  };
  // Without the costs a prognosis would only add income, so it waits for four weeks of statements
  const estimates = cash != null && basis.costsWeekly != null ? estimateItems(basis, items, now, FORECAST_WEEKS) : null;
  const forecast = cash == null ? null : buildForecast({ today: now, opening: cash, items, estimates, weeks: FORECAST_WEEKS });
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
    basis,
    rates: usedRates,
    notes,
    bankRange,
    settledInvoices,
  };
}
