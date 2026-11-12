# Code Arena judge runtime: Node.js 24 LTS. Build with: npm run judge:build
FROM node:24-bookworm-slim
ENV NODE_ENV=production NODE_OPTIONS=
# Unprivileged user; the judge also passes --user 10001:10001 explicitly.
RUN groupadd --gid 10001 runner \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin runner
USER 10001:10001
WORKDIR /tmp
