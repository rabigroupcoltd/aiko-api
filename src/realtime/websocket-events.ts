import { ERROR_CODES, INFO_CODES } from './notification-codes';

export interface NotificationDoc {
  code: string;
  summary: string;
  audience: string;
  payload: string;
  action: string;
  example?: Record<string, unknown>;
}

export const WEBSOCKET_NAMESPACE = '/ride';

export const WEBSOCKET_ROOMS = [
  {
    room: 'user:<userId>',
    joined: 'On connect, always.',
    purpose: 'Anything addressed to one person.',
  },
  {
    room: 'driver:<driverId>',
    joined: 'On connect, if the account has a driver profile.',
    purpose: 'The request grid and trip updates for that driver.',
  },
  {
    room: 'ride:<orderId>',
    joined: 'On connect, for every trip still in flight.',
    purpose: 'Both parties of one trip.',
  },
  {
    room: 'driver-watch:<driverId>',
    joined:
      'On connect for a trip already assigned, and server-side the moment a driver reserves your order.',
    purpose: 'Live position feed for one driver.',
  },
];

export const GRID_NOTIFICATIONS: NotificationDoc[] = [
  {
    code: INFO_CODES.REQUEST_NEW,
    summary:
      'A new job is open near you. Receiving it is already proof the order is inside your radius — the server did the geo filtering.',
    audience: '`driver:<driverId>` for every driver in the current ring',
    payload:
      '`{ order: { id, vehicleType, description, pickupLocation, pickupLat, pickupLng, dropoffLocation, dropoffLat, dropoffLng, distanceKm, earnings, fare, currency, createdAt } }` — no customer identity, and no compatibility score: that is per-driver, so refetch `GET /api/marketplace/orders` to rescore.',
    action: 'Add a card. Accept with `POST /api/marketplace/orders/{id}/reserve`.',
    example: {
      code: 'REQUEST_NEW',
      message: 'New request near you',
      data: {
        order: {
          id: '9c7e2a41-3b08-4f6d-95a2-7e1c4d8b0f33',
          vehicleType: 'TRICYCLE',
          description: 'Two cartons of frozen chicken. Handle upright.',
          pickupLocation: 'Minna Central Market, Minna',
          dropoffLocation: 'Bosso Estate, Minna',
          distanceKm: 8.4,
          earnings: 3150,
          fare: 3500,
          currency: 'NGN',
        },
      },
    },
  },
  {
    code: INFO_CODES.REQUEST_WON,
    summary:
      'You claimed it first. Redundant with the 200 from the reserve call, and deliberately so — that response can be lost to a dropped connection at the exact moment the order became yours.',
    audience: '`driver:<driverId>` — the winner only',
    payload: '`{ order }` — the full Order, now RESERVED and assigned to you',
    action: 'Remove the card and open the trip.',
    example: {
      code: 'REQUEST_WON',
      message: 'The request is yours',
      data: { order: { id: '9c7e2a41-3b08-4f6d-95a2-7e1c4d8b0f33', status: 'RESERVED' } },
    },
  },
  {
    code: INFO_CODES.REQUEST_LOST,
    summary:
      'Another driver got there first. Sent only to drivers who were actually shown the card, not broadcast — a client never receives an id it was never offered.',
    audience: '`driver:<driverId>` for every driver offered the order, except the winner',
    payload: '`{ orderId, reason: "TAKEN" }`',
    action: 'Remove the card. Also arrives as a push when the app is backgrounded.',
    example: {
      code: 'REQUEST_LOST',
      message: 'Another driver took this request',
      data: { orderId: '9c7e2a41-3b08-4f6d-95a2-7e1c4d8b0f33', reason: 'TAKEN' },
    },
  },
  {
    code: INFO_CODES.REQUEST_CLOSED,
    summary:
      'Off the market for a reason that is nobody’s win — the customer cancelled, or the search widened as far as it could and gave up.',
    audience: '`driver:<driverId>` for every driver offered the order',
    payload: '`{ orderId, reason: "CANCELLED" | "NO_DRIVER_FOUND" }`',
    action: 'Remove the card.',
    example: {
      code: 'REQUEST_CLOSED',
      message: 'The customer cancelled this request',
      data: { orderId: '9c7e2a41-3b08-4f6d-95a2-7e1c4d8b0f33', reason: 'CANCELLED' },
    },
  },
];

