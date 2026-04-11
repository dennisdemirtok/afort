import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { listInvoices, getInvoiceById, updateInvoice, getInvoicesByIds } from "../models/invoice";
import { listPaymentFiles, getPaymentFileById } from "../models/payment-file";
import { generatePain001 } from "../services/pain001";
import { pollGmail } from "../services/gmail";

const router = Router();

// List invoices
router.get("/invoices", (req: Request, res: Response) => {
  const q = req.query;
  const filters = {
    status: String(q.status || "") || undefined,
    vendor: String(q.vendor || "") || undefined,
    date_from: String(q.date_from || "") || undefined,
    date_to: String(q.date_to || "") || undefined,
  };
  res.json(listInvoices(filters));
});

// Get single invoice
router.get("/invoices/:id", (req: Request, res: Response) => {
  const invoice = getInvoiceById(req.params.id);
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });
  res.json(invoice);
});

// Update invoice
router.patch("/invoices/:id", (req: Request, res: Response) => {
  const invoice = updateInvoice(req.params.id, req.body);
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });
  res.json(invoice);
});

// Download PDF
router.get("/invoices/:id/pdf", (req: Request, res: Response) => {
  const invoice = getInvoiceById(req.params.id);
  if (!invoice || !invoice.pdf_path) return res.status(404).json({ error: "PDF not found" });
  if (!fs.existsSync(invoice.pdf_path)) return res.status(404).json({ error: "PDF file missing" });
  res.download(invoice.pdf_path);
});

// Create payment file
router.post("/payment-files", (req: Request, res: Response) => {
  const { invoice_ids, execution_date } = req.body;
  if (!invoice_ids || !Array.isArray(invoice_ids) || invoice_ids.length === 0) {
    return res.status(400).json({ error: "invoice_ids required" });
  }

  const execDate = execution_date || new Date().toISOString().split("T")[0];
  const invoices = getInvoicesByIds(invoice_ids);

  if (invoices.length === 0) return res.status(400).json({ error: "No valid invoices found" });

  const result = generatePain001(invoices, execDate);

  // Update invoice statuses
  for (const inv of invoices) {
    updateInvoice(inv.id, { status: "exported", payment_file_id: result.paymentFile.id });
  }

  res.json(result.paymentFile);
});

// List payment files
router.get("/payment-files", (_req: Request, res: Response) => {
  res.json(listPaymentFiles());
});

// Download payment file
router.get("/payment-files/:id/download", (req: Request, res: Response) => {
  const pf = getPaymentFileById(req.params.id);
  if (!pf || !fs.existsSync(pf.file_path)) return res.status(404).json({ error: "File not found" });
  res.download(pf.file_path, pf.filename);
});

// CSV export for Fortnox
router.get("/export/csv", (req: Request, res: Response) => {
  const q = req.query;
  const filters = {
    status: String(q.status || "") || undefined,
    vendor: String(q.vendor || "") || undefined,
    date_from: String(q.date_from || "") || undefined,
    date_to: String(q.date_to || "") || undefined,
  };
  const invoices = listInvoices(filters);

  const headers = [
    "id", "vendor_name", "invoice_number", "amount", "currency",
    "due_date", "ocr", "bankgiro", "plusgiro", "iban", "status", "received_at",
  ];
  const rows = invoices.map((inv) =>
    headers.map((h) => {
      const val = (inv as any)[h];
      if (val === null || val === undefined) return "";
      const str = String(val);
      return str.includes(",") || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
    }).join(",")
  );

  const csv = [headers.join(","), ...rows].join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=invoices_export.csv");
  res.send(csv);
});

// Re-process all invoices (clears DB, re-polls)
router.post("/reprocess", async (_req: Request, res: Response) => {
  try {
    const { getDb } = require("../models/database");
    const db = getDb();
    db.prepare("DELETE FROM invoices").run();
    const count = await pollGmail(true);
    res.json({ success: true, cleared: true, processed: count });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger Gmail poll manually
router.post("/trigger-poll", async (_req: Request, res: Response) => {
  try {
    const count = await pollGmail();
    res.json({ success: true, processed: count });
  } catch (err: any) {
    console.error("[Poll Error]", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
