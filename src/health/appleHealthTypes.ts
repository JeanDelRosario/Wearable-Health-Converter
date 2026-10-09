export type { SupportedTypeKey } from './measurementTypes';

export const APPLE_HEALTH_TYPES = {
  heartRateVariability: {
    id: 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
    label: 'HRV',
    outputType: 'heart_rate_variability_sdnn'
  },
  restingHeartRate: {
    id: 'HKQuantityTypeIdentifierRestingHeartRate',
    label: 'Rusthartslag',
    outputType: 'resting_heart_rate'
  },
  stepCount: {
    id: 'HKQuantityTypeIdentifierStepCount',
    label: 'Stappen',
    outputType: 'step_count'
  },
  sleepAnalysis: {
    id: 'HKCategoryTypeIdentifierSleepAnalysis',
    label: 'Slaap',
    outputType: 'sleep_analysis'
  },
  wristTemperature: {
    id: 'HKQuantityTypeIdentifierAppleSleepingWristTemperature',
    label: 'Nachttemperatuur',
    outputType: 'sleeping_wrist_temperature'
  }
} as const;

export type AppleHealthIdentifier = (typeof APPLE_HEALTH_TYPES)[keyof typeof APPLE_HEALTH_TYPES]['id'];

const typeById = new Map<string, { key: keyof typeof APPLE_HEALTH_TYPES; id: AppleHealthIdentifier; label: string; outputType: string }>(
  Object.entries(APPLE_HEALTH_TYPES).map(([key, value]) => [value.id, { key: key as keyof typeof APPLE_HEALTH_TYPES, ...value }])
);

export function getSupportedType(identifier: string | undefined) {
  return identifier ? typeById.get(identifier) : undefined;
}

export const supportedTypeIds = () => new Set(Object.values(APPLE_HEALTH_TYPES).map((item) => item.id));
