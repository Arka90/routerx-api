import { db } from "../../core/db/client";

export interface Monitor {
  id: number;
  user_id: number;
  url: string;
  interval_seconds: number;
  next_check_at: string;
  created_at: string;
}

export function createMonitor(userId: number, url: string, interval_seconds: number = 60): Monitor {
  // check if this user already monitors this URL
  const existing = db
    .prepare(`SELECT id FROM monitors WHERE user_id = ? AND url = ?`)
    .get(userId, url);

  if (existing) {
    throw new Error("Monitor already exists");
  }

  const now = new Date();
  
  const result = db
    .prepare(`
      INSERT INTO monitors (user_id, url, interval_seconds, next_check_at)
      VALUES (?, ?, ?, ?)
    `)
    .run(userId, url, interval_seconds, now.toISOString());

  return {
    id: Number(result.lastInsertRowid),
    user_id: userId,
    url,
    interval_seconds,
    next_check_at: now.toISOString(),
    created_at: now.toISOString(),
  };
}

export function getUserMonitors(userId: number): Monitor[] {
  return db
    .prepare(`
      SELECT *
      FROM monitors
      WHERE user_id = ?
      ORDER BY created_at DESC
    `)
    .all(userId) as Monitor[];
}

export function getMonitor(userId: number, monitorId: number): Monitor | undefined {
  return db
    .prepare(`
      SELECT *
      FROM monitors
      WHERE id = ? AND user_id = ?
    `)
    .get(monitorId, userId) as Monitor | undefined;
}

export function updateMonitor(
  userId: number,
  monitorId: number,
  data: { url?: string; interval_seconds?: number }
): Monitor {
  const updates: string[] = [];
  const params: any[] = [];

  if (data.url) {
    updates.push("url = ?");
    params.push(data.url);
  }

  if (data.interval_seconds) {
    updates.push("interval_seconds = ?");
    params.push(data.interval_seconds);
  }

  if (updates.length === 0) {
    const monitor = getMonitor(userId, monitorId);
    if (!monitor) throw new Error("Monitor not found");
    return monitor;
  }

  params.push(monitorId, userId);

  const result = db
    .prepare(
      `
      UPDATE monitors
      SET ${updates.join(", ")}
      WHERE id = ? AND user_id = ?
    `
    )
    .run(...params);

  if (result.changes === 0) {
    throw new Error("Monitor not found or unauthorized");
  }

  const updated = getMonitor(userId, monitorId);
  if (!updated) throw new Error("Monitor not found after update"); // Should not happen
  return updated;
}

export function deleteMonitor(userId: number, monitorId: number): boolean {
  const result = db
    .prepare(
      `
      DELETE FROM monitors
      WHERE id = ? AND user_id = ?
    `
    )
    .run(monitorId, userId);

  if (result.changes === 0) {
    throw new Error("Monitor not found or unauthorized");
  }

  return true;
}