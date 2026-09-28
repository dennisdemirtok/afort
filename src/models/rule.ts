import { getDb } from "./database";
import { v4 as uuidv4 } from "uuid";

/** "invoice": mail becomes an invoice to pay. "receipt": mail is a receipt for a card payment. */
export type RuleKind = "invoice" | "receipt";

export interface VendorRule {
  id: string;
  from_address: string;
  subject_contains: string | null;
  vendor_name: string | null;
  kind: RuleKind;
  created_at: string;
}

export function listRules(kind: RuleKind = "invoice"): VendorRule[] {
  return getDb()
    .prepare("SELECT * FROM vendor_rules WHERE COALESCE(kind, 'invoice') = ? ORDER BY vendor_name IS NULL, vendor_name, from_address")
    .all(kind) as VendorRule[];
}

export function createRule(fromAddress: string, subjectContains?: string, vendorName?: string, kind: RuleKind = "invoice"): VendorRule {
  const db = getDb();
  const id = uuidv4();
  db.prepare("INSERT INTO vendor_rules (id, from_address, subject_contains, vendor_name, kind) VALUES (?, ?, ?, ?, ?)").run(
    id,
    fromAddress.trim().toLowerCase(),
    subjectContains?.trim() || null,
    vendorName?.trim() || null,
    kind
  );
  return db.prepare("SELECT * FROM vendor_rules WHERE id = ?").get(id) as VendorRule;
}

export function ruleExists(fromAddress: string, kind: RuleKind = "invoice"): boolean {
  return !!getDb()
    .prepare("SELECT 1 FROM vendor_rules WHERE from_address = ? AND COALESCE(kind, 'invoice') = ?")
    .get(fromAddress.trim().toLowerCase(), kind);
}

export function deleteRule(id: string): void {
  getDb().prepare("DELETE FROM vendor_rules WHERE id = ?").run(id);
}
