import { Request, Response, NextFunction } from "express";
import { env } from "../config/env";
import { getUserByToken } from "../models/user";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Check bearer token
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.replace("Bearer ", "");
    if (token === env.authToken || getUserByToken(token)) return next();
  }

  // Check query param (for simple links)
  const qToken = req.query.token as string | undefined;
  if (qToken && (qToken === env.authToken || getUserByToken(qToken))) return next();

  // Check session cookie
  const cToken = req.cookies?.auth_token;
  if (cToken && (cToken === env.authToken || getUserByToken(cToken))) return next();

  // API requests get 401
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Web requests redirect to login
  res.redirect("/login");
}
