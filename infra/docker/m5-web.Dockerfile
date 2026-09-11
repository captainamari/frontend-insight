FROM node:24-alpine AS build

RUN npm install --global pnpm@11.15.1

WORKDIR /app
COPY . .

ARG APP_DIR
RUN test "$APP_DIR" = "web" -o "$APP_DIR" = "demo-app"
RUN pnpm install --frozen-lockfile \
  && pnpm --filter "@frontend-insight/${APP_DIR}..." build \
  && mkdir -p /out \
  && cp -R "apps/${APP_DIR}/dist/." /out/

FROM nginx:1.29-alpine

COPY infra/nginx/m5.conf /etc/nginx/conf.d/default.conf
COPY --from=build /out/ /usr/share/nginx/html/

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --retries=10 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/health || exit 1
