// Allowlisted language registry. Every command here is fixed: user source is
// written to a file and test input arrives on stdin, so no request value is
// ever placed in a command line, shell string or image name.
//
// Paths inside the container:
//   /src    the job's generated source file (read-only bind mount)
//   /build  compiled output (writable only during compile, read-only when running)
//   /tmp    small private tmpfs, fresh for every container

const PY_CHECK = "import sys\nsrc = open('/src/main.py', 'rb').read()\ncompile(src, 'main.py', 'exec')\n";

export const LANGUAGES = {
  python: {
    id: 'python',
    name: 'Python 3',
    version: 'CPython 3.13',
    fileName: 'main.py',
    image: 'code-arena-judge-python:3.13',
    dockerfile: 'docker/python',
    // Parse/compile check so syntax errors are reported separately from runtime errors.
    compile: ['python3', '-I', '-c', PY_CHECK],
    run: ['python3', '-I', '-B', '/src/main.py'],
    versionCmd: ['python3', '--version'],
    limits: { compileMs: 10000, runMs: 4000, memoryMb: 256, compileMemoryMb: 256, pids: 32, cpus: 1 },
  },
  javascript: {
    id: 'javascript',
    name: 'JavaScript (Node.js)',
    version: 'Node.js 24',
    fileName: 'main.js',
    image: 'code-arena-judge-node:24',
    dockerfile: 'docker/node',
    compile: ['node', '--check', '/src/main.js'],
    run: ['node', '/src/main.js'],
    versionCmd: ['node', '--version'],
    limits: { compileMs: 10000, runMs: 3000, memoryMb: 384, compileMemoryMb: 256, pids: 32, cpus: 1 },
  },
  java: {
    id: 'java',
    name: 'Java 21',
    version: 'Eclipse Temurin JDK 21',
    fileName: 'Main.java',
    image: 'code-arena-judge-java:21',
    dockerfile: 'docker/java',
    compile: ['javac', '-J-Xmx384m', '-encoding', 'UTF-8', '-d', '/build', '/src/Main.java'],
    run: ['java', '-Xss64m', '-Xmx384m', '-XX:+UseSerialGC', '-XX:-UsePerfData', '-cp', '/build', 'Main'],
    versionCmd: ['java', '-version'],
    limits: { compileMs: 20000, runMs: 4000, memoryMb: 512, compileMemoryMb: 768, pids: 64, cpus: 1 },
  },
  cpp: {
    id: 'cpp',
    name: 'C++17',
    version: 'GCC 14 (-std=c++17 -O2)',
    fileName: 'main.cpp',
    image: 'code-arena-judge-cpp:gcc14',
    dockerfile: 'docker/cpp',
    compile: ['g++', '-std=c++17', '-O2', '-pipe', '-o', '/build/main', '/src/main.cpp'],
    run: ['/build/main'],
    versionCmd: ['g++', '--version'],
    limits: { compileMs: 20000, runMs: 2000, memoryMb: 256, compileMemoryMb: 768, pids: 32, cpus: 1 },
  },
  csharp: {
    id: 'csharp',
    name: 'C# (.NET 10)',
    version: '.NET SDK 10.0',
    fileName: 'Main.cs',
    image: 'code-arena-judge-dotnet:10',
    dockerfile: 'docker/dotnet',
    // Copies the checked-in, pre-restored project and builds offline (see docker/dotnet).
    compile: ['sh', '/opt/code-arena/build.sh'],
    run: ['dotnet', '/build/Main.dll'],
    versionCmd: ['dotnet', '--version'],
    limits: { compileMs: 30000, runMs: 4000, memoryMb: 512, compileMemoryMb: 1536, pids: 128, cpus: 1 },
  },
};

export const LANGUAGE_IDS = Object.keys(LANGUAGES);

export function publicLanguages() {
  return LANGUAGE_IDS.map((id) => ({ id, name: LANGUAGES[id].name, version: LANGUAGES[id].version }));
}
