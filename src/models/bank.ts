import crypto from "crypto";
import { getDb } from "./database";

/**
 * The Nordea statements as uploaded: every booked transaction, and the balance at the end of
 * each day. Statements overlap, so the same row may arrive many times.
 */

export interface BankRow {
  date: string;
  amount: number;
  currency: string;
  name: string;
  message: string;
  // Nordea's "Saldo": the balance after this row. Only some rows have one.
  balance: number | null;
}

const isBooked = (row: BankRow) => /^\d{4}-\d{2}-\d{2}$/.test(row.date);
const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Balance at the end of each day in one statement. Nordea lists the newest row first and prints
 * the balance on only some rows, so rows above the one with a balance are added to it.
 */
export function dailyClosings(rows: BankRow[]): Map<string, number> {
  const booked = rows.filter(isBooked);
  const newestFirst = booked.length < 2 || booked[0].date >= booked[booked.length - 1].date ? booked : [...booked].reverse();
  const closings = new Map<string, number>();
  const above = new Map<string, number>();
  for (const row of newestFirst) {
    if (closings.has(row.date)) continue;
    if (row.balance != null) closings.set(row.date, round(row.balance + (above.get(row.date) || 0)));
    else above.set(row.date, (above.get(row.date) || 0) + row.amount);
  }
  return closings;
}

/** "PLUSGIROKONTO FTG 3 72 16-9 - 2026-11-10 13.20.14.csv" → the account and when it was exported. */
export function statementOrigin(filename: string, now: Date = new Date()): { account: string; exportedAt: string } {
  const m = filename.match(/^(.+?)\s+-\s+(\d{4}-\d{2}-\d{2})\s+(\d{2})\.(\d{2})\.(\d{2})/);
  if (m) return { account: m[1].trim(), exportedAt: `${m[2]} ${m[3]}:${m[4]}:${m[5]}` };
  return { account: "Bankkonto", exportedAt: now.toISOString().slice(0, 19).replace("T", " ") };
}

/** Stores a statement. Rows already seen are skipped; for a day's balance the latest export wins. */
export function saveBankStatement(rows: BankRow[], filename: string): { added: number; total: number } {
  const db = getDb();
  const { account, exportedAt } = statementOrigin(filename);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO bank_transactions (id, account, date, amount, currency, name, message) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const saveBalance = db.prepare(
    `INSERT INTO bank_balances (account, date, balance, exported_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(account, date) DO UPDATE SET balance = excluded.balance, exported_at = excluded.exported_at
     WHERE excluded.exported_at >= bank_balances.exported_at`
  );
  const booked = rows.filter(isBooked);
  let added = 0;
  db.transaction(() => {
    // Two identical card purchases on one day are two rows: the running count keeps them apart.
    // The balance is left out of the key since Nordea prints it on different rows in later exports.
    const seen = new Map<string, number>();
    for (const row of booked) {
      const key = [account, row.date, row.amount.toFixed(2), row.name, row.message].join("|");
      const occurrence = seen.get(key) || 0;
      seen.set(key, occurrence + 1);
      const id = crypto.createHash("sha1").update(`${key}|${occurrence}`).digest("hex");
      added += insert.run(id, account, row.date, row.amount, row.currency, row.name, row.message).changes;
    }
    for (const [date, balance] of dailyClosings(booked)) saveBalance.run(account, date, balance, exportedAt);
  })();
  return { added, total: booked.length };
}

export function bankRowsSince(from: string): BankRow[] {
  return (getDb().prepare(
    "SELECT date, amount, currency, name, message FROM bank_transactions WHERE date >= ? ORDER BY date DESC"
  ).all(from) as Omit<BankRow, "balance">[]).map((r) => ({ ...r, balance: null }));
}

export function bankDataRange(): { from: string; to: string } | null {
  const row = getDb().prepare("SELECT MIN(date) AS first, MAX(date) AS last FROM bank_transactions").get() as { first: string | null; last: string | null };
  return row.first && row.last ? { from: row.first, to: row.last } : null;
}

export interface AccountBalance {
  account: string;
  date: string;
  balance: number;
}

/** The newest known balance of every account. */
export function latestBalances(): AccountBalance[] {
  return getDb().prepare(
    `SELECT b.account, b.date, b.balance FROM bank_balances b
     JOIN (SELECT account, MAX(date) AS date FROM bank_balances GROUP BY account) newest
       ON newest.account = b.account AND newest.date = b.date`
  ).all() as AccountBalance[];
}

/** The total balance day by day; a day without transactions keeps the previous day's balance. */
export function balanceHistory(from: string, to: string): { date: string; balance: number }[] {
  const rows = getDb().prepare("SELECT account, date, balance FROM bank_balances ORDER BY date").all() as AccountBalance[];
  const current = new Map<string, number>();
  const history: { date: string; balance: number }[] = [];
  let next = 0;
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400000) {
    const date = new Date(t).toISOString().slice(0, 10);
    while (next < rows.length && rows[next].date <= date) {
      current.set(rows[next].account, rows[next].balance);
      next++;
    }
    if (current.size) history.push({ date, balance: round([...current.values()].reduce((sum, b) => sum + b, 0)) });
  }
  return history;
}
