/**
 * Sample payloads shared by the Swagger response decorators.
 *
 * These mirror the shapes the services actually return — Prisma models plus
 * whatever `include`/`select` the query uses — so the documented sample and a
 * real response line up field for field. Keep them in sync when a select or a
 * computed shape changes.
 */

// -------------------------------------------------------------------- ids

const USER_ID = '3f2a7c1e-9b64-4d2a-8f31-1c0d5e6a7b81';
const DRIVER_ID = 'd41c8b02-5e77-4a19-9c3b-6a2f8e0d4b55';
const ORDER_ID = '9c7e2a41-3b08-4f6d-95a2-7e1c4d8b0f33';
const REQUEST_ID = 'b5d9f0a3-7c21-4e88-9a16-2f3b6c8d1e04';
const WALLET_ID = 'e8a1c503-42b9-4d67-b0f8-93c5a7e2d146';

// ------------------------------------------------------------------ users

export const USER_EXAMPLE = {
  id: USER_ID,
  email: 'ada@example.com',
  name: 'Ada Obi',
  phone: '+2348012345678',
  roles: ['USER'],
  createdAt: '2026-07-14T09:12:33.481Z',
  updatedAt: '2026-07-28T16:04:02.117Z',
};

const ACCESS_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIzZjJhN2MxZS05YjY0LTRkMmEtOGYzMS0xYzBkNWU2YTdiODEiLCJlbWFpbCI6ImFkYUBleGFtcGxlLmNvbSIsInJvbGVzIjpbIlVTRVIiXSwiaWF0IjoxNzg1MzE1OTUzLCJleHAiOjE3ODU5MjA3NTN9.7Q0nJk8mVwZ2rC5pXsA1tD9yLbH3fGqE4uNvK6cRxTo';

// ------------------------------------------------------------- onboarding

/** Mid-onboarding: profile is saved, the selfie is not. */
export const ONBOARDING_STATE_EXAMPLE = {
  resumeStep: 'PHOTO',
  recordedStep: 'PHOTO',
  stepIndex: 2,
  totalSteps: 5,
  completed: false,
  completedAt: null,
  accountType: null,
  passengerReady: false,
  driver: { status: 'NOT_APPLICABLE', driverId: null, rejectionReason: null },
  requirements: {
    phone: true,
    profile: true,
    photo: false,
    liveness: false,
    accountType: false,
    vehicleDetails: true,
    adminApproval: true,
  },
};

/** Everything cleared — the client sends the user to the dashboard. */
export const ONBOARDING_STATE_DONE_EXAMPLE = {
  resumeStep: 'DONE',
  recordedStep: 'DONE',
  stepIndex: 5,
  totalSteps: 5,
  completed: true,
  completedAt: '2026-07-14T09:31:52.664Z',
  accountType: 'PASSENGER',
  passengerReady: true,
  driver: { status: 'NOT_APPLICABLE', driverId: null, rejectionReason: null },
  requirements: {
    phone: true,
    profile: true,
    photo: true,
    liveness: true,
    accountType: true,
    vehicleDetails: true,
    adminApproval: true,
  },
};

/** A rider who picked their role but has not registered a vehicle yet. */
export const ONBOARDING_STATE_RIDER_DOCS_EXAMPLE = {
  resumeStep: 'RIDER_DOCS',
  recordedStep: 'USER_TYPE',
  stepIndex: 5,
  totalSteps: 7,
  completed: false,
  completedAt: null,
  accountType: 'RIDER',
  // Shared steps are behind them, so they can already book trips as a passenger.
  passengerReady: true,
  driver: { status: 'NOT_SUBMITTED', driverId: null, rejectionReason: null },
  requirements: {
    phone: true,
    profile: true,
    photo: true,
    liveness: true,
    accountType: true,
    vehicleDetails: false,
    adminApproval: false,
  },
};

/**
 * Vehicle registered, sitting on the waiting screen until an admin clears the
 * KYC. `passengerReady` is true throughout — the app must not lock them out.
 */
export const ONBOARDING_STATE_AWAITING_APPROVAL_EXAMPLE = {
  resumeStep: 'AWAITING_APPROVAL',
  recordedStep: 'AWAITING_APPROVAL',
  stepIndex: 6,
  totalSteps: 7,
  completed: false,
  completedAt: null,
  accountType: 'RIDER',
  passengerReady: true,
  driver: {
    status: 'PENDING',
    driverId: 'd41c8b02-5e77-4a19-9c3b-6a2f8e0d4b55',
    rejectionReason: null,
  },
  requirements: {
    phone: true,
    profile: true,
    photo: true,
    liveness: true,
    accountType: true,
    vehicleDetails: true,
    adminApproval: false,
  },
};

