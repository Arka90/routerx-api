export type AlertPayload = {
  monitorId: number;
  url: string;
  status: "DOWN" | "UP";
  checkedAt: Date;
};

export interface NotificationProvider {
  send(payload: AlertPayload): Promise<void>;
}
