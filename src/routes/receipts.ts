import { Router, Request, Response, NextFunction } from "express";
import archiver from "archiver";
import multer from "multer";
import fs from "fs";
import path from "path";
import {
  listReceipts,
  getReceiptById,
  getReceiptsByIds,
  updateReceipt,
  setReceiptStatusBulk,
  deleteReceipts,
  listReceiptSources,
  listReceiptMonths,
  receiptCounts,
  ReceiptFilters,
  Receipt,
} from "../models/receipt";
import { listRules } from "../models/rule";
import { requireAdmin, currentUser } from "../middleware/auth";
import { attachReceiptPdf, importReceiptPdf, ImportedDocument } from "../services/receipt-documents";

const router = Router();
export const pdfUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function flash(pathname: string, kind: "ok" | "err", message: string): string {
  return `${pathname}${pathname.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(message)}`;
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return typeof value === "string" && value ? [value] : [];
}

export function receiptFiltersFromQuery(q: Record<string, unknown>): ReceiptFilters {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const status = str(q.status);
  const month = str(q.month);
  return {
    source: str(q.source),
    status: status === "new" || status === "booked" ? status : undefined,
    month: month && /^\d{4}-\d{2}$/.test(month) ? month : undefined,
    q: str(q.q),
  };
}

export function receiptQuery(filters: ReceiptFilters, overrides: Record<string, string | undefined> = {}): string {
  const params: Record<string, string | undefined> = { status: filters.status, source: filters.source, month: filters.month, q: filters.q, ...overrides };
  const qs = Object.entries(params)
    .filter(([, v]) => v)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return qs ? `?${qs}` : "";
}

/** Semicolon separated with BOM and decimal comma – opens correctly in Swedish Excel. */
export function receiptsToCsv(receipts: Receipt[]): string {
  const esc = (v: string | number | null | undefined) => {
    const s = v == null ? "" : String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ["Datum;Källa;Referens;Belopp;Valuta;Status;Bokförd;Ämne;Anteckning"];
  for (const r of receipts) {
    lines.push([
      (r.received_at || "").slice(0, 10), r.source, r.reference,
      r.amount != null ? r.amount.toFixed(2).replace(".", ",") : "", r.currency,
      r.status === "booked" ? "Bokförd" : "Ny", r.booked_at, r.subject, r.note,
    ].map(esc).join(";"));
  }
  return "﻿" + lines.join("\r\n");
}

function safeFilename(r: Receipt): string {
  const base = [r.source, r.reference || (r.received_at || "").slice(0, 10)].filter(Boolean).join("_").replace(/[^\p{L}\p{N}._-]+/gu, "_");
  return `${base}.${r.file_kind === "html" ? "html" : "pdf"}`;
}

router.get("/receipts", (req: Request, res: Response) => {
  const filters = receiptFiltersFromQuery(req.query as Record<string, unknown>);
  res.render("receipts", {
    receipts: listReceipts(filters),
    filters,
    sources: listReceiptSources(),
    months: listReceiptMonths(),
    counts: receiptCounts(),
    ruleCount: listRules("receipt").length,
    query: receiptQuery,
    ok: req.query.ok || null,
    err: req.query.err || null,
  });
});

router.get("/receipts/export.csv", (req: Request, res: Response) => {
  const filters = receiptFiltersFromQuery(req.query as Record<string, unknown>);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="kvitton${filters.month ? "-" + filters.month : ""}.csv"`);
  res.send(receiptsToCsv(listReceipts(filters, 5000)));
});

router.post("/receipts/download-zip", (req: Request, res: Response) => {
  const receipts = getReceiptsByIds(asArray(req.body.ids)).filter((r) => r.file_path && fs.existsSync(r.file_path));
  if (receipts.length === 0) return res.redirect(flash("/receipts", "err", "Inga kvitton med sparad fil var markerade."));
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="kvitton-${new Date().toISOString().slice(0, 10)}.zip"`);
  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("error", (err) => { console.error("[Receipts] ZIP failed:", err); res.end(); });
  archive.pipe(res);
  const used = new Set<string>();
  for (const r of receipts) {
    let name = safeFilename(r);
    if (used.has(name)) name = name.replace(/(\.\w+)$/, `_${r.id.slice(0, 6)}$1`);
    used.add(name);
    archive.file(r.file_path!, { name });
  }
  archive.finalize();
});

router.post("/receipts/bulk", (req: Request, res: Response) => {
  const ids = asArray(req.body.ids);
  const action = String(req.body.action || "");
  if (ids.length === 0) return res.status(400).json({ error: "ids required" });
  if (action === "delete") {
    return requireAdmin(req, res, () => res.json({ success: true, deleted: deleteReceipts(ids) }));
  }
  if (action === "booked" || action === "new") return res.json({ success: true, updated: setReceiptStatusBulk(ids, action) });
  res.status(400).json({ error: "Invalid action" });
});