/** Rejected KYC — back to the document step, with the reason to show them. */
export const ONBOARDING_STATE_REJECTED_EXAMPLE = {
  resumeStep: 'RIDER_DOCS',
  recordedStep: 'RIDER_DOCS',
  stepIndex: 5,
  totalSteps: 7,
  completed: false,
  completedAt: null,
  accountType: 'RIDER',
  passengerReady: true,
  driver: {
    status: 'REJECTED',
    driverId: 'd41c8b02-5e77-4a19-9c3b-6a2f8e0d4b55',
    rejectionReason: 'Plate number photo is unreadable.',
  },
  requirements: {
    phone: true,
    profile: true,
    photo: true,
    liveness: true,
    accountType: true,
    vehicleDetails: true,
    adminApproval: false,
  },
};

/** An approved rider. Still a passenger — note both roles. */
export const ONBOARDING_STATE_RIDER_DONE_EXAMPLE = {
  resumeStep: 'DONE',
  recordedStep: 'DONE',
  stepIndex: 7,
  totalSteps: 7,
  completed: true,
  completedAt: '2026-07-20T12:04:18.220Z',
  accountType: 'RIDER',
  passengerReady: true,
  driver: {
    status: 'APPROVED',
    driverId: 'd41c8b02-5e77-4a19-9c3b-6a2f8e0d4b55',
    rejectionReason: null,
  },
  requirements: {
    phone: true,
    profile: true,
    photo: true,
    liveness: true,
    accountType: true,
    vehicleDetails: true,
    adminApproval: true,
  },
};

// ------------------------------------------------------------------- auth

/** A user who has already finished setup — the "straight to dashboard" case. */
export const FIREBASE_SESSION_RETURNING_EXAMPLE = {
  isNewUser: false,
  accessToken: ACCESS_TOKEN,
  user: {
    ...USER_EXAMPLE,
    firebaseUid: 'YjFxN2JkQ2hyRW1jR3o5',
    firstName: 'Ada',
    lastName: 'Obi',
    dob: '1998-04-12T00:00:00.000Z',
    photoUrl: 'https://lh3.googleusercontent.com/a/ACg8ocK-example',
    profilePhotoUrl: 'http://localhost:3000/uploads/selfies/3f2a7c1e.jpg',
    authProvider: 'FIREBASE_GOOGLE',
    emailVerified: true,
    phoneVerified: false,
    accountType: 'PASSENGER',
    onboardingStep: 'DONE',
    onboardingCompletedAt: '2026-07-14T09:31:52.664Z',
    livenessPassedAt: '2026-07-14T09:28:40.115Z',
    lastLoginAt: '2026-08-01T07:55:12.883Z',
  },
  onboarding: ONBOARDING_STATE_DONE_EXAMPLE,
};

/**
 * First sign-in through phone auth: the number is already verified, so PHONE is
 * behind them and the app opens on the profile form.
 */
export const FIREBASE_SESSION_NEW_EXAMPLE = {
  isNewUser: true,
  accessToken: ACCESS_TOKEN,
  user: {
    id: '7d1e4a09-52c8-4b36-91af-3e0b7c6d5824',
    email: null,
    name: null,
    firstName: null,
    lastName: null,
    phone: '+2348012345678',
    dob: null,
    photoUrl: null,
    profilePhotoUrl: null,
    firebaseUid: 'Qk9wM2xUZVhyTm00VjEy',
    authProvider: 'FIREBASE_PHONE',
    emailVerified: false,
    phoneVerified: true,
    roles: ['USER'],
    accountType: null,
    onboardingStep: 'PROFILE',
    onboardingCompletedAt: null,
    livenessPassedAt: null,
    lastLoginAt: '2026-08-01T07:55:12.883Z',
    createdAt: '2026-08-01T07:55:12.883Z',
    updatedAt: '2026-08-01T07:55:12.883Z',
  },
  onboarding: {
    resumeStep: 'PROFILE',
    recordedStep: 'PROFILE',
    stepIndex: 1,
    totalSteps: 5,
    completed: false,
    completedAt: null,
    accountType: null,
    passengerReady: false,
    driver: { status: 'NOT_APPLICABLE', driverId: null, rejectionReason: null },
    requirements: {
      phone: true,
      profile: false,
      photo: false,
      liveness: false,
      accountType: false,
      vehicleDetails: true,
      adminApproval: true,
    },
  },
};

