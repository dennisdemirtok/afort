import fs from "fs";
import path from "path";
import { env } from "../config/env";
import { getPayout, upsertPayout } from "../models/shopify";
import { createNotification } from "../models/notification";
import { setMeta, getMeta } from "../models/database";

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
  return !!(env.shopifyStoreDomain && (env.shopifyAccessToken || (env.shopifyClientId && env.shopifyClientSecret)));
}

/** Which Railway variables are still missing, for the setup card. */
export function missingShopifySettings(): string[] {
  const missing: string[] = [];
  if (!env.shopifyStoreDomain) missing.push("SHOPIFY_STORE_DOMAIN");
  if (!env.shopifyAccessToken) {
    if (!env.shopifyClientId) missing.push("SHOPIFY_CLIENT_ID");
    if (!env.shopifyClientSecret) missing.push("SHOPIFY_CLIENT_SECRET");
  }
  return missing;
}

export type GraphqlFn = (query: string, variables: Record<string, unknown>) => Promise<any>;

// Client credentials tokens live for 24 hours; keep one and renew it a little early
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(forceRefresh = false): Promise<string> {
  if (env.shopifyAccessToken) return env.shopifyAccessToken;
  if (!forceRefresh && cachedToken && cachedToken.expiresAt > Date.now() + 5 * 60 * 1000) return cachedToken.value;

  const res = await fetch(`https://${env.shopifyStoreDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.shopifyClientId,
      client_secret: env.shopifyClientSecret,
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    if (/shop_not_permitted/i.test(text)) throw new Error("Shopify: appen och butiken ligger inte i samma organisation i Dev Dashboard");
    if (res.status === 400 || res.status === 401) throw new Error("Shopify godkände inte SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET – kontrollera att de kommer från appen AFORT i Dev Dashboard och att appen är installerad i butiken");
    throw new Error(`Shopify svarade ${res.status} när AFORT bad om en token`);
  }
  const body: any = JSON.parse(text);
  if (!body.access_token) throw new Error("Shopify skickade ingen token");
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 86399) * 1000 };
  return cachedToken.value;
}

/** Calls the Admin GraphQL API; renews the token once if Shopify says it has expired. */
export const shopifyGraphql: GraphqlFn = async (query, variables) => {
  const url = `https://${env.shopifyStoreDomain}/admin/api/${env.shopifyApiVersion}/graphql.json`;
  const call = async (token: string) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
  let res = await call(await getAccessToken());
  if (res.status === 401 && !env.shopifyAccessToken) res = await call(await getAccessToken(true));
  if (res.status === 401 || res.status === 403) {
    throw new Error("Shopify nekade åtkomst – kontrollera att appen AFORT är installerad och har behörigheterna read_shopify_payments_payouts och read_shopify_payments_accounts");
  }
  if (!res.ok) throw new Error(`Shopify svarade ${res.status}`);
  const body: any = await res.json();
  if (body.errors?.length) {
    const message = body.errors.map((e: any) => e.message).join("; ");
    if (/access denied|ACCESS_DENIED/i.test(message)) throw new Error(`Shopify nekade åtkomst till utbetalningarna (${message})`);
    throw new Error(message);
  }
  return body.data;
};

/** For tests: forget the cached token. */
export function resetShopifyTokenCache(): void {
  cachedToken = null;
}

const PAYOUTS_QUERY = `
query AfortPayouts($first: Int!, $after: String) {
  shopifyPaymentsAccount {
    id
    defaultCurrency
    balance { amount currencyCode }
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

async function fetchAllPayouts(graphql: GraphqlFn, max: number): Promise<{ nodes: PayoutNode[]; balance: { amount: string; currencyCode: string }[] }> {
  const nodes: PayoutNode[] = [];
  let balance: { amount: string; currencyCode: string }[] = [];
  let after: string | null = null;
  do {
    const data: any = await graphql(PAYOUTS_QUERY, { first: Math.min(50, max - nodes.length), after });
    const account = data?.shopifyPaymentsAccount;
    if (!account) throw new Error("Butiken har inget Shopify Payments-konto, eller så saknar appen behörigheten read_shopify_payments_accounts");
    if (!after) balance = account.balance || [];
    nodes.push(...(account.payouts?.nodes || []));
    after = account.payouts?.pageInfo?.hasNextPage ? account.payouts.pageInfo.endCursor : null;
  } while (after && nodes.length < max);
  return { nodes, balance };
}

async function fetchAllTransactions(graphql: GraphqlFn, max: number): Promise<TransactionNode[]> {
  const all: TransactionNode[] = [];
  let after: string | null = null;
  do {
    const data: any = await graphql(TRANSACTIONS_QUERY, { first: Math.min(250, max - all.length), after });
    const conn = data?.shopifyPaymentsAccount?.balanceTransactions;
    all.push(...(conn?.nodes || []));
    after = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after && all.length < max);
  return all;
}

export interface PendingBalance {
  updatedAt: string;
  currency: string | null;
  balance: number;
  count: number;
  gross: number;
  fees: number;
  net: number;
  transactions: { date: string; type: string; order: string | null; gross: number; fee: number; net: number; currency: string }[];
}

/** Money Shopify holds that is not part of any payout yet – what the next payout will contain. */
export function getPendingBalance(): PendingBalance | null {
  const raw = getMeta("shopify_pending");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingBalance;
  } catch {
    return null;
  }
}

/**
 * Fetches payouts and their transactions, writes a CSV report per payout and
 * stores the totals. Local status and bank matches are never touched.
 */
export async function syncShopifyPayouts(opts: { graphql?: GraphqlFn; maxPayouts?: number; maxTransactions?: number } = {}): Promise<ShopifySyncStatus & { busy?: boolean }> {
  if (status.running) return { ...status, busy: true };
  Object.assign(status, { running: true, startedAt: new Date().toISOString(), finishedAt: null, payouts: 0, created: 0, error: null });
  try {
    if (!isShopifyConfigured() && !opts.graphql) throw new Error(`Shopify är inte kopplat (${missingShopifySettings().join(", ")} saknas i Railway)`);
    const graphql = opts.graphql || shopifyGraphql;
    const { nodes: payouts, balance } = await fetchAllPayouts(graphql, opts.maxPayouts || 200);
    const allTransactions = await fetchAllTransactions(graphql, opts.maxTransactions || 5000);
    const payoutIds = new Set(payouts.map((p) => p.id));
    const transactions = new Map<string, TransactionNode[]>();
    const pending: TransactionNode[] = [];
    for (const t of allTransactions) {
      const payoutId = t.associatedPayout?.id;
      if (payoutId && payoutIds.has(payoutId)) {
        if (!transactions.has(payoutId)) transactions.set(payoutId, []);
        transactions.get(payoutId)!.push(t);
      } else if (t.type !== "TRANSFER") {
        pending.push(t);
      }
    }
    pending.sort((a, b) => b.transactionDate.localeCompare(a.transactionDate));
    const pendingSummary: PendingBalance = {
      updatedAt: new Date().toISOString(),
      currency: balance[0]?.currencyCode || pending[0]?.amount.currencyCode || null,
      balance: balance.reduce((sum, b) => sum + (parseFloat(b.amount) || 0), 0),
      count: pending.length,
      gross: pending.reduce((sum, t) => sum + num(t.amount), 0),
      fees: pending.reduce((sum, t) => sum + Math.abs(num(t.fee)), 0),
      net: pending.reduce((sum, t) => sum + num(t.net), 0),
      transactions: pending.map((t) => ({
        date: t.transactionDate.slice(0, 10),
        type: TYPE_LABELS[t.type] || t.type,
        order: t.associatedOrder?.name || null,
        gross: num(t.amount),
        fee: -Math.abs(num(t.fee)),
        net: num(t.net),
        currency: t.amount.currencyCode,
      })),
    };
    setMeta("shopify_pending", JSON.stringify(pendingSummary));

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
