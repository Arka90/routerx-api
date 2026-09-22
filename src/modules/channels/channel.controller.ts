import { Response } from "express";
import { z } from "zod";
import { AuthRequest } from "../auth/auth.middleware";
import {
  createChannel,
  deleteChannel,
  getChannel,
  listChannels,
  updateChannel,
} from "./channel.service";
import { getProvider } from "../notifications/registry";
import { ChannelConfigError } from "../notifications/types";
import { config as appConfig } from "../../core/config";
import { assertWithinQuota, QuotaExceededError } from "../billing/quota";

const channelType = z.enum(["email", "slack", "discord", "webhook"]);

const createSchema = z.object({
  type: channelType,
  name: z.string().trim().min(1).max(80),
  config: z.record(z.string(), z.unknown()).default({}),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

export async function listChannelsHandler(req: AuthRequest, res: Response) {
  res.json({ channels: await listChannels(req.orgId!) });
}

export async function createChannelHandler(req: AuthRequest, res: Response) {
  const parsed = createSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid channel" });
  }

  try {
    await assertWithinQuota(req.orgId!, "channels");

    const channel = await createChannel(
      req.orgId!,
      parsed.data.type,
      parsed.data.name,
      parsed.data.config
    );

    res.status(201).json({ channel });
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      return res.status(402).json({ error: error.message, upgrade_required: true });
    }
    if (error instanceof ChannelConfigError) {
      return res.status(400).json({ error: error.message });
    }
    throw error;
  }
}

export async function updateChannelHandler(req: AuthRequest, res: Response) {
  const channelId = Number(req.params.id);
  const parsed = updateSchema.safeParse(req.body);

  if (!Number.isInteger(channelId) || !parsed.success) {
    return res.status(400).json({ error: "Invalid channel update" });
  }

  try {
    const channel = await updateChannel(req.orgId!, channelId, parsed.data);

    if (!channel) return res.status(404).json({ error: "Channel not found" });

    res.json({ channel });
  } catch (error) {
    if (error instanceof ChannelConfigError) {
      return res.status(400).json({ error: error.message });
    }
    throw error;
  }
}

export async function deleteChannelHandler(req: AuthRequest, res: Response) {
  const channelId = Number(req.params.id);

  if (!Number.isInteger(channelId)) {
    return res.status(400).json({ error: "Invalid channel" });
  }

  const removed = await deleteChannel(req.orgId!, channelId);

  if (!removed) return res.status(404).json({ error: "Channel not found" });

  res.json({ message: "Channel deleted" });
}

/**
 * Send a sample alert. Configuring a webhook and finding out whether it works
 * during the next real outage is not a reasonable way to learn.
 */
export async function testChannelHandler(req: AuthRequest, res: Response) {
  const channelId = Number(req.params.id);

  if (!Number.isInteger(channelId)) {
    return res.status(400).json({ error: "Invalid channel" });
  }

  const channel = await getChannel(req.orgId!, channelId);

  if (!channel) return res.status(404).json({ error: "Channel not found" });

  try {
    await getProvider(channel.type).send(channel, {
      type: "TEST",
      monitor: { id: 0, name: "Test notification", url: "https://example.com" },
      organizationName: req.orgName ?? "your workspace",
      headline: "Test",
      rootCause: null,
      detail: "This is a test alert from RouteRX. If you can see it, the channel works.",
      occurredAt: new Date(),
      incidentId: null,
      durationSeconds: null,
      dashboardUrl: `${appConfig.appUrl}/dashboard`,
    });

    res.json({ message: "Test alert sent" });
  } catch (error) {
    res.status(502).json({
      error: `Could not deliver to this channel: ${(error as Error).message}`,
    });
  }
}
