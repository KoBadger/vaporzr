import { decide, problemsFor } from './monitor-worker.mjs';

const assert = (cond, msg) => {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exitCode = 1;
  } else console.log('ok:', msg);
};

const now = 1_000_000_000_000;

// Healthy payload, first ever run: silence, but remember the state.
let d = decide([], null, now, 180);
assert(d.notify === false, 'healthy first run does not alert');

// Healthy after an alert: recovery notice exactly once.
d = decide([], { sig: 'librespot', at: now - 60_000 }, now, 180);
assert(d.notify === true && d.kind === 'recovered', 'recovery announced once');
const afterRecovery = decide([], d.next, now + 60_000, 180);
assert(afterRecovery.notify === false, 'recovery not repeated');

// Same problem inside the window: suppressed.
const problems = problemsFor({
  ok: true,
  librespot: 'stopped',
  youtube: 'ok',
  backup: { stale: false, error: null, ageHours: 3 },
});
assert(problems.length === 1 && problems[0].key === 'librespot', 'librespot detected');
d = decide(problems, { sig: 'librespot', at: now - 60_000 }, now, 180);
assert(d.notify === false && d.kind === 'suppressed', 'repeat suppressed inside window');
d = decide(problems, { sig: 'librespot', at: now - 181 * 60_000 }, now, 180);
assert(d.notify === true && d.kind === 'alert', 'repeat re-alerts after window');

// Stale backup is a problem; a missing backup block is also a problem.
const stale = problemsFor({ ok: true, backup: { stale: true, ageHours: 60, error: null } });
assert(
  stale.some((p) => p.key === 'backup-stale'),
  'stale backup detected',
);
const unreported = problemsFor({ ok: true });
assert(
  unreported.some((p) => p.key === 'backup-unreported'),
  'missing backup state is reported, not assumed fine',
);
const failed = problemsFor({ ok: true, backup: { stale: false, error: 'restic: repository is full' } });
assert(
  failed.some((p) => p.key === 'backup-error'),
  'backup error surfaced',
);

// Down: single problem, no cascade.
const down = problemsFor(null);
assert(down.length === 1 && down[0].key === 'down', 'missing payload is one "down" problem');

console.log(process.exitCode ? 'FAILED' : 'ALL_OK');
