import { AlertPayload } from "./types";
import { EmailProvider } from "./email.provider";

const providers = [
  new EmailProvider(),
];

export async function sendAlert(payload: AlertPayload) {
  for (const provider of providers) {
    try {
      await provider.send(payload);
    } catch (err) {
      console.error("Notification provider failed:", err);
    }
  }
}