/** PDFs downloaded from a vendor portal (Meta, Google Ads …) become receipts of their own. */
router.post(
  "/receipts/upload",
  (req: Request, res: Response, next: NextFunction) =>
    pdfUpload.array("pdfs", 50)(req, res, (err: unknown) => {
      if (err) return res.redirect(flash("/receipts", "err", "En fil är för stor (max 15 MB) eller så valdes för många (max 50)."));
      next();
    }),
  async (req: Request, res: Response) => {
    const source = String(req.body.source || "").trim().slice(0, 60);
    const files = (req.files as Express.Multer.File[] | undefined) || [];
    if (!source) return res.redirect(flash("/receipts", "err", "Ange källa, t.ex. Meta Ads."));
    if (files.length === 0) return res.redirect(flash("/receipts", "err", "Välj en eller flera PDF:er."));

    const counts: Record<ImportedDocument["status"], number> = { created: 0, attached: 0, exists: 0, deleted: 0 };
    const failed: string[] = [];
    for (const file of files) {
      try {
        counts[(await importReceiptPdf({ source, data: file.buffer, filename: file.originalname })).status]++;
      } catch {
        failed.push(file.originalname);
      }
    }
    const parts = [
      counts.created && `${counts.created} kvitton skapade`,
      counts.attached && `${counts.attached} kopplade till befintliga kvitton`,
      counts.exists && `${counts.exists} fanns redan`,
      counts.deleted && `${counts.deleted} har raderats tidigare och hoppades över`,
    ].filter(Boolean);
    const target = `/receipts${receiptQuery({ source })}`;
    if (failed.length) return res.redirect(flash(target, "err", `${[...parts, `${failed.length} var inga läsbara PDF:er (${failed.join(", ")})`].join(", ")}.`));
    res.redirect(flash(target, "ok", `${parts.join(", ")}.`));
  }
);

router.get("/receipts/:id", (req: Request, res: Response) => {
  const receipt = getReceiptById(req.params.id);
  if (!receipt) return res.status(404).render("error", { title: "Kvittot finns inte", message: "Kvittot kan ha raderats." });
  res.render("receipt-detail", {
    receipt,
    hasFile: !!(receipt.file_path && fs.existsSync(receipt.file_path)),
    isAdmin: currentUser(res)?.role === "admin",
    ok: req.query.ok || null,
    err: req.query.err || null,
  });
});

router.post("/receipts/:id", (req: Request, res: Response) => {
  const receipt = getReceiptById(req.params.id);
  if (!receipt) return res.status(404).render("error", { title: "Kvittot finns inte", message: "Kvittot kan ha raderats." });
  const amountRaw = String(req.body.amount || "").replace(/\s/g, "").replace(",", ".");
  const amount = amountRaw === "" ? null : parseFloat(amountRaw);
  if (amountRaw !== "" && isNaN(amount as number)) return res.redirect(flash(`/receipts/${receipt.id}`, "err", "Beloppet måste vara ett tal, t.ex. 1234,50."));
  updateReceipt(receipt.id, {
    source: String(req.body.source || "").trim() || receipt.source,
    amount,
    currency: String(req.body.currency || "").trim().toUpperCase() || null,
    reference: String(req.body.reference || "").trim() || null,
    note: String(req.body.note || "").trim() || null,
    manually_edited: 1,
  });
  res.redirect(flash(`/receipts/${receipt.id}`, "ok", "Kvittot är sparat."));
});

router.post("/receipts/:id/status", (req: Request, res: Response) => {
  const status = req.body.status === "booked" ? "booked" : "new";
  if (!updateReceipt(req.params.id, { status })) return res.status(404).render("error", { title: "Kvittot finns inte", message: "" });
  res.redirect(flash(`/receipts/${req.params.id}`, "ok", status === "booked" ? "Kvittot är markerat som bokfört." : "Kvittot är återställt till nytt."));
});

/** The real document for a receipt whose mail only linked to it (Google Ads), or a PDF replacing the mail. */
router.post(
  "/receipts/:id/document",
  (req: Request, res: Response, next: NextFunction) =>
    pdfUpload.single("pdf")(req, res, (err: unknown) => {
      if (err) return res.redirect(flash(`/receipts/${req.params.id}`, "err", "Filen är för stor (max 15 MB)."));
      next();
    }),
  async (req: Request, res: Response) => {
    const receipt = getReceiptById(req.params.id);
    if (!receipt) return res.status(404).render("error", { title: "Kvittot finns inte", message: "Kvittot kan ha raderats." });
    if (!req.file) return res.redirect(flash(`/receipts/${receipt.id}`, "err", "Välj en PDF först."));
    try {
      const updated = await attachReceiptPdf(receipt, req.file.buffer, req.file.originalname);
      const amount = updated.amount != null && updated.amount !== receipt.amount ? ` Beloppet ${updated.amount.toFixed(2).replace(".", ",")} ${updated.currency || ""} lästes ur PDF:en.` : "";
      res.redirect(flash(`/receipts/${receipt.id}`, "ok", `PDF:en är sparad.${amount}`.trim()));
    } catch (err: any) {
      res.redirect(flash(`/receipts/${receipt.id}`, "err", err?.message || "PDF:en kunde inte sparas."));
    }
  }
);

router.post("/receipts/:id/delete", requireAdmin, (req: Request, res: Response) => {
  deleteReceipts([req.params.id]);
  res.redirect(flash("/receipts", "ok", "Kvittot är raderat och hämtas inte in igen."));
});

/** The document itself: PDF inline, HTML in a sandbox (no scripts, no forms). */
router.get("/receipts/:id/file", (req: Request, res: Response) => {
  const receipt = getReceiptById(req.params.id);
  if (!receipt?.file_path || !fs.existsSync(receipt.file_path)) return res.status(404).send("Filen finns inte");
  const download = req.query.download === "1";
  if (receipt.file_kind === "html") {
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; font-src *;");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (download) res.setHeader("Content-Disposition", `attachment; filename="${safeFilename(receipt)}"`);
    return fs.createReadStream(receipt.file_path).pipe(res);
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${safeFilename(receipt)}"`);
  fs.createReadStream(path.resolve(receipt.file_path)).pipe(res);
});

export default router;