/** Password sign-in, which only staff accounts can satisfy. */
export const ADMIN_SESSION_EXAMPLE = {
  accessToken: ACCESS_TOKEN,
  user: {
    id: '0b6c3e18-7a45-49d2-83f1-6e2a9c0b5d37',
    email: 'admin@aiko.ng',
    name: 'Platform Admin',
    phone: '+2348000000000',
    roles: ['ADMIN', 'USER'],
    authProvider: 'PASSWORD',
    accountType: null,
    onboardingStep: 'DONE',
    createdAt: '2026-07-01T08:00:00.000Z',
    updatedAt: '2026-08-01T07:40:19.226Z',
  },
  onboarding: { ...ONBOARDING_STATE_DONE_EXAMPLE, accountType: null },
};

/** `GET /api/auth/profile` — public user columns, driver profile, onboarding. */
export const PROFILE_EXAMPLE = {
  ...USER_EXAMPLE,
  driver: null,
  onboarding: ONBOARDING_STATE_DONE_EXAMPLE,
};

// -------------------------------------------------------- vehicle photos

export const VEHICLE_PHOTO_EXAMPLE = {
  id: '7b3d1f95-0c48-4e2a-a761-5d9b8c3e0a27',
  driverId: DRIVER_ID,
  type: 'FRONT',
  url: 'http://localhost:3000/uploads/drivers/d41c8b02/front-1785315953.jpg',
  key: 'drivers/d41c8b02/front-1785315953.jpg',
  provider: 'LOCAL',
  mimeType: 'image/jpeg',
  sizeBytes: 284913,
  createdAt: '2026-07-20T11:41:07.903Z',
};

export const VEHICLE_PHOTOS_EXAMPLE = [
  VEHICLE_PHOTO_EXAMPLE,
  {
    ...VEHICLE_PHOTO_EXAMPLE,
    id: 'c19a4e60-8d2b-4715-93af-0e6d5b1c8f42',
    type: 'PLATE_NUMBER',
    url: 'http://localhost:3000/uploads/drivers/d41c8b02/plate-1785315960.jpg',
    key: 'drivers/d41c8b02/plate-1785315960.jpg',
    sizeBytes: 198340,
  },
];

// ---------------------------------------------------------------- wallet

export const WALLET_EXAMPLE = {
  id: WALLET_ID,
  driverId: DRIVER_ID,
  totalEarnings: 184500,
  totalWithdrawals: 120000,
  totalDebt: 0,
  availableBalance: 64500,
  pendingBalance: 0,
  createdAt: '2026-07-14T09:20:11.004Z',
  updatedAt: '2026-07-31T18:55:41.762Z',
};

export const LEDGER_TRANSACTION_EXAMPLE = {
  id: 'a0f31d78-6b95-4c02-8e14-7d2a9c5b3f60',
  driverId: DRIVER_ID,
  type: 'RIDE_EARNINGS',
  amount: 2160,
  balanceAfter: 64500,
  reference: 'ORDER-9c7e2a41-3b08-4f6d-95a2-7e1c4d8b0f33',
  description: 'Earnings for trip 9c7e2a41',
  createdAt: '2026-07-31T18:55:41.762Z',
};

// --------------------------------------------------------------- drivers

export const DRIVER_EXAMPLE = {
  id: DRIVER_ID,
  userId: USER_ID,
  vehicleType: 'TRICYCLE',
  vehiclePlate: 'LAG-482-KJA',
  vehicleModel: 'Bajaj RE',
  vehicleColor: 'Yellow',
  vehicleYear: 2022,
  kycStatus: 'APPROVED',
  kycRejectionReason: null,
  isAvailable: true,
  isBlocked: false,
  debtLimit: 10000,
  currentDebt: 0,
  rating: 4.8,
  ratingCount: 63,
  totalTrips: 214,
  acceptedTrips: 231,
  cancelledTrips: 17,
  createdAt: '2026-07-14T09:20:10.221Z',
  updatedAt: '2026-07-31T18:55:41.762Z',
};

/** `GET /api/drivers/:id` and `/me` — the profile with every relation loaded. */
export const DRIVER_DETAIL_EXAMPLE = {
  ...DRIVER_EXAMPLE,
  user: USER_EXAMPLE,
  wallet: WALLET_EXAMPLE,
  vehiclePhotos: VEHICLE_PHOTOS_EXAMPLE,
  location: {
    driverId: DRIVER_ID,
    latitude: 6.5244,
    longitude: 3.3792,
    heading: 118.4,
    speedKph: 24.6,
    accuracyMeters: 8,
    recordedAt: '2026-08-01T07:59:12.310Z',
    updatedAt: '2026-08-01T07:59:12.512Z',
  },
};

