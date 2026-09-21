import { Router, Request, Response } from "express";
import fs from "fs";
import {
  listInvoices,
  getInvoiceById,
  updateInvoice,
  getInvoicesByIds,
  deleteInvoices,
  setStatusBulk,
  STATUSES,
  InvoiceStatus,
} from "../models/invoice";
import { listPaymentFiles, getPaymentFileById } from "../models/payment-file";
import { getUnreadNotifications, getUnreadCount, markAllRead, markRead } from "../models/notification";
import { generatePain001, validateForPayment } from "../services/pain001";
import { pollGmail, getPollStatus } from "../services/gmail";
import { requireAdmin } from "../middleware/auth";
import { filtersFromQuery, invoicesToCsv } from "./shared";

const router = Router();

// ---- Invoices ----

router.get("/invoices", (req: Request, res: Response) => {
  res.json(listInvoices(filtersFromQuery(req.query)));
});

router.get("/invoices/:id", (req: Request, res: Response) => {
  const invoice = getInvoiceById(req.params.id);
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });
  res.json(invoice);
});

router.patch("/invoices/:id", (req: Request, res: Response) => {
  const allowed = ["vendor_name", "invoice_number", "amount", "currency", "due_date", "ocr", "bankgiro", "plusgiro", "iban", "status"];
  const patch: Record<string, any> = {};
  for (const key of allowed) if (key in req.body) patch[key] = req.body[key];
  if (patch.status && !STATUSES.includes(patch.status)) return res.status(400).json({ error: "Invalid status" });

  const invoice = updateInvoice(req.params.id, patch);
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });
  res.json(invoice);
});

router.delete("/invoices/:id", requireAdmin, (req: Request, res: Response) => {
  res.json({ success: true, deleted: deleteInvoices([req.params.id]) });
});

router.post("/invoices/bulk", (req: Request, res: Response) => {
  const { ids, action } = req.body;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string")) {
    return res.status(400).json({ error: "ids required" });
  }

  if (action === "delete") {
    return requireAdmin(req, res, () => res.json({ success: true, deleted: deleteInvoices(ids) }));
  }
  if (STATUSES.includes(action)) {
    return res.json({ success: true, updated: setStatusBulk(ids, action as InvoiceStatus), status: action });
  }
  res.status(400).json({ error: "Invalid action" });
});

router.get("/invoices/:id/pdf", (req: Request, res: Response) => {
  const invoice = getInvoiceById(req.params.id);
  if (!invoice?.pdf_path || !fs.existsSync(invoice.pdf_path)) return res.status(404).json({ error: "PDF not found" });
  res.download(invoice.pdf_path);
});

// ---- Payment files ----

router.post("/payment-files", (req: Request, res: Response) => {
  const { invoice_ids, execution_date } = req.body;
  if (!Array.isArray(invoice_ids) || invoice_ids.length === 0) {
    return res.status(400).json({ error: "invoice_ids required" });
  }
  const invoices = getInvoicesByIds(invoice_ids);
  const problems = validateForPayment(invoices);
  if (problems.length > 0) return res.status(400).json({ error: problems.join(" ") });

  const execDate = execution_date || new Date().toISOString().split("T")[0];
  const result = generatePain001(invoices, execDate);
  for (const inv of invoices) {
    updateInvoice(inv.id, { status: "exported", payment_file_id: result.paymentFile.id });
  }
  res.json(result.paymentFile);
});

router.get("/payment-files", (_req: Request, res: Response) => {
  res.json(listPaymentFiles());
});

router.get("/payment-files/:id/download", (req: Request, res: Response) => {
  const pf = getPaymentFileById(req.params.id);
  if (!pf || !fs.existsSync(pf.file_path)) return res.status(404).json({ error: "File not found" });
  res.download(pf.file_path, pf.filename);
});

// ---- Export ----

router.get("/export/csv", (req: Request, res: Response) => {
  const csv = invoicesToCsv(listInvoices(filtersFromQuery(req.query)));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=fakturor_${new Date().toISOString().slice(0, 10)}.csv`);
  res.send(csv);
});

// ---- Gmail ----

// Looks for new invoice mail right now (the same thing the 15 minute schedule does)
router.post("/trigger-poll", async (_req: Request, res: Response) => {
  const result = await pollGmail("new");
  if (result.busy) return res.status(409).json({ error: "En hämtning pågår redan", status: result });
  if (result.error && result.created === 0) return res.status(502).json({ error: result.error, status: result });
  res.json({ success: true, processed: result.created, status: result });
});

// Re-reads every mail from every sender in the background. Statuses, manual
// edits and deleted invoices are preserved. Progress: GET /api/reprocess.
router.post("/reprocess", requireAdmin, (_req: Request, res: Response) => {
  if (getPollStatus().running) return res.status(409).json({ error: "En hämtning pågår redan", status: getPollStatus() });
  pollGmail("all").catch((err) => console.error("[Reprocess]", err));
  res.status(202).json({ success: true, started: true });
});

router.get("/reprocess", (_req: Request, res: Response) => {
  res.json(getPollStatus());
});

// ---- Notifications ----

router.get("/notifications", (_req: Request, res: Response) => {
  res.json({ unread: getUnreadCount(), notifications: getUnreadNotifications() });
});

router.post("/notifications/read", (_req: Request, res: Response) => {
  markAllRead();
  res.json({ success: true });
});

router.post("/notifications/:id/read", (req: Request, res: Response) => {
  markRead(req.params.id);
  res.json({ success: true });
});

export default router;
