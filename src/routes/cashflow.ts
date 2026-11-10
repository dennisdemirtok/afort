import crypto from "crypto";
import { Router, Request, Response } from "express";
import { env } from "../config/env";
import { requireAdmin } from "../middleware/auth";
import { bankRowsSince } from "../models/bank";
import { today } from "../models/invoice";
import { addDays, cashflowOverview } from "../services/cashflow";
import {
  connectFortnox, fortnoxAuthUrl, fortnoxRedirectUri, isFortnoxConfigured, isFortnoxConnected, lastFortnoxSync, syncFortnoxInvoices,
} from "../services/fortnox";
import { matchBankRows, matchPayoutRows } from "./web";

const router = Router();

const STATE_COOKIE = "fortnox_oauth_state";

function flash(kind: "ok" | "err", message: string): string {
  return `/cashflow?${kind}=${encodeURIComponent(message)}`;
}

router.get("/cashflow", (req: Request, res: Response) => {
  // Payments already on the statement are in the balance, whether or not they have been ticked off
  const recent = bankRowsSince(addDays(today(), -90));
  const invoiceIds = new Set(matchBankRows(recent).matches.filter((m) => !m.alreadyPaid && !m.risky).map((m) => m.invoice.id));
  const payoutIds = new Set(matchPayoutRows(recent).map((m) => m.payout.id));
  res.render("cashflow", {
    overview: cashflowOverview({ invoiceIds, payoutIds }),
    fortnox: { configured: isFortnoxConfigured(), connected: isFortnoxConnected(), redirectUri: fortnoxRedirectUri(), last: lastFortnoxSync() },
    ok: req.query.ok || null,
    err: req.query.err || null,
  });
});

router.get("/fortnox/connect", requireAdmin, (_req: Request, res: Response) => {
  if (!isFortnoxConfigured()) return res.redirect(flash("err", "FORTNOX_CLIENT_ID och FORTNOX_CLIENT_SECRET saknas i Railway."));
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie(STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", secure: env.isProduction, maxAge: 10 * 60 * 1000 });
  res.redirect(fortnoxAuthUrl(state));
});

router.get("/auth/fortnox/callback", requireAdmin, async (req: Request, res: Response) => {
  const state = req.cookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE);
  if (!state || req.query.state !== state) return res.redirect(flash("err", "Kopplingen till Fortnox kunde inte verifieras. Försök igen."));
  if (typeof req.query.code !== "string") return res.redirect(flash("err", "Fortnox gav inget godkännande."));
  try {
    await connectFortnox(req.query.code);
  } catch (err: any) {
    return res.redirect(flash("err", err?.message || "Kopplingen till Fortnox misslyckades."));
  }
  const result = await syncFortnoxInvoices();
  if (result.error) return res.redirect(flash("err", `Fortnox är kopplat, men hämtningen misslyckades: ${result.error}`));
  res.redirect(flash("ok", `Fortnox är kopplat. ${result.invoices} kundfakturor hämtade, ${result.unpaid} obetalda.`));
});

router.post("/fortnox/sync", async (_req: Request, res: Response) => {
  const result = await syncFortnoxInvoices();
  if (result.error) return res.redirect(flash("err", result.error));
  res.redirect(flash("ok", `${result.invoices} kundfakturor hämtade från Fortnox, ${result.unpaid} obetalda.`));
});

export default router;
