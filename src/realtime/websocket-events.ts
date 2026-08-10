/**
 * The `/ride` WebSocket contract, as data.
 *
 * OpenAPI has no concept of a socket event, so this is the single source for
 * both renderings: the markdown reference in the Swagger description, and the
 * `x-websocket` block in the generated JSON that tooling can read. Keep it in
 * step with RideGateway — a test asserts every @SubscribeMessage handler and
 * every server emit appears here.
 */

export interface ClientEventDoc {
  event: string;
  summary: string;
  /** Who is allowed to send it. */
  sender: string;
  /** Shape of the message body. */
  payload: Record<string, string>;
  /** What comes back in the acknowledgement callback's `data`. */
  ack: string;
  /** Anything the server broadcasts as a result. */
  triggers?: string[];
  example?: Record<string, unknown>;
}

export interface ServerEventDoc {
  event: string;
  summary: string;
  /** Which room(s) it lands in, i.e. who receives it. */
  audience: string;
  payload: string;
  example?: Record<string, unknown>;
}

export const WEBSOCKET_NAMESPACE = '/ride';

export const WEBSOCKET_ROOMS = [
  { room: 'user:<userId>', joined: 'On connect, always.', purpose: 'Anything addressed to one person.' },
  { room: 'driver:<driverId>', joined: 'On connect, if the account has a driver profile.', purpose: 'Ride offers and trip updates for that driver.' },
  { room: 'ride:<orderId>', joined: 'On accept-driver / subscribe-ride, and re-joined on reconnect for any trip still in flight.', purpose: 'Both parties of one trip.' },
  { room: 'driver-watch:<driverId>', joined: 'On subscribe-driver-location, or automatically once a driver is assigned to your trip.', purpose: 'Live position feed for one driver.' },
  { room: 'request:<requestId>', joined: 'On passenger-trip-request and driver-bid.', purpose: 'The passenger plus every driver bidding.' },
];

// ------------------------------------------------------- client -> server

