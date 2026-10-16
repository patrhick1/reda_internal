import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const credential = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
const token = credential.split('\n').find(x => x.startsWith('password='))?.slice(9);
if (!token) throw Error('GitHub credential unavailable');
const mode = process.argv[2];
let endpoint, body, method = 'GET';
if (mode === 'create') {
  endpoint = 'pulls'; method = 'POST';
  body = { base: 'main', head: 'codex/to-work-on-abcd', title: 'Fix Bowan quantities, rollover attempts and operations visibility', body: readFileSync('tools/to-work-on-20261016/pr-body.txt', 'utf8') };
} else if (mode === 'merge') {
  endpoint = 'pulls/' + Number(process.argv[3]) + '/merge'; method = 'PUT'; body = { merge_method: 'squash', sha: process.argv[4] };
} else if (mode === 'checks') endpoint = 'commits/' + process.argv[3] + '/check-runs';
else if (mode === 'status') endpoint = 'commits/' + process.argv[3] + '/status';
else if (mode === 'runs') endpoint = 'actions/runs?head_sha=' + process.argv[3];
else if (mode === 'jobs') endpoint = 'actions/runs/' + Number(process.argv[3]) + '/jobs';
else if (mode === 'joblog') endpoint = 'actions/jobs/' + Number(process.argv[3]) + '/logs';
else throw Error('Unknown mode');
const r = await fetch('https://api.github.com/repos/patrhick1/reda_internal/' + endpoint, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
if (!r.ok) throw Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 600)}`);
if (mode === 'joblog') { console.log((await r.text()).split('\n').filter(x => /error|fail|PASS|passed|not ok/i.test(x)).join('\n')); process.exit(); }
const d = await r.json();
if (d.check_runs) console.log(JSON.stringify(d.check_runs.map(x => ({ id: x.id, name: x.name, status: x.status, conclusion: x.conclusion, url: x.details_url }))));
else if (d.workflow_runs) console.log(JSON.stringify(d.workflow_runs.map(x => ({ id: x.id, sha: x.head_sha, status: x.status, conclusion: x.conclusion, url: x.html_url }))));
else if (d.jobs) console.log(JSON.stringify(d.jobs.map(x => ({ id: x.id, name: x.name, status: x.status, conclusion: x.conclusion, steps: x.steps.map(y => ({ name: y.name, conclusion: y.conclusion })) }))));
else if (d.statuses) console.log(JSON.stringify({ state: d.state, statuses: d.statuses.map(x => ({ state: x.state, context: x.context, url: x.target_url, description: x.description })) }));
else console.log(JSON.stringify({ number: d.number, url: d.html_url, head: d.head?.sha, sha: d.sha, merged: d.merged, message: d.message }));
