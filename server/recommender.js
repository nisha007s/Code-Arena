// Explainable, content-based practice recommender. Local and deterministic.
//
// Part 1 — TF-IDF similarity (classic information retrieval):
//   terms(d)  = title words (weight 1 each) + tags (weight 2 each)
//   idf(t)    = ln((1 + N) / (1 + df(t))) + 1          (smoothed IDF)
//   v_d[t]    = tf(t, d) · idf(t), then L2-normalised
//   sim(P, d) = P · v_d                                  (cosine, both unit length)
//
// Part 2 — hand-written ranking rules (not learned):
//   profile P = normalise( Σ_i  recency_i · struggle_i · v_{p_i} )
//       over the guest's 5 most recent distinct attempted problems p_i (Submit only)
//       recency_i  = 1, 0.85, 0.70, 0.55, 0.40   (most recent first)
//       struggle_i = 2 if p_i has a Wrong Answer / Time Limit Exceeded with no later Accepted, else 1
//   target level  = recency-weighted mean difficulty (easy 0, medium 1, hard 2),
//                   +0.5 if the latest attempt was Accepted, clamped to [0, 2]
//   fit(d)        = 1 − |level(d) − target| / 2
//   score(d)      = 0.75 · sim(P, d) + 0.25 · fit(d)
//   Solved problems are excluded. Ties break by problem number (stable id).
//   Cold start (no attempts): Easy problems with distinct primary topics.
//
// Inputs are public titles/tags and the guest's own verdict history only —
// never source code or hidden tests. No model is trained and nothing about a
// player's ability is predicted.

const STOPWORDS = new Set(['a', 'an', 'and', 'of', 'the', 'to', 'in', 'on', 'for']);
const LEVEL = { easy: 0, medium: 1, hard: 2 };
const LEVEL_NAME = ['Easy', 'Medium', 'Hard'];
const RECENCY = [1, 0.85, 0.7, 0.55, 0.4];
const STRUGGLE_VERDICTS = new Set(['WA', 'TLE']);
export const WEIGHTS = { similarity: 0.75, difficulty: 0.25, tagTf: 2, titleTf: 1, struggle: 2 };

export function termsOf(doc) {
  const tf = new Map();
  for (const w of doc.title.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w && !STOPWORDS.has(w)) tf.set(w, (tf.get(w) || 0) + WEIGHTS.titleTf);
  }
  for (const tag of doc.tags) tf.set('#' + tag, (tf.get('#' + tag) || 0) + WEIGHTS.tagTf);
  return tf;
}

const prettyTerm = (t) => (t.startsWith('#') ? t.slice(1).replace(/-/g, ' ') : `“${t}”`);

export function buildIndex(docs) {
  const N = docs.length;
  const tfs = docs.map(termsOf);
  const df = new Map();
  for (const tf of tfs) for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const idf = new Map([...df].map(([t, n]) => [t, Math.log((1 + N) / (1 + n)) + 1]));
  const vectors = new Map();
  docs.forEach((d, i) => {
    const v = new Map();
    for (const [t, f] of tfs[i]) v.set(t, f * idf.get(t));
    vectors.set(d.id, normalize(v));
  });
  return { docs: [...docs].sort((a, b) => a.number - b.number), idf, vectors, byId: new Map(docs.map((d) => [d.id, d])) };
}

function normalize(v) {
  let norm = 0;
  for (const x of v.values()) norm += x * x;
  norm = Math.sqrt(norm);
  const out = new Map();
  if (norm === 0) return out;
  for (const [t, x] of v) out.set(t, x / norm);
  return out;
}

function dot(a, b) {
  let s = 0;
  for (const [t, x] of a) { const y = b.get(t); if (y) s += x * y; }
  return s;
}

/**
 * @param index  result of buildIndex()
 * @param attempts  this guest's judged Submit attempts, oldest first: [{problem_id, verdict, seq}]
 * @param limit  number of recommendations (default 3)
 */
