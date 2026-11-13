export const EXAMPLES = {
  contrast: {
    horizon: 30,
    tasks: [
      { name: 'Sensor', execution: 2, period: 5, deadline: 5, offset: 0 },
      { name: 'Control', execution: 4, period: 7, deadline: 7, offset: 0 },
    ],
  },
  constrained: {
    horizon: 24,
    tasks: [
      { name: 'Capture', execution: 2, period: 6, deadline: 3, offset: 0 },
      { name: 'Transmit', execution: 2, period: 8, deadline: 3, offset: 0 },
    ],
  },
  staggered: {
    horizon: 32,
    tasks: [
      { name: 'Read', execution: 1, period: 4, deadline: 2, offset: 0 },
      { name: 'Write', execution: 2, period: 8, deadline: 4, offset: 2 },
      { name: 'Report', execution: 3, period: 16, deadline: 10, offset: 4 },
    ],
  },
};
export function validate(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !['tasks', 'horizon'].includes(k))
  )
    throw Error('Scenario needs tasks and horizon only.');
  if (!Number.isInteger(input.horizon) || input.horizon < 1 || input.horizon > 2000)
    throw Error('Horizon must be an integer from 1 to 2,000.');
  if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > 8)
    throw Error('Provide between one and eight tasks.');
  const names = new Set();
  const tasks = input.tasks.map((t, id) => {
    if (
      !t ||
      typeof t !== 'object' ||
      Array.isArray(t) ||
      Object.keys(t).length !== 5 ||
      Object.keys(t).some((k) => !['name', 'execution', 'period', 'deadline', 'offset'].includes(k))
    )
      throw Error('Each task needs name, execution, period, deadline, and offset.');
    if (
      typeof t.name !== 'string' ||
      !t.name.trim() ||
      t.name.length > 32 ||
      /[\x00-\x1f]/.test(t.name) ||
      names.has(t.name.trim())
    )
      throw Error('Task names must be unique, printable, and at most 32 characters.');
    names.add(t.name.trim());
    for (const k of ['execution', 'period', 'deadline', 'offset'])
      if (!Number.isInteger(t[k])) throw Error(`${t.name}: timing values must be integers.`);
    if (
      t.period < 1 ||
      t.period > 200 ||
      t.execution < 1 ||
      t.execution > t.deadline ||
      t.deadline > t.period ||
      t.offset < 0 ||
      t.offset >= t.period
    )
      throw Error(
        `${t.name}: use 1 ≤ execution ≤ deadline ≤ period ≤ 200, and 0 ≤ offset < period.`,
      );
    return { ...t, name: t.name.trim(), id };
  });
  return { tasks, horizon: input.horizon };
}
export function simulate(input, policy = 'edf') {
  if (!['edf', 'rm'].includes(policy)) throw Error('Policy must be edf or rm.');
  const { tasks, horizon } = validate(input),
    jobs = [],
    timeline = [],
    events = [];
  let active = [],
    previous = null,
    preemptions = 0,
    busy = 0;
  const compare =
    policy === 'edf'
      ? (a, b) => a.deadline - b.deadline || a.task - b.task || a.release - b.release
      : (a, b) =>
          tasks[a.task].period - tasks[b.task].period || a.task - b.task || a.release - b.release;
  for (let time = 0; time < horizon; time++) {
    for (const task of tasks)
      if (time >= task.offset && (time - task.offset) % task.period === 0) {
        const job = {
          id: jobs.length,
          task: task.id,
          name: task.name,
          number: (time - task.offset) / task.period + 1,
          release: time,
          deadline: time + task.deadline,
          execution: task.execution,
          remaining: task.execution,
          firstStart: null,
          completion: null,
          missed: false,
        };
        jobs.push(job);
        active.push(job);
        events.push({ time, type: 'release', job: job.id });
      }
    active.sort(compare);
    const job = active[0] || null;
    if (previous !== null && jobs[previous].remaining > 0 && job?.id !== previous) {
      preemptions++;
      events.push({ time, type: 'preempt', job: previous });
    }
    if (job) {
      busy++;
      job.firstStart ??= time;
      job.remaining--;
      if (job.remaining === 0) {
        job.completion = time + 1;
        events.push({ time: time + 1, type: 'complete', job: job.id });
        active = active.filter((j) => j.id !== job.id);
      }
    }
    const last = timeline.at(-1),
      id = job?.id ?? null;
    if (last && last.job === id) last.end = time + 1;
    else timeline.push({ start: time, end: time + 1, job: id, task: job?.task ?? null });
    previous = id;
    for (const pending of active)
      if (pending.deadline === time + 1) {
        pending.missed = true;
        events.push({ time: time + 1, type: 'miss', job: pending.id });
      }
  }
  for (const job of jobs) {
    job.response = job.completion === null ? null : job.completion - job.release;
    job.lateness = job.completion === null ? null : job.completion - job.deadline;
    job.status = job.missed
      ? job.completion === null
        ? 'overdue'
        : 'late'
      : job.completion === null
        ? 'pending'
        : 'on time';
  }
  return {
    policy,
    horizon,
    jobs,
    timeline,
    events,
    preemptions,
    busy,
    idle: horizon - busy,
    misses: jobs.filter((j) => j.missed).length,
    completed: jobs.filter((j) => j.completion !== null).length,
    due: jobs.filter((j) => j.deadline <= horizon).length,
  };
}
function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}
export function analyze(input) {
  const { tasks } = validate(input),
    utilization = tasks.reduce((s, t) => s + t.execution / t.period, 0),
    synchronous = tasks.every((t) => t.offset === 0),
    priority = [...tasks].sort((a, b) => a.period - b.period || a.id - b.id),
    responses = [];
  for (let i = 0; i < priority.length; i++) {
    const task = priority[i],
      steps = [task.execution];
    let r = task.execution;
    while (r <= task.deadline) {
      const next =
        task.execution +
        priority.slice(0, i).reduce((s, h) => s + Math.ceil(r / h.period) * h.execution, 0);
      if (next === r) break;
      steps.push(next);
      r = next;
    }
    responses.push({
      task: task.id,
      name: task.name,
      deadline: task.deadline,
      bound: r,
      passes: r <= task.deadline,
      steps,
    });
  }
  let hyperperiod = 1;
  for (const t of tasks) {
    hyperperiod = (hyperperiod / gcd(hyperperiod, t.period)) * t.period;
    if (hyperperiod > 200000) {
      hyperperiod = null;
      break;
    }
  }
  const rm = {
    status: responses.every((r) => r.passes) ? 'pass' : synchronous ? 'fail' : 'not-proven',
    responses,
  };
  let edf;
  if (utilization > 1 + 1e-12)
    edf = {
      status: 'fail',
      reason: 'Long-run utilization exceeds one processor.',
      witness: null,
      checked: 0,
    };
  else if (hyperperiod === null)
    edf = {
      status: 'inconclusive',
      reason: 'Exact hyperperiod exceeds the 200,000-tick analysis limit.',
      witness: null,
      checked: 0,
    };
  else {
    const points = new Set();
    for (const t of tasks) for (let d = t.deadline; d <= hyperperiod; d += t.period) points.add(d);
    let witness = null,
      checked = 0,
      minSlack = Infinity;
    for (const time of [...points].sort((a, b) => a - b)) {
      const terms = tasks.map(
          (t) => Math.max(0, Math.floor((time - t.deadline) / t.period) + 1) * t.execution,
        ),
        demand = terms.reduce((s, c) => s + c, 0);
      checked++;
      minSlack = Math.min(minSlack, time - demand);
      if (demand > time) {
        witness = { time, demand, terms };
        break;
      }
    }
    edf = {
      status: witness ? (synchronous ? 'fail' : 'not-proven') : 'pass',
      reason: witness
        ? 'Synchronous processor demand exceeds available time.'
        : 'All demand-bound checkpoints through one hyperperiod pass.',
      witness,
      checked,
      minSlack,
    };
  }
  return {
    utilization,
    hyperperiod,
    synchronous,
    rm,
    edf,
    assumptions:
      'One fully preemptive processor; independent periodic jobs; integer timing; no blocking, jitter, or scheduling overhead. Offset scenarios use synchronous worst-case bounds; a failed bound does not establish failure for that particular offset pattern.',
  };
}
export function compare(input) {
  const scenario = validate(input);
  const clean = { horizon: scenario.horizon, tasks: scenario.tasks.map(({ id, ...t }) => t) };
  return {
    scenario: clean,
    analysis: analyze(clean),
    edf: simulate(clean, 'edf'),
    rm: simulate(clean, 'rm'),
  };
}
export function jobsCSV(run) {
  const quote = (v) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
  return (
    [
      [
        'task',
        'job',
        'release',
        'deadline',
        'execution',
        'first_start',
        'completion',
        'response',
        'lateness',
        'status',
      ],
      ...run.jobs.map((j) => [
        j.name,
        j.number,
        j.release,
        j.deadline,
        j.execution,
        j.firstStart,
        j.completion,
        j.response,
        j.lateness,
        j.status,
      ]),
    ]
      .map((row) => row.map(quote).join(','))
      .join('\r\n') + '\r\n'
  );
}
