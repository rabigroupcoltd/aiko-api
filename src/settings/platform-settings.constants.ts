export const PLATFORM_SETTINGS = {
  FARE_ROUNDING_STEP: {
    label: 'Fare rounding step',
    description:
      'Every fare is rounded up to the nearest multiple of this many currency units (e.g. 10 rounds ₦1,234 up to ₦1,240).',
    default: Number(process.env.FARE_ROUNDING_STEP || 10),
    min: 1,
    max: null,
    format: 'number',
  },
  ROAD_DISTANCE_FACTOR: {
    label: 'Road distance factor',
    description:
      "Multiplier applied to straight-line distance for a fare quote when Google's Distance Matrix is unreachable or unconfigured — real roads are never straight, so this pads the estimate. Does not affect driver route planning, which keeps its own copy of this factor (see route.util.ts).",
    default: Number(process.env.ROAD_DISTANCE_FACTOR || 1.3),
    min: 1,
    max: null,
    format: 'number',
  },
  DRIVER_DEBT_LIMIT: {
    label: 'Driver debt limit',
    description:
      'The most platform commission a driver may owe from cash trips. At or above this, they cannot go online or take new orders until an admin records their payment. Individual drivers can be given their own limit from their profile. 0 turns the limit off.',
    default: Number(process.env.DRIVER_DEBT_LIMIT || 5000),
    min: 0,
    max: null,
    format: 'number',
  },
  DRIVER_SHIFT_START_MINUTE: {
    label: 'Work hours start',
    description:
      'Earliest time (Lagos time, GMT+1) drivers can go online, stored as minutes past midnight (420 = 7:00 AM). Set start and end to the same time to allow drivers online at any hour.',
    default: Number(process.env.DRIVER_SHIFT_START_MINUTE || 7 * 60),
    min: 0,
    max: 24 * 60 - 1,
    format: 'time',
  },
  DRIVER_SHIFT_END_MINUTE: {
    label: 'Work hours end',
    description:
      'Time (Lagos time, GMT+1) after which drivers can no longer go online or take new work, stored as minutes past midnight (1080 = 6:00 PM). Drivers can still finish orders they already hold. An end earlier than the start means an overnight shift.',
    default: Number(process.env.DRIVER_SHIFT_END_MINUTE || 18 * 60),
    min: 0,
    max: 24 * 60 - 1,
    format: 'time',
  },
  DISPATCH_SEARCH_MINUTES: {
    label: 'Rider search time',
    description:
      'How long an order keeps looking for a rider before it closes as "No driver found". While it searches, the radius widens to its limit and riders who come online are offered it, and admins can assign a rider by hand. Restarts when an admin revives an order or a rider hands an assigned order back.',
    default: Number(process.env.DISPATCH_SEARCH_MINUTES || 10),
    min: 1,
    max: 120,
    format: 'number',
  },
} as const;

export type PlatformSettingKey = keyof typeof PLATFORM_SETTINGS;

export const PLATFORM_SETTING_KEYS = Object.keys(PLATFORM_SETTINGS) as PlatformSettingKey[];

export function isPlatformSettingKey(key: string): key is PlatformSettingKey {
  return PLATFORM_SETTING_KEYS.includes(key as PlatformSettingKey);
}