export const TRIP_NOTIFICATIONS: NotificationDoc[] = [
  {
    code: INFO_CODES.ORDER_RESERVED,
    summary: 'A driver claimed your order. Carries who is coming and the ETA along their real route.',
    audience: '`user:<customerId>`',
    payload: '`{ order, eta: { pickupMinutes, deliveryMinutes } | null }`',
    action:
      'Show "driver found". Your sockets are joined to that driver’s position feed automatically — DRIVER_LOCATION starts arriving.',
  },
  {
    code: INFO_CODES.ORDER_STATUS,
    summary: 'A trip moved to a new status. Fires for every non-cancelled transition.',
    audience: '`ride:<orderId>`, `user:<customerId>` and `driver:<driverId>`',
    payload: '`{ order }` — the full Order at its new status',
    action: 'Re-render the trip.',
  },
  {
    code: INFO_CODES.ORDER_CANCELLED,
    summary: 'A trip was cancelled by either party.',
    audience: '`ride:<orderId>`, `user:<customerId>` and `driver:<driverId>`',
    payload: '`{ order }` — carries `cancellationReason`',
    action: 'Close the trip.',
  },
  {
    code: INFO_CODES.ORDER_NO_DRIVER,
    summary:
      'The search widened to MAX_DRIVER_RADIUS_KM across MAX_DISPATCH_ATTEMPTS passes and nobody claimed it. Terminal.',
    audience: '`user:<customerId>`',
    payload: '`{ order }` at NO_DRIVER_FOUND',
    action: 'Offer to re-book.',
  },
  {
    code: INFO_CODES.DRIVER_LOCATION,
    summary:
      'The assigned driver moved. Raised for positions arriving over REST too, so a driver whose phone is locked still animates on the map.',
    audience: '`driver-watch:<driverId>`',
    payload: '`{ driverId, lat, lng, heading, speedKph, recordedAt }`',
    action: 'Move the marker.',
    example: {
      code: 'DRIVER_LOCATION',
      message: 'Driver moved',
      data: { driverId: 'd41c8b02-5e77-4a19-9c3b-6a2f8e0d4b55', lat: 9.6139, lng: 6.5569 },
    },
  },
  {
    code: INFO_CODES.MESSAGE,
    summary: 'A chat message on a trip. Also raised by `POST /api/orders/{id}/messages`.',
    audience: '`ride:<orderId>`',
    payload: '`{ message }` — the RideMessage',
    action: 'Append to the thread.',
  },
  {
    code: INFO_CODES.MESSAGE_READ,
    summary:
      'The other party opened the chat, so everything you sent before now is read. Raised only when something actually changed — an open chat screen polling in the background emits nothing.',
    audience: '`ride:<orderId>` — both parties, so compare `readerId` to ignore your own',
    payload: '`{ orderId, readerId, readAt, count }`',
    action: 'Mark your own sent messages as read, and clear the unread badge for that order.',
    example: {
      code: 'MESSAGE_READ',
      message: 'Messages read',
      data: {
        orderId: '9c7e2a41-3b08-4f6d-95a2-7e1c4d8b0f33',
        readerId: '3f2a7c1e-9b64-4d2a-8f31-1c0d5e6a7b81',
        readAt: '2026-08-22T11:04:12.880Z',
        count: 2,
      },
    },
  },
  {
    code: INFO_CODES.KYC_UPDATED,
    summary: 'An admin cleared or rejected this driver’s documents.',
    audience: '`user:<driverUserId>`',
    payload: '`{ driver }`',
    action: 'Refresh onboarding state.',
  },
];

export const ALL_NOTIFICATIONS = [...GRID_NOTIFICATIONS, ...TRIP_NOTIFICATIONS];

export const ERROR_NOTIFICATIONS: NotificationDoc[] = [
  {
    code: ERROR_CODES.UNAUTHORIZED,
    summary: 'The handshake token was missing, malformed or expired. The socket closes right after.',
    audience: 'The connecting socket',
    payload: '`{ code, message, error }`',
    action: 'Refresh the access token and reconnect.',
  },
  {
    code: ERROR_CODES.NOTIFICATION_FAILED,
    summary: 'The server could not build a notification it had already committed to.',
    audience: 'The affected socket',
    payload: '`{ code, message, error }`',
    action: 'Refetch state — `GET /api/drivers/state` for a driver.',
  },
];

export const WEBSOCKET_CONTRACT = {
  namespace: WEBSOCKET_NAMESPACE,
  transport: 'socket.io',
  direction: 'server-to-client only — the socket accepts no client events',
  authentication: {
    handshake: 'auth.token, or an Authorization header. A `Bearer ` prefix is stripped either way.',
    token: 'The same accessToken the REST endpoints issue.',
    onFailure: 'An `error` event carrying UNAUTHORIZED, then the socket is closed.',
  },
  events: {
    connected: 'Once, immediately after the handshake. `{ code, message, data: { userId, driverId } }`',
    info: '`{ code, message, data }` — code is one of the INFO codes below',
    error: '`{ code, message, error }`',
  },
  recovery:
    'A reconnect needs no replay. Call GET /api/drivers/state (driver) or GET /api/orders (passenger) and rebuild from that.',
  rooms: WEBSOCKET_ROOMS,
  infoCodes: ALL_NOTIFICATIONS,
  errorCodes: ERROR_NOTIFICATIONS,
};

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((cells) => `| ${cells.join(' | ')} |`),
  ].join('\n');
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function notificationRows(docs: NotificationDoc[]): string[][] {
  return docs.map((doc) => [
    `**\`${doc.code}\`**<br>${cell(doc.summary)}`,
    cell(doc.audience),
    cell(doc.payload),
    cell(doc.action),
  ]);
}

