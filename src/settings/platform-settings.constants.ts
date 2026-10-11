export const PLATFORM_SETTINGS = {
  FARE_ROUNDING_STEP: {
    label: 'Fare rounding step',
    description:
      'Every fare is rounded up to the nearest multiple of this many currency units (e.g. 10 rounds ₦1,234 up to ₦1,240).',
    default: Number(process.env.FARE_ROUNDING_STEP || 10),
    min: 1,
  },
  ROAD_DISTANCE_FACTOR: {
    label: 'Road distance factor',
    description:
      "Multiplier applied to straight-line distance for a fare quote when Google's Distance Matrix is unreachable or unconfigured — real roads are never straight, so this pads the estimate. Does not affect driver route planning, which keeps its own copy of this factor (see route.util.ts).",
    default: Number(process.env.ROAD_DISTANCE_FACTOR || 1.3),
    min: 1,
  },
  DRIVER_DEBT_LIMIT: {
    label: 'Driver debt limit',
    description:
      'The most platform commission a driver may owe from cash trips. At or above this, they cannot go online or take new orders until an admin records their payment. Individual drivers can be given their own limit from their profile. 0 turns the limit off.',
    default: Number(process.env.DRIVER_DEBT_LIMIT || 5000),
    min: 0,
  },
} as const;

export type PlatformSettingKey = keyof typeof PLATFORM_SETTINGS;

export const PLATFORM_SETTING_KEYS = Object.keys(PLATFORM_SETTINGS) as PlatformSettingKey[];

export function isPlatformSettingKey(key: string): key is PlatformSettingKey {
  return PLATFORM_SETTING_KEYS.includes(key as PlatformSettingKey);
}
