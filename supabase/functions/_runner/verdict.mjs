// Maps a raw CPython-WASI run to a verdict.
export function pyVerdict(r) {
  if (r.outOfFuel) return 'TLE';
  if (r.truncated) return 'OLE';
  if (/MemoryError/.test(r.stderr) || /memory access out of bounds|Out of memory|could not allocate/i.test(r.trap || '')) return 'MLE';
  if (r.trap) return 'RE';
  return r.exitCode === 0 ? 'OK' : 'RE';
}