export const CLIENT_EVENTS: ClientEventDoc[] = [
  {
    event: 'passenger-trip-request',
    summary: 'Ask for a driver. Mirrors POST /api/ride-requests.',
    sender: 'Passenger',
    payload: {
      vehicleType: 'CAR | BIKE | TRUCK | TRICYCLE | BICYCLE',
      pickupLocation: 'string',
      dropoffLocation: 'string',
      pickupLat: 'number',
      pickupLng: 'number',
      dropoffLat: 'number',
      dropoffLng: 'number',
      'paymentMethod?': 'CASH | BANK_TRANSFER',
      'radiusKm?': 'number — defaults to SEARCH_RADIUS_KM',
    },
    ack: '`{ request, quote, matchedDrivers }` — joins `request:<requestId>`',
    triggers: ['`ride-request` to every matched driver'],
    example: {
      vehicleType: 'TRICYCLE',
      pickupLocation: 'Ikeja City Mall, Alausa, Lagos',
      dropoffLocation: 'Computer Village, Ikeja, Lagos',
      pickupLat: 6.6018,
      pickupLng: 3.3515,
      dropoffLat: 6.5952,
      dropoffLng: 3.3372,
      paymentMethod: 'CASH',
    },
  },
  {
    event: 'nearby-requests',
    summary:
      'Ask what is open near you. The pull half of matching — fan-out only reaches drivers who were already online, so this is how a driver who came online mid-search finds work already in flight. Mirrors GET /api/ride-requests/nearby.',
    sender: 'Driver — anyone else gets 403',
    payload: {
      lat: 'number — where the driver is now',
      lng: 'number',
      'radiusKm?': 'number 0.5-50 — defaults to SEARCH_RADIUS_KM',
      'limit?': 'number 1-50 — defaults to 20',
    },
    ack: 'Open `RideRequest`s for your vehicle type, each with `pickupDistanceKm`, `secondsRemaining` and `hasBid`, nearest first — joins `request:<requestId>` for every one of them',
    example: { lat: 9.6139, lng: 6.5569, radiusKm: 5 },
  },
  {
    event: 'marketplace-orders',
    summary:
      'The driver\'s available-orders grid. Mirrors GET /api/marketplace/orders — same ranking, same redaction. Sent after an `order-available` push so the client can rescore against its own position without an HTTP round trip.',
    sender: 'Driver — anyone else gets 403',
    payload: {
      'lat?': 'number — a fresher fix than the server has, if you have one',
      'lng?': 'number',
      'radiusKm?': 'number 0.5-50 — defaults to INITIAL_DRIVER_RADIUS_KM',
      'limit?': 'number 1-50 — defaults to 20',
    },
    ack: '`{ orders, held, capacity, atCapacity }` — each order carries a `compatibility` block scored for this driver',
    example: { lat: 9.6139, lng: 6.5569, radiusKm: 5 },
  },
  {
    event: 'reserve-order',
    summary:
      'Claim an order. Atomic — concurrent attempts resolve to one winner and every loser acks 409 ORDER_ALREADY_RESERVED. Capacity and route compatibility are re-checked server-side.',
    sender: 'Driver',
    payload: { orderId: 'uuid' },
    ack: '`{ order, compatibility, held, capacity }` — joins `ride:<orderId>`. 409 `ORDER_ALREADY_RESERVED`, or 400 `MAX_ORDER_CAPACITY_REACHED`',
    triggers: ['`order-reserved` to the customer', '`order-removed` to every other driver'],
    example: { orderId: '9c7e2a41-3b08-4f6d-95a2-7e1c4d8b0f33' },
  },
  {
    event: 'skip-order',
    summary:
      'Drop an order from this driver\'s grid only. The order stays open and every other driver still sees it.',
    sender: 'Driver',
    payload: { orderId: 'uuid' },
    ack: '`{ orderId, skipped, hiddenUntil }`',
    example: { orderId: '9c7e2a41-3b08-4f6d-95a2-7e1c4d8b0f33' },
  },
  {
    event: 'active-orders',
    summary:
      'Everything the driver is holding plus the optimised route across all of it. Also re-joins every held order\'s room, so chat survives a reconnect on all of them rather than only the one on screen.',
    sender: 'Driver',
    payload: {},
    ack: '`{ orders, route, held, capacity, status }` — `status` is OFFLINE | AVAILABLE | BUSY',
    example: {},
  },
  {
    event: 'driver-bid',
    summary: 'Bid on an open request. One bid per driver; bidding again replaces it.',
    sender: 'Driver',
    payload: {
      requestId: 'uuid',
      'amount?': 'number — only becomes the fare when ALLOW_BID_FARE_OVERRIDE=true',
      'note?': 'string',
    },
    ack: 'The created `RideBid` — joins `request:<requestId>`',
    triggers: ['`driver-bid-placed` to the passenger'],
    example: { requestId: 'b5d9f0a3-7c21-4e88-9a16-2f3b6c8d1e04', amount: 1300, note: 'I am 2 minutes away.' },
  },
  {
    event: 'accept-driver',
    summary: 'Pick a bidding driver. Turns the request into a trip.',
    sender: 'Passenger who raised the request',
    payload: { requestId: 'uuid', driverId: 'uuid' },
    ack: 'The created `Order`, already ACCEPTED — joins `ride:<orderId>` and `driver-watch:<driverId>`',
    triggers: ['`driver-accepted` to both parties'],
    example: {
      requestId: 'b5d9f0a3-7c21-4e88-9a16-2f3b6c8d1e04',
      driverId: 'd41c8b02-5e77-4a19-9c3b-6a2f8e0d4b55',
    },
  },
  {
    event: 'cancel-request',
    summary: 'Call off the search before a driver is accepted.',
    sender: 'Passenger who raised the request',
    payload: { requestId: 'uuid', 'reason?': 'string' },
    ack: 'The cancelled `RideRequest`',
    triggers: ['`ride-request-cancelled` to every matched driver'],
    example: { requestId: 'b5d9f0a3-7c21-4e88-9a16-2f3b6c8d1e04', reason: 'Changed my mind.' },
  },
  {
    event: 'subscribe-ride',
    summary: 'Follow a trip you are on — used after a reconnect.',
    sender: 'Either participant',
    payload: { rideId: 'uuid' },
    ack: 'The `Order` — joins `ride:<orderId>` and the driver’s position feed',
    example: { rideId: '9c7e2a41-3b08-4f6d-95a2-7e1c4d8b0f33' },
  },
  {
    event: 'update-ride-stage',
    summary: 'Move the trip along. Same transition rules as PATCH /api/orders/{id}/status.',
    sender: 'Driver on the trip',
    payload: { rideId: 'uuid', stage: 'ARRIVED | IN_PROGRESS | COMPLETED' },
    ack: 'The updated `Order`',
    triggers: ['`ride-stage-changed` to both parties'],
    example: { rideId: '9c7e2a41-3b08-4f6d-95a2-7e1c4d8b0f33', stage: 'ARRIVED' },
  },
  {
    event: 'cancel-trip',
    summary: 'Cancel an accepted trip.',
    sender: 'Either participant',
    payload: { rideId: 'uuid', 'reason?': 'string' },
    ack: 'The cancelled `Order`',
    triggers: ['`trip-cancelled` to both parties'],
    example: { rideId: '9c7e2a41-3b08-4f6d-95a2-7e1c4d8b0f33', reason: 'Passenger did not show up.' },
  },
  {
    event: 'message',
    summary: 'Send a chat message on a trip.',
    sender: 'Either participant',
    payload: { rideId: 'uuid', content: 'string, max 2000' },
    ack: 'The created `RideMessage`',
    triggers: ['`new-message` to the other party'],
    example: { rideId: '9c7e2a41-3b08-4f6d-95a2-7e1c4d8b0f33', content: 'I am waiting by the main entrance.' },
  },
  {
    event: 'submit-rating',
    summary: 'Rate the other party. COMPLETED trips only, once each.',
    sender: 'Either participant',
    payload: { rideId: 'uuid', score: 'number 1-5', 'comment?': 'string' },
    ack: 'The created `RideRating`',
    example: { rideId: '9c7e2a41-3b08-4f6d-95a2-7e1c4d8b0f33', score: 5, comment: 'Smooth ride.' },
  },
  {
    event: 'driver-live-location',
    summary: 'Publish a position. Expected roughly every 10s while online.',
    sender: 'Driver only — anyone else gets 403',
    payload: {
      lat: 'number',
      lng: 'number',
      'heading?': 'number 0-360',
      'speedKph?': 'number',
      'accuracyMeters?': 'number',
      'recordedAt?': 'ISO 8601',
    },
    ack: '`{ driverId, lat, lng, recordedAt }`',
    triggers: ['`driver-location-update` to everyone watching this driver'],
    example: { lat: 6.5244, lng: 3.3792, heading: 118.4, speedKph: 24.6 },
  },
  {
    event: 'subscribe-driver-location',
    summary: 'Start receiving one driver’s position feed.',
    sender: 'Any authenticated client',
    payload: { driverId: 'uuid' },
    ack: '`{ driverId }` — joins `driver-watch:<driverId>`',
    example: { driverId: 'd41c8b02-5e77-4a19-9c3b-6a2f8e0d4b55' },
  },
  {
    event: 'unsubscribe-driver-location',
    summary: 'Stop receiving that feed.',
    sender: 'Any authenticated client',
    payload: { driverId: 'uuid' },
    ack: '`{ driverId }` — leaves `driver-watch:<driverId>`',
    example: { driverId: 'd41c8b02-5e77-4a19-9c3b-6a2f8e0d4b55' },
  },
];

