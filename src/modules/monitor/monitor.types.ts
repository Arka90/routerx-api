import type { AssertionType } from "../../domain/assertions";

export interface Monitor {
  id: number;
  org_id: number;
  created_by: number | null;
  name: string | null;
  url: string;
  method: string;
  request_headers: Record<string, string>;
  request_body: string | null;
  expected_status_codes: number[];
  assertion_type: AssertionType;
  assertion_value: string | null;
  timeout_ms: number;
  follow_redirects: boolean;
  interval_seconds: number;
  paused: boolean;
  confirmed_status: "UP" | "DOWN" | "DEGRADED" | "UNCONFIRMED" | "MAINTENANCE";
  consecutive_failures: number;
  consecutive_successes: number;
  tls_expiry_at: Date | null;
  tls_alerted_days: number[];
  in_maintenance: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface AlertPolicy {
  monitor_id: number;
  failure_threshold: number;
  recovery_threshold: number;
  alert_on_slow: boolean;
  slow_threshold_ms: number;
  renotify_minutes: number | null;
  muted_until: Date | null;
}

export const DEFAULT_POLICY: Omit<AlertPolicy, "monitor_id"> = {
  failure_threshold: 3,
  recovery_threshold: 2,
  alert_on_slow: false,
  slow_threshold_ms: 1500,
  renotify_minutes: null,
  muted_until: null,
};

export interface MonitorWithPolicy extends Monitor {
  policy: AlertPolicy;
  channel_ids: number[];
}

export interface CreateMonitorInput {
  name?: string | null;
  url: string;
  method?: string;
  request_headers?: Record<string, string>;
  request_body?: string | null;
  expected_status_codes?: number[];
  assertion_type?: AssertionType;
  assertion_value?: string | null;
  timeout_ms?: number;
  follow_redirects?: boolean;
  interval_seconds?: number;
  paused?: boolean;
}

export type UpdateMonitorInput = Partial<CreateMonitorInput>;

export interface AlertPolicyInput {
  failure_threshold?: number;
  recovery_threshold?: number;
  alert_on_slow?: boolean;
  slow_threshold_ms?: number;
  renotify_minutes?: number | null;
  muted_until?: string | null;
  channel_ids?: number[];
}