export const DRIVER_LIST_EXAMPLE = [
  { ...DRIVER_EXAMPLE, user: USER_EXAMPLE, vehiclePhotos: [VEHICLE_PHOTO_EXAMPLE] },
];

/** Live presence from Redis GEOSEARCH — not a database read. */
export const NEARBY_DRIVERS_EXAMPLE = [
  {
    driverId: DRIVER_ID,
    lat: 6.5244,
    lng: 3.3792,
    distanceKm: 0.82,
    heading: 118.4,
    speedKph: 24.6,
    accuracyMeters: 8,
    recordedAt: '2026-08-01T07:59:12.310Z',
  },
  {
    driverId: '61b0e7d4-9a35-42c8-b71e-5f8c0a2d6934',
    lat: 6.5301,
    lng: 3.3715,
    distanceKm: 1.47,
    heading: 42.1,
    speedKph: 0,
    accuracyMeters: 12,
    recordedAt: '2026-08-01T07:58:47.882Z',
  },
];

export const DRIVER_ANALYTICS_EXAMPLE = {
  totalEarnings: 184500,
  todayEarnings: 6480,
  weekEarnings: 41320,
  tripsCompleted: 214,
  activeTrips: 1,
  rating: 4.8,
  acceptanceRate: 93.1,
  cancellationRate: 6.9,
  currentDebt: 0,
  debtLimit: 10000,
};

// --------------------------------------------------------------- pricing

export const PRICING_RULE_EXAMPLE = {
  id: '2d6f8a10-4c93-4b7e-85a1-0f3e7c9d2b46',
  vehicleType: 'TRICYCLE',
  baseFare: 300,
  perKm: 120,
  perMinute: 15,
  minimumFare: 600,
  bookingFee: 50,
  surgeMultiplier: 1,
  avgSpeedKph: 25,
  platformFeePercent: 10,
  currency: 'NGN',
  isActive: true,
  createdAt: '2026-07-01T08:00:00.000Z',
  updatedAt: '2026-07-26T13:22:45.918Z',
};

export const PRICING_RULES_EXAMPLE = [
  PRICING_RULE_EXAMPLE,
  {
    ...PRICING_RULE_EXAMPLE,
    id: '8e1b3c47-25da-4f90-9367-b0d4a8e5c213',
    vehicleType: 'BICYCLE',
    baseFare: 150,
    perKm: 70,
    perMinute: 8,
    minimumFare: 300,
    avgSpeedKph: 15,
  },
];

/** The quote object — also what gets frozen into `Order.pricingSnapshot`. */
export const FARE_QUOTE_EXAMPLE = {
  vehicleType: 'TRICYCLE',
  currency: 'NGN',
  distanceKm: 5.72,
  durationMins: 13.73,
  fare: 1250,
  platformFee: 125,
  driverEarnings: 1125,
  breakdown: {
    baseFare: 300,
    distanceCharge: 686.4,
    timeCharge: 205.95,
    bookingFee: 50,
    surgeMultiplier: 1,
    minimumFareApplied: false,
  },
};

export const FARE_QUOTE_ALL_EXAMPLE = [
  FARE_QUOTE_EXAMPLE,
  {
    ...FARE_QUOTE_EXAMPLE,
    vehicleType: 'BICYCLE',
    durationMins: 22.88,
    fare: 780,
    platformFee: 78,
    driverEarnings: 702,
    breakdown: {
      baseFare: 150,
      distanceCharge: 400.4,
      timeCharge: 183.04,
      bookingFee: 50,
      surgeMultiplier: 1,
      minimumFareApplied: false,
    },
  },
];

// ---------------------------------------------------------------- orders

/** Only the columns a counterparty may see — see CONTACT_USER_SELECT. */
const CONTACT_USER_EXAMPLE = {
  id: USER_ID,
  name: 'Ada Obi',
  phone: '+2348012345678',
};

