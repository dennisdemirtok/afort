import { Request, Response, NextFunction, CookieOptions } from "express";
import crypto from "crypto";
import { env } from "../config/env";
import { getUserByToken, getAdminUser, User } from "../models/user";

export const SESSION_COOKIE = "auth_token";

export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProduction,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Resolves a session/API token to a user. AUTH_TOKEN always maps to the admin. */
function resolveUser(token: string | undefined): User | undefined {
  if (!token) return undefined;
  if (safeEqual(token, env.authToken)) return getAdminUser();
  return getUserByToken(token);
}

export function currentUser(res: Response): User | undefined {
  return res.locals.user as User | undefined;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;

  let user = resolveUser(bearer) || resolveUser(req.cookies?.[SESSION_COOKIE]);

  // Legacy invite links (?token=...). Personal tokens only – the master
  // AUTH_TOKEN is never accepted in a URL, where it would end up in logs.
  if (!user && typeof req.query.token === "string") {
    const viaLink = getUserByToken(req.query.token);
    if (viaLink) {
      res.cookie(SESSION_COOKIE, viaLink.token, sessionCookieOptions());
      user = viaLink;
    }
  }

  if (user) {
    res.locals.user = user;
    return next();
  }

  if (req.originalUrl.startsWith("/api/")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  // Remember where the visitor was going – but never carry a token along in the URL
  const keepTarget = req.method === "GET" && req.originalUrl !== "/" && req.query.token === undefined;
  const target = keepTarget ? `?next=${encodeURIComponent(req.originalUrl)}` : "";
  res.redirect(`/login${target}`);
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (currentUser(res)?.role === "admin") return next();
  if (req.originalUrl.startsWith("/api/")) {
    return res.status(403).json({ error: "Kräver administratörsbehörighet" });
  }
  res.status(403).render("error", {
    title: "Ingen behörighet",
    message: "Den här sidan är bara tillgänglig för administratörer.",
  });
}
