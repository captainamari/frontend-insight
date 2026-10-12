FROM node:24-alpine

RUN npm install --global pnpm@11.15.1

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile && pnpm build

RUN mkdir -p /var/lib/frontend-insight/sourcemaps && chown node:node /var/lib/frontend-insight/sourcemaps && chmod 700 /var/lib/frontend-insight/sourcemaps

USER node

CMD ["pnpm", "--filter", "@frontend-insight/api", "start"]