export function recommend(index, attempts, limit = 3) {
  const solved = new Set(attempts.filter((a) => a.verdict === 'AC').map((a) => a.problem_id));
  const unsolved = index.docs.filter((d) => !solved.has(d.id));
  if (!unsolved.length) {
    return { mode: 'all_solved', items: [], explanation: 'You have solved every problem in the library.' };
  }

  // Most recent distinct attempted problems (newest first).
  const recent = [];
  for (let i = attempts.length - 1; i >= 0 && recent.length < 5; i--) {
    const id = attempts[i].problem_id;
    if (index.byId.has(id) && !recent.includes(id)) recent.push(id);
  }

  if (!recent.length) {
    const picks = [];
    const topics = new Set();
    for (const d of index.docs) {
      if (d.difficulty !== 'easy' || solved.has(d.id) || topics.has(d.primaryTopic)) continue;
      topics.add(d.primaryTopic);
      picks.push({ problem: summary(d), score: null, reason: `Starter pick: an Easy ${prettyTerm('#' + d.primaryTopic)} problem.`, terms: ['#' + d.primaryTopic] });
      if (picks.length === limit) break;
    }
    return { mode: 'cold_start', items: picks, explanation: 'No attempts yet, so these are Easy problems covering different topics.' };
  }

  // Profile vector from recent attempts.
  const struggled = new Set();
  for (const id of recent) {
    const mine = attempts.filter((a) => a.problem_id === id);
    const lastAc = Math.max(-1, ...mine.filter((a) => a.verdict === 'AC').map((a) => a.seq));
    if (mine.some((a) => STRUGGLE_VERDICTS.has(a.verdict) && a.seq > lastAc)) struggled.add(id);
  }
  const profileRaw = new Map();
  let levelSum = 0, levelWeight = 0;
  recent.forEach((id, i) => {
    const w = RECENCY[i] * (struggled.has(id) ? WEIGHTS.struggle : 1);
    for (const [t, x] of index.vectors.get(id)) profileRaw.set(t, (profileRaw.get(t) || 0) + w * x);
    levelSum += RECENCY[i] * LEVEL[index.byId.get(id).difficulty];
    levelWeight += RECENCY[i];
  });
  const profile = normalize(profileRaw);
  const latest = attempts[attempts.length - 1];
  let target = levelSum / levelWeight + (latest.verdict === 'AC' ? 0.5 : 0);
  target = Math.min(2, Math.max(0, target));

  let candidates = unsolved.filter((d) => !recent.includes(d.id));
  if (candidates.length < limit) candidates = unsolved;

  const scored = candidates.map((d) => {
    const v = index.vectors.get(d.id);
    const sim = dot(profile, v);
    const fit = 1 - Math.abs(LEVEL[d.difficulty] - target) / 2;
    const score = WEIGHTS.similarity * sim + WEIGHTS.difficulty * fit;
    const contrib = [...v].map(([t, x]) => [t, x * (profile.get(t) || 0)]).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    return { d, sim, fit, score: Math.round(score * 1e6) / 1e6, terms: contrib.slice(0, 2).map(([t]) => t) };
  });
  scored.sort((a, b) => b.score - a.score || a.d.number - b.d.number);

  const items = scored.slice(0, limit).map((s) => ({
    problem: summary(s.d),
    score: s.score,
    similarity: Math.round(s.sim * 1000) / 1000,
    difficultyFit: Math.round(s.fit * 1000) / 1000,
    terms: s.terms,
    reason: reasonFor(s, index, recent, struggled, target),
  }));
  return {
    mode: 'personalized',
    items,
    explanation: `Based on your last ${recent.length} attempted problem${recent.length > 1 ? 's' : ''} and a target level near ${LEVEL_NAME[Math.round(target)]}.`,
  };
}

function reasonFor(s, index, recent, struggled, target) {
  const parts = [];
  if (s.terms.length) {
    const topicText = s.terms.map(prettyTerm).join(' and ');
    const struggledMatch = recent.find((id) => struggled.has(id) && s.terms.some((t) => index.vectors.get(id).has(t)));
    const sameTopic = recent.find((id) => s.terms.some((t) => index.vectors.get(id).has(t)));
    if (struggledMatch) parts.push(`Practises ${topicText}, where ${index.byId.get(struggledMatch).title} is still unsolved after a wrong answer or timeout.`);
    else if (sameTopic) parts.push(`Shares ${topicText} with ${index.byId.get(sameTopic).title}, which you tried recently.`);
  } else {
    parts.push('A new topic for you.');
  }
  const lvl = LEVEL[s.d.difficulty];
  if (lvl === Math.round(target)) parts.push(`${LEVEL_NAME[lvl]}, close to your recent level.`);
  else if (lvl > target) parts.push(`${LEVEL_NAME[lvl]}: a step up.`);
  else parts.push(`${LEVEL_NAME[lvl]}: a lighter warm-up.`);
  return parts.join(' ');
}

function summary(d) {
  return { id: d.id, number: d.number, title: d.title, difficulty: d.difficulty, tags: [...d.tags] };
}
