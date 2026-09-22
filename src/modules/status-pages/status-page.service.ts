import crypto from "crypto";
import { execute, query, queryOne, withTransaction } from "../../core/db/client";

export interface StatusPage {
  id: number;
  org_id: number;
  slug: string;
  name: string;
  headline: string | null;
  about: string | null;
  support_url: string | null;
  published: boolean;
  show_uptime: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface StatusPageComponent {
  monitor_id: number;
  display_name: string;
  position: number;
}

export class SlugTakenError extends Error {}

/** Lowercase, hyphenated, and never something that collides with a route. */
const RESERVED_SLUGS = new Set([
  "api",
  "app",
  "admin",
  "auth",
  "dashboard",
  "status",
  "www",
  "subscribe",
  "unsubscribe",
  "subscriptions",
  "confirm",
]);

export function normalizeSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

export function assertUsableSlug(slug: string): void {
  if (slug.length < 3) {
    throw new SlugTakenError("A page address needs at least three characters");
  }

  if (RESERVED_SLUGS.has(slug)) {
    throw new SlugTakenError(`"${slug}" is reserved — pick another address`);
  }
}

export async function listStatusPages(orgId: number): Promise<StatusPage[]> {
  return query<StatusPage>(
    `SELECT * FROM status_pages WHERE org_id = $1 ORDER BY created_at ASC`,
    [orgId]
  );
}

export async function getStatusPage(
  orgId: number,
  id: number
): Promise<StatusPage | undefined> {
  return queryOne<StatusPage>(
    `SELECT * FROM status_pages WHERE id = $1 AND org_id = $2`,
    [id, orgId]
  );
}

export async function createStatusPage(
  orgId: number,
  input: { name: string; slug: string; headline?: string | null }
): Promise<StatusPage> {
  const slug = normalizeSlug(input.slug || input.name);
  assertUsableSlug(slug);

  const existing = await queryOne<{ id: number }>(
    `SELECT id FROM status_pages WHERE slug = $1`,
    [slug]
  );

  if (existing) {
    throw new SlugTakenError(`The address "${slug}" is already taken`);
  }

  const row = await queryOne<StatusPage>(
    `INSERT INTO status_pages (org_id, slug, name, headline)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [orgId, slug, input.name.trim(), input.headline ?? null]
  );

  return row!;
}

export async function updateStatusPage(
  orgId: number,
  id: number,
  patch: Partial<{
    name: string;
    slug: string;
    headline: string | null;
    about: string | null;
    support_url: string | null;
    published: boolean;
    show_uptime: boolean;
  }>
): Promise<StatusPage | undefined> {
  const assignments: string[] = [];
  const params: unknown[] = [];

  const push = (column: string, value: unknown) => {
    params.push(value);
    assignments.push(`${column} = $${params.length}`);
  };

  if (patch.name !== undefined) push("name", patch.name.trim());
  if (patch.headline !== undefined) push("headline", patch.headline);
  if (patch.about !== undefined) push("about", patch.about);
  if (patch.support_url !== undefined) push("support_url", patch.support_url);
  if (patch.published !== undefined) push("published", patch.published);
  if (patch.show_uptime !== undefined) push("show_uptime", patch.show_uptime);

  if (patch.slug !== undefined) {
    const slug = normalizeSlug(patch.slug);
    assertUsableSlug(slug);

    const clash = await queryOne<{ id: number }>(
      `SELECT id FROM status_pages WHERE slug = $1 AND id <> $2`,
      [slug, id]
    );

    if (clash) throw new SlugTakenError(`The address "${slug}" is already taken`);

    push("slug", slug);
  }

  if (assignments.length === 0) return getStatusPage(orgId, id);

  assignments.push("updated_at = now()");
  params.push(id, orgId);

  const rows = await query<StatusPage>(
    `UPDATE status_pages SET ${assignments.join(", ")}
      WHERE id = $${params.length - 1} AND org_id = $${params.length}
      RETURNING *`,
    params
  );

  return rows[0];
}

export async function deleteStatusPage(orgId: number, id: number): Promise<boolean> {
  return (
    (await execute(`DELETE FROM status_pages WHERE id = $1 AND org_id = $2`, [
      id,
      orgId,
    ])) > 0
  );
}

export async function listComponents(pageId: number): Promise<StatusPageComponent[]> {
  return query<StatusPageComponent>(
    `SELECT monitor_id, display_name, position
       FROM status_page_monitors
      WHERE status_page_id = $1
      ORDER BY position, display_name`,
    [pageId]
  );
}

/**
 * Replace the page's components wholesale.
 *
 * The insert joins through `monitors` on the owning organization, so a
 * monitor id from another workspace simply does not match — a status page
 * cannot be used to publish somebody else's uptime.
 */
export async function setComponents(
  orgId: number,
  pageId: number,
  components: Array<{ monitor_id: number; display_name: string }>
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(`DELETE FROM status_page_monitors WHERE status_page_id = $1`, [
      pageId,
    ]);

    for (const [index, component] of components.entries()) {
      await client.query(
        `INSERT INTO status_page_monitors
           (status_page_id, monitor_id, display_name, position)
         SELECT $1, m.id, $3, $4
           FROM monitors m
          WHERE m.id = $2 AND m.org_id = $5`,
        [pageId, component.monitor_id, component.display_name.trim(), index, orgId]
      );
    }
  });
}

// ---------------------------------------------------------------
// Subscribers
// ---------------------------------------------------------------

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export interface PendingSubscription {
  confirmToken: string;
  unsubscribeToken: string;
  alreadyConfirmed: boolean;
}

/**
 * Record a subscription request and return the tokens for the emails.
 *
 * Double opt-in, and the response says nothing about whether the address was
 * already subscribed — otherwise the endpoint becomes a way to test which
 * addresses follow a given company's status page.
 */
export async function requestSubscription(
  pageId: number,
  email: string
): Promise<PendingSubscription> {
  const confirmToken = generateToken();
  const unsubscribeToken = generateToken();

  const existing = await queryOne<{ id: number; confirmed_at: Date | null }>(
    `SELECT id, confirmed_at FROM status_page_subscribers
      WHERE status_page_id = $1 AND email = $2`,
    [pageId, email]
  );

  if (existing?.confirmed_at) {
    return { confirmToken, unsubscribeToken, alreadyConfirmed: true };
  }

  await execute(
    `INSERT INTO status_page_subscribers
       (status_page_id, email, confirm_token_hash, unsubscribe_token_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (status_page_id, email) DO UPDATE SET
       confirm_token_hash = EXCLUDED.confirm_token_hash,
       unsubscribe_token_hash = EXCLUDED.unsubscribe_token_hash`,
    [pageId, email, hashToken(confirmToken), hashToken(unsubscribeToken)]
  );

  return { confirmToken, unsubscribeToken, alreadyConfirmed: false };
}

export async function confirmSubscription(token: string): Promise<string | null> {
  const rows = await query<{ email: string }>(
    `UPDATE status_page_subscribers
        SET confirmed_at = now(), confirm_token_hash = NULL
      WHERE confirm_token_hash = $1 AND confirmed_at IS NULL
      RETURNING email::text AS email`,
    [hashToken(token)]
  );

  return rows[0]?.email ?? null;
}

export async function unsubscribe(token: string): Promise<boolean> {
  return (
    (await execute(`DELETE FROM status_page_subscribers WHERE unsubscribe_token_hash = $1`, [
      hashToken(token),
    ])) > 0
  );
}

export async function countSubscribers(pageId: number): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM status_page_subscribers
      WHERE status_page_id = $1 AND confirmed_at IS NOT NULL`,
    [pageId]
  );

  return row?.count ?? 0;
}
