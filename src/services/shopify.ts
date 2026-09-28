import fs from "fs";
import path from "path";
import { env } from "../config/env";
import { getPayout, upsertPayout } from "../models/shopify";
import { createNotification } from "../models/notification";

/**
 * Shopify Payments payouts: what Shopify transfers to the bank account, and the
 * sales, refunds and fees behind each transfer. One CSV report per payout.
 */

export interface ShopifySyncStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  payouts: number;
  created: number;
  error: string | null;
}

const status: ShopifySyncStatus = { running: false, startedAt: null, finishedAt: null, payouts: 0, created: 0, error: null };

export function getShopifySyncStatus(): ShopifySyncStatus {
  return { ...status };
}

export function isShopifyConfigured(): boolean {
  return !!(env.shopifyStoreDomain && env.shopifyAccessToken);
}

export type GraphqlFn = (query: string, variables: Record<string, unknown>) => Promise<any>;

/** Calls the Admin GraphQL API with the custom app's token. */
export const shopifyGraphql: GraphqlFn = async (query, variables) => {
  const url = `https://${env.shopifyStoreDomain}/admin/api/${env.shopifyApiVersion}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": env.shopifyAccessToken },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401 || res.status === 403) throw new Error("Shopify nekade åtkomst – kontrollera SHOPIFY_ACCESS_TOKEN och appens behörigheter");
  if (!res.ok) throw new Error(`Shopify svarade ${res.status}`);
  const body: any = await res.json();
  if (body.errors?.length) throw new Error(body.errors.map((e: any) => e.message).join("; "));
  return body.data;
};

const PAYOUTS_QUERY = `
query AfortPayouts($first: Int!, $after: String) {
  shopifyPaymentsAccount {
    id
    defaultCurrency
    payouts(first: $first, after: $after, sortKey: ISSUED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        legacyResourceId
        issuedAt
        status
        transactionType
        net { amount currencyCode }
        summary {
          chargesGross { amount currencyCode }
          chargesFee { amount currencyCode }
          refundsFeeGross { amount currencyCode }
          refundsFee { amount currencyCode }
          adjustmentsGross { amount currencyCode }
          adjustmentsFee { amount currencyCode }
          reservedFundsGross { amount currencyCode }
          reservedFundsFee { amount currencyCode }
        }
      }
    }
  }
}`;

const TRANSACTIONS_QUERY = `
query AfortPayoutTransactions($first: Int!, $after: String) {
  shopifyPaymentsAccount {
    balanceTransactions(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        type
        transactionDate
        amount { amount currencyCode }
        fee { amount currencyCode }
        net { amount currencyCode }
        sourceType
        associatedOrder { id name }
        associatedPayout { id status }
        adjustmentReason
      }
    }
  }
}`;

interface PayoutNode {
  id: string;
  legacyResourceId: string;
  issuedAt: string;
  status: string;
  transactionType: string;
  net: { amount: string; currencyCode: string };
  summary: Record<string, { amount: string; currencyCode: string }>;
}

interface TransactionNode {
  id: string;
  type: string;
  transactionDate: string;
  amount: { amount: string; currencyCode: string };
  fee: { amount: string; currencyCode: string } | null;
  net: { amount: string; currencyCode: string } | null;
  sourceType: string | null;
  associatedOrder: { id: string; name: string } | null;
  associatedPayout: { id: string | null; status: string } | null;
  adjustmentReason: string | null;
}

const TYPE_LABELS: Record<string, string> = {
  CHARGE: "Försäljning",
  REFUND: "Återbetalning",
  DISPUTE: "Tvist",
  DISPUTE_REVERSAL: "Tvist återförd",
  ADJUSTMENT: "Justering",
  RESERVED_FUNDS: "Reserverade medel",
  RESERVED_FUNDS_WITHDRAWAL: "Reserv frigjord",
  TRANSFER: "Överföring till bank",
  TRANSFER_FAILURE: "Misslyckad överföring",
  TRANSFER_CANCEL: "Överföring avbruten",
  TRANSFER_REFUND: "Överföring återförd",
  CHARGEBACK: "Chargeback",
  CHARGEBACK_HOLD: "Chargeback spärr",
  CHARGEBACK_HOLD_RELEASE: "Chargeback släppt",
  ADVANCE: "Förskott",
  ADVANCE_FUNDING: "Förskott utbetalt",
  SHOPIFY_COLLECTIVE_CREDIT: "Collective kredit",
  SHOPIFY_COLLECTIVE_DEBIT: "Collective debet",
  SHOP_CASH_CREDIT: "Shop Cash kredit",
  SHOP_CASH_REFUND_DEBIT: "Shop Cash återbetalning",
  MARKETPLACE_FEE_CREDIT: "Marknadsplatsavgift kredit",
  MARKETPLACE_FEE_CREDIT_REVERSAL: "Marknadsplatsavgift återförd",
  RISK_REVERSAL: "Riskreservering",
  FEES: "Avgifter",
};

const num = (m: { amount: string } | null | undefined): number => (m ? parseFloat(m.amount) || 0 : 0);
const csvNum = (n: number) => n.toFixed(2).replace(".", ",");
const csvCell = (v: string | number | null | undefined) => {
  const s = v == null ? "" : String(v);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The CSV the bookkeeper opens: every transaction behind the payout, then the totals. */
export function buildPayoutReport(payout: PayoutNode, transactions: TransactionNode[]): string {
  const lines: string[] = [];
  lines.push(["Datum", "Typ", "Order", "Brutto", "Avgift", "Netto", "Valuta", "Kommentar"].join(";"));
  const sorted = [...transactions].sort((a, b) => a.transactionDate.localeCompare(b.transactionDate));
  for (const t of sorted) {
    if (t.type === "TRANSFER") continue; // the payout itself
    lines.push([
      t.transactionDate.slice(0, 10),
      TYPE_LABELS[t.type] || t.type,
      csvCell(t.associatedOrder?.name || ""),
      csvNum(num(t.amount)),
      csvNum(-Math.abs(num(t.fee))),
      csvNum(num(t.net)),
      t.amount.currencyCode,
      csvCell(t.adjustmentReason || ""),
    ].join(";"));
  }
  const s = payout.summary;
  const cur = payout.net.currencyCode;
  lines.push("");
  lines.push(["Sammanställning utbetalning", payout.legacyResourceId, "", "", "", "", "", ""].join(";"));
  lines.push(["Utbetalningsdatum", payout.issuedAt.slice(0, 10)].join(";"));
  lines.push(["Försäljning brutto", "", "", csvNum(num(s.chargesGross)), csvNum(-num(s.chargesFee)), csvNum(num(s.chargesGross) - num(s.chargesFee)), cur].join(";"));
  lines.push(["Återbetalningar", "", "", csvNum(-Math.abs(num(s.refundsFeeGross))), csvNum(-num(s.refundsFee)), csvNum(-Math.abs(num(s.refundsFeeGross)) - num(s.refundsFee)), cur].join(";"));
  lines.push(["Justeringar och tvister", "", "", csvNum(num(s.adjustmentsGross)), csvNum(-num(s.adjustmentsFee)), csvNum(num(s.adjustmentsGross) - num(s.adjustmentsFee)), cur].join(";"));
  lines.push(["Reserverade medel", "", "", csvNum(num(s.reservedFundsGross)), csvNum(-num(s.reservedFundsFee)), csvNum(num(s.reservedFundsGross) - num(s.reservedFundsFee)), cur].join(";"));
  lines.push(["Summa avgifter", "", "", "", csvNum(-(num(s.chargesFee) + num(s.refundsFee) + num(s.adjustmentsFee) + num(s.reservedFundsFee))), "", cur].join(";"));
  lines.push(["Utbetalt till bank (netto)", "", "", "", "", csvNum(num(payout.net)), cur].join(";"));
  return "﻿" + lines.join("\r\n");
}

async function fetchAllPayouts(graphql: GraphqlFn, max: number): Promise<PayoutNode[]> {
  const nodes: PayoutNode[] = [];
  let after: string | null = null;
  do {
    const data: any = await graphql(PAYOUTS_QUERY, { first: Math.min(50, max - nodes.length), after });
    const account = data?.shopifyPaymentsAccount;
    if (!account) throw new Error("Butiken har inget Shopify Payments-konto, eller så saknar appen behörigheten read_shopify_payments_accounts");
    nodes.push(...(account.payouts?.nodes || []));
    after = account.payouts?.pageInfo?.hasNextPage ? account.payouts.pageInfo.endCursor : null;
  } while (after && nodes.length < max);
  return nodes;
}

async function fetchTransactionsByPayout(graphql: GraphqlFn, max: number): Promise<Map<string, TransactionNode[]>> {
  const byPayout = new Map<string, TransactionNode[]>();
  let after: string | null = null;
  let fetched = 0;
  do {
    const data: any = await graphql(TRANSACTIONS_QUERY, { first: Math.min(250, max - fetched), after });
    const conn = data?.shopifyPaymentsAccount?.balanceTransactions;
    const nodes: TransactionNode[] = conn?.nodes || [];
    fetched += nodes.length;
    for (const t of nodes) {
      const payoutId = t.associatedPayout?.id;
      if (!payoutId) continue;
      if (!byPayout.has(payoutId)) byPayout.set(payoutId, []);
      byPayout.get(payoutId)!.push(t);
    }
    after = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after && fetched < max);
  return byPayout;
}

/**
 * Fetches payouts and their transactions, writes a CSV report per payout and
 * stores the totals. Local status and bank matches are never touched.
 */
export async function syncShopifyPayouts(opts: { graphql?: GraphqlFn; maxPayouts?: number; maxTransactions?: number } = {}): Promise<ShopifySyncStatus & { busy?: boolean }> {
  if (status.running) return { ...status, busy: true };
  Object.assign(status, { running: true, startedAt: new Date().toISOString(), finishedAt: null, payouts: 0, created: 0, error: null });
  try {
    if (!isShopifyConfigured() && !opts.graphql) throw new Error("Shopify är inte kopplat (SHOPIFY_STORE_DOMAIN / SHOPIFY_ACCESS_TOKEN saknas)");
    const graphql = opts.graphql || shopifyGraphql;
    const payouts = await fetchAllPayouts(graphql, opts.maxPayouts || 200);
    const transactions = payouts.length ? await fetchTransactionsByPayout(graphql, opts.maxTransactions || 5000) : new Map<string, TransactionNode[]>();

    for (const p of payouts) {
      const rows = transactions.get(p.id) || [];
      const day = p.issuedAt.slice(0, 10);
      const dir = path.join(env.shopifyDir, day.slice(0, 4));
      fs.mkdirSync(dir, { recursive: true });
      const reportPath = path.join(dir, `shopify-utbetalning-${day}-${p.legacyResourceId}.csv`);
      fs.writeFileSync(reportPath, buildPayoutReport(p, rows));

      const existed = !!getPayout(p.legacyResourceId);
      const s = p.summary;
      upsertPayout({
        id: p.legacyResourceId,
        gid: p.id,
        issued_at: p.issuedAt,
        shopify_status: p.status,
        transaction_type: p.transactionType,
        net: num(p.net),
        currency: p.net.currencyCode,
        charges_gross: num(s.chargesGross),
        charges_fee: num(s.chargesFee),
        refunds_gross: num(s.refundsFeeGross),
        refunds_fee: num(s.refundsFee),
        adjustments_gross: num(s.adjustmentsGross),
        adjustments_fee: num(s.adjustmentsFee),
        reserved_gross: num(s.reservedFundsGross),
        reserved_fee: num(s.reservedFundsFee),
        transaction_count: rows.filter((t) => t.type !== "TRANSFER").length,
        report_path: reportPath,
        synced_at: new Date().toISOString(),
      });
      status.payouts++;
      if (!existed) {
        status.created++;
        createNotification(
          "shopify",
          "Ny Shopify-utbetalning",
          `${num(p.net).toFixed(2).replace(".", ",")} ${p.net.currencyCode} utbetalt ${day}`,
          "/shopify"
        );
      }
    }
    console.log(`[Shopify] Synced ${status.payouts} payouts (${status.created} new)`);
  } catch (err: any) {
    status.error = err?.message || String(err);
    console.error("[Shopify] Sync failed:", status.error);
  } finally {
    status.running = false;
    status.finishedAt = new Date().toISOString();
  }
  return { ...status };
}
