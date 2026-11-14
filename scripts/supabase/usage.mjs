// Prints Free-plan usage for Code Arena (judge calls this month, database size, counts).
//   SUPABASE_SERVICE_ROLE_KEY=... node scripts/supabase/usage.mjs
// The Supabase dashboard (Organization → Usage) remains the authoritative source.
import { CONFIG } from '../../public/js/config.js';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!key) { console.error('Set SUPABASE_SERVICE_ROLE_KEY (never commit it).'); process.exit(2); }
const res = await fetch(`${CONFIG.supabaseUrl}/rest/v1/rpc/ca_usage_report`, { method: 'POST', headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: '{}' });
const u = await res.json();
if (!res.ok) { console.error(u); process.exit(1); }
const pct = (a, b) => `${((a / b) * 100).toFixed(1)}%`;
const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
console.log(`Month ${u.month}
  Judge function calls : ${u.judgeFunctionCalls} (${pct(u.judgeFunctionCalls, u.freeInvocationQuota)} of 500,000 free; code execution pauses at ${u.judgeCallLimit})
  Database size        : ${mb(u.databaseBytes)} (${pct(u.databaseBytes, u.freeDatabaseBytes)} of 500 MB free; submissions table ${mb(u.submissionsTableBytes)})
  Guests (profiles)    : ${u.profiles}
  Submissions          : ${u.submissionsThisMonth} this month, ${u.submissionsTotal} total
  Open rooms           : ${u.openRooms}`);
