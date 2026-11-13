import test from 'node:test';
import assert from 'node:assert/strict';
import { validate, simulate, analyze, compare, jobsCSV, EXAMPLES } from '../core.js';
const task = (execution, period, deadline = period, offset = 0, name = 'A') => ({
  name,
  execution,
  period,
  deadline,
  offset,
});
const scenario = (tasks, horizon = 30) => ({ tasks, horizon });
test('validation enforces bounded constrained-deadline task model', () => {
  for (const bad of [
    scenario([]),
    scenario([task(3, 2)]),
    scenario([task(1, 201)]),
    scenario([task(1, 4, 4, 4)]),
    scenario([task(1, 4), task(1, 5)]),
    scenario([task(1.5, 4)]),
    scenario([task(1, 4)], 2001),
    { ...EXAMPLES.contrast, other: 1 },
  ])
    assert.throws(() => validate(bad));
  assert.throws(() => simulate(EXAMPLES.contrast, 'fifo'));
  assert.equal(validate(EXAMPLES.contrast).tasks.length, 2);
});
test('completion at the deadline succeeds and release at horizon is excluded', () => {
  const r = simulate(scenario([task(2, 2)], 6));
  assert.equal(r.misses, 0);
  assert.equal(r.jobs.length, 3);
  assert.deepEqual(
    r.jobs.map((j) => j.completion),
    [2, 4, 6],
  );
  assert.equal(r.busy, 6);
});
test('EDF meets a high-utilization set that rate monotonic misses', () => {
  const r = compare(EXAMPLES.contrast);
  assert.equal(r.edf.misses, 0);
  assert.ok(r.rm.misses > 0);
  assert.equal(r.analysis.edf.status, 'pass');
  assert.equal(r.analysis.rm.status, 'fail');
  assert.ok(r.rm.preemptions > 0);
});
test('low utilization alone does not certify constrained deadlines', () => {
  const a = analyze(EXAMPLES.constrained);
  assert.ok(a.utilization < 1);
  assert.equal(a.edf.status, 'fail');
  assert.deepEqual(a.edf.witness, { time: 3, demand: 4, terms: [2, 2] });
  assert.ok(simulate(EXAMPLES.constrained).misses > 0);
});
test('offsets delay releases and failed synchronous bounds are qualified', () => {
  const input = scenario([task(2, 6, 3, 0, 'A'), task(2, 8, 3, 3, 'B')], 3);
  const r = simulate(input);
  assert.equal(r.jobs.length, 1);
  assert.equal(analyze(input).edf.status, 'not-proven');
  assert.equal(analyze(input).rm.status, 'not-proven');
});
test('overload rejects all offset patterns and large hyperperiod remains inconclusive', () => {
  assert.equal(
    analyze(scenario([task(2, 3, 3, 1, 'A'), task(2, 3, 3, 0, 'B')])).edf.status,
    'fail',
  );
  const a = analyze(
    scenario([task(1, 197, 197, 0, 'A'), task(1, 199, 199, 0, 'B'), task(1, 193, 193, 0, 'C')]),
  );
  assert.equal(a.hyperperiod, null);
  assert.equal(a.edf.status, 'inconclusive');
});
test('response-time recurrence exposes interference steps and deterministic ties', () => {
  const a = analyze(scenario([task(1, 4), task(2, 5, 5, 0, 'B')]));
  assert.deepEqual(a.rm.responses[1].steps, [2, 3]);
  assert.equal(a.rm.responses[1].bound, 3);
  const r = simulate(scenario([task(1, 4), task(1, 4, 4, 0, 'B')], 4), 'rm');
  assert.deepEqual(
    r.timeline.map((s) => s.task),
    [0, 1, null],
  );
});
test('unfinished future jobs are pending, missed jobs remain overdue or late', () => {
  const r = simulate(scenario([task(2, 3, 3, 0, 'A'), task(2, 3, 3, 0, 'B')], 4));
  assert.equal(r.jobs[1].status, 'late');
  assert.equal(r.jobs[1].lateness, 1);
  assert.ok(r.jobs.some((j) => j.status === 'pending'));
  const short = simulate(scenario([task(2, 3, 3, 0, 'A'), task(2, 3, 3, 0, 'B')], 3));
  assert.equal(short.jobs[1].status, 'overdue');
});
let seed = 9317;
const random = (n) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % n;
};
function matchingFeasible(input) {
  const units = [];
  for (const t of input.tasks)
    for (let release = t.offset; release + t.deadline <= input.horizon; release += t.period)
      for (let u = 0; u < t.execution; u++) units.push({ release, deadline: release + t.deadline });
  const slots = Array(input.horizon).fill(-1);
  function assign(unit, seen) {
    for (let tick = units[unit].release; tick < units[unit].deadline; tick++) {
      if (seen.has(tick)) continue;
      seen.add(tick);
      if (slots[tick] === -1 || assign(slots[tick], seen)) {
        slots[tick] = unit;
        return true;
      }
    }
    return false;
  }
  return units.every((_, i) => assign(i, new Set()));
}
test('EDF finite-horizon feasibility agrees with independent bipartite matching on 400 scenarios', () => {
  for (let trial = 0; trial < 400; trial++) {
    const tasks = Array.from({ length: 1 + random(3) }, (_, i) => {
        const period = 2 + random(6),
          deadline = 1 + random(period);
        return task(1 + random(deadline), period, deadline, random(period), String(i));
      }),
      input = scenario(tasks, 6 + random(15));
    assert.equal(simulate(input).misses === 0, matchingFeasible(input), JSON.stringify(input));
  }
});
test('timelines conserve execution, respect releases, and count true preemptions', () => {
  for (const input of Object.values(EXAMPLES))
    for (const policy of ['edf', 'rm']) {
      const r = simulate(input, policy),
        executed = new Map();
      let end = 0,
        preemptions = 0;
      for (let i = 0; i < r.timeline.length; i++) {
        const s = r.timeline[i];
        assert.equal(s.start, end);
        assert.ok(s.end > s.start);
        end = s.end;
        if (s.job !== null) {
          const j = r.jobs[s.job];
          assert.ok(s.start >= j.release);
          executed.set(j.id, (executed.get(j.id) || 0) + s.end - s.start);
          if (i + 1 < r.timeline.length && j.completion !== s.end) preemptions++;
        }
      }
      assert.equal(end, input.horizon);
      assert.equal(preemptions, r.preemptions);
      for (const j of r.jobs) assert.equal(executed.get(j.id) || 0, j.execution - j.remaining);
      assert.equal(r.busy + r.idle, r.horizon);
    }
});
test('EDF analysis agrees with synchronous simulation through bounded hyperperiods', () => {
  for (let trial = 0; trial < 150; trial++) {
    const tasks = Array.from({ length: 1 + random(3) }, (_, i) => {
      const p = 2 + random(7),
        d = 1 + random(p);
      return task(1 + random(d), p, d, 0, String(i));
    });
    const input = scenario(tasks),
      a = analyze(input);
    assert.ok(a.hyperperiod <= 2000);
    input.horizon = a.hyperperiod;
    assert.equal(a.edf.status === 'pass', simulate(input).misses === 0, JSON.stringify(input));
    assert.equal(a.rm.status === 'pass', simulate(input, 'rm').misses === 0, JSON.stringify(input));
  }
});
test('reports are deterministic, immutable, and CSV escapes names', () => {
  const input = scenario([task(1, 4, 4, 0, 'Name, "quoted"')], 5),
    copy = structuredClone(input);
  assert.deepEqual(compare(input), compare(input));
  assert.deepEqual(input, copy);
  assert.ok(jobsCSV(simulate(input)).includes('"Name, ""quoted"""'));
});
