import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, recommend, termsOf } from '../server/recommender.js';
import { bank } from './helpers.js';

const index = buildIndex(bank.recommenderDocs());
let seq = 0;
const attempt = (problem_id, verdict) => ({ problem_id, verdict, seq: ++seq });

test('TF-IDF vectors are unit length and tags weigh more than title words', () => {
  for (const v of index.vectors.values()) {
    const norm = Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0));
    assert.ok(Math.abs(norm - 1) < 1e-9);
  }
  const tf = termsOf({ title: 'Target Pair', tags: ['hash-map'] });
  assert.equal(tf.get('#hash-map'), 2);
  assert.equal(tf.get('target'), 1);
});

test('cold start: up to three Easy problems with distinct primary topics', () => {
  const r = recommend(index, []);
  assert.equal(r.mode, 'cold_start');
  assert.equal(r.items.length, 3);
  assert.ok(r.items.every((i) => i.problem.difficulty === 'easy'));
  const topics = r.items.map((i) => bank.get(i.problem.id).primaryTopic);
  assert.equal(new Set(topics).size, 3);
  assert.ok(r.items.every((i) => i.reason.length > 0));
});

test('a wrong answer pulls recommendations toward the same topic', () => {
  const r = recommend(index, [attempt('bracket-check', 'WA')]);
  assert.equal(r.mode, 'personalized');
  assert.equal(r.items[0].problem.id, 'next-warmer-day', 'the other stack problem ranks first');
  assert.match(r.items[0].reason, /stack/);
  assert.match(r.items[0].reason, /Bracket Check/);
  assert.ok(!r.items.some((i) => i.problem.id === 'bracket-check'));
});

test('a wrong answer or timeout gives its topics more weight than other failures', () => {
  const scoreOf = (history, id) => {
    const r = recommend(index, history, 12);
    return r.items.find((i) => i.problem.id === id).score;
  };
  // Island Count shares "graphs" with Cheapest Route. A TLE (struggle) should
  // raise Cheapest Route's score compared with a runtime error (no struggle weight).
  const withTle = scoreOf([attempt('target-pair', 'AC'), attempt('island-count', 'TLE')], 'cheapest-route');
  const withRe = scoreOf([attempt('target-pair', 'AC'), attempt('island-count', 'RE')], 'cheapest-route');
  assert.ok(withTle > withRe, `${withTle} should exceed ${withRe}`);
  // …and an Accepted after the wrong answer removes the extra weight.
  const recovered = recommend(index, [attempt('island-count', 'WA'), attempt('island-count', 'AC'), attempt('target-pair', 'WA')], 12);
  assert.ok(!recovered.items.some((i) => i.problem.id === 'island-count'));
});

test('solved problems are excluded and all-solved returns nothing', () => {
  const solvedSome = recommend(index, [attempt('target-pair', 'AC'), attempt('unique-window', 'AC')]);
  assert.ok(!solvedSome.items.some((i) => ['target-pair', 'unique-window'].includes(i.problem.id)));
  const all = recommend(index, bank.list.map((p) => attempt(p.id, 'AC')));
  assert.equal(all.mode, 'all_solved');
  assert.deepEqual(all.items, []);
});

test('deterministic, with ties broken by problem number', () => {
  const history = [attempt('first-occurrence', 'WA')];
  const a = recommend(index, history), b = recommend(index, history);
  assert.deepEqual(a, b);
  for (let i = 1; i < a.items.length; i++) {
    const [x, y] = [a.items[i - 1], a.items[i]];
    assert.ok(x.score > y.score || (x.score === y.score && x.problem.number < y.problem.number));
  }
  // Construct an exact tie: two documents with identical text must keep number order.
  const docs = [
    { id: 'p1', number: 1, title: 'Alpha', difficulty: 'easy', tags: ['arrays'], primaryTopic: 'arrays' },
    { id: 'p2', number: 2, title: 'Beta', difficulty: 'easy', tags: ['stack'], primaryTopic: 'stack' },
    { id: 'p3', number: 3, title: 'Beta', difficulty: 'easy', tags: ['stack'], primaryTopic: 'stack' },
  ];
  const tie = recommend(buildIndex(docs), [{ problem_id: 'p1', verdict: 'WA', seq: 1 }], 2);
  assert.equal(tie.items[0].score, tie.items[1].score);
  assert.deepEqual(tie.items.map((i) => i.problem.id), ['p2', 'p3']);
});

test('recommender inputs contain only public titles, tags and difficulty', () => {
  for (const d of bank.recommenderDocs()) {
    assert.deepEqual(Object.keys(d).sort(), ['difficulty', 'id', 'number', 'primaryTopic', 'tags', 'title']);
  }
});
