# Development image for the whole monorepo (web + api). Not a production image: production hosting is not decided yet.
FROM node:24-bookworm-slim
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends postgresql-client ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
EXPOSE 3000 8787
