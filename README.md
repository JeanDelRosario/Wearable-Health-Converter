# Wearable Health Converter

Convert Apple Health XML/ZIP and Google/Fitbit Takeout ZIP exports into a daily CSV covering 28 days. Supports sleep duration, steps, HRV, resting heart rate, nightly skin/wrist temperature and temperature deviation where a baseline is available. Garmin, WHOOP and Oura are planned, not implemented.

Based on [Damianmts/AppleHealthConverter](https://github.com/Damianmts/AppleHealthConverter).

## Use

Open the built `dist/index.html` in a desktop browser, or serve it on a static HTTPS host. Select your export, the period's end date and the wearer's timezone. Click Process, check coverage and warnings, then save the CSV. Hold the Measurements box for five seconds to change the selection.

CSV headers and labels are always English:

```text
category,date,value,unit,source,measurement_type
```

Each selected metric has one row per day: all six metrics produce 168 rows. Missing values stay blank; measured zeroes remain zero. Source filenames and metric definitions are preserved for traceability. Apple HRV is SDNN; Fitbit HRV is RMSSD, so they should not be treated as interchangeable.

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
| `src/health/xmlRecordParser.ts`, `dailySummary.ts` | Apple records and daily aggregation |
| `src/health/zipReader.ts`, `streamingParsers.ts` | Selective ZIP reading and incremental parsing |
| `src/health/csv.ts`, `measurementTypes.ts`, `timeZone.ts` | Output schema, metrics and date grouping |
| `src/health/*.test.ts` | Parser, aggregation and export checks |

To add a platform, map its exports to the shared daily row schema, retain provenance, define overlap/source rules and add representative synthetic tests.

## Processing notes and validation

Google daily tables take precedence over legacy Fitbit summaries for the whole metric. Disagreements generate warnings; older values are not added or used to fill gaps. Conflicting records can leave affected daily totals blank. Legacy Fitbit step timestamps are interpreted as UTC with a warning. Daily summaries retain their exported date labels; timestamped steps use the selected timezone.

Apple steps retain the original Watch-priority approximation with a six-minute guard. Temperature is skin/wrist temperature, not core body temperature. No baseline is inferred; Apple deviation stays blank. Apple temperature has only been validated with synthetic records.

The build and 42 test cases passed through a direct Node assertion harness. The standard Vitest runner stalled in the restricted development environment; run `npm test` locally. Google results matched an independent calculation. Compiled-interface checks confirmed identical English CSVs in both interface languages. Actual Safari, Chrome, Edge and Firefox testing, and comparisons against wearable apps, remain necessary.
