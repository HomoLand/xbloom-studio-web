# syntax=docker/dockerfile:1

FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable \
    && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack prepare pnpm@9.15.4 --activate \
    && pnpm install --frozen-lockfile

COPY . .
ARG VITE_STATIC=""
ARG VITE_BASE=/
ENV VITE_STATIC=${VITE_STATIC} \
    VITE_BASE=${VITE_BASE}
RUN pnpm test && pnpm run build

FROM nginxinc/nginx-unprivileged:1.29-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 8080
USER 101
