#!/usr/bin/env node
//
// Block until Postgres and Redis actually accept connections.
//
// `docker compose up -d` returns as soon as the containers are created, not when
// the services inside them are ready. Running a migration against a Postgres that
// is still initialising fails with a connection error that reads like a config
// problem, so this exists to make `npm run db:up` mean what it says.

import net from 'node:net';

const TARGETS = [
  { name: 'postgres', host: '127.0.0.1', port: 5432 },
  { name: 'redis', host: '127.0.0.1', port: 6379 },
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
