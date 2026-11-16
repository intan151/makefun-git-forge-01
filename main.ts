// main.ts — entry point: bring the forge up, hand its port to the trial env,
// then sit tight until the env reports the trial is finished.
//
// The env (MAKEFUN_ENV_URL, http://store:8080 inside a trial pod) is the only
// service this process talks to. The steps, in order:
//   1. refuse to run when MAKEFUN_ENV_URL is missing (exit 1);
//   2. start the forge on a kernel-chosen port — never 8080, the env's own;
//   3. tell the env that port with POST /register {"port": N};
//   4. ask GET /done over and over until it says {"done": true}, then exit 0.
// A register or poll that fails is retried; the pause below doubles each time
// and stops growing at two seconds. The env answers /done immediately, so the
// wait here is a sequence of short requests, never one held open.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (envOrigin === '') {
  process.stderr.write('MAKEFUN_ENV_URL is unset, so there is no env to join; exiting\n');
  process.exit(1);
}

const PER_CALL_BUDGET_MS = 30_000;
const FIRST_PAUSE_MS = 250;
const LONGEST_PAUSE_MS = 2_000;
const MAX_DOUBLINGS = 8;

const pause = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

function pauseAfterFailures(failures: number): number {
  const doublings = failures < MAX_DOUBLINGS ? failures : MAX_DOUBLINGS;
  const grown = FIRST_PAUSE_MS * 2 ** doublings;
  return grown < LONGEST_PAUSE_MS ? grown : LONGEST_PAUSE_MS;
}

class ContractError extends Error {}

async function postJson(path: string, payload: unknown): Promise<Response> {
  return fetch(`${envOrigin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(PER_CALL_BUDGET_MS),
  });
}

/**
 * Announce the bound port until the env takes it. A 200 is the normal answer
 * and a 409 means some earlier register already won, which is not this
 * process's problem to fix — either way the port is known and we move on.
 * A 400 or 405 is a contract error and ends the program; anything else (the
 * env still starting, a dropped connection) is retried.
 */
async function announce(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const reply = await postJson('/register', { port });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        throw new ContractError(`register refused with HTTP ${reply.status}: ${await reply.text()}`);
      }
    } catch (err) {
      if (err instanceof ContractError) throw err;
    }
    await pause(pauseAfterFailures(failures));
    failures += 1;
  }
}

/** Ask GET /done until it answers {"done": true}; never return before that. */
async function awaitDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const reply = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(PER_CALL_BUDGET_MS),
      });
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The env is unreachable for now; that only means "not done yet".
    }
    await pause(pauseAfterFailures(failures));
    failures += 1;
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      resolve();
    });
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the forge did not bind a TCP port');
  }
  process.stdout.write(`forge listening on port ${bound.port}\n`);

  await announce(bound.port);
  process.stdout.write('registered with the env; waiting for done\n');

  await awaitDone();
  server.close();
  process.stdout.write('trial done; shutting down\n');
}

run()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