// ------------------------------------------------------- server -> client

export const SERVER_EVENTS: ServerEventDoc[] = [
  {
    event: 'connected',
    summary:
      'Sent once, immediately after the handshake. On failure it carries a 401 envelope and the socket is then closed — wait for this before sending anything.',
    audience: 'The connecting socket',
    payload: '`{ code, message, data: { userId, driverId } }`',
    example: { code: 200, message: 'Connected', data: { userId: '3f2a7c1e-9b64-4d2a-8f31-1c0d5e6a7b81', driverId: null } },
  },
  {
    event: 'ride-request',
    summary:
      'A new job. Fanned out to every driver the matcher picked, and re-raised for a single driver when one comes online next to a request that is already open.',
    audience: '`driver:<driverId>` for each matched driver',
    payload: '`{ requestId, vehicleType, pickup, dropoff, distanceKm, fare, expiresAt }`',
    example: {
      requestId: 'b5d9f0a3-7c21-4e88-9a16-2f3b6c8d1e04',
      vehicleType: 'TRICYCLE',
      pickup: { location: 'Ikeja City Mall, Alausa, Lagos', lat: 6.6018, lng: 3.3515 },
      dropoff: { location: 'Computer Village, Ikeja, Lagos', lat: 6.5952, lng: 3.3372 },
      distanceKm: 5.72,
      fare: 1250,
      expiresAt: '2026-08-01T07:59:31.209Z',
    },
  },
  {
    event: 'driver-bid-placed',
    summary: 'A driver has bid on your request.',
    audience: '`user:<passengerId>` and `request:<requestId>`',
    payload: 'The `RideBid`',
    example: {
      id: '6a2d9f31-0c85-47be-9134-8e7b5a0c3d92',
      requestId: 'b5d9f0a3-7c21-4e88-9a16-2f3b6c8d1e04',
      driverId: 'd41c8b02-5e77-4a19-9c3b-6a2f8e0d4b55',
      amount: 1300,
      note: 'I am 2 minutes away.',
      status: 'PENDING',
    },
  },
  {
    event: 'driver-accepted',
    summary: 'The request became a trip. Both sides get the same Order.',
    audience: '`user:<passengerId>` and `driver:<driverId>`',
    payload: 'The created `Order`',
  },
  {
    event: 'ride-request-expired',
    summary:
      'Nobody accepted inside RIDE_REQUEST_TTL, after MATCHING_RETRIES attempts. Raised by the timeout worker, not by any client.',
    audience: '`user:<passengerId>`',
    payload: 'The expired `RideRequest`',
  },
  {
    event: 'ride-request-cancelled',
    summary: 'The passenger withdrew — drivers should drop the offer from their inbox.',
    audience: '`driver:<driverId>` for each matched driver',
    payload: '`{ requestId }`',
    example: { requestId: 'b5d9f0a3-7c21-4e88-9a16-2f3b6c8d1e04' },
  },
  {
    event: 'ride-stage-changed',
    summary:
      'The trip moved. Fires for every non-cancelled status — created, accepted, arrived, in progress, completed.',
    audience: '`ride:<orderId>`, `user:<passengerId>` and `driver:<driverId>`',
    payload: 'The full `Order` at its new status',
  },
  {
    event: 'trip-cancelled',
    summary: 'The same broadcast as above, under a different name when the new status is CANCELLED.',
    audience: '`ride:<orderId>`, `user:<passengerId>` and `driver:<driverId>`',
    payload: 'The cancelled `Order`, with `cancellationReason`',
  },
  {
    event: 'new-message',
    summary: 'A chat message on a trip. Also raised by POST /api/orders/{id}/messages.',
    audience: '`ride:<orderId>`',
    payload: 'The `RideMessage`',
    example: {
      id: 'f4a8b217-6d05-4c93-8e71-3b2f9a0c5d68',
      orderId: '9c7e2a41-3b08-4f6d-95a2-7e1c4d8b0f33',
      senderId: '3f2a7c1e-9b64-4d2a-8f31-1c0d5e6a7b81',
      content: 'I am waiting by the main entrance.',
      readAt: null,
      createdAt: '2026-08-01T07:58:44.117Z',
    },
  },
  {
    event: 'order-available',
    summary:
      'A marketplace order is open near you. Raised on creation, on each widening pass, and when a driver comes online or frees a capacity slot next to work already in flight.',
    audience: '`driver:<driverId>` for each driver inside the current radius with free capacity',
    payload:
      '`{ id, vehicleType, pickupLocation, pickupLat, pickupLng, dropoffLocation, dropoffLat, dropoffLng, distanceKm, earnings, fare, currency, createdAt }` — no customer identity, and no compatibility score: that is per-driver, so refetch the grid on receipt',
    example: {
      id: '9c7e2a41-3b08-4f6d-95a2-7e1c4d8b0f33',
      vehicleType: 'TRICYCLE',
      pickupLocation: 'Minna Central Market, Minna',
      dropoffLocation: 'Bosso Estate, Minna',
      distanceKm: 8.4,
      earnings: 3150,
      fare: 3500,
      currency: 'NGN',
    },
  },
  {
    event: 'order-reserved',
    summary: 'A driver claimed your order. Carries the driver, the vehicle, and the ETA along their real route.',
    audience: '`user:<customerId>` and `ride:<orderId>`',
    payload: '`{ order, eta: { pickupMinutes, deliveryMinutes } }`',
  },
  {
    event: 'order-removed',
    summary:
      'Drop this order from the grid — someone else reserved it, the customer cancelled, or the search gave up. Broadcast to the namespace; a driver who never had the card ignores an id they do not hold.',
    audience: 'Every connected client',
    payload: '`{ orderId, reason: "RESERVED" | "CANCELLED" | "NO_DRIVER_FOUND" }`',
    example: { orderId: '9c7e2a41-3b08-4f6d-95a2-7e1c4d8b0f33', reason: 'RESERVED' },
  },
  {
    event: 'order-no-driver',
    summary:
      'The search widened to MAX_DRIVER_RADIUS_KM across MAX_DISPATCH_ATTEMPTS passes and nobody claimed it. Terminal.',
    audience: '`user:<customerId>`',
    payload: 'The `Order` at NO_DRIVER_FOUND',
  },
  {
    event: 'driver-location-update',
    summary: 'A driver moved. This is what animates the marker on the map.',
    audience: '`driver-watch:<driverId>`',
    payload: '`{ driverId, lat, lng, heading, speedKph, recordedAt }`',
    example: {
      driverId: 'd41c8b02-5e77-4a19-9c3b-6a2f8e0d4b55',
      lat: 6.5244,
      lng: 3.3792,
      heading: 118.4,
      speedKph: 24.6,
      recordedAt: '2026-08-01T07:59:12.310Z',
    },
  },
  {
    event: 'exception',
    summary:
      'A malformed payload. Validation runs before the handler and throws, which bypasses the ack — so this arrives as its own event rather than in the callback. Business failures (403, 404, 409) DO come back in the ack.',
    audience: 'The sending socket',
    payload: '`{ status: "error", message }`',
    example: { status: 'error', message: ['lat must be a latitude string or number'] },
  },
];

