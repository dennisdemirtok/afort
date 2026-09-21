import { getDb } from "./database";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import bcrypt from "bcryptjs";

export const ADMIN_EMAIL = "admin@afort.local";

export interface User {
  id: string;
  name: string;
  email: string;
  token: string;
  password_hash: string | null;
  role: string;
  created_at: string;
}

function generateToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

export function generatePassword(): string {
  return crypto.randomBytes(9).toString("base64url");
}

export function createUserWithPassword(name: string, email: string, password: string, role = "viewer"): User {
  const db = getDb();
  const id = uuidv4();
  db.prepare("INSERT INTO users (id, name, email, token, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)").run(
    id, name.trim(), email.trim().toLowerCase(), generateToken(), bcrypt.hashSync(password, 10), role
  );
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User;
}

export function verifyPassword(email: string, password: string): User | null {
  const user = getUserByEmail(email);
  if (!user || !user.password_hash) return null;
  return bcrypt.compareSync(password, user.password_hash) ? user : null;
}

/** Sets a new password and signs the user out everywhere by rotating the session token. */
export function setPassword(userId: string, password: string): void {
  getDb().prepare("UPDATE users SET password_hash = ?, token = ? WHERE id = ?").run(
    bcrypt.hashSync(password, 10), generateToken(), userId
  );
}

export function getUserById(id: string): User | undefined {
  return getDb().prepare("SELECT * FROM users WHERE id = ?").get(id) as User | undefined;
}

export function getUserByEmail(email: string): User | undefined {
  return getDb().prepare("SELECT * FROM users WHERE email = ?").get(email.trim().toLowerCase()) as User | undefined;
}

export function getUserByToken(token: string): User | undefined {
  if (!token) return undefined;
  return getDb().prepare("SELECT * FROM users WHERE token = ?").get(token) as User | undefined;
}

export function getAdminUser(): User | undefined {
  return getUserByEmail(ADMIN_EMAIL);
}

export function listUsers(): User[] {
  return getDb().prepare("SELECT * FROM users ORDER BY role = 'admin' DESC, created_at").all() as User[];
}

export function removeUser(id: string): void {
  getDb().prepare("DELETE FROM users WHERE id = ? AND role != 'admin'").run(id);
}

/**
 * Makes sure the built-in admin account exists. AUTH_TOKEN is its initial
 * password; a password changed later in the app is left alone.
 */
export function ensureAdminExists(initialPassword: string): void {
  const db = getDb();
  const existing = getAdminUser();

  if (!existing) {
    db.prepare("INSERT INTO users (id, name, email, token, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)").run(
      uuidv4(), "Admin", ADMIN_EMAIL, generateToken(), bcrypt.hashSync(initialPassword, 10), "admin"
    );
    return;
  }

  if (!existing.password_hash) {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(initialPassword, 10), existing.id);
  }
  // Earlier versions used AUTH_TOKEN itself as the session token, which put the
  // admin password in the cookie. Replace it with a random token.
  if (existing.token === initialPassword) {
    db.prepare("UPDATE users SET token = ? WHERE id = ?").run(generateToken(), existing.id);
  }
}
