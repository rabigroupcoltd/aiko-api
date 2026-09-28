/**
 * Global numeric knobs that used to be env-only constants.
 *
 * Each one is seeded into `PlatformSetting` from its env var (or the literal
 * default below) the first time the app boots, so nothing changes for an
 * existing deployment until an admin actually edits one — see
 * PlatformSettingsService.ensureDefaults.
 */
export const PLATFORM_SETTINGS = {
  FARE_ROUNDING_STEP: {
    description:
      'Every fare is rounded up to the nearest multiple of this many currency units (e.g. 10 rounds ₦1,234 up to ₦1,240).',
    default: Number(process.env.FARE_ROUNDING_STEP || 10),
  },
  ROAD_DISTANCE_FACTOR: {
    description:
      "Multiplier applied to straight-line distance for a fare quote when Google's Distance Matrix is unreachable or unconfigured — real roads are never straight, so this pads the estimate. Does not affect driver route planning, which keeps its own copy of this factor (see route.util.ts).",
    default: Number(process.env.ROAD_DISTANCE_FACTOR || 1.3),
  },
} as const;

export type PlatformSettingKey = keyof typeof PLATFORM_SETTINGS;

export const PLATFORM_SETTING_KEYS = Object.keys(PLATFORM_SETTINGS) as PlatformSettingKey[];

export function isPlatformSettingKey(key: string): key is PlatformSettingKey {
  return PLATFORM_SETTING_KEYS.includes(key as PlatformSettingKey);
}
