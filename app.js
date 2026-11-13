import { EXAMPLES, jobsCSV } from './core.js';
const $ = (id) => document.getElementById(id),
  colors = ['#4983ac', '#d79a49', '#6b9d87', '#a28ab9', '#ce7f78', '#83a3b7', '#b1a158', '#7e8ec0'];
let scenario = structuredClone(EXAMPLES.contrast),
  result = null,
  policy = 'edf',
  worker = null,
  revision = 0;
function el(tag, text, className) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (className) n.className = className;
  return n;
}
function svg(tag, attrs, text) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) n.setAttribute(key, String(value));
  if (text !== undefined) n.textContent = text;
  return n;
}
function status(text) {
  $('status').textContent = text;
}
function invalidate() {
  revision++;
  worker?.terminate();
  worker = null;
  result = null;
  $('run').disabled = false;
  $('results').hidden = true;
  status('Task fleet changed. Run again to update the evidence.');
}
function taskEditor() {
  const fragment = document.createDocumentFragment();
  scenario.tasks.forEach((task, i) => {
    const row = el('tr');
    for (const key of ['name', 'execution', 'period', 'deadline', 'offset']) {
      const cell = el('td'),
        input = el('input');
      input.type = key === 'name' ? 'text' : 'number';
      input.value = task[key];
      input.setAttribute('aria-label', `${key} for task ${i + 1}`);
      if (key === 'name') input.maxLength = 32;
      else {
        input.min = key === 'offset' ? 0 : 1;
        input.max = 200;
        input.step = 1;
      }
      input.addEventListener('input', () => {
        task[key] = key === 'name' ? input.value : Number(input.value);
        invalidate();
      });
      cell.append(input);
      row.append(cell);
    }
    const cell = el('td'),
      remove = el('button', '×');
    remove.setAttribute('aria-label', `Remove task ${i + 1}`);
    remove.disabled = scenario.tasks.length === 1;
    remove.addEventListener('click', () => {
      scenario.tasks.splice(i, 1);
      invalidate();
      taskEditor();
    });
    cell.append(remove);
    row.append(cell);
    fragment.append(row);
  });
  $('tasks').replaceChildren(fragment);
  $('add').disabled = scenario.tasks.length >= 8;
  $('horizon').value = scenario.horizon;
}
function download(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type })),
    a = el('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function inspect(id) {
  const j = result[policy].jobs[id];
  $('inspector').textContent =
    `${j.name} / job ${j.number} · released ${j.release} · deadline ${j.deadline} · first ran ${j.firstStart ?? 'not yet'} · completed ${j.completion ?? 'unfinished'} · response ${j.response ?? 'pending'} · remaining ${j.remaining} ticks · ${j.status}`;
}
function timeline() {
  if (!result) return;
  const run = result[policy],
    windowSize = Math.min(Number($('window').value), run.horizon),
    max = run.horizon - windowSize;
  $('start').max = max;
  $('start').value = Math.min(Number($('start').value), max);
  const start = Number($('start').value),
    end = start + windowSize,
    unit = 22,
    left = 105,
    width = left + windowSize * unit + 20,
    height = 60 + scenario.tasks.length * 48;
  const canvas = $('timeline');
  canvas.setAttribute('width', width);
  canvas.setAttribute('height', height);
  canvas.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const fragment = document.createDocumentFragment();
  for (let t = start; t <= end; t++) {
    const x = left + (t - start) * unit;
    fragment.append(svg('line', { x1: x, x2: x, y1: 25, y2: height - 15, stroke: '#e8eef3' }));
    if ((t - start) % Math.max(1, Math.ceil(windowSize / 30)) === 0)
      fragment.append(svg('text', { x, y: 15, 'text-anchor': 'middle' }, t));
  }
  scenario.tasks.forEach((task, i) => {
    fragment.append(svg('text', { x: 5, y: 51 + i * 48 }, task.name.slice(0, 15)));
  });
  for (const s of run.timeline) {
    if (s.task === null || s.end <= start || s.start >= end) continue;
    const j = run.jobs[s.job],
      x = left + (Math.max(s.start, start) - start) * unit,
      y = 33 + s.task * 48,
      rect = svg('rect', {
        x,
        y,
        width: (Math.min(s.end, end) - Math.max(s.start, start)) * unit - 1,
        height: 27,
        rx: 3,
        fill: colors[s.task],
        class: 'segment',
        tabindex: 0,
        role: 'button',
        'aria-label': `${j.name} job ${j.number}, execution ${s.start} to ${s.end}`,
      });
    rect.append(
      svg(
        'title',
        {},
        `${j.name} #${j.number}: ${s.start}–${s.end}, deadline ${j.deadline}, ${j.status}`,
      ),
    );
    rect.addEventListener('click', () => inspect(j.id));
    rect.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        inspect(j.id);
      }
    });
    fragment.append(rect);
  }
  for (const j of run.jobs) {
    if (j.deadline < start || j.deadline > end) continue;
    const x = left + (j.deadline - start) * unit,
      y = 65 + j.task * 48;
    const diamond = svg('path', {
      d: `M${x} ${y - 4} l4 4 -4 4 -4 -4 Z`,
      fill: j.missed ? '#b54f44' : '#8398a9',
    });
    diamond.append(
      svg(
        'title',
        {},
        `${j.name} #${j.number} deadline ${j.deadline}${j.missed ? ' · missed' : ''}`,
      ),
    );
    fragment.append(diamond);
  }
  canvas.replaceChildren(fragment);
  $('range').textContent = `${start}–${end}`;
}
function ledger() {
  const run = result[policy],
    filter = $('filter').value,
    rows = run.jobs.filter(
      (j) =>
        filter === 'all' ||
        (filter === 'missed' && j.missed) ||
        (filter === 'pending' && j.completion === null),
    ),
    fragment = document.createDocumentFragment();
  for (const j of rows.slice(0, 200)) {
    const row = el('tr');
    for (const value of [
      `${j.name} / ${j.number}`,
      j.release,
      j.deadline,
      j.completion ?? '—',
      j.response ?? '—',
      j.status,
    ])
      row.append(el('td', value));
    fragment.append(row);
  }
  $('ledger').replaceChildren(fragment);
  $('ledger-count').textContent =
    `Showing ${Math.min(rows.length, 200)} of ${rows.length} matching jobs. CSV includes all ${run.jobs.length} jobs for this policy.`;
}
function switchPolicy(next) {
  policy = next;
  for (const key of ['edf', 'rm']) $(key).setAttribute('aria-pressed', String(key === policy));
  $('inspector').textContent = 'Select an execution bar to inspect its job.';
  timeline();
  ledger();
}
function render() {
  const a = result.analysis,
    comparison = document.createDocumentFragment();
  for (const key of ['edf', 'rm']) {
    const run = result[key],
      card = el('article', undefined, 'card');
    card.append(el('h3', key === 'edf' ? 'EARLIEST DEADLINE FIRST' : 'RATE MONOTONIC'));
    const metric = el('div', String(run.misses), 'metric');
    metric.append(el('small', 'missed deadlines'));
    card.append(
      metric,
      el(
        'p',
        `${run.completed} completed / ${run.jobs.length} released · ${run.due} due within preview\n${run.preemptions} preemptions · ${run.idle} idle ticks`,
      ),
    );
    comparison.append(card);
  }
  $('comparison').replaceChildren(comparison);
  const legend = document.createDocumentFragment();
  scenario.tasks.forEach((task, i) => {
    const item = el('span'),
      dot = el('i');
    dot.style.backgroundColor = colors[i];
    item.append(dot, el('span', task.name));
    legend.append(item);
  });
  $('legend').replaceChildren(legend);
  const proofs = document.createDocumentFragment();
  for (const key of ['edf', 'rm']) {
    const proof = a[key],
      card = el('article', undefined, 'card'),
      state = el('h3', `${key.toUpperCase()} / ${proof.status.toUpperCase()}`, proof.status);
    card.append(state);
    if (key === 'edf') {
      card.append(el('p', proof.reason));
      if (proof.witness)
        card.append(
          el(
            'p',
            `${proof.witness.demand} required ticks in a ${proof.witness.time}-tick interval. Per-task demand: ${proof.witness.terms.join(' + ')}.`,
          ),
        );
      card.append(
        el(
          'p',
          `${proof.checked} checkpoints · hyperperiod ${a.hyperperiod ?? '> 200,000'} · utilization ${(a.utilization * 100).toFixed(2)}%`,
        ),
      );
    } else
      card.append(
        el(
          'p',
          `${proof.responses.filter((r) => r.passes).length} / ${proof.responses.length} response-time bounds meet their deadlines. Priority: shorter period first; ties use task order.`,
        ),
      );
    proofs.append(card);
  }
  $('proofs').replaceChildren(proofs);
  $('iterations').replaceChildren(
    ...a.rm.responses.map((r) =>
      el(
        'p',
        `${r.name}: ${r.steps.join(' → ')} ticks; deadline ${r.deadline} · ${r.passes ? 'passes' : 'bound exceeds deadline'}`,
      ),
    ),
  );
  $('assumptions').textContent = a.assumptions;
  $('results').hidden = false;
  switchPolicy(policy);
}
function run(candidate = scenario) {
  worker?.terminate();
  const ticket = ++revision,
    current = new Worker('./worker.js', { type: 'module' });
  worker = current;
  $('run').disabled = true;
  status('Simulating both policies and checking schedulability…');
  current.onmessage = ({ data }) => {
    if (ticket !== revision) return;
    current.terminate();
    worker = null;
    $('run').disabled = false;
    if (data.error) {
      status(data.error);
      return;
    }
    result = data.result;
    scenario = structuredClone(result.scenario);
    taskEditor();
    $('start').value = 0;
    render();
    status(
      `Compared ${scenario.horizon} ticks. The preview and all-time model checks are shown separately.`,
    );
  };
  current.onerror = () => {
    if (ticket !== revision) return;
    current.terminate();
    worker = null;
    $('run').disabled = false;
    status('The scheduling worker failed. Try again.');
  };
  current.postMessage(candidate);
}
$('add').addEventListener('click', () => {
  let id = 1;
  while (scenario.tasks.some((t) => t.name === `Task ${id}`)) id++;
  scenario.tasks.push({ name: `Task ${id}`, execution: 1, period: 10, deadline: 10, offset: 0 });
  invalidate();
  taskEditor();
});
$('horizon').addEventListener('input', () => {
  scenario.horizon = Number($('horizon').value);
  invalidate();
});
$('example').addEventListener('change', () => {
  invalidate();
  scenario = structuredClone(EXAMPLES[$('example').value]);
  taskEditor();
  run();
});
$('run').addEventListener('click', () => run());
for (const key of ['edf', 'rm']) $(key).addEventListener('click', () => switchPolicy(key));
$('window').addEventListener('change', timeline);
$('start').addEventListener('input', timeline);
$('filter').addEventListener('change', ledger);
$('csv').addEventListener('click', () =>
  download(`deadline-${policy}-jobs.csv`, jobsCSV(result[policy]), 'text/csv;charset=utf-8'),
);
$('export').addEventListener('click', () =>
  download('deadline-scenario.json', JSON.stringify(result.scenario, null, 2)),
);
$('report').addEventListener('click', () =>
  download('deadline-analysis.json', JSON.stringify(result, null, 2)),
);
$('import').addEventListener('change', async () => {
  const file = $('import').files[0];
  if (!file) return;
  worker?.terminate();
  worker = null;
  $('run').disabled = false;
  const ticket = ++revision;
  try {
    if (file.size > 10000) throw Error('Scenarios must be at most 10 KB.');
    const candidate = JSON.parse(await file.text());
    if (ticket === revision) run(candidate);
  } catch (e) {
    if (ticket === revision) status(`Import rejected: ${e.message}`);
  } finally {
    $('import').value = '';
  }
});
taskEditor();
run();
