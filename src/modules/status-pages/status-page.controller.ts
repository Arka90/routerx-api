import { Response } from "express";
import { z } from "zod";
import { AuthRequest } from "../auth/auth.middleware";
import {
  countSubscribers,
  createStatusPage,
  deleteStatusPage,
  getStatusPage,
  listComponents,
  listStatusPages,
  setComponents,
  SlugTakenError,
  updateStatusPage,
} from "./status-page.service";
import { config } from "../../core/config";
import { assertWithinQuota, QuotaExceededError } from "../billing/quota";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z.string().trim().max(50).optional(),
  headline: z.string().trim().max(200).nullish(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  slug: z.string().trim().max(50).optional(),
  headline: z.string().trim().max(200).nullable().optional(),
  about: z.string().trim().max(4000).nullable().optional(),
  support_url: z.string().trim().url().max(500).nullable().optional(),
  published: z.boolean().optional(),
  show_uptime: z.boolean().optional(),
});

const componentsSchema = z.object({
  components: z
    .array(
      z.object({
        monitor_id: z.number().int().positive(),
        display_name: z.string().trim().min(1).max(80),
      })
    )
    .max(50),
});

async function requirePage(req: AuthRequest, res: Response) {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid status page id" });
    return null;
  }

  const page = await getStatusPage(req.orgId!, id);

  if (!page) {
    res.status(404).json({ error: "Status page not found" });
    return null;
  }

  return page;
}

function withUrl<T extends { slug: string }>(page: T) {
  return { ...page, public_url: `${config.appUrl}/status/${page.slug}` };
}

export async function listStatusPagesHandler(req: AuthRequest, res: Response) {
  const pages = await listStatusPages(req.orgId!);

  res.json({ status_pages: pages.map(withUrl) });
}

export async function createStatusPageHandler(req: AuthRequest, res: Response) {
  const parsed = createSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid page" });
  }

  try {
    await assertWithinQuota(req.orgId!, "status_pages");

    const page = await createStatusPage(req.orgId!, {
      name: parsed.data.name,
      slug: parsed.data.slug ?? parsed.data.name,
      headline: parsed.data.headline ?? null,
    });

    res.status(201).json({ status_page: withUrl(page) });
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      return res.status(402).json({ error: error.message, upgrade_required: true });
    }
    if (error instanceof SlugTakenError) {
      return res.status(409).json({ error: error.message });
    }
    throw error;
  }
}

export async function getStatusPageHandler(req: AuthRequest, res: Response) {
  const page = await requirePage(req, res);
  if (!page) return;

  res.json({
    status_page: withUrl(page),
    components: await listComponents(page.id),
    subscriber_count: await countSubscribers(page.id),
  });
}

export async function updateStatusPageHandler(req: AuthRequest, res: Response) {
  const page = await requirePage(req, res);
  if (!page) return;

  const parsed = updateSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid page" });
  }

  try {
    const updated = await updateStatusPage(req.orgId!, page.id, parsed.data);

    res.json({ status_page: withUrl(updated!) });
  } catch (error) {
    if (error instanceof SlugTakenError) {
      return res.status(409).json({ error: error.message });
    }
    throw error;
  }
}

export async function setComponentsHandler(req: AuthRequest, res: Response) {
  const page = await requirePage(req, res);
  if (!page) return;

  const parsed = componentsSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid component list" });
  }

  await setComponents(req.orgId!, page.id, parsed.data.components);

  res.json({ components: await listComponents(page.id) });
}

export async function deleteStatusPageHandler(req: AuthRequest, res: Response) {
  const page = await requirePage(req, res);
  if (!page) return;

  await deleteStatusPage(req.orgId!, page.id);

  res.json({ message: "Status page deleted" });
}
