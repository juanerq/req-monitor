FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

COPY . ./
COPY web ./web
RUN mkdir -p playwright/.auth artifacts && pnpm typecheck

EXPOSE 8787

CMD ["pnpm", "monitor-api"]
