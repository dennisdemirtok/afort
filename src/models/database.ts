import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { env } from "../config/env";

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

    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
    CREATE INDEX IF NOT EXISTS idx_invoices_gmail_id ON invoices(gmail_message_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_vendor ON invoices(vendor_name);
  `);
}
