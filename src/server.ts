import app from "./app";
import { scheduleWeeklyReport } from "./core/queue/schedulers/report.scheduler";

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`RouteRx API running on port ${PORT}`);
  scheduleWeeklyReport();
});


/*
Features 
1️⃣ Root cause classification done
2️⃣ SSL expiry monitoring done
3️⃣ Maintenance windows done
4️⃣ Response time alerts
5️⃣ Weekly reports done
6️⃣ Status page
*/