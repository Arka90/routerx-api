# ---------- BUILD STAGE ----------
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build


# ---------- RUNTIME STAGE ----------
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# No `COPY .env` here on purpose: baking it in writes SMTP credentials and
# JWT_SECRET into an image layer, where they survive `docker history` and any
# registry the image is pushed to. Configuration is injected at runtime
# instead (docker-compose `env_file`, or `docker run --env-file`).

EXPOSE 3000

CMD ["node", "dist/server.js"]