export const ORDER_EXAMPLE = {
  id: ORDER_ID,
  userId: USER_ID,
  driverId: DRIVER_ID,
  vehicleType: 'TRICYCLE',
  pickupLocation: 'Ikeja City Mall, Alausa, Lagos',
  dropoffLocation: 'Computer Village, Ikeja, Lagos',
  pickupLat: 6.6018,
  pickupLng: 3.3515,
  dropoffLat: 6.5952,
  dropoffLng: 3.3372,
  distanceKm: 5.72,
  durationMins: 13.73,
  fare: 1250,
  currency: 'NGN',
  pricingSnapshot: FARE_QUOTE_EXAMPLE.breakdown,
  status: 'ACCEPTED',
  paymentMethod: 'CASH',
  paymentStatus: 'PENDING',
  platformFee: 125,
  driverEarnings: 1125,
  cancellationReason: null,
  acceptedAt: '2026-08-01T07:58:02.441Z',
  arrivedAt: null,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  createdAt: '2026-08-01T07:57:31.209Z',
  updatedAt: '2026-08-01T07:58:02.441Z',
  user: CONTACT_USER_EXAMPLE,
  driver: {
    ...DRIVER_EXAMPLE,
    user: { id: 'a7c04e91-2f68-4b35-8d10-9e5a3c7b0f28', name: 'Emeka Nwosu', phone: '+2348023456789' },
  },
};

export const ORDER_PAGE_EXAMPLE = {
  totalItems: 47,
  totalPages: 3,
  currentPage: 1,
  result: [ORDER_EXAMPLE],
};

export const RIDE_MESSAGE_EXAMPLE = {
  id: 'f4a8b217-6d05-4c93-8e71-3b2f9a0c5d68',
  orderId: ORDER_ID,
  senderId: USER_ID,
  content: 'I am waiting by the main entrance.',
  readAt: null,
  createdAt: '2026-08-01T07:58:44.117Z',
};

export const RIDE_MESSAGES_EXAMPLE = [
  RIDE_MESSAGE_EXAMPLE,
  {
    ...RIDE_MESSAGE_EXAMPLE,
    id: '05c7e3a9-1b48-4d26-9f03-8a6c2e4b7d51',
    senderId: 'a7c04e91-2f68-4b35-8d10-9e5a3c7b0f28',
    content: 'On my way, 3 minutes out.',
    readAt: '2026-08-01T07:59:01.550Z',
    createdAt: '2026-08-01T07:58:58.902Z',
  },
];

export const RIDE_RATING_EXAMPLE = {
  id: '3e9c1a48-7f26-4b50-8d93-1c0e5a7b2f64',
  orderId: ORDER_ID,
  raterId: USER_ID,
  rateeId: 'a7c04e91-2f68-4b35-8d10-9e5a3c7b0f28',
  score: 5,
  comment: 'Smooth ride, very polite driver.',
  createdAt: '2026-08-01T08:14:22.706Z',
};

// --------------------------------------------------------- ride requests

export const RIDE_REQUEST_EXAMPLE = {
  id: REQUEST_ID,
  userId: USER_ID,
  vehicleType: 'TRICYCLE',
  pickupLocation: 'Ikeja City Mall, Alausa, Lagos',
  dropoffLocation: 'Computer Village, Ikeja, Lagos',
  pickupLat: 6.6018,
  pickupLng: 3.3515,
  dropoffLat: 6.5952,
  dropoffLng: 3.3372,
  distanceKm: 5.72,
  durationMins: 13.73,
  estimatedFare: 1250,
  paymentMethod: 'CASH',
  status: 'MATCHED',
  expiresAt: '2026-08-01T07:59:31.209Z',
  matchedDriverIds: [DRIVER_ID, '61b0e7d4-9a35-42c8-b71e-5f8c0a2d6934'],
  orderId: null,
  createdAt: '2026-08-01T07:57:31.209Z',
  updatedAt: '2026-08-01T07:57:31.780Z',
};

/** `POST /api/ride-requests` returns the request, its quote and who was pinged. */
export const RIDE_REQUEST_CREATED_EXAMPLE = {
  request: RIDE_REQUEST_EXAMPLE,
  quote: FARE_QUOTE_EXAMPLE,
  matchedDrivers: NEARBY_DRIVERS_EXAMPLE,
};

export const RIDE_BID_EXAMPLE = {
  id: '6a2d9f31-0c85-47be-9134-8e7b5a0c3d92',
  requestId: REQUEST_ID,
  driverId: DRIVER_ID,
  amount: 1300,
  note: 'I am 2 minutes away.',
  status: 'PENDING',
  createdAt: '2026-08-01T07:57:48.663Z',
  updatedAt: '2026-08-01T07:57:48.663Z',
};

