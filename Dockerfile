FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml tsconfig.json pnpm-workspace.yaml ./
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/tsconfig.json frontend/tsconfig.node.json ./frontend/
RUN corepack enable && pnpm install --frozen-lockfile && pnpm --filter frontend install --frozen-lockfile

COPY src ./src
COPY frontend/src ./frontend/src
COPY frontend/index.html ./frontend/
RUN pnpm run build:all

RUN mkdir -p /app/data

CMD ["node", "dist/index.js"]
