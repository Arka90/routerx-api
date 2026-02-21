import app from "./app";

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`RouteRx API running on port ${PORT}`);
});


/*
Features 
1️⃣ Root cause classification done
2️⃣ SSL expiry monitoring done
3️⃣ Maintenance windows in progress
4️⃣ Response time alerts
5️⃣ Weekly reports
6️⃣ Status page
*/