export const RIDE_REQUEST_WITH_BIDS_EXAMPLE = {
  ...RIDE_REQUEST_EXAMPLE,
  bids: [RIDE_BID_EXAMPLE],
};

/**
 * `GET /api/ride-requests/nearby` — open requests around a driver, with how far
 * the pickup is from them and whether they have already bid.
 */
export const NEARBY_RIDE_REQUESTS_EXAMPLE = [
  {
    ...RIDE_REQUEST_EXAMPLE,
    bids: [RIDE_BID_EXAMPLE],
    pickupDistanceKm: 1.24,
    secondsRemaining: 84,
    hasBid: false,
  },
  {
    ...RIDE_REQUEST_EXAMPLE,
    id: '2e91c7a0-4b68-4d13-90f5-7c3a8e0b6d24',
    pickupLocation: 'Bosso Road, Minna',
    dropoffLocation: 'Mobil Roundabout, Minna',
    bids: [],
    pickupDistanceKm: 3.08,
    secondsRemaining: 41,
    hasBid: true,
  },
];

// ---------------------------------------------------------- notifications

export const DEVICE_EXAMPLE = {
  id: '7d3b1a90-6c25-4e08-93f1-2b5a8d0c4f76',
  userId: USER_ID,
  platform: 'ANDROID',
  deviceId: 'a3f1c8e0d94b27e5',
  deviceName: 'Tecno Spark 10',
  appVersion: '1.0.0',
  lastUsedAt: '2026-08-02T09:14:07.114Z',
  createdAt: '2026-07-28T18:41:52.660Z',
  updatedAt: '2026-08-02T09:12:33.905Z',
};

export const DEVICE_LIST_EXAMPLE = [
  DEVICE_EXAMPLE,
  {
    ...DEVICE_EXAMPLE,
    id: 'b0e94c31-5a72-4f89-8d16-3c7e2a9b0d45',
    deviceId: '5c19e7b0a2d84f36',
    deviceName: 'Infinix Hot 40',
    lastUsedAt: null,
  },
];

// ------------------------------------------------------------- addresses

export const ADDRESS_EXAMPLE = {
  id: 'c8f5b230-91ae-4d67-b024-7a3e6c1d9058',
  userId: USER_ID,
  name: 'Home',
  address: '12 Allen Avenue, Ikeja, Lagos',
  latitude: 6.6018,
  longitude: 3.3515,
  placeId: 'ChIJyWEHuEmuEmsRm9hTkapTCrk',
  source: 'SAVED',
  isDefault: true,
  createdAt: '2026-07-16T10:02:19.338Z',
  updatedAt: '2026-07-16T10:02:19.338Z',
};

export const ADDRESS_LIST_EXAMPLE = [
  ADDRESS_EXAMPLE,
  {
    ...ADDRESS_EXAMPLE,
    id: '1a4e7c95-3d02-48bf-96c1-0b8d5f2a7e63',
    name: 'Work',
    address: '1 Adeola Odeku Street, Victoria Island, Lagos',
    latitude: 6.4281,
    longitude: 3.4219,
    isDefault: false,
  },
];

/**
 * Search merges three tiers — the caller's saved addresses, the shared place
 * cache, then the Places API. `source` says which tier a row came from and
 * `id` is only set for rows the caller has saved.
 */
export const ADDRESS_SEARCH_EXAMPLE = {
  results: [
    {
      id: ADDRESS_EXAMPLE.id,
      name: 'Home',
      address: '12 Allen Avenue, Ikeja, Lagos',
      latitude: 6.6018,
      longitude: 3.3515,
      placeId: 'ChIJyWEHuEmuEmsRm9hTkapTCrk',
      source: 'SAVED',
      isDefault: true,
    },
    {
      id: null,
      name: 'Ikeja City Mall',
      address: 'Obafemi Awolowo Way, Alausa, Ikeja, Lagos',
      latitude: 6.6127,
      longitude: 3.3583,
      placeId: 'ChIJ7cv00DwsDogRAMDACa2m4K8',
      source: 'CACHED',
      isDefault: false,
    },
  ],
  source: 'cache',
};

// ------------------------------------------------------------- analytics

export const ANALYTICS_OVERVIEW_EXAMPLE = {
  totalUsers: 1842,
  totalDrivers: 317,
  activeDrivers: 96,
  totalOrders: 12480,
  completedOrders: 11203,
  cancelledOrders: 894,
  completionRate: '89.8',
  cancellationRate: '7.2',
  cashRevenue: 9842500,
  transferRevenue: 3120400,
  totalRevenue: 12962900,
  platformEarnings: 1296290,
  outstandingDebt: 184300,
};