export function renderWebSocketReference(): string {
  const lines: string[] = [];

  lines.push('## Realtime (WebSocket)');
  lines.push('');
  lines.push(
    `Socket.IO at \`ws://<host>${WEBSOCKET_NAMESPACE}\`. It is a **notification pipe**: the ` +
      'server pushes, the client listens, and nothing goes the other way. Every mutation — ' +
      'booking, accepting, rejecting, cancelling, going online, publishing a position — is a ' +
      'REST call. The socket exists to tell you something changed so you can update the screen.',
  );
  lines.push('');
  lines.push(
    'This is what makes reconnecting trivial: there is no in-flight request state to replay. ' +
      'Call `GET /api/drivers/state` and rebuild from the answer.',
  );
  lines.push('');

  lines.push('### Connecting');
  lines.push('');
  lines.push('```js');
  lines.push(`const socket = io('ws://localhost:3000${WEBSOCKET_NAMESPACE}', {`);
  lines.push('  auth: { token: accessToken },   // the same token the REST API issues');
  lines.push('});');
  lines.push('');
  lines.push("socket.on('connected', ({ data }) => {");
  lines.push('  // data = { userId, driverId }');
  lines.push('});');
  lines.push('');
  lines.push("socket.on('info', ({ code, message, data }) => {");
  lines.push('  switch (code) {');
  lines.push("    case 'REQUEST_NEW':    return addCard(data.order);");
  lines.push("    case 'REQUEST_LOST':   return removeCard(data.orderId);");
  lines.push("    case 'REQUEST_CLOSED': return removeCard(data.orderId);");
  lines.push("    case 'REQUEST_WON':    return openTrip(data.order);");
  lines.push('  }');
  lines.push('});');
  lines.push('');
  lines.push("socket.on('error', ({ code, message, error }) => {");
  lines.push("  if (code === 'UNAUTHORIZED') refreshTokenAndReconnect();");
  lines.push('});');
  lines.push('```');
  lines.push('');

  lines.push('### Three events');
  lines.push('');
  lines.push(
    table(
      ['Event', 'When', 'Shape'],
      [
        ['`connected`', 'Once, right after the handshake', '`{ code, message, data: { userId, driverId } }`'],
        ['`info`', 'Something happened', '`{ code, message, data }`'],
        ['`error`', 'Something failed', '`{ code, message, error }`'],
      ],
    ),
  );
  lines.push('');
  lines.push(
    'The `code` on `info` and `error` is a **string**, not an HTTP status — it is what you ' +
      'switch on to know what `data` contains.',
  );
  lines.push('');

  lines.push('### The request grid');
  lines.push('');
  lines.push(
    'Drivers see open jobs as cards. A card appears on `REQUEST_NEW` and leaves on exactly one ' +
      'of the other three — there is no fourth way for it to disappear, and you should never ' +
      'expire one yourself. Fastest finger wins: whoever calls the reserve endpoint first gets ' +
      '`REQUEST_WON`, everybody else gets `REQUEST_LOST`.',
  );
  lines.push('');
  lines.push(table(['Code', 'Goes to', '`data`', 'Do this'], notificationRows(GRID_NOTIFICATIONS)));
  lines.push('');

  lines.push('### Trips, chat and position');
  lines.push('');
  lines.push(table(['Code', 'Goes to', '`data`', 'Do this'], notificationRows(TRIP_NOTIFICATIONS)));
  lines.push('');

  lines.push('### Errors');
  lines.push('');
  lines.push(table(['Code', 'Goes to', 'Payload', 'Do this'], notificationRows(ERROR_NOTIFICATIONS)));
  lines.push('');

  lines.push('### Rooms');
  lines.push('');
  lines.push(
    'You never name a room — the server joins you to the right ones on connect, and joins a ' +
      'passenger to their driver’s feed the moment an order is reserved. Listed so the ' +
      '"goes to" column above makes sense.',
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
    'Trip rooms are re-joined automatically on reconnect for anything still in flight, so a ' +
      'dropped connection needs no special handling.',
  );
  lines.push('');
  lines.push(
    'The full contract is also machine-readable under `x-websocket` in ' +
      '[the OpenAPI JSON](/api/docs-json).',
  );

  return lines.join('\n');
}
