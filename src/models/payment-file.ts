import { getDb } from "./database";
import { v4 as uuidv4 } from "uuid";

export interface PaymentFile {
  id: string;
  filename: string;
  file_path: string;
  num_transactions: number;
  total_amount: number;
  currency: string;
  execution_date: string;
  created_at: string;
}

export function createPaymentFile(data: Omit<PaymentFile, "id" | "created_at">): PaymentFile {
  const db = getDb();
  const id = uuidv4();

  db.prepare(`
    INSERT INTO payment_files (id, filename, file_path, num_transactions, total_amount, currency, execution_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, data.filename, data.file_path, data.num_transactions, data.total_amount, data.currency, data.execution_date);

  return db.prepare("SELECT * FROM payment_files WHERE id = ?").get(id) as PaymentFile;
}

export function listPaymentFiles(): PaymentFile[] {
  const db = getDb();
  return db.prepare("SELECT * FROM payment_files ORDER BY created_at DESC").all() as PaymentFile[];
}

export function getPaymentFileById(id: string): PaymentFile | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM payment_files WHERE id = ?").get(id) as PaymentFile | undefined;
}
