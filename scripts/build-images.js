// Builds the five judge images and records the exact runtime versions.
//
//   npm run judge:build            build (uses the Docker cache)
//   npm run judge:build -- --pull  also pull newer patch releases of the base images
//
// Writes docker/versions.json (commit it) with each image's id, base image and
// the version string printed by the runtime inside the container.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectRoot } from '../server/config.js';
import { LANGUAGES, LANGUAGE_IDS } from '../server/judge/languages.js';

const docker = process.env.DOCKER || 'docker';
const pull = process.argv.includes('--pull');
const run = (args, opts = {}) => spawnSync(docker, args, { encoding: 'utf8', ...opts });

const ver = run(['version', '--format', '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}']);
if (ver.status !== 0) {
  console.error('Docker is not available. Install Docker Desktop (Windows/macOS) or Docker Engine (Linux), start it, and retry.');
  console.error(ver.stderr || ver.error?.message || '');
  process.exit(1);
}
console.log(`Docker ${ver.stdout.trim()}`);

const out = { docker: ver.stdout.trim(), builtAt: new Date().toISOString(), images: {} };
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
for (const id of LANGUAGE_IDS) {
  if (only.length && !only.includes(id)) continue;
  const lang = LANGUAGES[id];
  const context = path.join(projectRoot, lang.dockerfile);
  const base = fs.readFileSync(path.join(context, 'Dockerfile'), 'utf8').match(/^FROM\s+(\S+)/m)[1];
  console.log(`\n▶ ${lang.image}  (from ${base})`);
  const build = run(['build', ...(pull ? ['--pull'] : []), '-t', lang.image, context], { stdio: 'inherit' });
  if (build.status !== 0) { console.error(`Build failed for ${id}`); process.exit(1); }
  const imageId = run(['image', 'inspect', '--format', '{{.Id}}', lang.image]).stdout.trim();
  const v = run(['run', '--rm', '--network', 'none', lang.image, ...lang.versionCmd]);
  const version = (v.stdout + v.stderr).trim().split('\n')[0];
  out.images[id] = { image: lang.image, base, imageId, version };
  console.log(`  ${version}`);
}
const file = path.join(projectRoot, 'docker', 'versions.json');
const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { images: {} };
out.images = { ...previous.images, ...out.images };
fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log(`\nRecorded versions in docker/versions.json. Next: npm run judge:smoke`);
