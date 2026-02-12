import { spawn } from "child_process";
import express from "express";

export function registerWebhook(app: express.Express) {
  app.post("/deploy", (req, res) => {
    console.log("GitHub webhook received");

    // respond FIRST
    res.status(200).send("OK");

    // then deploy in background
    const child = spawn("bash", ["/root/deploy.sh"], {
      detached: true,
      stdio: "ignore"
    });

    child.unref();
  });
}
