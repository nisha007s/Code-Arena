# Code Arena judge runtime: C# on .NET 10 SDK. Build with: npm run judge:build
#
# The checked-in project (Main.csproj) is restored and test-built here, at
# /tmp/proj, which is the same path build.sh uses at judge time (inside the
# container's private /tmp). Judge builds then run with --no-restore and need
# no network or external packages.
FROM mcr.microsoft.com/dotnet/sdk:10.0
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE=1 \
    DOTNET_GENERATE_ASPNET_CERTIFICATE=false \
    DOTNET_CLI_HOME=/tmp \
    NUGET_PACKAGES=/opt/nuget \
    MSBUILDDISABLENODEREUSE=1 \
    DOTNET_gcServer=0
COPY Main.csproj /tmp/proj/Main.csproj
COPY Placeholder.cs /tmp/proj/Main.cs
RUN mkdir -p /opt/nuget /opt/code-arena \
 && cd /tmp/proj \
 && dotnet restore \
 && dotnet build --no-restore -c Release -nodeReuse:false -p:UseSharedCompilation=false -o /tmp/warmup \
 && rm -rf /tmp/warmup /tmp/proj/bin /tmp/proj/obj/Release /tmp/proj/Main.cs \
 && mv /tmp/proj /opt/code-arena/template \
 && rm -rf /tmp/.dotnet /tmp/.nuget \
 && chmod -R a+rX /opt/code-arena /opt/nuget
COPY build.sh /opt/code-arena/build.sh
RUN chmod 0555 /opt/code-arena/build.sh \
 && groupadd --gid 10001 runner \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin runner
USER 10001:10001
WORKDIR /tmp
