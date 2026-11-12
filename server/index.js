// Entry point:  npm start  (local, 127.0.0.1)   ·   npm run start:lan  (0.0.0.0)
import os from 'node:os';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const server = createApp(config);
const address = await server.start();

const urls = [];
if (config.host === '0.0.0.0') {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${address.port}`);
  }
  urls.unshift(`http://127.0.0.1:${address.port}`);
} else {
  urls.push(`http://${config.host}:${address.port}`);
}
const judge = server.services.judge.status();
console.log(`\nCode Arena is running`);
for (const u of urls) console.log(`  ${u}`);
if (config.host === '0.0.0.0') console.log('LAN mode: open one of the network URLs above on both laptops. Invites use the address you opened.');
console.log(`Judge: ${judge.driver} — ${judge.message}`);
if (judge.unsandboxed) console.log('WARNING: the local test judge runs code without a sandbox. Do not use it for real matches.');

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.log('\nStopping…');
  await server.stop().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
