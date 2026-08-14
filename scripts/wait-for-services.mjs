#!/usr/bin/env node
//
// A fast port check. **This is not the readiness gate - `docker compose up --wait` is.**
//
// > **An open TCP port is not a ready Postgres, and this script used to claim it was.**
// > The postmaster listens before initdb has finished, so a socket connects and the very
// > first query is refused. On a laptop the image is warm and the window is too small to
// > ever see; on a cold CI runner that has just pulled the image it is wide, and the first
// > CI run failed on `CREATE SCHEMA IF NOT EXISTS \"drizzle\"` about six seconds after
// > this script said "postgres ready on :5432". See SPEC/TECH/14.
//
// `db:up` now passes `--wait`, which blocks on the healthchecks declared in
// docker-compose.yml - `pg_isready`, `redis-cli ping`, `mc ready` - and those are what
// actually mean ready. This runs after them and stays because it fails fast and legibly
// when a port is bound by something else entirely, which a healthcheck does not diagnose.

import net from 'node:net';

const TARGETS = [
  { name: 'postgres', host: '127.0.0.1', port: 5432 },
  { name: 'redis', host: '127.0.0.1', port: 6379 },
  { name: 'minio', host: '127.0.0.1', port: 9000 },
];

const TIMEOUT_MS = 60_000;
const RETRY_MS = 250;

function probe({ host, port }) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1_000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function waitFor(target) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probe(target)) {
      process.stdout.write(`  ${target.name} ready on :${target.port}\n`);
      return true;
    }
    await new Promise((r) => setTimeout(r, RETRY_MS));
  }
  process.stderr.write(
    `  ${target.name} did NOT become ready on :${target.port} within ${TIMEOUT_MS / 1000}s\n`,
  );
  return false;
}

const results = [];
for (const target of TARGETS) {
  results.push(await waitFor(target));
}

if (results.some((ok) => !ok)) {
  process.stderr.write('\nservices not ready - try: docker compose logs\n');
  process.exit(1);
}