/** The whole contract, for the `x-websocket` block in the OpenAPI JSON. */
export const WEBSOCKET_CONTRACT = {
  namespace: WEBSOCKET_NAMESPACE,
  transport: 'socket.io',
  authentication: {
    handshake: 'auth.token, or an Authorization header. A `Bearer ` prefix is stripped either way.',
    token: 'The same accessToken the REST endpoints issue.',
    onFailure: 'A `connected` event carrying a 401 envelope, then the socket is closed.',
  },
  acknowledgements: {
    envelope: '{ code, message, data } on success, { code, message, error } on failure',
    note: 'Identical to the REST envelope, so one response handler serves both transports.',
  },
  scaling:
    'Broadcasts go through the Redis Streams adapter, so a client on one instance still receives events raised on another.',
  rooms: WEBSOCKET_ROOMS,
  clientToServer: CLIENT_EVENTS,
  serverToClient: SERVER_EVENTS,
};

// ------------------------------------------------------------- rendering

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((cells) => `| ${cells.join(' | ')} |`),
  ].join('\n');
}

/** Escapes pipes so a payload containing `A | B` cannot break the table. */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function payloadCell(payload: Record<string, string>): string {
  return Object.entries(payload)
    .map(([key, type]) => `\`${cell(key)}\`: ${cell(type)}`)
    .join('<br>');
}

