/**
 * Checks the WebSocket catalogue against the gateway. Run with:
 *
 *   npm run verify:ws-docs
 *
 * The catalogue in websocket-events.ts is hand-written, so it is only worth
 * trusting if something compares it to the source. Three invariants, each
 * catching a different kind of drift:
 *
 *   1. The gateway has no `@SubscribeMessage` handlers. The socket is a
 *      one-way pipe by design, and a handler creeping back in is the single
 *      change that would silently break that guarantee — the docs would still
 *      say "no client events" while the server quietly accepted one.
 *   2. Every INFO_CODES member the gateway actually sends is documented.
 *   3. Every documented code exists in INFO_CODES / ERROR_CODES, so a renamed
 *      constant cannot leave a stale row in the published table.
 *
 * A plain script rather than a test because the project has no test runner.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { ERROR_CODES, INFO_CODES } from './notification-codes';
import { ALL_NOTIFICATIONS, ERROR_NOTIFICATIONS } from './websocket-events';

const GATEWAY = join(__dirname, '..', 'ride', 'ride.gateway.ts');

const source = readFileSync(GATEWAY, 'utf8');
const problems: string[] = [];

// 1 — the socket must stay receive-only.
const handlers = [...source.matchAll(/@SubscribeMessage\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
if (handlers.length > 0) {
  problems.push(
    `The gateway declares ${handlers.length} @SubscribeMessage handler(s): ${handlers.join(', ')}.\n` +
      '  The socket is documented as notification-only. Either move the mutation to a REST\n' +
      '  endpoint, or update the contract and this check together.',
  );
}

// 2 — every code the gateway sends is documented.
const documented = new Set([
  ...ALL_NOTIFICATIONS.map((doc) => doc.code),
  ...ERROR_NOTIFICATIONS.map((doc) => doc.code),
]);

const used = [...source.matchAll(/(?:INFO_CODES|ERROR_CODES)\.([A-Z_]+)/g)].map((m) => m[1]);
const known: Record<string, string> = { ...INFO_CODES, ...ERROR_CODES };

for (const name of new Set(used)) {
  const code = known[name];
  if (!code) {
    problems.push(`Gateway references \`${name}\`, which is not in INFO_CODES or ERROR_CODES.`);
    continue;
  }
  if (!documented.has(code)) {
    problems.push(`\`${code}\` is sent by the gateway but has no row in websocket-events.ts.`);
  }
}

// 3 — nothing documented has since been renamed away.
const defined = new Set<string>(Object.values(known));
for (const code of documented) {
  if (!defined.has(code)) {
    problems.push(`\`${code}\` is documented but no longer exists in notification-codes.ts.`);
  }
}

if (problems.length > 0) {
  console.error('WebSocket catalogue is out of step with the gateway:\n');
  problems.forEach((problem) => console.error(`  • ${problem}`));
  console.error('');
  process.exit(1);
}

console.log(
  `WebSocket catalogue OK — no client events, ${documented.size} codes documented and sent.`,
);
