import fs from "fs";
import path from "path";
import { Invoice, InvoiceFilters, STATUSES, isOverdue } from "../models/invoice";

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function filtersFromQuery(q: Record<string, unknown>): InvoiceFilters {
  const status = str(q.status);
  return {
    status: status && (STATUSES as readonly string[]).includes(status) ? status : undefined,
    vendor: str(q.vendor),
    q: str(q.q),
    overdue: q.overdue === "1",
    duplicates: q.duplicates === "1",
    date_from: str(q.date_from),
    date_to: str(q.date_to),
  };
}

/** Query string for the current filters, with overrides. Used by tabs, pagination and export links. */
export function filterQuery(filters: InvoiceFilters, overrides: Record<string, string | number | undefined> = {}): string {
  const params: Record<string, string | number | undefined> = {
    status: filters.status,
    vendor: filters.vendor,
    q: filters.q,
    overdue: filters.overdue ? "1" : undefined,
    duplicates: filters.duplicates ? "1" : undefined,
    ...overrides,
  };
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return qs ? `?${qs}` : "";
}

const STATUS_LABELS: Record<string, string> = {
  new: "Ny",
  approved: "Godkänd",
  exported: "Exporterad",
  paid: "Betald",
};

/** Semicolon separated with BOM and decimal comma – opens correctly in Swedish Excel. */
export function invoicesToCsv(invoices: Invoice[]): string {
  const columns: [string, (inv: Invoice) => string | number | null][] = [
    ["Leverantör", (i) => i.vendor_name],
    ["Fakturanummer", (i) => i.invoice_number],
    ["Belopp", (i) => (i.amount != null ? i.amount.toFixed(2).replace(".", ",") : "")],
    ["Valuta", (i) => i.currency],
    ["Mottagen", (i) => (i.received_at || "").slice(0, 10)],
    ["Förfallodatum", (i) => i.due_date],
    ["Status", (i) => STATUS_LABELS[i.status] || i.status],
    ["Betald", (i) => i.paid_at],
    ["OCR", (i) => i.ocr],
    ["Bankgiro", (i) => i.bankgiro],
    ["Plusgiro", (i) => i.plusgiro],
    ["IBAN", (i) => i.iban],
    ["Ämne", (i) => i.subject],
  ];
  const escape = (value: string | number | null) => {
    const s = value == null ? "" : String(value);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map(([name]) => name).join(";")];
  for (const inv of invoices) lines.push(columns.map(([, get]) => escape(get(inv))).join(";"));
  return "﻿" + lines.join("\r\n");
}

// ---- View helpers (available in every template as `h`) ----

export const viewHelpers = {
  statusLabel: (status: string) => STATUS_LABELS[status] || status,

  money(amount: number | null | undefined, currency?: string | null): string {
    if (amount == null) return "–";
    const formatted = amount.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return currency ? `${formatted} ${currency}` : formatted;
  },

  /** ISO timestamp or date → YYYY-MM-DD in Swedish time */
  date(value: string | null | undefined): string {
    if (!value) return "–";
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const d = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z");
    return isNaN(d.getTime()) ? value.slice(0, 10) : d.toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
  },

  initials(name: string | null | undefined): string {
    const words = (name || "?").replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return "?";
    return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
  },

  isOverdue,

  daysOverdue(dueDate: string): number {
    return Math.floor((Date.now() - new Date(dueDate + "T00:00:00").getTime()) / 86400000);
  },

  filterQuery,

  roleLabel: (role: string) => (role === "admin" ? "Administratör" : "Bokförare"),
};

/**
 * Google Fonts URL for Material Symbols limited to the icons the templates
 * actually use (a few kB instead of several MB). Found by scanning the views
 * for <span class="icon ...">name</span>, so it cannot drift out of sync.
 */
export function buildIconFontUrl(viewsDir: string): string {
  const names = new Set<string>();
  const scan = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(full);
      else if (entry.name.endsWith(".ejs")) {
        const source = fs.readFileSync(full, "utf-8");
        for (const m of source.matchAll(/class="icon[^"]*">\s*([a-z0-9_]+)\s*</g)) names.add(m[1]);
        // Icon names chosen in template code: icon: 'name' / ? 'a' : 'b'
        for (const m of source.matchAll(/icon:\s*['"]([a-z0-9_]+)['"]/g)) names.add(m[1]);
        for (const m of source.matchAll(/class="icon[^"]*"><%=[^%]*?'([a-z0-9_]+)'\s*:\s*'([a-z0-9_]+)'/g)) { names.add(m[1]); names.add(m[2]); }
      }
    }
  };
  scan(viewsDir);
  const base = "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0&display=block";
  return names.size ? `${base}&icon_names=${[...names].sort().join(",")}` : base;
}
