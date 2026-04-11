import { Request, Response, NextFunction } from "express";
import { env } from "../config/env";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Check bearer token
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.replace("Bearer ", "");
    if (token === env.authToken) return next();
  }

  // Check query param (for simple links)
  if (req.query.token === env.authToken) return next();

  // Check session cookie
  if (req.cookies?.auth_token === env.authToken) return next();

  // API requests get 401
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Web requests redirect to login
  res.redirect("/login");
}
