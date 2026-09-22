export type ChannelType = "email" | "slack" | "discord" | "webhook";

export type AlertEventType =
  | "DOWN"
  | "UP"
  | "DEGRADED"
  | "REMINDER"
  | "TLS_EXPIRY"
  | "TEST";

export interface NotificationChannelRecord {
  id: number;
  org_id: number;
  type: ChannelType;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  created_at: Date;
}

export interface AlertEvent {
  type: AlertEventType;
  monitor: {
    id: number;
    name: string | null;
    url: string;
  };
  organizationName: string;
  /** Short status word for display: Down, Recovered, Degraded. */
  headline: string;
  rootCause: string | null;
  detail: string | null;
  occurredAt: Date;
  incidentId: number | null;
  /** Set on recovery. */
  durationSeconds: number | null;
  dashboardUrl: string;
}

export interface ChannelProvider {
  type: ChannelType;
  /** Throws a ChannelConfigError when the stored config is unusable. */
  validateConfig(config: Record<string, unknown>): Promise<Record<string, unknown>>;
  send(channel: NotificationChannelRecord, event: AlertEvent): Promise<void>;
}

export class ChannelConfigError extends Error {}
