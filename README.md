# Wearable Health Converter

Convert Apple Health XML/ZIP, Google/Fitbit Takeout ZIP, Garmin account-export ZIP, Samsung Health CSV-export ZIP and WHOOP CSV-export ZIP files into a daily CSV covering 28 days. Formats are detected automatically. Supports sleep duration, steps, HRV, resting heart rate, nightly skin/wrist temperature and temperature deviation where supplied or calculable from an exported baseline. Availability depends on the platform and included datasets. Oura is planned, not implemented.

Based on [Damianmts/AppleHealthConverter](https://github.com/Damianmts/AppleHealthConverter).

## Use

Open the built `dist/index.html` in a desktop browser, or serve it on a static HTTPS host. Select your export, an end date covered by its data and the wearer's timezone. Click Process, check coverage and warnings, then save the CSV. Large Apple ZIPs report progress while their XML is processed. Hold the Measurements box for five seconds to change the selection.

CSV headers and labels are always English:

```text
category,date,value,unit,source,measurement_type
```

Each selected metric has one row per day: all six metrics produce 168 rows. Missing values stay blank; measured zeroes remain zero. Source datasets and metric definitions are preserved for traceability. Garmin, Samsung and WHOOP source labels omit account identifiers. Apple HRV is SDNN; Fitbit and WHOOP HRV are RMSSD; Garmin's health-status JSON and Samsung's Energy Score CSV do not specify their HRV calculation method. Do not assume these summaries are interchangeable.

Downloads are named `wearable-health-<random-id>.csv`. The cryptographically random 128-bit ID identifies one export, not a participant. Saving the same result again keeps its ID; processing again generates a new one. IDs are not derived from health data or stored between sessions. A random filename does not make the health measurements anonymous.

## Privacy

Files are processed locally in a browser worker. The app has no upload endpoint, analytics, database or persistent browser storage. Only selected ZIP entries are read and decompressed. Downloaded CSVs remain on the user's device. If hosted, the provider may retain ordinary website access logs; wearable data is not sent to it by the app. Keep real health exports and participant CSVs out of this public repository.

## Build

Use Node 20.19+ on the 20.x line, or Node 22.12+.

```bash
npm ci
npm run dev       # local development
npm test          # automated checks
npm run build    # standalone dist/index.html
```

Deploy the `dist` folder to a static host such as Netlify. Edit the source and rebuild; do not edit the generated HTML.

## Code layout

| Path | Purpose |
| --- | --- |
| `index.html`, `src/app/` | Interface, language selection and CSV download |
| `src/workers/healthProcessor.worker.ts` | Background processing and progress messages |
| `src/health/processing.ts` | Detect format and coordinate imports |
| `src/health/googleHealthImporter.ts` | Google/Fitbit CSV and JSON mappings |
| `src/health/garminHealthImporter.ts` | Garmin daily-summary JSON mappings |
| `src/health/samsungHealthImporter.ts` | Samsung CSV datasets, sleep-stage joins and export notes |
| `src/health/whoopHealthImporter.ts` | WHOOP recovery summaries and sleep sessions |
| `src/health/xmlRecordParser.ts`, `dailySummary.ts` | Apple records and daily aggregation |
| `src/health/zipReader.ts`, `streamingParsers.ts` | Selective ZIP reading and incremental parsing |
| `src/health/csv.ts`, `measurementTypes.ts`, `timeZone.ts` | Output schema, metrics and date grouping |
| `src/health/*.test.ts` | Parser, aggregation and export checks |

To add a platform, map its exports to the shared daily row schema, retain provenance, define overlap/source rules and add representative synthetic tests.

## Processing notes and validation

Google daily tables take precedence over legacy Fitbit summaries for the whole metric. Disagreements generate warnings; older values are not added or used to fill gaps. Conflicting records can leave affected daily totals blank. Legacy Fitbit step timestamps are interpreted as UTC with a warning. Daily summaries retain their exported date labels; timestamped steps use the selected timezone.

Garmin imports `UDSFile`, `sleepData` and `healthStatusData` JSON arrays from the `DI_CONNECT` folders. Steps use `totalSteps`; daily resting heart rate uses `currentDayRestingHeartRate`, without substituting `restingHeartRate` or overnight `HR`. Sleep sums deep, light and REM seconds plus distinct, nonoverlapping naps, excluding awake and unmeasurable time. Missing REM is treated as zero for older exports with deep/light totals. Unconfirmed sleep is skipped; edited durations that exceed timestamp windows are retained with a warning. HRV uses the provided overnight `HRV` summary. `SKIN_TEMP_C` is an exported temperature deviation, not an absolute temperature; Nightly temperature stays blank. Baseline limits are not used to reconstruct absolute temperature. Duplicate values are counted once; conflicts leave affected values blank. Daily calendar labels are preserved. Profile files, workout/activity data and nested raw FIT archives are skipped; standalone FIT files are not supported.

Samsung handles the CSV metadata line, prefixed column names, trailing commas and macOS resource forks. Steps use `step_daily_trend` records with `source_type=-2` (Samsung's combined total); individual phone/watch totals and pedometer files are not added. Conflicting revisions use the latest `update_time`; unresolved ties stay blank. Sleep joins `sleep_stage` to its parent `sleep` record, unions light/deep/REM intervals and excludes awake time. Unstaged sessions are excluded with a note; awake/asleep conflicts stay blank. Nightly temperature is the mean of distinct `skin_temperature.temperature` session means, grouped by local session end date. Deviation is the mean of each session's temperature minus its explicit baseline; it stays blank if any included session lacks a baseline. UTC timestamps use exported `time_offset`, falling back to the selected timezone with a note. Daily `day_time` labels are preserved. HRV uses numeric `vitality_score.shrv_value` sleeping-HRV summaries, not HRV scores. Raw HRV/binning JSON and legacy raw cycle-temperature JSON references are not imported. Ordinary or sleeping heart rate is not substituted for daily resting heart rate, which stays blank for these Samsung datasets. Profile, exercise and unrelated health data are skipped. These datasets may cover different dates, so check the selected period.

WHOOP reads only `physiological_cycles.csv` and `sleeps.csv`, including within wrapper folders. Recovery imports `Resting heart rate (bpm)`, `Heart rate variability (ms)` and absolute `Skin temp (celsius)`. Sleep uses exported `Asleep duration (min)` from `sleeps.csv`, including distinct, nonoverlapping naps; the repeated main-sleep summary in physiological cycles is not added. If `sleeps.csv` is absent, main sleep from physiological cycles is used with a warning that naps are unavailable. Sleep and recovery retain the printed `Wake onset` date, without timezone conversion; the selected timezone does not shift these dates. Duplicate values are counted once; conflicting daily summaries or overlapping sleep sessions leave affected values blank. Steps and temperature deviation stay blank because the supported datasets provide neither step counts nor a temperature baseline. Journal entries, workouts and macOS resource forks are skipped. [WHOOP's API reference](https://developer.whoop.com/api/) identifies its recovery HRV as RMSSD and skin temperature as Celsius.

Apple steps retain the original Watch-priority approximation with a six-minute guard. Apple Watch temperature uses `HKQuantityTypeIdentifierAppleSleepingWristTemperature`, averaged by sample end date and exported in Celsius to two decimal places; Fahrenheit samples are converted first. Body-temperature records are excluded. Temperature is skin/wrist temperature, not core body temperature. No baseline is inferred; Apple deviation stays blank.

All 72 synthetic test cases passed through a direct Node assertion harness, covering mappings, duplicates, overlaps, revisions, missing values, Samsung/WHOOP CSV structure, WHOOP source precedence and mixed-platform rejection. The bundled worker's WHOOP results matched an independent Python CSV calculation across five periods. Samsung results previously matched an independent CSV calculation across five periods; Garmin results matched an independent JSON calculation. Apple temperature results previously matched an independent XML calculation on a private multi-gigabyte export. The standard Vitest runner stalled during teardown in the restricted development environment; run `npm test` locally. Google results previously matched an independent calculation. Compiled-interface checks previously confirmed identical English CSVs in both interface languages. Actual Safari, Chrome, Edge and Firefox testing, and comparisons against wearable apps, remain necessary.
