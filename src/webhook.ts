import { exec } from "child_process";
import express from "express";

export function registerWebhook(app: express.Express) {
  app.post("/deploy", (req, res) => {
    console.log("GitHub webhook received");

    exec("bash ~/deploy.sh", (err, stdout, stderr) => {
      console.log(stdout);
      console.log(stderr);
    });

    res.send("Deploy started");
  });
}
