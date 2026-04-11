import { getDb } from "./database";
import { v4 as uuidv4 } from "uuid";

export interface Notification {
  id: string;
  type: string;
  title: string;
  message: string | null;
  link: string | null;
  read: number;
  created_at: string;
}

export function createNotification(type: string, title: string, message?: string, link?: string): Notification {
  const db = getDb();
  const id = uuidv4();
  db.prepare("INSERT INTO notifications (id, type, title, message, link) VALUES (?, ?, ?, ?, ?)").run(
    id, type, title, message || null, link || null
  );
  return db.prepare("SELECT * FROM notifications WHERE id = ?").get(id) as Notification;
}

export function getUnreadNotifications(): Notification[] {
  const db = getDb();
  return db.prepare("SELECT * FROM notifications WHERE read = 0 ORDER BY created_at DESC LIMIT 20").all() as Notification[];
}

export function getUnreadCount(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as count FROM notifications WHERE read = 0").get() as { count: number };
  return row.count;
}

export function markAllRead(): void {
  const db = getDb();
  db.prepare("UPDATE notifications SET read = 1 WHERE read = 0").run();
}

export function markRead(id: string): void {
  const db = getDb();
  db.prepare("UPDATE notifications SET read = 1 WHERE id = ?").run(id);
}
