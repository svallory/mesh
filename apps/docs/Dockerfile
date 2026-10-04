# syntax=docker/dockerfile:1
# Build the Mesh docs site (docmd static site) and serve it with unprivileged nginx.
#
# The docs app is self-contained: it never depends on the workspace's link: MX
# packages, so this build copies only apps/docs and installs from its own
# lockfile (docker/bun.lock), which `bun run validate` keeps in step with
# package.json. The image build never sees the workspace root, so root-level
# overrides, patchedDependencies and trustedDependencies do not apply to it.
# Both base images are pinned by digest; bump tag and digest together.

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS build
WORKDIR /app

COPY docker/package.json docker/bun.lock ./
RUN bun install --frozen-lockfile

COPY package.json docmd.config.json ./
COPY docs ./docs
RUN bun run build

FROM nginxinc/nginx-unprivileged:1.30.5-alpine@sha256:ed04ec1ff34502c339ee5c3ae3f855442398edc1d05591e2b98981dcbbd20b1e
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/site /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ || exit 1
