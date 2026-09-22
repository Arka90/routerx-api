import { emailProvider } from "./providers/email.provider";
import { slackProvider } from "./providers/slack.provider";
import { discordProvider } from "./providers/discord.provider";
import { webhookProvider } from "./providers/webhook.provider";
import type { ChannelProvider, ChannelType } from "./types";

const providers: Record<ChannelType, ChannelProvider> = {
  email: emailProvider,
  slack: slackProvider,
  discord: discordProvider,
  webhook: webhookProvider,
};

export function getProvider(type: ChannelType): ChannelProvider {
  return providers[type];
}

export const CHANNEL_TYPES = Object.keys(providers) as ChannelType[];
