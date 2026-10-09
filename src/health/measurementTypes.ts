export const MEASUREMENT_TYPES = {
  heartRateVariability: { label: 'HRV', en: 'HRV' },
  restingHeartRate: { label: 'Rusthartslag', en: 'Resting heart rate' },
  stepCount: { label: 'Stappen', en: 'Steps' },
  sleepAnalysis: { label: 'Slaap', en: 'Sleep' },
  wristTemperature: { label: 'Nachttemperatuur', en: 'Nightly temperature' },
  temperatureDeviation: { label: 'Temperatuurverschil', en: 'Temperature deviation' }
} as const;

export type SupportedTypeKey = keyof typeof MEASUREMENT_TYPES;

export const SUMMARY_TYPE_ORDER: SupportedTypeKey[] = [
  'sleepAnalysis', 'stepCount', 'heartRateVariability', 'restingHeartRate',
  'wristTemperature', 'temperatureDeviation'
];
