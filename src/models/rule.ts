import { getDb } from "./database";
import { v4 as uuidv4 } from "uuid";

export interface VendorRule {
  id: string;
  from_address: string;
  subject_contains: string | null;
  vendor_name: string | null;
  created_at: string;
}

export function listRules(): VendorRule[] {
  return getDb().prepare("SELECT * FROM vendor_rules ORDER BY vendor_name IS NULL, vendor_name, from_address").all() as VendorRule[];
}

export function createRule(fromAddress: string, subjectContains?: string, vendorName?: string): VendorRule {
  const db = getDb();
  const id = uuidv4();
  db.prepare("INSERT INTO vendor_rules (id, from_address, subject_contains, vendor_name) VALUES (?, ?, ?, ?)").run(
    id,
    fromAddress.trim().toLowerCase(),
    subjectContains?.trim() || null,
    vendorName?.trim() || null
  );
  return db.prepare("SELECT * FROM vendor_rules WHERE id = ?").get(id) as VendorRule;
}

export function ruleExists(fromAddress: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM vendor_rules WHERE from_address = ?").get(fromAddress.trim().toLowerCase());
}

export function deleteRule(id: string): void {
  getDb().prepare("DELETE FROM vendor_rules WHERE id = ?").run(id);
}
