import express from "express";
import healthRoute from "./modules/health/health.route";
import probeRoutes from "./modules/probe/probe.route";
import authRoutes from "./modules/auth/auth.routes";
import monitorRoutes from "./modules/monitor/monitor.route";
import { runMigrations } from "./core/db/migrate";
import { requireAuth } from "./modules/auth/auth.middleware";
import "dotenv/config";
import "./core/db/client";
import { db } from "./core/db/client";


const app = express();
app.use(express.json());
runMigrations();

app.use("/health", healthRoute);
app.use("/auth", authRoutes);
app.use("/probe", probeRoutes);
app.use("/monitor", requireAuth ,monitorRoutes);

export default app;
