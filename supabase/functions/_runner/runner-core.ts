// Shared runner: executes ONE test of ONE submission inside the WebAssembly sandbox.
// Only the judge may call it (x-runner-key). Hidden inputs/expected outputs never leave
// this function; for hidden tests only a verdict and a time are returned.
// Every response this code produces carries `x-ca-runner: 1`; platform errors do not.

type Test = { input: string; output: string };
type Bundle = { public: Test[]; hidden: Test[] };
export type Exec = (source: string, stdin: string, o: { timeMs: number; outputLimit: number }) => Promise<{
  verdict: string; ms: number; stdout: string; stderr: string; detail?: string;
}>;

const enc = new TextEncoder();
const b64 = (x: string) => new TextDecoder().decode(Uint8Array.from(atob(x), (c) => c.charCodeAt(0)));
const tokens = (s: string) => s.split(/\s+/).filter(Boolean);
const same = (a: string, b: string) => { const x = tokens(a), y = tokens(b); return x.length === y.length && x.every((t, i) => t === y[i]); };
const trim = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '\n… (trimmed)' : s);

function keyOk(given: string | null): boolean {
  const want = Deno.env.get('RUNNER_KEY') || '';
  if (!given || want.length < 32 || given.length !== want.length) return false;
  let d = 0; for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ given.charCodeAt(i);
  return d === 0;
}
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-ca-runner': '1' } });

const cache = new Map<string, Bundle>();
async function bundle(problem: string, base: URL): Promise<Bundle> {
  if (!cache.has(problem)) {
    const gz = await Deno.readFile(new URL(`./tests/${problem}.json.gz`, base));
    const text = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    cache.set(problem, JSON.parse(text));
  }
  return cache.get(problem)!;
}

// Warm-up: V8 compiles WebAssembly functions lazily, so the first runs in a fresh worker are
// several times slower. A cold worker answers its first request with { warming: true } after an
// unmeasured warm-up run (in that request's own CPU budget) and WITHOUT running the student's
// code; the judge then sends the same test again to the now-warm worker.
const WARM_INPUT = Array.from({ length: 800 }, (_, i) => ((i * 7919) % 10007) - 5000).join(' ');
export function serveRunner({ problems, exec, base, warm }: { problems: string[]; exec: () => Promise<Exec>; base: URL; warm: string }) {
  let warmed = false;
  Deno.serve(async (req) => {
    if (req.method !== 'POST' || !keyOk(req.headers.get('x-runner-key'))) return new Response('Not found', { status: 404 });
    let b: any;
    try { b = await req.json(); } catch { return reply(400, { error: 'bad_json' }); }
    if (!problems.includes(b.problemId)) return reply(400, { error: 'wrong_runner' });
    // Phase 1 test hook (requires the runner key): simulate an infrastructure stall.
    if (b.testStallMs) { await new Promise((r) => setTimeout(r, Math.min(b.testStallMs, 20000))); }
    const source = b64(b.sourceB64 || '');
    const timeMs = Math.max(100, Math.min(Number(b.timeMs) || 1000, 1500));
    let input: string, expected: string | null = null, kind: 'public' | 'hidden' | 'custom';
    if (b.test === 'custom') { kind = 'custom'; input = b64(b.customInputB64 || ''); }
    else {
      const m = /^(public|hidden)-(\d+)$/.exec(String(b.test));
      if (!m) return reply(400, { error: 'bad_test' });
      const t = (await bundle(b.problemId, base))[m[1] as 'public' | 'hidden'][Number(m[2]) - 1];
      if (!t) return reply(400, { error: 'no_such_test' });
      kind = m[1] as 'public' | 'hidden'; input = t.input; expected = t.output;
    }
    const outputLimit = expected !== null ? Math.max(64 * 1024, enc.encode(expected).length * 2 + 1024) : 64 * 1024;
    if (!warmed && !b.skipWarm) {
      await (await exec())(warm, WARM_INPUT, { timeMs: 1500, outputLimit: 1 << 20 }).catch(() => null);
      warmed = true;
      return reply(200, { warming: true });
    }
    warmed = true;
    const run = await (await exec())(source, input, { timeMs, outputLimit });
    let verdict = run.verdict;                      // OK | TLE | MLE | RE | OLE
    if (verdict === 'OK' && run.ms > timeMs) verdict = 'TLE';
    if (kind !== 'custom' && verdict === 'OK') verdict = same(run.stdout, expected!) ? 'AC' : 'WA';
    const out: Record<string, unknown> = { verdict, timeMs: Math.round(run.ms) };
    if (kind !== 'hidden') { out.stdout = trim(run.stdout, kind === 'custom' ? 16000 : 8000); out.stderr = trim(run.stderr, kind === 'custom' ? 8000 : 4000); }
    return reply(200, out);
  });
}
