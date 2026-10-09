import type { AppleHealthIdentifier, SupportedTypeKey, APPLE_HEALTH_TYPES } from './appleHealthTypes';

export interface HealthRecord {
  identifier: AppleHealthIdentifier;
  typeKey: keyof typeof APPLE_HEALTH_TYPES;
  outputType: string;
  startDate: string;
  endDate: string;
  value: string;
  unit: string;
  sourceName: string;
  sourceVersion: string;
  device: string;
}

export interface ProcessingOptions {
  selectedTypes: SupportedTypeKey[];
  startDate?: string;
  endDate?: string;
  /** IANA timezone used for Google/Fitbit timestamped steps. Daily labels are preserved. */
  timeZone?: string;
}

export interface ImportWarning { code: string; detail?: string }

export interface ProgressUpdate {
  phase: 'reading' | 'parsing';
  bytesRead: number;
  totalBytes: number;
  recordsMatched: number;
}
