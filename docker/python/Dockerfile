# Code Arena judge runtime: Python 3.13 (CPython). Build with: npm run judge:build
FROM python:3.13-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONIOENCODING=utf-8
# Unprivileged user; the judge also passes --user 10001:10001 explicitly.
RUN groupadd --gid 10001 runner \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin runner
USER 10001:10001
WORKDIR /tmp