export const ANALYTICS_DRIVERS_EXAMPLE = [
  {
    id: DRIVER_ID,
    name: 'Emeka Nwosu',
    email: 'emeka@example.com',
    phone: '+2348023456789',
    vehicleType: 'TRICYCLE',
    vehicle: 'Bajaj RE (LAG-482-KJA)',
    status: 'APPROVED',
    isAvailable: true,
    isBlocked: false,
    totalTrips: 214,
    completedTrips: 214,
    cancelledTrips: 17,
    earnings: 184500,
    platformFeePaid: 20500,
    currentDebt: 0,
    debtLimit: 10000,
    rating: 4.8,
    acceptanceRate: '93.1',
    cancellationRate: '6.9',
  },
];

export const ANALYTICS_ORDERS_EXAMPLE = {
  today: { total: 84, completed: 71, cancelled: 6, pending: 7, revenue: 96400 },
  thisWeek: { total: 612, completed: 548, cancelled: 41, pending: 23, revenue: 703200 },
  thisMonth: { total: 2478, completed: 2231, cancelled: 176, pending: 71, revenue: 2864300 },
  allTime: { total: 12480, revenue: 12962900 },
};

export const ANALYTICS_REVENUE_EXAMPLE = {
  chartData: [
    { date: '2026-07-30', cash: 71200, transfer: 22400, total: 93600 },
    { date: '2026-07-31', cash: 68900, transfer: 25100, total: 94000 },
    { date: '2026-08-01', cash: 74300, transfer: 22100, total: 96400 },
  ],
  summary: {
    totalRevenue: 2864300,
    cashRevenue: 2168400,
    transferRevenue: 695900,
    averageOrderValue: 1284,
  },
};

export const ANALYTICS_VEHICLE_TYPES_EXAMPLE = [
  {
    vehicleType: 'TRICYCLE',
    isActive: true,
    baseFare: 300,
    perKm: 120,
    drivers: 214,
    totalOrders: 8940,
    completedOrders: 8104,
    cancelledOrders: 602,
    revenue: 9420600,
    platformEarnings: 942060,
  },
  {
    vehicleType: 'BICYCLE',
    isActive: true,
    baseFare: 150,
    perKm: 70,
    drivers: 103,
    totalOrders: 3540,
    completedOrders: 3099,
    cancelledOrders: 292,
    revenue: 3542300,
    platformEarnings: 354230,
  },
];

export const ANALYTICS_TOP_DRIVERS_EXAMPLE = [
  {
    id: DRIVER_ID,
    name: 'Emeka Nwosu',
    vehicleType: 'TRICYCLE',
    totalTrips: 214,
    totalEarnings: 184500,
    rating: 4.8,
  },
];

export const ANALYTICS_LOW_PERFORMERS_EXAMPLE = [
  {
    id: '61b0e7d4-9a35-42c8-b71e-5f8c0a2d6934',
    name: 'Musa Bello',
    vehicleType: 'BICYCLE',
    totalTrips: 12,
    rating: 3.1,
    currentDebt: 4200,
  },
];

// --------------------------------------------------------------- storage

export const STORAGE_PROVIDER_EXAMPLE = {
  active: 'LOCAL',
  available: ['LOCAL', 'CLOUDINARY', 'S3', 'CLOUDFLARE_R2'],
};

// --------------------------------------------------------------- paging

export const TRANSACTION_PAGE_EXAMPLE = {
  totalItems: 128,
  totalPages: 3,
  currentPage: 1,
  result: [
    LEDGER_TRANSACTION_EXAMPLE,
    {
      ...LEDGER_TRANSACTION_EXAMPLE,
      id: '5c8b0e24-9a71-4f36-b8d2-0e4a7c3f9b15',
      type: 'WITHDRAWAL',
      amount: -20000,
      balanceAfter: 44500,
      reference: 'WDR-d41c8b02-1785315953000',
      description: 'Withdrawal request',
      createdAt: '2026-07-31T19:02:10.338Z',
    },
  ],
};

export const WALLET_LIST_EXAMPLE = [
  {
    ...WALLET_EXAMPLE,
    driver: { ...DRIVER_EXAMPLE, user: CONTACT_USER_EXAMPLE },
  },
];

// ---------------------------------------------------------- marketplace

/**
 * One card in the driver's available-orders grid.
 *
 * Note what is absent: no `userId`, no customer name, no phone numbers. §9 —
 * none of that is needed to decide whether to take the job, and it arrives with
 * the reservation.
 */
