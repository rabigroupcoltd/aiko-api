/**
 * Checks the WebSocket catalogue against the gateway. Run with:
 *
 *   npm run verify:ws-docs
 *
 * The catalogue in websocket-events.ts is hand-written, so it is only worth
 * trusting if something compares it to the source. This reads the gateway,
 * extracts every `@SubscribeMessage` name and every `.emit(...)` name, and
 * exits non-zero when one of them is undocumented — which turns doc drift into
 * a failed command rather than a quiet gap in the published spec.
 *
 * A plain script rather than a test because the project has no test runner.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { CLIENT_EVENTS, SERVER_EVENTS } from './websocket-events';

const GATEWAY = join(__dirname, '..', 'ride', 'ride.gateway.ts');

/**
 * Events the `.emit('name'` regex cannot see, and why.
 *
 * `requiresLiteral` keeps the exemption narrow: the name must still occur
 * somewhere in the gateway, so removing the event is still a failure. Only
 * `exception` is fully external — Nest's WebSocket exception layer emits it,
 * and no line of ours mentions it.
 */
const INDIRECT_EMITS: Record<string, { why: string; requiresLiteral: boolean }> = {
  'ride-stage-changed': {
    why: 'chosen into a variable in broadcastOrder() before the emit',
    requiresLiteral: true,
  },
  'trip-cancelled': {
    why: 'chosen into a variable in broadcastOrder() before the emit',
    requiresLiteral: true,
  },
  exception: {
    why: "raised by Nest's WebSocket exception layer, not by our code",
    requiresLiteral: false,
  },
};

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function main() {
  const source = readFileSync(GATEWAY, 'utf8');

  const handled = unique(
    [...source.matchAll(/@SubscribeMessage\('([^']+)'\)/g)].map((m) => m[1]),
  );
  const emitted = unique([...source.matchAll(/\.emit\(\s*'([^']+)'/g)].map((m) => m[1]));

  const documentedClient = unique(CLIENT_EVENTS.map((e) => e.event));
  const documentedServer = unique(SERVER_EVENTS.map((e) => e.event));

  const problems: string[] = [];

  // A zero count means the regexes stopped matching the gateway's style, which
  // would otherwise make every check below pass vacuously.
  if (handled.length === 0) problems.push('found no @SubscribeMessage handlers — check the regex');
  if (emitted.length === 0) problems.push('found no .emit() calls — check the regex');

  handled
    .filter((e) => !documentedClient.includes(e))
    .forEach((e) => problems.push(`client event '${e}' is handled but not documented`));

  documentedClient
    .filter((e) => !handled.includes(e))
    .forEach((e) => problems.push(`client event '${e}' is documented but no handler exists`));

  emitted
    .filter((e) => !documentedServer.includes(e))
    .forEach((e) => problems.push(`server event '${e}' is emitted but not documented`));

  documentedServer
    .filter((e) => !emitted.includes(e))
    .forEach((e) => {
      const reason = INDIRECT_EMITS[e];
      if (!reason) {
        problems.push(`server event '${e}' is documented but never emitted`);
        return;
      }

      // The allowlist excuses the emit regex, not the event's existence — the
      // name must still appear in the gateway, so deleting one is still caught.
      if (reason.requiresLiteral && !source.includes(`'${e}'`)) {
        problems.push(`server event '${e}' (${reason.why}) no longer appears in the gateway`);
      }
    });

  // Every broadcast a handler claims to trigger must be a real server event.
  for (const event of CLIENT_EVENTS) {
    for (const trigger of event.triggers ?? []) {
      const named = [...trigger.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]);
      if (named.length === 0) problems.push(`'${event.event}' has a trigger naming no event`);
      named
        .filter((name) => !documentedServer.includes(name))
        .forEach((name) => problems.push(`'${event.event}' triggers unknown event '${name}'`));
    }
  }

  console.log(`handlers in gateway : ${handled.length}  -> documented ${documentedClient.length}`);
  console.log(`emits in gateway    : ${emitted.length}  -> documented ${documentedServer.length}`);

  if (problems.length > 0) {
    console.error('\nWebSocket docs are out of date:');
    problems.forEach((p) => console.error(`  - ${p}`));
    process.exit(1);
  }

  console.log('\nWebSocket catalogue matches the gateway.');
}

main();
