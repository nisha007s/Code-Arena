#!/bin/sh
# Offline C# build used by the judge.  Input: /src/Main.cs   Output: /build/Main.dll
set -e
cp -r /opt/code-arena/template /tmp/proj
cp /src/Main.cs /tmp/proj/Main.cs
cd /tmp/proj
exec dotnet build --no-restore -nologo -v:q -clp:NoSummary -c Release -nodeReuse:false -p:UseSharedCompilation=false -o /build
