# Code Arena judge runtime: Java 21 (Eclipse Temurin JDK). Build with: npm run judge:build
FROM eclipse-temurin:21-jdk-noble
# Unprivileged user; the judge also passes --user 10001:10001 explicitly.
RUN groupadd --gid 10001 runner \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin runner
USER 10001:10001
WORKDIR /tmp
