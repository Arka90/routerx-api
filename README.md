<div align="center">
  <img src="https://raw.githubusercontent.com/Arka90/routerx-web/main/public/logo.svg" alt="RouteRX Logo" width="120" style="margin-bottom: 20px" onerror="this.style.display='none'">

  # ⚡ RouteRX
  
  **Proactive Reliability Monitoring & Incident Detection**

  <p>
    <em>Distributed uptime monitoring, advanced failure forensics, and intelligent outage alerting built for modern infrastructure.</em>
  </p>

  <p>
    <a href="https://routerx.heyarka.cloud/"><strong>🌐 Live Demo</strong></a> ·
    <a href="https://github.com/Arka90/routerx-web"><strong>🖥️ Frontend Repository</strong></a> ·
    <a href="#-getting-started"><strong>🚀 Getting Started</strong></a>
  </p>
</div>

---

## 🚀 Overview

**RouteRX** is a production-grade observability platform designed to monitor web services, detect failures in real-time, classify root causes, and notify your team *before* users encounter an issue.

Unlike basic uptime checkers that merely ping a server to check if a site is "up" or "down", RouteRX conducts deep network layers analysis to understand exactly **why** a service failed.

### ❓ The Problem We Solve

Modern systems rarely "just go down". Failures are usually nuanced and layered:
- Misconfigured DNS records
- Expiring SSL certificates
- Unresponsive upstream dependencies
- Degraded TLS handshakes
- High latency and partial outages

While legacy monitoring tools report a binary `❌ Site is down`, RouteRX provides actionable intelligence:
- `🔍 DNS resolution failed`
- `🔍 TLS certificate expires in 3 days`
- `🔍 TCP handshake timeout`
- `🔍 High TTFB latency spike`

This deep-dive forensic capability allows engineers to proactively remediate issues.

---

## 📸 Platform Previews

Take a look at the beautifully designed Next.js dashboard built to manage and monitor seamlessly:

<details>
<summary><b>Click to expand and view screenshots</b></summary>
<br>

![Screenshot 1](./screenshots/screenshot-1.png)
<br><br>
![Screenshot 2](./screenshots/screenshot-2.png)
<br><br>
![Screenshot 3](./screenshots/screenshot-3.png)
<br><br>
![Screenshot 4](./screenshots/screenshot-4.png)
<br><br>
![Screenshot 5](./screenshots/screenshot-5.png)
<br><br>
![Screenshot 6](./screenshots/screenshot-6.png)
<br><br>
![Screenshot 7](./screenshots/screenshot-7.png)
<br><br>
![Screenshot 8](./screenshots/screenshot-8.png)

</details>

---

## 🧠 System Architecture

RouteRX operates as a **distributed background-processing system** composed of independent, highly decoupled services. The UI is simply a presentation layer into the true product: a highly available monitoring engine.

```text
User Dashboard (Next.js)
        ↓
API Layer (Node.js)
        ↓
PostgreSQL (State, History & Time-Series Data)
        ↓
Redis Queue (BullMQ)
        ↓
Background Workers (Monitoring Engine)
        ↓
External Websites (HTTP/TCP/TLS Probes)
```

### 🧩 Core Components

#### 1️⃣ Monitoring Scheduler
Handles reliable execution of repeated jobs. Each monitor generates a BullMQ job with configurable intervals (30s, 1m, 5m), relying on idempotent execution keys and safe restart capabilities to guarantee continuity even if the API server crashes.

#### 2️⃣ Probe Worker (The Engine)
Operates independently from the web layer. Each worker executes a complete network diagnostic trace:
1. **DNS Resolution:** Timing the domain name lookup
2. **TCP Connection:** Measuring establishing connection latency 
3. **TLS Handshake:** Validating secure channel negotiation
4. **HTTP Request:** Fetching and timing network packets
5. **Response Analysis:** Timing Time To First Byte (TTFB) and full transfer

#### 3️⃣ Root Cause Classification Engine
Differentiates between various failures to identify actual root causes intelligently:

| Failure Type | Description |
| :--- | :--- |
| `DNS_FAILURE` | Domain name fails to resolve |
| `TCP_FAILURE` | Destination server is completely unreachable |
| `TLS_FAILURE` | Certificate or secure handshake problem |
| `HTTP_ERROR` | Server returned a 5xx or 4xx error code |
| `TIMEOUT` | Server response exceeded predefined thresholds |

#### 4️⃣ Incident Detection & Deduplication
Incidents trigger exclusively upon consecutive failure runs. This logic prevents alert storms and false alarms typically caused by minor packet drops, temporary routing hiccups, or container cold starts.

#### 5️⃣ Proactive TLS Monitoring
RouteRX automatically extracts and validates SSL certificate metadata. It actively calculates remaining validity hours to warn you of upcoming expirations or invalid signatures—sidestepping one of the most prominent real-world causes of downtime.

#### 6️⃣ Maintenance Windows
Prevent alerting engineers at 2AM for planned deployments with scheduled routing maintenance which natively suppresses alerts while seamlessly resuming once the window ends.

#### 7️⃣ Public Status Pages
Provides your customers with fully integrated, Vercel/GitHub styled status pages that exhibit true SLA uptimes and detailed incident history.

---

## 📊 Metrics & Data Analytics

The time-series performance data engine retains comprehensive metrics including:
* **Global Uptime (%)**
* **Granular Downtime Durations**
* **Network Latency & Response Spikes**
* **Success Streak Measurement**
* **Automated Weekly Reliability Reports**

---

## ⚙️ Technology Stack

**Frontend Repository:** [routerx-web](https://github.com/Arka90/routerx-web)
* Next.js (React)
* TypeScript
* Tailored custom shadcn/ui design
* Recharts Real-time visual data

**Backend API (This Repository)**
* Node.js & TypeScript
* Domain-Driven Design (Clean Architecture)
* RESTful JSON endpoints

**Infrastructure & Persistence**
* PostgreSQL (Relational Persistence Layer)
* Redis (Lightning-fast Caching)
* BullMQ (Reliable Job Queue Workers)
* Docker & Docker Compose

---

## �️ Getting Started

Want to run the complete background processing stack locally?

### Prerequisites
* Docker and Docker Compose
* Node.js v18+

### Quick Start

```bash
# 1. Clone the core API repository
git clone https://github.com/Arka90/routerx-api.git
cd routerx-api

# 2. Setup your local environment variables
cp .env.example .env

# 3. Spin up dependent infrastructure (PostgreSQL & Redis)
docker compose up -d

# 4. Install modular dependencies and boot up REST Server
npm install
npm run dev
```

**Starting the Headless Monitoring Engine:**
To start the workers that actually ingest and run probe queries, open a new terminal:
```bash
npm run worker
```

---

## 📌 Roadmap & Future Vision

- [ ] Multi-region monitoring execution points
- [ ] Advanced anomaly detection via ML
- [ ] Dynamic Webhook payload integrations
- [ ] Slack/Discord native bot notifications
- [ ] External distributed probe clusters

---

<div align="center">
  <br/>
  <em>Engineered for unparalleled systemic observability and backend reliability.</em>
</div>
