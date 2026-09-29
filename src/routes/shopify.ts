import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { listPayouts, getPayout, setPayoutStatus, payoutStats } from "../models/shopify";
import { isShopifyConfigured, syncShopifyPayouts, getShopifySyncStatus, missingShopifySettings } from "../services/shopify";
import { env } from "../config/env";

const router = Router();

function flash(pathname: string, kind: "ok" | "err", message: string): string {
  return `${pathname}?${kind}=${encodeURIComponent(message)}`;
}

router.get("/shopify", (req: Request, res: Response) => {
  res.render("shopify", {
    payouts: listPayouts(),
    stats: payoutStats(),
    configured: isShopifyConfigured(),
    missing: missingShopifySettings(),
    storeDomain: env.shopifyStoreDomain,
    syncStatus: getShopifySyncStatus(),
    ok: req.query.ok || null,
    err: req.query.err || null,
  });
});

router.post("/shopify/sync", async (_req: Request, res: Response) => {
  const result = await syncShopifyPayouts();
  if (result.busy) return res.redirect(flash("/shopify", "err", "En hämtning pågår redan."));
  if (result.error) return res.redirect(flash("/shopify", "err", result.error));
  res.redirect(flash("/shopify", "ok", result.created ? `${result.created} nya utbetalningar hämtade.` : `Klart – ${result.payouts} utbetalningar är uppdaterade, inga nya.`));
});

router.get("/shopify/:id/report", (req: Request, res: Response) => {
  const payout = getPayout(req.params.id);
  if (!payout?.report_path || !fs.existsSync(payout.report_path)) return res.status(404).send("Rapporten finns inte");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${path.basename(payout.report_path)}"`);
  fs.createReadStream(payout.report_path).pipe(res);
});

router.post("/shopify/:id/status", (req: Request, res: Response) => {
  const status = req.body.status === "booked" ? "booked" : req.body.status === "received" ? "received" : "new";
  if (!setPayoutStatus(req.params.id, status)) return res.redirect(flash("/shopify", "err", "Utbetalningen finns inte."));
  res.redirect(flash("/shopify", "ok", status === "booked" ? "Utbetalningen är markerad som bokförd." : status === "received" ? "Utbetalningen är markerad som inbetald." : "Utbetalningen är återställd."));
});

export default router;
