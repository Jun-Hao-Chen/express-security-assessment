'use strict';

// Security regression tests for the forum.
//
//   node --test test/security.test.js                          -> tests app.js
//   APP_FILE=app.original.js node --test test/security.test.js -> same tests, pre-fix code
//
// Each test starts its own copy of the app in a temporary directory with an
// empty data/messages.json, so the real data file is never touched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROJECT_DIR = path.resolve(__dirname, '..');
const APP_FILE = path.resolve(PROJECT_DIR, process.env.APP_FILE || 'app.js');
let nextPort = 3200;

async function startApp({ adminPassword } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forum-test-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.copyFileSync(APP_FILE, path.join(dir, 'app.js'));
  const dataFile = path.join(dir, 'data', 'messages.json');
  fs.writeFileSync(dataFile, '[]\n');

  const port = nextPort++;
  const env = { ...process.env, PORT: String(port), NODE_PATH: path.join(PROJECT_DIR, 'node_modules') };
  delete env.ADMIN_PASSWORD;
  if (adminPassword) env.ADMIN_PASSWORD = adminPassword;

  const child = spawn(process.execPath, [path.join(dir, 'app.js')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('app did not start within 5s')), 5000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('running at')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => reject(new Error(`app exited early with code ${code}`)));
  });

  return {
    base: `http://127.0.0.1:${port}`,
    readData: () => JSON.parse(fs.readFileSync(dataFile, 'utf8')),
    stop: () => {
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function post(base, route, fields) {
  return fetch(base + route, {
    method: 'POST',
    body: new URLSearchParams(fields),
    redirect: 'manual'
  });
}

test('F1: admin login fails closed when ADMIN_PASSWORD is not set', async () => {
  const app = await startApp();
  try {
    const res = await post(app.base, '/admin/login', { password: '' });
    const body = await res.text();
    assert.ok(!body.includes('Admin login succeeded'), 'empty password must not log in');
    assert.notEqual(res.status, 200);
  } finally {
    app.stop();
  }
});

test('F1: admin login accepts only the configured password', async () => {
  const app = await startApp({ adminPassword: 'correct-horse' });
  try {
    const wrong = await (await post(app.base, '/admin/login', { password: 'wrong' })).text();
    const right = await (await post(app.base, '/admin/login', { password: 'correct-horse' })).text();
    assert.ok(wrong.includes('Admin login failed'));
    assert.ok(right.includes('Admin login succeeded'));
  } finally {
    app.stop();
  }
});

test('F2: status endpoint does not reveal whether an admin password is set', async () => {
  const app = await startApp();
  try {
    const status = await (await fetch(app.base + '/lab/status')).json();
    assert.equal(status.adminPasswordConfigured, undefined);
  } finally {
    app.stop();
  }
});

test('F3: new posts enforce the same server-side length limit as edits', async () => {
  const app = await startApp();
  try {
    const res = await post(app.base, '/messages', { name: 'tester', message: 'A'.repeat(2001) });
    assert.equal(res.status, 400);
    assert.equal(app.readData().length, 0, 'oversized post must not be stored');
  } finally {
    app.stop();
  }
});

test('F3: a 90,000-character post is rejected and not stored', async () => {
  const app = await startApp();
  try {
    const res = await post(app.base, '/messages', { name: 'tester', message: 'A'.repeat(90000) });
    assert.ok([400, 413].includes(res.status), `expected 400 or 413, got ${res.status}`);
    assert.equal(app.readData().length, 0);
  } finally {
    app.stop();
  }
});

test('F3: replies enforce the length limit', async () => {
  const app = await startApp();
  try {
    await post(app.base, '/messages', { name: 'tester', message: 'parent post' });
    const parentId = app.readData()[0].id;
    const res = await post(app.base, `/messages/${parentId}/reply`, { name: 'tester', message: 'A'.repeat(2001) });
    assert.equal(res.status, 400);
    assert.equal(app.readData().length, 1, 'oversized reply must not be stored');
  } finally {
    app.stop();
  }
});

test('F3: a missing field returns 400 instead of crashing the handler (500)', async () => {
  const app = await startApp();
  try {
    const res = await post(app.base, '/messages', { name: 'only-a-name' });
    assert.equal(res.status, 400);
  } finally {
    app.stop();
  }
});

test('F4: 50 concurrent posts are all stored, with unique IDs', async () => {
  const app = await startApp();
  try {
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) => post(app.base, '/messages', { name: 'race-test', message: `race-${i}` }))
    );
    const statuses = responses.map((res) => res.status);
    assert.deepEqual([...new Set(statuses)], [302], `unexpected statuses: ${statuses.join(',')}`);

    const stored = app.readData().filter((m) => String(m.message).startsWith('race-'));
    assert.equal(stored.length, 50, 'every acknowledged post must be persisted');
    assert.equal(new Set(stored.map((m) => m.id)).size, 50, 'IDs must be unique');
  } finally {
    app.stop();
  }
});
