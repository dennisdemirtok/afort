import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { env } from "../config/env";
import defaultRules from "../config/gmail-rules.json";

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dir = path.dirname(env.databasePath);
    fs.mkdirSync(dir, { recursive: true });
    db = new Database(env.databasePath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initSchema();
  }
  return db;
}

function addColumnIfMissing(table: string, column: string, definition: string) {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      gmail_message_id TEXT UNIQUE,
      sender TEXT,
      subject TEXT,
      received_at TEXT,
      processed_at TEXT,
      vendor_name TEXT,
      invoice_number TEXT,
      amount REAL,
      currency TEXT DEFAULT 'SEK',
      due_date TEXT,
      ocr TEXT,
      bankgiro TEXT,
      plusgiro TEXT,
      iban TEXT,
      pdf_path TEXT,
      status TEXT DEFAULT 'new',
      payment_file_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (payment_file_id) REFERENCES payment_files(id)
    );

    CREATE TABLE IF NOT EXISTS payment_files (
      id TEXT PRIMARY KEY,
      filename TEXT,
      file_path TEXT,
      num_transactions INTEGER,
      total_amount REAL,
      currency TEXT DEFAULT 'SEK',
      execution_date TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      token TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      role TEXT DEFAULT 'viewer',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT,
      link TEXT,
      read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Sender rules live in the database (on the persistent volume) so that
    -- changes made in Settings survive deploys and take effect on the next poll.
    CREATE TABLE IF NOT EXISTS vendor_rules (
      id TEXT PRIMARY KEY,
      from_address TEXT NOT NULL,
      subject_contains TEXT,
      vendor_name TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Gmail messages the user has deleted. They are never imported again,
    -- not even when all mail is re-read.
    CREATE TABLE IF NOT EXISTS deleted_messages (
      gmail_message_id TEXT PRIMARY KEY,
      deleted_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
    CREATE INDEX IF NOT EXISTS idx_invoices_gmail_id ON invoices(gmail_message_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_vendor ON invoices(vendor_name);
    CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
  `);

  // Migrations for databases created by earlier versions
  addColumnIfMissing("users", "password_hash", "TEXT");
  addColumnIfMissing("invoices", "paid_at", "TEXT");
  addColumnIfMissing("invoices", "manually_edited", "INTEGER DEFAULT 0");

  seedVendorRules();
}

// Vendor display names for the senders that shipped with the first versions
const DEFAULT_VENDOR_NAMES: Record<string, string> = {
  "bws.dk": "Blue Water Shipping",
  "fancywork.pl": "Fancywork DTF",
  "dtftransfer.com": "DTFtransfer.com",
  "poczta.wfirma.pl": "Feelgood SP",
  "feelgood.pl": "Feelgood SP",
  "fortnox.se": "Aflasta AB",
  "sitodrukowy.pl": "Helios Advertising",
};

function seedVendorRules() {
  const count = (db.prepare("SELECT COUNT(*) AS n FROM vendor_rules").get() as { n: number }).n;
  if (count > 0) return;

  const insert = db.prepare(
    "INSERT INTO vendor_rules (id, from_address, subject_contains, vendor_name) VALUES (?, ?, ?, ?)"
  );
  for (const rule of defaultRules.rules as { from: string; subject_contains?: string }[]) {
    const domain = rule.from.split("@")[1]?.toLowerCase() || "";
    insert.run(uuidv4(), rule.from.toLowerCase(), rule.subject_contains || null, DEFAULT_VENDOR_NAMES[domain] || null);
  }
}