export const MARKETPLACE_CARD_EXAMPLE = {
  id: ORDER_ID,
  vehicleType: 'TRICYCLE',
  pickupLocation: 'Minna Central Market, Minna',
  pickupLat: 9.6139,
  pickupLng: 6.5569,
  dropoffLocation: 'Bosso Estate, Minna',
  dropoffLat: 9.6485,
  dropoffLng: 6.5311,
  distanceKm: 8.4,
  durationMins: 20.16,
  earnings: 3150,
  fare: 3500,
  currency: 'NGN',
  paymentMethod: 'CASH',
  createdAt: '2026-08-08T09:12:03.118Z',
  ageSeconds: 42,
  compatibility: {
    compatible: true,
    additionalDistanceKm: 1.2,
    additionalTimeMinutes: 3,
    routeScore: 88,
    match: 'GREAT',
    pickupDistanceKm: 0.8,
    existingDelayMinutes: 2,
    reason: '+1.2 km on your current route',
  },
};

export const MARKETPLACE_GRID_EXAMPLE = {
  orders: [
    MARKETPLACE_CARD_EXAMPLE,
    {
      ...MARKETPLACE_CARD_EXAMPLE,
      id: '4b8e1d70-2c94-4a63-8f15-6d0a7b3c9e28',
      pickupLocation: 'Tunga Low-Cost, Minna',
      dropoffLocation: 'Airport Road, Minna',
      fare: 2800,
      earnings: 2520,
      compatibility: {
        compatible: false,
        additionalDistanceKm: 6.8,
        additionalTimeMinutes: 16,
        routeScore: 21,
        match: 'POOR',
        pickupDistanceKm: 2.4,
        existingDelayMinutes: 11,
        reason: 'Would delay a customer you already accepted by 11 min',
      },
    },
  ],
  held: 1,
  capacity: 3,
  atCapacity: false,
};

export const MARKETPLACE_RESERVED_EXAMPLE = {
  order: { ...ORDER_EXAMPLE, status: 'RESERVED', reservedAt: '2026-08-08T09:12:45.902Z' },
  compatibility: MARKETPLACE_CARD_EXAMPLE.compatibility,
  held: 2,
  capacity: 3,
};

/**
 * The driver's route across everything they hold.
 *
 * Note the interleaving — pickup, pickup, drop-off, pickup — and that each order
 * keeps its own status. §19 and §45: the route groups them operationally, the
 * orders stay separate.
 */
export const MARKETPLACE_ACTIVE_EXAMPLE = {
  orders: [
    {
      ...ORDER_EXAMPLE,
      status: 'PICKED_UP',
      pickedUpAt: '2026-08-08T09:20:11.004Z',
      deliveryEtaMinutes: 18,
      pickupEtaMinutes: null,
    },
    {
      ...ORDER_EXAMPLE,
      id: '4b8e1d70-2c94-4a63-8f15-6d0a7b3c9e28',
      status: 'RESERVED',
      deliveryEtaMinutes: 26,
      pickupEtaMinutes: 7,
    },
  ],
  route: {
    stops: [
      {
        orderId: '4b8e1d70-2c94-4a63-8f15-6d0a7b3c9e28',
        kind: 'PICKUP',
        lat: 9.6139,
        lng: 6.5569,
        address: 'Tunga Low-Cost, Minna',
        phone: '08031234567',
        status: 'RESERVED',
        sequence: 1,
        legKm: 2.1,
        cumulativeKm: 2.1,
        etaMinutes: 7,
      },
      {
        orderId: ORDER_ID,
        kind: 'DROPOFF',
        lat: 9.6485,
        lng: 6.5311,
        address: 'Bosso Estate, Minna',
        phone: '08037654321',
        status: 'PICKED_UP',
        sequence: 2,
        legKm: 3.4,
        cumulativeKm: 5.5,
        etaMinutes: 18,
      },
    ],
    totalKm: 8.2,
    totalMinutes: 26,
    deliveryEtaByOrder: { [ORDER_ID]: 18 },
    pickupEtaByOrder: { '4b8e1d70-2c94-4a63-8f15-6d0a7b3c9e28': 7 },
  },
  held: 2,
  capacity: 3,
  status: 'AVAILABLE',
};

export const ORDER_ETA_EXAMPLE = {
  pickupMinutes: 8,
  deliveryMinutes: 24,
  driverHandlingOtherOrders: true,
};
