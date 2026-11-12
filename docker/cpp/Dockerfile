# Code Arena judge runtime: GCC 14 for C++17. Build with: npm run judge:build
FROM gcc:14-bookworm
# Unprivileged user; the judge also passes --user 10001:10001 explicitly.
RUN groupadd --gid 10001 runner \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin runner
USER 10001:10001
WORKDIR /tmp
