import { env } from "../config/env";
import { getMeta, setMeta } from "../models/database";
import { customerInvoicesWithoutVat, markOthersPaid, setCustomerInvoiceVat, upsertCustomerInvoice } from "../models/fortnox";

/**
 * Reads customer invoices from Fortnox. AFORT only ever sends GET requests, although Fortnox's
 * "invoice" scope itself allows writing.
 */

const OAUTH_URL = "https://apps.fortnox.se/oauth-v1";
const API_URL = "https://api.fortnox.se/3";
const SCOPE = "invoice";

export type FetchFn = typeof fetch;

export function fortnoxRedirectUri(): string {
  return `${env.publicUrl}/auth/fortnox/callback`;
}

export function isFortnoxConfigured(): boolean {
  return !!(env.fortnoxClientId && env.fortnoxClientSecret);
}

export function isFortnoxConnected(): boolean {
  return isFortnoxConfigured() && !!getMeta("fortnox_refresh_token");
}

export function fortnoxAuthUrl(state: string): string {
  const query = new URLSearchParams({
    client_id: env.fortnoxClientId,
    redirect_uri: fortnoxRedirectUri(),
    scope: SCOPE,
    state,
    access_type: "offline",
    response_type: "code",
  });
  return `${OAUTH_URL}/auth?${query}`;
}

let accessToken: { value: string; expiresAt: number } | null = null;
let refreshing: Promise<string> | null = null;

async function requestToken(body: Record<string, string>, fetchFn: FetchFn): Promise<string> {
  const credentials = Buffer.from(`${env.fortnoxClientId}:${env.fortnoxClientSecret}`).toString("base64");
  const res = await fetchFn(`${OAUTH_URL}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${credentials}` },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) throw new Error("Fortnox godkände inte kopplingen. Koppla om Fortnox under Kassaflöde.");
    throw new Error(`Fortnox svarade ${res.status} när AFORT bad om en token`);
  }
  const token: any = await res.json();
  if (!token.access_token) throw new Error("Fortnox skickade ingen token");
  // A refresh token works once: the new one must be saved before anything else can fail
  if (token.refresh_token) setMeta("fortnox_refresh_token", token.refresh_token);
  accessToken = { value: token.access_token, expiresAt: Date.now() + (Number(token.expires_in) || 3600) * 1000 };
  return token.access_token;
}

export async function connectFortnox(code: string, fetchFn: FetchFn = fetch): Promise<void> {
  await requestToken({ grant_type: "authorization_code", code, redirect_uri: fortnoxRedirectUri() }, fetchFn);
}

function getAccessToken(fetchFn: FetchFn): Promise<string> {
  if (accessToken && accessToken.expiresAt > Date.now() + 60_000) return Promise.resolve(accessToken.value);
  // Two refreshes at once would invalidate each other's token
  if (!refreshing) {
    const refreshToken = getMeta("fortnox_refresh_token");
    if (!refreshToken) return Promise.reject(new Error("Fortnox är inte kopplat"));
    refreshing = requestToken({ grant_type: "refresh_token", refresh_token: refreshToken }, fetchFn).finally(() => { refreshing = null; });
  }
  return refreshing;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function apiGet(path: string, fetchFn: FetchFn): Promise<any> {
  const call = async () => fetchFn(`${API_URL}${path}`, {
    headers: { Authorization: `Bearer ${await getAccessToken(fetchFn)}`, Accept: "application/json" },
  });
  let res = await call();
  if (res.status === 429) {
    await wait(5000);
    res = await call();
  }
  if (res.status === 401 || res.status === 403) throw new Error("Fortnox nekade åtkomst. Kontrollera att integrationen har behörigheten Faktura och koppla om.");
  if (!res.ok) throw new Error(`Fortnox svarade ${res.status}`);
  return res.json();
}

const PAGE_SIZE = 500;

async function listInvoices(query: string, fetchFn: FetchFn): Promise<any[]> {
  const all: any[] = [];
  for (let page = 1; page <= 100; page++) {
    const body = await apiGet(`/invoices?${query}&limit=${PAGE_SIZE}&page=${page}`, fetchFn);
    const invoices: any[] = body.Invoices || [];
    all.push(...invoices);
    if (invoices.length < PAGE_SIZE) break;
  }
  return all;
}

const toNumber = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isNaN(n) ? null : n;
};

export interface FortnoxSyncResult {
  at: string;
  invoices: number;
  unpaid: number;
  error: string | null;
}

export function lastFortnoxSync(): FortnoxSyncResult | null {
  const raw = getMeta("fortnox_last_sync");
  return raw ? (JSON.parse(raw) as FortnoxSyncResult) : null;
}

let running = false;

/** Unpaid invoices for the forecast, and the last five quarters' invoices with VAT for the VAT report. */
export async function syncFortnoxInvoices(fetchFn: FetchFn = fetch, opts: { pauseMs?: number } = {}): Promise<FortnoxSyncResult> {
  const result: FortnoxSyncResult = { at: new Date().toISOString(), invoices: 0, unpaid: 0, error: null };
  if (running) return { ...result, error: "En hämtning från Fortnox pågår redan." };
  running = true;
  try {
    const now = new Date();
    const since = new Date(Date.UTC(now.getUTCFullYear() - 1, Math.floor(now.getUTCMonth() / 3) * 3 - 3, 1)).toISOString().slice(0, 10);
    const unpaid = await listInvoices("filter=unpaid", fetchFn);
    const recent = await listInvoices(`fromdate=${since}`, fetchFn);
    const syncedAt = new Date().toISOString();
    const byNumber = new Map<string, any>();
    for (const inv of [...recent, ...unpaid]) byNumber.set(String(inv.DocumentNumber), inv);
    for (const [number, inv] of byNumber) {
      const rate = toNumber(inv.CurrencyRate);
      const unit = toNumber(inv.CurrencyUnit);
      upsertCustomerInvoice({
        document_number: number,
        customer_name: inv.CustomerName || null,
        invoice_date: inv.InvoiceDate || null,
        due_date: inv.DueDate || null,
        final_pay_date: inv.FinalPayDate || null,
        total: toNumber(inv.Total),
        balance: toNumber(inv.Balance),
        currency: inv.Currency || "SEK",
        sek_rate: rate && unit ? rate / unit : 1,
        cancelled: inv.Cancelled ? 1 : 0,
        synced_at: syncedAt,
      });
    }
    markOthersPaid(unpaid.map((inv) => String(inv.DocumentNumber)));

    // VAT is only on the single invoice. Fortnox allows 25 requests per 5 seconds.
    for (const number of customerInvoicesWithoutVat()) {
      const body = await apiGet(`/invoices/${encodeURIComponent(number)}`, fetchFn);
      const vat = toNumber(body.Invoice?.TotalVAT);
      if (vat != null) setCustomerInvoiceVat(number, vat);
      await wait(opts.pauseMs ?? 220);
    }
    result.invoices = byNumber.size;
    result.unpaid = unpaid.length;
  } catch (err: any) {
    result.error = err?.message || String(err);
    console.error("[Fortnox] Sync failed:", result.error);
  } finally {
    running = false;
  }
  setMeta("fortnox_last_sync", JSON.stringify(result));
  return result;
}
