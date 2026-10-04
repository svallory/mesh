# syntax=docker/dockerfile:1
# Build the Mesh docs site (docmd static site) and serve it with nginx.
#
# The docs app is self-contained: it depends only on @docmd/core and
# @docmd/plugin-search, never on the workspace's link: MX packages, so this
# build copies only apps/docs and installs it standalone. That keeps the
# image buildable from the repo alone, without the local MX checkout that
# the root bun.lock references.

FROM oven/bun:1.3.14 AS build
WORKDIR /app

COPY package.json ./
RUN bun install

COPY docmd.config.json ./
COPY docs ./docs
RUN bun run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/site /usr/share/nginx/html
EXPOSE 80
