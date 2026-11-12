// Output checker for this catalog: compare whitespace-separated tokens as exact
// strings. Line endings and surrounding whitespace do not matter; extra or
// missing tokens are a mismatch.
export function tokenize(text) {
  return String(text).split(/\s+/).filter(Boolean);
}

export function compareOutput(actual, expected) {
  const a = tokenize(actual);
  const e = tokenize(expected);
  if (a.length !== e.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== e[i]) return false;
  return true;
}
