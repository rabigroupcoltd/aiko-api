# Backend API Reference — Aiko / Rabi

REST base URL: `http://localhost:3000/api`
WebSocket: `ws://localhost:3000/ride`
Auth: `Authorization: Bearer <accessToken>` (JWT, expires 7d)

One backend serves both the **admin dashboard** and the **mobile apps**. Access is
separated by role, not by deployment — `ADMIN` routes are marked below.

---

## Table of Contents

1. [Conventions](#1-conventions)
2. [Auth](#2-auth)
3. [Users](#3-users)
4. [Pricing (admin-configurable)](#4-pricing-admin-configurable)
5. [Drivers & vehicles](#5-drivers--vehicles)
6. [Driver location & nearby search](#6-driver-location--nearby-search)
7. [Addresses](#7-addresses)
8. [Ride requests & bidding](#8-ride-requests--bidding)
9. [Orders (trips)](#9-orders-trips)
10. [Wallet](#10-wallet)
11. [Analytics](#11-analytics)
12. [Storage](#12-storage)
13. [Push notifications](#13-push-notifications)
14. [WebSockets](#14-websockets)
15. [Background jobs](#15-background-jobs)
16. [Configuration](#16-configuration)
17. [Route summary](#17-route-summary)

---

## 1. Conventions

### Roles

| Role | Who |
|------|-----|
| `USER` | Passenger. Assigned on registration. |
| `RIDER` | Driver. Added automatically on `POST /api/drivers/register`. |
| `ADMIN` | Back office. **Cannot** be self-assigned — created by the seed script only. |

A user can hold several roles at once; a driver is always a `USER` too.

### Vehicle types

`BICYCLE | TRICYCLE | BIKE | CAR | TRUCK`

Every booking names a vehicle type, and pricing, driver matching and analytics
are all keyed off it. A tricycle request is only ever offered to tricycle
drivers.

### Response envelope

**Every** response — REST and WebSocket acks alike — uses one of two shapes,
picked by the status code:

```jsonc
// code < 400
{ "code": 200, "message": "SUCCESSFUL", "data": { } }

// code >= 400
{ "code": 404, "message": "NOT FOUND", "error": "Driver not found" }
```

- `code` is always the HTTP status, and the response's actual status line
  matches it — you can branch on either.
- Success carries `data` and never `error`. Failure carries `error` and never
  `data`.
- `message` is a short label (`SUCCESSFUL`, `NOT FOUND`) or a friendlier line
  where one helps (`Order accepted`, `You are now online`).
- `error` is a string. Validation failures join every constraint message with
  `, `.

Client check is just `if (res.code >= 400)`.

> **To read this document:** the JSON shown under each endpoint is the contents
> of `data`. The envelope is not repeated 60 times. A full response looks like:
>
> ```json
> { "code": 201, "message": "Order created", "data": { "id": "uuid", "fare": 1480 } }
> ```

### Errors

| Code | Meaning |
|------|---------|
| 400 | Validation failure, illegal state transition, or a broken relation |
| 401 | Missing / invalid / expired token |
| 403 | Authenticated but not allowed (wrong role, not your record) |
| 404 | Not found |
| 409 | Conflict — duplicate record, or you lost a race (order already accepted) |
| 500 | Unhandled failure. The real message is logged; in production the client gets a generic line |
| 503 | Database unreachable — safe to retry |

Unknown body properties are **rejected** (`forbidNonWhitelisted`), so don't send
fields that aren't documented.

#### Database errors

Prisma failures are translated rather than surfacing as a blanket 500 — a
duplicate email comes back as a `409` a client can act on, not an opaque crash.
Two passes produce the response ([prisma-error.ts](src/common/responses/prisma-error.ts)):

1. **`extractPrismaMessage`** reads the message text and matches it against a
   pattern list. This is the only thing that works for
   `PrismaClientValidationError`, which carries no code and no `meta` — the
   field name exists only in prose.
2. **The code table** decides the status, which the text cannot.

So the message comes from (1) and the status from (2); when no pattern matches,
the code table supplies the message too.

| Prisma | Becomes | `error` |
|--------|---------|---------|
| `P2002` unique violation | 409 | `A record with this email already exists.` |
| `P2025` record not found | 404 | `Record not found. It may have already been changed or deleted.` |
| `P2003` foreign key | 400 | `Related record referenced by driverId does not exist.` |
| `P2000` / `P2005`–`P2020` | 400 | Field-specific validation message |
| `P2034` write conflict | 409 | `This record is being changed by another request, please retry` |
| `P1000`–`P1017` connection | 503 | `Database is unavailable, please try again shortly` |
| Validation — missing / null / wrong-typed argument | 400 | `Missing required field "vehicleType".` |
| Validation — unknown or misspelled argument | 500 | Our query is wrong, not the caller's input |
| Anything else | 500 | Logged in full, generic message in production |

Retryable failures are exactly the `409 P2034` and the `503`s.

Messages that name a schema field are developer-facing. Since DTO validation
runs before Prisma, hitting one in production means a bug on our side — so
those are replaced with `The request could not be processed` when
`NODE_ENV=production`, and logged in full regardless.

### Money

All amounts are plain numbers in the currency on the pricing rule (default
`NGN`). Fares round **up** to a multiple of `FARE_ROUNDING_STEP` (default 10).

---

## 2. Auth

### POST /api/auth/register

```json
{
  "email": "user@example.com",
  "password": "string (6–128 chars)",
  "name": "John Doe",
  "phone": "+2348012345678",
  "roles": ["USER"]
}
```

`roles` accepts only `USER` and `RIDER`. Passing `ADMIN` returns 400.

**201:**
```json
{
  "user": { "id": "uuid", "email": "user@example.com", "name": "John Doe", "roles": ["USER"] },
  "accessToken": "jwt-token"
}
```

**Errors:** 409 email already registered.

---

### POST /api/auth/login

```json
{ "email": "user@example.com", "password": "string" }
```

**200:** same shape as register. **Errors:** 401 invalid credentials.

---

### GET /api/auth/profile

Auth: JWT.

**200:** the user plus their driver profile and vehicle photos. The password
hash is **never** returned.

```json
{
  "id": "uuid",
  "email": "user@example.com",
  "name": "John Doe",
  "phone": "+2348012345678",
  "roles": ["USER", "RIDER"],
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:00.000Z",
  "driver": { "id": "uuid", "vehicleType": "TRICYCLE", "vehiclePhotos": [] }
}
```

---

## 3. Users

### GET /api/users
Auth: JWT. Array of users, no password field.

### GET /api/users/:id
Auth: JWT. User plus driver profile.

### PATCH /api/users/:id
Auth: JWT — own profile only, unless `ADMIN`.

```json
{ "name": "New Name", "phone": "+2348098765432" }
```

---

## 4. Pricing (admin-configurable)

One `PricingRule` per vehicle type. This is the single source of truth for
every fare the platform quotes — clients never send a price.

```
fare = ceil(( max(baseFare + perKm×distanceKm + perMinute×durationMins, minimumFare)
              × surgeMultiplier + bookingFee ) / step) × step

platformFee    = round(fare × platformFeePercent / 100)
driverEarnings = fare − platformFee
durationMins   = distanceKm / avgSpeedKph × 60
distanceKm     = haversine(pickup, dropoff) × ROAD_DISTANCE_FACTOR
```

`avgSpeedKph` is per vehicle type, so a bicycle quotes a longer ETA — and a
higher time charge — than a car over the same route.

Defaults are created automatically on first boot for any vehicle type without a
rule, so fares work before an admin touches anything.

---

### GET /api/pricing

Public. `?activeOnly=true` to hide disabled types.

**200:**
```json
[
  {
    "id": "uuid",
    "vehicleType": "TRICYCLE",
    "baseFare": 400,
    "perKm": 120,
    "perMinute": 10,
    "minimumFare": 500,
    "bookingFee": 0,
    "surgeMultiplier": 1,
    "avgSpeedKph": 25,
    "platformFeePercent": 10,
    "currency": "NGN",
    "isActive": true
  }
]
```

### GET /api/pricing/:vehicleType

Public. Single rule. 404 if none.

---

### POST /api/pricing/estimate

Auth: JWT. Quote one vehicle type before booking.

```json
{
  "vehicleType": "TRICYCLE",
  "pickupLat": 9.6091,
  "pickupLng": 6.5471,
  "dropoffLat": 9.6497,
  "dropoffLng": 6.5261
}
```

**200:**
```json
{
  "vehicleType": "TRICYCLE",
  "currency": "NGN",
  "distanceKm": 6.42,
  "durationMins": 15.41,
  "fare": 1480,
  "platformFee": 148,
  "driverEarnings": 1332,
  "breakdown": {
    "baseFare": 400,
    "distanceCharge": 770.4,
    "timeCharge": 154.1,
    "bookingFee": 0,
    "surgeMultiplier": 1,
    "minimumFareApplied": false
  }
}
```

### POST /api/pricing/estimate/all

Auth: JWT. Same body minus `vehicleType` (it is ignored if sent). Returns one
quote **per active vehicle type** for the route — this is what powers the
"tricycle ₦1,480 / bicycle ₦820" picker in the app.

**200:** array of the object above.

---

### PUT /api/pricing/:vehicleType — `ADMIN`

Create or replace a rule.

```json
{
  "baseFare": 400,
  "perKm": 120,
  "perMinute": 10,
  "minimumFare": 500,
  "bookingFee": 0,
  "surgeMultiplier": 1,
  "avgSpeedKph": 25,
  "platformFeePercent": 10,
  "currency": "NGN",
  "isActive": true
}
```

`baseFare`, `perKm`, `perMinute` and `minimumFare` are required; the rest have
defaults.

### PATCH /api/pricing/:vehicleType — `ADMIN`

Partial update — send only what changes. Typical uses:

```json
{ "surgeMultiplier": 1.8 }
```
```json
{ "isActive": false }
```

Setting `isActive: false` immediately stops new bookings of that vehicle type
(`400 "<TYPE> is not available for booking"`). Trips already in flight keep the
fare frozen on the order, so a price change never rewrites history.

---

## 5. Drivers & vehicles

### POST /api/drivers/register

Auth: JWT. **`multipart/form-data`** — vehicle details plus photos.

| Field | Type | Notes |
|-------|------|-------|
| `vehicleType` | text | `BICYCLE \| TRICYCLE \| BIKE \| CAR \| TRUCK` |
| `vehiclePlate` | text | 3–20 chars, uppercased and unique across drivers |
| `vehicleModel` | text | |
| `vehicleColor` | text | optional |
| `vehicleYear` | text | optional, 1950–2100 |
| `photos` | file[] | up to `MAX_VEHICLE_PHOTOS` (default 6), ≤ 5 MB each |
| `photoTypes` | text | optional, comma-separated labels matched positionally |

`photoTypes` values: `FRONT, BACK, SIDE, INTERIOR, PLATE_NUMBER, OTHER`.
Unlabelled files become `OTHER`.

Accepted image types: `jpeg, jpg, png, webp, heic, heif`.

```bash
curl -X POST http://localhost:3000/api/drivers/register \
  -H "Authorization: Bearer $TOKEN" \
  -F vehicleType=TRICYCLE \
  -F vehiclePlate=ABC-123XY \
  -F vehicleModel="Bajaj RE" \
  -F vehicleColor=Yellow \
  -F photoTypes=FRONT,BACK,PLATE_NUMBER \
  -F photos=@front.jpg -F photos=@back.jpg -F photos=@plate.jpg
```

Photos upload to the active storage provider *before* the database write, and
are deleted again if the write fails — no half-registered drivers, no orphaned
files.

**201:**
```json
{
  "id": "uuid",
  "userId": "uuid",
  "vehicleType": "TRICYCLE",
  "vehiclePlate": "ABC-123XY",
  "vehicleModel": "Bajaj RE",
  "vehicleColor": "Yellow",
  "vehicleYear": null,
  "kycStatus": "PENDING",
  "kycRejectionReason": null,
  "isAvailable": false,
  "isBlocked": false,
  "debtLimit": 10000,
  "currentDebt": 0,
  "rating": 5,
  "ratingCount": 0,
  "totalTrips": 0,
  "acceptedTrips": 0,
  "cancelledTrips": 0,
  "user": { "id": "uuid", "name": "...", "email": "...", "phone": "..." },
  "wallet": { "availableBalance": 0, "totalDebt": 0 },
  "vehiclePhotos": [
    {
      "id": "uuid",
      "type": "FRONT",
      "url": "https://res.cloudinary.com/.../front.jpg",
      "key": "vehicles/<userId>/1712345678901-a1b2c3d4.jpg",
      "provider": "CLOUDINARY",
      "mimeType": "image/jpeg",
      "sizeBytes": 184320
    }
  ]
}
```

**Errors:** 400 driver profile already exists · 400 vehicle plate already registered.

---

### GET /api/drivers/me
Auth: JWT. The caller's own driver profile, or `null`.

### GET /api/drivers
Public. Filters: `?vehicleType=TRICYCLE&kycStatus=APPROVED&isAvailable=true`.

### GET /api/drivers/:id
Public. Driver with user, wallet, photos and last known location.

### PATCH /api/drivers/:id
Auth: JWT — self or `ADMIN`. Update `vehicleType`, `vehiclePlate`,
`vehicleModel`, `vehicleColor`, `vehicleYear`.

---

### Vehicle photos

#### GET /api/drivers/:id/photos
Public. Array of photo records.

#### POST /api/drivers/:id/photos
Auth: JWT — self or `ADMIN`. `multipart/form-data` with `photos` (file[]) and
optional `photoTypes`. Returns the driver's full photo list.

#### DELETE /api/drivers/:id/photos/:photoId
Auth: JWT — self or `ADMIN`. Removes the row and the stored object.

```json
{ "deleted": true, "id": "uuid" }
```

Deletion routes to the provider recorded on the row, so photos uploaded before
a provider swap still delete correctly.

---

### KYC

#### PATCH /api/drivers/:id/kyc/approve — `ADMIN`
Empty body. Sets `kycStatus: APPROVED` and clears any rejection reason.

#### PATCH /api/drivers/:id/kyc/reject — `ADMIN`
```json
{ "reason": "Plate number photo unreadable" }
```
Sets `REJECTED`, stores the reason, forces the driver offline and clears them
from the Redis presence index.

---

### PATCH /api/drivers/:id/availability

Auth: JWT — self or `ADMIN`.

```json
{ "isAvailable": true }
```

Going online requires `kycStatus: APPROVED` and `isBlocked: false`, and adds the
driver to the Redis availability set **for their vehicle type**. Going offline
removes them.

**Errors:** 403 KYC must be approved before going online · 403 driver is blocked.

---

### GET /api/drivers/:id/analytics

Auth: JWT — self or `ADMIN`.

```json
{
  "totalEarnings": 50000,
  "todayEarnings": 3000,
  "weekEarnings": 15000,
  "tripsCompleted": 45,
  "activeTrips": 1,
  "rating": 4.8,
  "acceptanceRate": 95.5,
  "cancellationRate": 2.1,
  "currentDebt": 500,
  "debtLimit": 10000
}
```

Rates are computed over trips the driver engaged with (`accepted + cancelled`).

### GET /api/drivers/:id/wallet
Auth: JWT — self or `ADMIN`.

### POST /api/drivers/:id/pay-debt
Auth: JWT — self or `ADMIN`. `{ "amount": 1000 }`. Clamped to the outstanding
debt, writes a `DEBT_PAYMENT` ledger entry, and unblocks the driver if the
remaining debt drops below the limit.

### PATCH /api/drivers/:id/debt-limit — `ADMIN`
`{ "debtLimit": 15000 }`

### PATCH /api/drivers/:id/block — `ADMIN`
`{ "isBlocked": true }` — also forces them offline and clears Redis presence.

---

## 6. Driver location & nearby search

Redis is the source of truth for live position; Postgres holds a snapshot
flushed every `LOCATION_FLUSH_INTERVAL_MS` (default 30s) by a BullMQ job.

| Key | Type | Purpose |
|-----|------|---------|
| `drivers:locations` | GEO | Position of every reporting driver |
| `drivers:available:{VEHICLE_TYPE}` | Set | Who is online, **per vehicle type** |
| `driver:heartbeat:{driverId}` | String, TTL 15s | Expired ⇒ treated as offline |
| `driver:{driverId}:meta` | Hash | heading, speedKph, accuracyMeters, recordedAt |

### POST /api/drivers/location

Auth: JWT (driver). Send roughly every 10s while online.

```json
{
  "lat": 9.6091,
  "lng": 6.5471,
  "heading": 145,
  "speedKph": 38.5,
  "accuracyMeters": 4.2,
  "recordedAt": "2025-08-15T09:30:12.000Z"
}
```

Only `lat` and `lng` are required. One `MULTI` performs the `GEOADD`, the
metadata write and the heartbeat refresh.

**200:**
```json
{ "driverId": "uuid", "lat": 9.6091, "lng": 6.5471, "recordedAt": "2025-08-15T09:30:12.000Z" }
```

The identical WebSocket event is `driver-live-location`.

---

### GET /api/drivers/nearby

Auth: JWT.
`?lat=9.6139&lng=6.5569&radiusKm=5&limit=20&vehicleType=TRICYCLE`

`GEOSEARCH` finds candidates, then anyone with an expired heartbeat, the wrong
vehicle type, unapproved KYC, a block or an offline flag is dropped. Sorted
nearest first.

**200:**
```json
{
  "drivers": [
    {
      "driverId": "uuid",
      "lat": 9.6091,
      "lng": 6.5471,
      "distanceKm": 2.45,
      "heading": 145,
      "speedKph": 38.5,
      "accuracyMeters": 4.2,
      "recordedAt": "2025-08-15T09:30:12.000Z",
      "vehicleType": "TRICYCLE",
      "vehicleModel": "Bajaj RE",
      "vehiclePlate": "ABC-123XY",
      "vehicleColor": "Yellow",
      "rating": 4.8,
      "totalTrips": 45,
      "name": "Musa Ibrahim",
      "phone": "+2348012345678"
    }
  ]
}
```

`GET /api/orders/drivers/nearby` is kept as an alias with the same contract.

---

## 7. Addresses

Cache-through search: the caller's saved addresses → the shared place cache →
Google Places. Remote hits are written to the shared cache (`PlaceCache`), so
one user's lookup warms it for everyone without polluting anybody's saved list.

Without `GOOGLE_MAPS_API_KEY` the remote step is skipped and search still works
off the cache.

### GET /api/addresses/search

Auth: JWT. `?q=mobil&lat=9.61&lng=6.55&limit=10`

`q` is 2–200 chars. `lat`/`lng` bias remote results toward the passenger.

**200:**
```json
{
  "results": [
    {
      "id": "uuid",
      "name": "My Home",
      "address": "Mobil Roundabout, Tunga, Minna",
      "latitude": 9.6091,
      "longitude": 6.5471,
      "placeId": "ChIJ...",
      "source": "SAVED",
      "isDefault": true
    }
  ],
  "source": "cache"
}
```

`source` per result: `SAVED` (the caller's own row, has an `id`) ·
`CACHED` (shared cache, `id: null`) · `REMOTE` (fresh from Places, `id: null`).
Top-level `source`: `"cache"` or `"remote"`.

### POST /api/addresses

Auth: JWT. Saves to the caller's list; re-saving the same address updates it
rather than erroring.

```json
{
  "name": "My Home",
  "address": "Mobil Roundabout, Tunga, Minna",
  "latitude": 9.6091,
  "longitude": 6.5471,
  "placeId": "ChIJ...",
  "isDefault": false
}
```

`isDefault: true` clears the flag on the caller's other addresses.

### GET /api/addresses
Auth: JWT. The caller's saved addresses, default first.

### GET /api/addresses/:id
Auth: JWT. 403 if it isn't yours.

### PATCH /api/addresses/:id
Auth: JWT. `{ "name": "Work", "isDefault": true }`

### DELETE /api/addresses/:id
Auth: JWT. `{ "deleted": true, "id": "uuid" }`

---

## 8. Ride requests & bidding

The matching flow, before an order exists:

```
passenger creates request
  → server quotes the fare and GEOSEARCHes drivers of that vehicle type
  → matched drivers receive `ride-request`
  → drivers respond with `driver-bid`
  → passenger picks one with `accept-driver`
  → an Order is created, already ACCEPTED
```

A request lives `RIDE_REQUEST_TTL` seconds (default 120). If nobody is nearby
the matching worker retries with a wider radius up to `MATCHING_RETRIES` times;
if still unaccepted at TTL it becomes `EXPIRED`.

Statuses: `PENDING → MATCHED → ACCEPTED`, or `EXPIRED` / `CANCELLED`.

These REST routes mirror the WebSocket events exactly — use whichever suits the
client.

### POST /api/ride-requests

Auth: JWT.

```json
{
  "vehicleType": "TRICYCLE",
  "pickupLocation": "Mobil Roundabout, Tunga",
  "dropoffLocation": "FUT Minna, Bosso Campus",
  "pickupLat": 9.6091,
  "pickupLng": 6.5471,
  "dropoffLat": 9.6497,
  "dropoffLng": 6.5261,
  "paymentMethod": "CASH",
  "radiusKm": 5
}
```

**201:**
```json
{
  "request": {
    "id": "uuid",
    "vehicleType": "TRICYCLE",
    "estimatedFare": 1480,
    "distanceKm": 6.42,
    "durationMins": 15.41,
    "status": "MATCHED",
    "matchedDriverIds": ["uuid", "uuid"],
    "expiresAt": "2025-08-15T09:32:12.000Z",
    "bids": []
  },
  "quote": { "...": "same shape as POST /api/pricing/estimate" },
  "matchedDrivers": [{ "driverId": "uuid", "distanceKm": 2.45 }]
}
```

**Errors:** 400 you already have an open ride request.

### GET /api/ride-requests
Auth: JWT. Your last 20 requests (as passenger, or as a matched driver).

### GET /api/ride-requests/inbox
Auth: JWT (driver). Open, unexpired requests this driver was matched into.

### GET /api/ride-requests/nearby

Auth: JWT (driver, KYC-approved, unblocked).

```
GET /api/ride-requests/nearby?lat=9.6139&lng=6.5569&radiusKm=5&limit=20
```

Everything still open within `radiusKm` of that position, for the caller's own
vehicle type, nearest pickup first.

**Why this exists.** Matching only pushes: a request fans out to whoever was
online the moment it was raised. A driver who comes online thirty seconds later
is invisible to it — the rematch worker will find them only if it happens to
still be retrying, and never once those attempts are spent. `inbox` cannot help
either, since it answers "what was I offered". This is the pull half: *what is
going on near me right now*.

Anything returned is subscribed to the caller — they are added to the request's
`matchedDriverIds`, so they also receive its `ride-request-cancelled` and
expiry broadcasts instead of showing a job that closed minutes ago. Polling
this costs no writes once the driver is subscribed to everything nearby.

**200:** the requests, each with the usual fields plus:

| Field | Meaning |
| --- | --- |
| `pickupDistanceKm` | How far the pickup is from the position you sent |
| `secondsRemaining` | Until the request expires |
| `hasBid` | Whether you have already bid on it |

The passenger's `phone` comes back `null` here. Browsing is open to every
approved driver in the radius, which is a wider audience than the matcher's own
shortlist, and a number is not needed to decide whether to bid — it arrives with
the order once the bid is accepted.

Bid on one with `POST /api/ride-requests/{id}/bids` as normal — being matched
was never a precondition for bidding.

The same thing happens automatically without polling: going online, and every
location heartbeat while online, announces the driver and triggers a server-side
sweep (throttled to one per `DRIVER_SWEEP_THROTTLE` seconds per driver). Any
open request it finds is delivered as an ordinary `ride-request` socket event
and push notification, so a driver who simply toggles online gets the work
pushed to them without asking.

**Errors:** 403 no driver profile · 403 KYC not approved · 403 driver is blocked.

### GET /api/ride-requests/:id
Auth: JWT. The request with all bids.

### POST /api/ride-requests/:id/bids

Auth: JWT (driver). Must be KYC-approved, unblocked, and driving the requested
vehicle type. Re-bidding replaces your previous bid.

```json
{ "amount": 1480, "note": "2 minutes away" }
```

`amount` is **informational** by default — the server quote is what gets
charged. Set `ALLOW_BID_FARE_OVERRIDE=true` to let an accepted bid set the
fare, in which case it must be within ±50% of the quote.

**201:** the bid, with the driver and their user contact details.

### POST /api/ride-requests/:id/accept

Auth: JWT (the requesting passenger).

```json
{ "driverId": "uuid" }
```

Claims the request atomically, creates the order in `ACCEPTED`, marks the
winning bid `ACCEPTED` and the rest `REJECTED`.

**200:** the created order. **Errors:** 400 request is no longer open · 404 that
driver has not bid.

### POST /api/ride-requests/:id/cancel

Auth: JWT (the requesting passenger). `{ "reason": "Changed my mind" }`
400 once the request has become a trip — cancel the order instead.

---

## 9. Orders (trips)

All order routes require JWT. Non-admins only ever see trips they are a party
to, on either side.

### POST /api/orders

Books directly, without the bidding flow. **There is no `fare` field** — the
server prices the trip from the active rule for `vehicleType`.

```json
{
  "vehicleType": "TRICYCLE",
  "pickupLocation": "Mobil Roundabout, Tunga",
  "dropoffLocation": "FUT Minna, Bosso Campus",
  "pickupLat": 9.6091,
  "pickupLng": 6.5471,
  "dropoffLat": 9.6497,
  "dropoffLng": 6.5261,
  "paymentMethod": "CASH"
}
```

`paymentMethod`: `CASH | BANK_TRANSFER`.

**201:**
```json
{
  "id": "uuid",
  "userId": "uuid",
  "driverId": null,
  "vehicleType": "TRICYCLE",
  "pickupLocation": "Mobil Roundabout, Tunga",
  "dropoffLocation": "FUT Minna, Bosso Campus",
  "pickupLat": 9.6091,
  "pickupLng": 6.5471,
  "dropoffLat": 9.6497,
  "dropoffLng": 6.5261,
  "distanceKm": 6.42,
  "durationMins": 15.41,
  "fare": 1480,
  "currency": "NGN",
  "pricingSnapshot": {
    "baseFare": 400,
    "distanceCharge": 770.4,
    "timeCharge": 154.1,
    "bookingFee": 0,
    "surgeMultiplier": 1,
    "minimumFareApplied": false
  },
  "status": "PENDING",
  "paymentMethod": "CASH",
  "paymentStatus": "PENDING",
  "platformFee": 148,
  "driverEarnings": 1332,
  "acceptedAt": null,
  "arrivedAt": null,
  "startedAt": null,
  "completedAt": null,
  "cancelledAt": null,
  "cancellationReason": null,
  "user": { "id": "uuid", "name": "...", "phone": "..." },
  "driver": null
}
```

`pricingSnapshot` freezes the rates used, so a later admin price change never
rewrites a past trip.

---

### GET /api/orders

`?status=PENDING&userId=&driverId=&vehicleType=TRICYCLE&limit=20&offset=0`

**200** — `data` is the standard paginated shape:
```json
{
  "totalItems": 137,
  "totalPages": 7,
  "currentPage": 1,
  "result": [ /* orders */ ]
}
```

> Changed from the previous version, which returned a bare array.

### GET /api/orders/:id
Full order with user and driver. 403 if you aren't a participant.

---

### POST /api/orders/:id/accept

Auth: JWT (driver). Empty body. The token's user is resolved to their driver
profile — you don't pass a driverId.

The claim is a guarded update, so with two drivers racing exactly one wins and
the other gets `400 "Order was already accepted by another driver"`.

**Errors:** 400 order not available · 400 KYC not approved · 400 driver blocked ·
400 driver not available · 400 vehicle type mismatch · 403 no driver profile.

---

### PATCH /api/orders/:id/status

```json
{ "status": "IN_PROGRESS", "reason": "optional, for CANCELLED" }
```

Legal transitions — anything else is a 400:

| From | To |
|------|-----|
| `PENDING` | `ACCEPTED`, `CANCELLED` |
| `ACCEPTED` | `ARRIVED`, `IN_PROGRESS`, `CANCELLED` |
| `ARRIVED` | `IN_PROGRESS`, `CANCELLED` |
| `IN_PROGRESS` | `COMPLETED`, `CANCELLED` |
| `COMPLETED` / `CANCELLED` | — terminal |

**On `COMPLETED`** — one transaction covering the order, driver counters, wallet
and ledger:

- `CASH` — the driver already holds the money, so `platformFee` is added to
  `currentDebt` and `wallet.totalDebt`; ledger entry `PLATFORM_FEE`.
- `BANK_TRANSFER` — the platform holds the money, so `driverEarnings` is added
  to `availableBalance` and `totalEarnings`; ledger entry `RIDE_EARNINGS`.
- `totalTrips` increments, `paymentStatus` becomes `PAID`.
- If `currentDebt >= debtLimit` the driver is blocked, forced offline and
  cleared from Redis presence.

**On `CANCELLED`** — `cancelledTrips` increments only when the **driver**
cancels a trip they had already accepted. An admin cancelling on their behalf
does not count against them.

### POST /api/orders/:id/cancel
Shorthand for the above. `{ "reason": "Driver took too long" }`

---

### Trip chat

#### GET /api/orders/:id/messages
Participants only. Ascending by time, sender contact included.

#### POST /api/orders/:id/messages
`{ "content": "I'm at the gate" }` — 400 once the trip is completed or cancelled.
Also broadcast over WebSocket as `new-message`.

### POST /api/orders/:id/rating

Rates the other party. Completed trips only, once per person.

```json
{ "score": 5, "comment": "Very fast" }
```

`score` is 1–5. A passenger rating a driver updates the driver's running mean
(`rating`, `ratingCount`).

**Errors:** 400 you can only rate a completed trip · 400 you already rated this trip.

---

## 10. Wallet

All wallet routes require JWT **and** ownership — a driver sees only their own
wallet, an admin sees any.

> These were previously unauthenticated. Anyone who knew a `driverId` could read
> balances and trigger withdrawals; that is now closed.

### GET /api/wallet/driver/:driverId

```json
{
  "id": "uuid",
  "driverId": "uuid",
  "totalEarnings": 50000,
  "totalWithdrawals": 20000,
  "totalDebt": 500,
  "availableBalance": 29500,
  "pendingBalance": 0,
  "createdAt": "...",
  "updatedAt": "..."
}
```

Created on demand if the driver has no wallet row yet.

### GET /api/wallet/driver/:driverId/transactions

`?limit=50&offset=0` — paginated.

```json
{
  "totalItems": 212,
  "totalPages": 5,
  "currentPage": 1,
  "result": [
    {
      "id": "uuid",
      "driverId": "uuid",
      "type": "RIDE_EARNINGS",
      "amount": 1332,
      "balanceAfter": 29500,
      "reference": "ORDER-uuid",
      "description": "Ride earnings for trip uuid",
      "createdAt": "..."
    }
  ]
}
```

`type`: `RIDE_EARNINGS | PLATFORM_FEE | WITHDRAWAL | DEBT_PAYMENT | ADJUSTMENT`.
Money leaving the driver (`PLATFORM_FEE`, `WITHDRAWAL`, `DEBT_PAYMENT`) is
recorded as a **negative** amount.

### POST /api/wallet/driver/:driverId/withdraw

`{ "amount": 5000 }`

Minimum `MIN_WITHDRAWAL` (default 500). Refused while the driver has
outstanding debt. The balance check lives inside the update, so two concurrent
withdrawals cannot both succeed.

**Errors:** 400 minimum withdrawal is N · 400 clear your outstanding debt first ·
400 insufficient balance.

### GET /api/wallet/all — `ADMIN`
Every wallet with driver and user, richest first.

---

## 11. Analytics — `ADMIN`

All routes require the `ADMIN` role. Drivers get their own figures from
`GET /api/drivers/:id/analytics`.

### GET /api/analytics/overview
```json
{
  "totalUsers": 100,
  "totalDrivers": 25,
  "activeDrivers": 12,
  "totalOrders": 500,
  "completedOrders": 450,
  "cancelledOrders": 30,
  "completionRate": "90.0",
  "cancellationRate": "6.0",
  "cashRevenue": 300000,
  "transferRevenue": 200000,
  "totalRevenue": 500000,
  "platformEarnings": 50000,
  "outstandingDebt": 2000
}
```

### GET /api/analytics/vehicle-types

New — how each vehicle type is performing, alongside its current rates.

```json
[
  {
    "vehicleType": "TRICYCLE",
    "isActive": true,
    "baseFare": 400,
    "perKm": 120,
    "drivers": 18,
    "totalOrders": 320,
    "completedOrders": 295,
    "cancelledOrders": 15,
    "revenue": 436000,
    "platformEarnings": 43600
  }
]
```

### GET /api/analytics/drivers
Per-driver earnings, trips, rating, debt.

### GET /api/analytics/orders
```json
{
  "today":     { "total": 10, "completed": 8, "cancelled": 1, "pending": 1, "revenue": 15000 },
  "thisWeek":  { "...": "" },
  "thisMonth": { "...": "" },
  "allTime":   { "total": 500, "revenue": 500000 }
}
```

### GET /api/analytics/revenue
30-day daily series plus a summary.

### GET /api/analytics/top-drivers?limit=10
### GET /api/analytics/low-performers?limit=10

---

## 12. Storage

Vehicle photos go to one of four backends, chosen by `STORAGE_PROVIDER`:

| Provider | Env | Notes |
|----------|-----|-------|
| `LOCAL` | `UPLOAD_DIR` | Writes to disk, served at `/uploads/...`. Default — no credentials needed. |
| `CLOUDINARY` | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | `key` is the Cloudinary `public_id`. |
| `S3` | `AWS_REGION`, `AWS_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_S3_PUBLIC_URL` | |
| `CLOUDFLARE_R2` | `CLOUDFLARE_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_URL` | S3-compatible. R2 buckets are private by default, so set `R2_PUBLIC_URL`. |

Swapping is a one-line env change and a restart — no code touches a concrete
provider, everything goes through `StorageService`. Only the active provider's
SDK client is constructed, so unused credentials can stay blank.

Every `VehiclePhoto` row stores the `provider` it was written with, so files
uploaded before a swap still delete from the right place.

Object keys look like `vehicles/<userId>/<timestamp>-<random><ext>`.

### GET /api/storage/provider — `ADMIN`

```json
{ "active": "CLOUDINARY", "available": ["LOCAL", "CLOUDINARY", "S3", "CLOUDFLARE_R2"] }
```

---

## 13. Push notifications

Firebase Cloud Messaging, using the same service-account credentials as
`POST /api/auth/firebase` — there is nothing extra to configure. If Firebase is
unconfigured, push is skipped silently and the socket remains the only delivery
path.

**Push is a fallback, never the source of truth.** Everything below is also a
WebSocket broadcast; push exists for a client that is backgrounded or off the
socket. Nothing in the ride services knows notifications exist — they publish to
the in-process event bus, and both the gateway and the notifier subscribe to it.

### Registering a device

#### POST /api/notifications/devices

Auth: JWT.

```json
{
  "token": "<fcm-registration-token>",
  "platform": "ANDROID",
  "deviceId": "a3f1c8e0d94b27e5",
  "deviceName": "Tecno Spark 10",
  "appVersion": "1.0.0"
}
```

Idempotent — call it on every launch and on every token refresh. Sending a
stable `deviceId` is what lets a rotated token replace the previous registration
for the same handset instead of leaving a dead one behind, and it also drops the
**previous owner's** registration if the phone changed hands.

#### DELETE /api/notifications/devices

Auth: JWT. `{ "token": "<fcm-registration-token>" }` — call on sign-out, before
clearing the session. Scoped to the caller, so one user cannot silence another.

#### GET /api/notifications/devices

Auth: JWT. The caller's registrations. Tokens themselves are never returned —
they are send-only credentials.

#### POST /api/notifications/test

Auth: JWT. `{ "title": "…", "body": "…" }`, both optional. Sends to every device
registered to the caller and returns `{ sent, failed, pruned }`. `sent: 0`
without an error means Firebase is unconfigured on this server, or the device
never registered.

Tokens FCM reports as unregistered are deleted automatically on the next send,
so the table does not accumulate dead installs.

### What gets sent

Every message carries a `type` in its data payload, plus a `dedupeKey` matching
the socket event it duplicates — a foreground client that already handled the
socket event should drop the notification rather than showing it twice.

| `type` | Goes to | When |
|--------|---------|------|
| `RIDE_REQUEST` | Matched drivers | A new job, and when a driver comes online next to an open one |
| `BID_PLACED` | Passenger | A driver offered to take the trip |
| `BID_ACCEPTED` | Winning driver | The passenger picked them |
| `RIDE_REQUEST_CANCELLED` | Matched drivers | Passenger withdrew — **silent**, data only |
| `RIDE_REQUEST_EXPIRED` | Passenger | Nobody bid inside the TTL |
| `TRIP_STATUS` | Passenger, and driver on completion | `ARRIVED`, `IN_PROGRESS`, `COMPLETED` (in `data.status`) |
| `TRIP_CANCELLED` | Both parties | A trip was called off |
| `TRIP_MESSAGE` | The other party | Chat on an active trip |
| `KYC_STATUS` | Driver | An admin cleared or rejected their documents |

Notes on the delivery choices:

- **Cancellations are silent** — data only, no tray entry. The offer has to
  disappear from the driver's inbox, but buzzing a phone to say "never mind" is
  the fastest way to get notifications turned off.
- **Collapse keys** are per subject, not per message: several drivers bidding on
  one request refresh a single tray entry rather than stacking, and a burst of
  chat on one trip is one notification.
- **Ride offers expire.** They carry a TTL of `RIDE_REQUEST_TTL`, so a driver
  coming back online is never buzzed about a job that closed an hour ago. Trip
  updates use `PUSH_TRIP_TTL` (default 1800s).
- `ACCEPTED` raises no `TRIP_STATUS`: it is the same moment as the accepted bid,
  which the driver has already been told about and the passenger triggered.

### Android channel

`FCM_RIDE_CHANNEL_ID` is **unset by default**, and should stay that way unless
the app declares a matching high-importance channel. Naming a channel the client
has not created makes Android fall back to the manifest default — that loses the
heads-up banner rather than gaining it.

---

## 14. WebSockets

Namespace `/ride`. Socket.IO with the Redis Streams adapter, so any instance can
reach any socket — no sticky sessions.

### Connecting

```ts
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000/ride', {
  transports: ['websocket'],
  auth: { token: accessToken },
});

socket.on('connected', ({ ok, userId, driverId }) => { /* ... */ });
```

The token also works as an `Authorization: Bearer` handshake header. A bad token
gets `connected: { ok: false }` followed by a disconnect.

On connect you are joined to `user:{yourUserId}`, `driver:{yourDriverId}` if you
have a driver profile, and the rooms of any trip still in flight — so a
reconnect mid-trip resumes without extra calls.

### Client → server

| Event | Who | Payload | Effect |
|-------|-----|---------|--------|
| `driver-live-location` | DRIVER | `{ lat, lng, heading?, speedKph?, accuracyMeters?, recordedAt? }` | GEOADD + heartbeat, broadcasts to watchers |
| `subscribe-driver-location` | any | `{ driverId }` | Join that driver's position feed |
| `unsubscribe-driver-location` | any | `{ driverId }` | Leave it |
| `passenger-trip-request` | PASSENGER | `CreateRideRequestDto` (§8) | Creates the request and fans it out |
| `nearby-requests` | DRIVER | `{ lat, lng, radiusKm?, limit? }` | Open requests around you — the pull half of matching (§8). Joins each request room |
| `driver-bid` | DRIVER | `{ requestId, amount?, note? }` | Places / replaces a bid |
| `accept-driver` | PASSENGER | `{ requestId, driverId }` | Creates the order |
| `cancel-request` | PASSENGER | `{ requestId, reason? }` | Cancels before matching |
| `subscribe-ride` | participant | `{ rideId }` | Join a trip room, returns the order |
| `update-ride-stage` | participant | `{ rideId, stage }` | `ARRIVED \| IN_PROGRESS \| COMPLETED` |
| `cancel-trip` | participant | `{ rideId, reason? }` | Cancels an active trip |
| `message` | participant | `{ rideId, content }` | Trip chat |
| `submit-rating` | participant | `{ rideId, score, comment? }` | Rate the other party |

Every handler returns an ack in the **same envelope as REST**, so one response
handler covers both transports:

```ts
const res = await socket.emitWithAck('accept-driver', { requestId, driverId });
if (res.code >= 400) showError(res.error);
else openTripScreen(res.data);
```

### Server → client

| Event | Payload | Sent to |
|-------|---------|---------|
| `connected` | Envelope — `data: { userId, driverId }`, or `code: 401` then a disconnect | The connecting socket |
| `driver-location-update` | `{ driverId, lat, lng, heading, speedKph, recordedAt }` | `driver-watch:{driverId}` |
| `ride-request` | `{ requestId, vehicleType, pickup, dropoff, distanceKm, fare, expiresAt }` | Each matched driver — including a driver who just came online near an already-open request |
| `driver-bid-placed` | The bid, with driver details | Passenger + request room |
| `driver-accepted` | The created order | Passenger and winning driver |
| `ride-request-cancelled` | `{ requestId }` | Matched drivers |
| `ride-request-expired` | The request | Passenger |
| `ride-stage-changed` | The order | Trip room, passenger, driver |
| `trip-cancelled` | The order | Trip room, passenger, driver |
| `new-message` | The message with sender | Trip room |

Because REST and WebSocket share one event bus, a status change made over REST
still reaches sockets — the admin dashboard cancelling a trip pushes
`trip-cancelled` to both apps. Push notifications (§13) subscribe to that same
bus, so every event above also reaches a backgrounded client.

### Rooms

| Room | Members |
|------|---------|
| `user:{userId}` | One user, any role |
| `driver:{driverId}` | One driver — ride offers |
| `ride:{orderId}` | Driver + passenger |
| `driver-watch:{driverId}` | Everyone tracking that driver on a map |
| `request:{requestId}` | Passenger + bidding drivers |

---

## 15. Background jobs

BullMQ on the same Redis.

| Queue | Job | Schedule | Purpose |
|-------|-----|----------|---------|
| `driver-location` | `process-driver-location` | Repeating, every `LOCATION_FLUSH_INTERVAL_MS` | Flush Redis positions into `driver_locations` |
| `ride-matching` | `find-nearby-drivers` | On demand, `MATCHING_RETRY_DELAY_MS` apart | Re-search with a wider radius when nobody was found |
| `ride-timeout` | `cancel-unaccepted-order` | Delayed to `expiresAt` | Expire a request nobody accepted |

Workers live in `WorkersModule`. Drop that one import from `AppModule` to run
API-only instances and host the workers in a separate process.

---

## 16. Configuration

See `.env.example` for the full annotated list. The ones that change behaviour
most:

| Variable | Default | Effect |
|----------|---------|--------|
| `STORAGE_PROVIDER` | `LOCAL` | Which photo backend is active |
| `FARE_ROUNDING_STEP` | `10` | Fares round up to this multiple |
| `ROAD_DISTANCE_FACTOR` | `1.3` | Straight-line → road distance padding |
| `SEARCH_RADIUS_KM` | `5` | Default driver search radius |
| `RIDE_REQUEST_TTL` | `120` | Seconds before a request expires |
| `ALLOW_BID_FARE_OVERRIDE` | `false` | Let an accepted bid set the fare |
| `DRIVER_HEARTBEAT_TTL` | `15` | Seconds before a driver counts as offline |
| `MIN_WITHDRAWAL` | `500` | Smallest withdrawal |
| `GOOGLE_MAPS_API_KEY` | — | Blank disables remote place lookup |

### First run

```bash
npm install
cp .env.example .env          # then fill in DATABASE_URL and JWT_SECRET
npm run prisma:migrate        # creates the schema
npm run prisma:seed           # first ADMIN + default pricing rules
npm run start:dev
```

The seed is idempotent. It creates the first admin from `SEED_ADMIN_EMAIL` /
`SEED_ADMIN_PASSWORD` — the only way to get one, since registration refuses to
grant `ADMIN`.

Redis must be reachable for presence, matching and WebSockets.

### Adding an endpoint

Same pattern everywhere — a service never throws at its boundary, and a
controller never builds an envelope by hand.

**Service** — try/catch, return `{ error, body }`:

```ts
async findOne(id: string): Promise<ServiceResult> {
  try {
    const driver = await this.prisma.driver.findUnique({ where: { id } });
    if (!driver) return notFound('Driver not found');
    return ok(driver);
  } catch (e) {
    return this.response.errorHandler(e);   // Prisma + HttpException aware
  }
}
```

**Controller** — try/catch, hand the result to `ResponsesService`:

```ts
@Get(':id')
async findOne(@Param('id') id: string) {
  try {
    const result = await this.driversService.findOne(id);
    return this.response.handle(result);              // 201 via handleCreated()
  } catch (e) {
    return this.response.exception(e);
  }
}
```

`handle()` maps the error code to the right status, so a handler never needs an
`if (result.error === 1) … if (result.error === 2) …` ladder. Branch manually
only when you want a custom message for a specific case.

**Error codes** — `0`, `1` and `2` mean what they do in the `api` project; the
rest exist so a service can ask for the exact status instead of collapsing
everything into 400 or 500.

| `error` | Constant | Status | Helper |
|---------|----------|--------|--------|
| 0 | `ERR.NONE` | 200 / 201 | `ok(body)` |
| 1 | `ERR.BAD_REQUEST` | 400 | `badRequest(msg)` |
| 2 | `ERR.EXCEPTION` | 500 | `exception(msg)` |
| 3 | `ERR.UNAUTHORIZED` | 401 | `unauthorized(msg)` |
| 4 | `ERR.FORBIDDEN` | 403 | `forbidden(msg)` |
| 5 | `ERR.NOT_FOUND` | 404 | `notFound(msg)` |
| 6 | `ERR.CONFLICT` | 409 | `conflict(msg)` |
| 7 | `ERR.UNAVAILABLE` | 503 | — set by the Prisma mapper |

Guards that return a result compose by propagating it:

```ts
const allowed = await this.assertCanManage(driverId, user);
if (allowed.error) return allowed;        // 403 or 404 passes straight through
```

Three pieces make this hold globally, all wired in `main.ts`:

| Piece | Job |
|-------|-----|
| `StatusInterceptor` | Sets the HTTP status line from `code` in the body |
| `AllExceptionsFilter` | Catches what bypasses a controller's try/catch — guards, pipes, validation — and emits the same envelope |
| `ValidationPipe` `exceptionFactory` | Joins constraint messages into one `error` string |

Paginated lists go through `this.response.pagingData({ totalItems, result }, page, limit)`.

---

## 17. Route summary

| Method | Path | Auth |
|--------|------|------|
| POST | `/api/auth/register` | — |
| POST | `/api/auth/login` | — |
| GET | `/api/auth/profile` | JWT |
| GET | `/api/users` | JWT |
| GET | `/api/users/:id` | JWT |
| PATCH | `/api/users/:id` | JWT (self / admin) |
| GET | `/api/pricing` | — |
| GET | `/api/pricing/:vehicleType` | — |
| POST | `/api/pricing/estimate` | JWT |
| POST | `/api/pricing/estimate/all` | JWT |
| PUT | `/api/pricing/:vehicleType` | ADMIN |
| PATCH | `/api/pricing/:vehicleType` | ADMIN |
| POST | `/api/drivers/register` | JWT · multipart |
| GET | `/api/drivers/me` | JWT |
| GET | `/api/drivers/nearby` | JWT |
| POST | `/api/drivers/location` | JWT (driver) |
| GET | `/api/drivers` | — |
| GET | `/api/drivers/:id` | — |
| PATCH | `/api/drivers/:id` | JWT (self / admin) |
| GET | `/api/drivers/:id/photos` | — |
| POST | `/api/drivers/:id/photos` | JWT (self / admin) · multipart |
| DELETE | `/api/drivers/:id/photos/:photoId` | JWT (self / admin) |
| PATCH | `/api/drivers/:id/kyc/approve` | ADMIN |
| PATCH | `/api/drivers/:id/kyc/reject` | ADMIN |
| PATCH | `/api/drivers/:id/availability` | JWT (self / admin) |
| GET | `/api/drivers/:id/analytics` | JWT (self / admin) |
| GET | `/api/drivers/:id/wallet` | JWT (self / admin) |
| POST | `/api/drivers/:id/pay-debt` | JWT (self / admin) |
| PATCH | `/api/drivers/:id/debt-limit` | ADMIN |
| PATCH | `/api/drivers/:id/block` | ADMIN |
| GET | `/api/addresses/search` | JWT |
| POST | `/api/addresses` | JWT |
| GET | `/api/addresses` | JWT |
| GET | `/api/addresses/:id` | JWT |
| PATCH | `/api/addresses/:id` | JWT |
| DELETE | `/api/addresses/:id` | JWT |
| POST | `/api/ride-requests` | JWT |
| GET | `/api/ride-requests` | JWT |
| GET | `/api/ride-requests/inbox` | JWT (driver) |
| GET | `/api/ride-requests/nearby` | JWT (driver) |
| GET | `/api/ride-requests/:id` | JWT |
| POST | `/api/ride-requests/:id/bids` | JWT (driver) |
| POST | `/api/ride-requests/:id/accept` | JWT (passenger) |
| POST | `/api/ride-requests/:id/cancel` | JWT (passenger) |
| POST | `/api/orders` | JWT |
| GET | `/api/orders` | JWT |
| GET | `/api/orders/drivers/nearby` | JWT |
| GET | `/api/orders/:id` | JWT (participant) |
| POST | `/api/orders/:id/accept` | JWT (driver) |
| PATCH | `/api/orders/:id/status` | JWT (participant) |
| POST | `/api/orders/:id/cancel` | JWT (participant) |
| GET | `/api/orders/:id/messages` | JWT (participant) |
| POST | `/api/orders/:id/messages` | JWT (participant) |
| POST | `/api/orders/:id/rating` | JWT (participant) |
| GET | `/api/wallet/all` | ADMIN |
| GET | `/api/wallet/driver/:driverId` | JWT (self / admin) |
| GET | `/api/wallet/driver/:driverId/transactions` | JWT (self / admin) |
| POST | `/api/wallet/driver/:driverId/withdraw` | JWT (self / admin) |
| GET | `/api/analytics/overview` | ADMIN |
| GET | `/api/analytics/vehicle-types` | ADMIN |
| GET | `/api/analytics/drivers` | ADMIN |
| GET | `/api/analytics/orders` | ADMIN |
| GET | `/api/analytics/revenue` | ADMIN |
| GET | `/api/analytics/top-drivers` | ADMIN |
| GET | `/api/analytics/low-performers` | ADMIN |
| GET | `/api/storage/provider` | ADMIN |
| POST | `/api/notifications/devices` | JWT |
| DELETE | `/api/notifications/devices` | JWT |
| GET | `/api/notifications/devices` | JWT |
| POST | `/api/notifications/test` | JWT |

### Breaking changes vs. the previous document

| What | Was | Now |
|------|-----|-----|
| **Every response** | Raw object / Nest's `{ statusCode, message, error }` | `{ code, message, data }` under 400, `{ code, message, error }` at 400+ |
| WebSocket acks | Raw object | Same envelope as REST |
| `GET /orders`, `GET /wallet/.../transactions` | Bare array / ad-hoc paging | `{ totalItems, totalPages, currentPage, result }` inside `data` |
| Database failures | Blanket 500 | Mapped — 409 on duplicate, 404 on missing, 503 when unreachable |
| `POST /api/orders` | Client sent `fare` | `fare` rejected; server prices from `vehicleType` |
| `POST /api/orders` | No vehicle type | `vehicleType` required |
| `GET /api/orders` | Bare array, public | `{ data, total, limit, offset }`, JWT, scoped to your trips |
| `POST /api/drivers/register` | JSON | `multipart/form-data` with photos |
| KYC / block / debt-limit | Any JWT | `ADMIN` only |
| Wallet routes | Public | JWT + ownership |
| Analytics | Any JWT | `ADMIN` only |
| `GET /api/drivers`, `/:id` | Returned the password hash | Never returned |
| `POST /api/auth/register` | `roles` accepted `ADMIN` | `USER` / `RIDER` only |
| `POST /api/orders/:id/accept` | Treated the JWT `sub` as a driverId | Resolves the caller's driver profile (previously always 404'd) |