/**
 * Builds the markdown block that goes into the Swagger description.
 *
 * Rendered from the same constants as `x-websocket`, so the human-readable and
 * machine-readable versions cannot drift apart.
 */
export function renderWebSocketReference(): string {
  const lines: string[] = [];

  lines.push('## Realtime (WebSocket)');
  lines.push('');
  lines.push(
    'The matching and trip flow is also available over Socket.IO at ' +
      `\`ws://<host>${WEBSOCKET_NAMESPACE}\`. The REST routes under **Ride Requests** and ` +
      '**Orders** mirror it for clients that cannot hold a socket open, and both raise the same ' +
      'broadcasts — so a passenger on a socket sees a trip cancelled through the REST API.',
  );
  lines.push('');

  lines.push('### Connecting');
  lines.push('');
  lines.push('```js');
  lines.push(`const socket = io('ws://localhost:3000${WEBSOCKET_NAMESPACE}', {`);
  lines.push('  auth: { token: accessToken },   // the same token the REST API issues');
  lines.push('});');
  lines.push('');
  lines.push("socket.on('connected', (res) => {");
  lines.push('  if (res.code !== 200) return; // 401 — the socket is closed right after this');
  lines.push('  // res.data = { userId, driverId }');
  lines.push('});');
  lines.push('');
  lines.push('// Every client event takes an acknowledgement callback.');
  lines.push("socket.emit('subscribe-ride', { rideId }, (res) => {");
  lines.push('  if (res.code === 200) console.log(res.data);');
  lines.push('  else console.error(res.error);');
  lines.push('});');
  lines.push('```');
  lines.push('');
  lines.push(
    'Acks use the **same envelope as the REST API**, so one response handler serves both ' +
      'transports. Broadcasts go through the Redis Streams adapter, so a client on one instance ' +
      'still receives events raised on another.',
  );
  lines.push('');

  lines.push('### Client → server');
  lines.push('');
  lines.push(
    table(
      ['Event', 'Who', 'Payload', 'Ack `data`'],
      CLIENT_EVENTS.map((e) => [
        `**\`${e.event}\`**<br>${cell(e.summary)}`,
        cell(e.sender),
        payloadCell(e.payload),
        cell(e.ack) + (e.triggers?.length ? `<br>→ broadcasts ${e.triggers.map(cell).join(', ')}` : ''),
      ]),
    ),
  );
  lines.push('');

  lines.push('### Server → client');
  lines.push('');
  lines.push(
    table(
      ['Event', 'Goes to', 'Payload'],
      SERVER_EVENTS.map((e) => [
        `**\`${e.event}\`**<br>${cell(e.summary)}`,
        cell(e.audience),
        cell(e.payload),
      ]),
    ),
  );
  lines.push('');

  lines.push('### Rooms');
  lines.push('');
  lines.push(
    'You never name a room directly — the server joins you to the right ones. Listed so the ' +
      'audience column above makes sense.',
  );
  lines.push('');
  lines.push(
    table(
      ['Room', 'Joined when', 'Carries'],
      WEBSOCKET_ROOMS.map((r) => [`\`${r.room}\``, cell(r.joined), cell(r.purpose)]),
    ),
  );
  lines.push('');
  lines.push(
    'Trip rooms are re-joined automatically on reconnect for any trip still in flight, so a ' +
      'dropped connection does not need special handling.',
  );
  lines.push('');
  lines.push(
    'The full contract is also machine-readable under `x-websocket` in ' +
      '[the OpenAPI JSON](/api/docs-json).',
  );

  return lines.join('\n');
}
