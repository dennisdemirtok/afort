import { Request, Response, NextFunction } from "express";
import { env } from "../config/env";
import { getUserByToken } from "../models/user";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Check bearer token (API)
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.replace("Bearer ", "");
    if (isValidToken(token)) return next();
  }

  // Check session cookie
  const cToken = req.cookies?.auth_token;
  if (cToken && isValidToken(cToken)) return next();

  // Check query param — if valid, set cookie so future requests work without ?token=
  const qToken = req.query.token as string | undefined;
  if (qToken && isValidToken(qToken)) {
    res.cookie("auth_token", qToken, { httpOnly: true, sameSite: "strict", maxAge: 30 * 24 * 60 * 60 * 1000 });
    return next();
  }

  // API requests get 401
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Web requests redirect to login
  res.redirect("/login");
}

function isValidToken(token: string): boolean {
  if (token === env.authToken) return true;
  if (getUserByToken(token)) return true;
  return false;
}
