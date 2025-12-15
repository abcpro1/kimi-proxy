FROM oven/bun:1.3.4-alpine AS build
WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock tsconfig.json ./
COPY frontend/package.json frontend/tsconfig.json frontend/tsconfig.node.json ./frontend/

RUN bun install
RUN bun install --cwd frontend

COPY src ./src
COPY frontend/src ./frontend/src
COPY frontend/index.html ./frontend/
COPY frontend/vite.config.ts ./frontend/

RUN bun run build:all

FROM oven/bun:1.3.4-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/dist ./dist
COPY --from=build /app/frontend/dist ./frontend/dist
COPY package.json bun.lock ./
COPY frontend/package.json ./frontend/package.json

RUN bun install --production --frozen-lockfile

RUN mkdir -p /app/data

EXPOSE 8000
CMD ["bun", "run", "dist/index.js"]
