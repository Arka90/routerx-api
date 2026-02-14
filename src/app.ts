import express from "express";
import healthRoute from "./modules/health/health.route";
import probeRoute from "./modules/probe/probe.route";
import monitorRoute from "./modules/monitor/monitor.route";

const app = express();

app.use(express.json());

app.use("/health", healthRoute);
app.use("/probe", probeRoute);
app.use("/monitor", monitorRoute);

export default app;
