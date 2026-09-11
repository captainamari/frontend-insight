FROM node:24-alpine

RUN npm install --global pnpm@11.15.1

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile && pnpm build

USER node

CMD ["pnpm", "migrate:verify"]
