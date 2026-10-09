import { processHealthFile } from '../health/processing';
import { summaryRowToCsv } from '../health/csv';
import type { ProcessingOptions } from '../health/models';

type WorkerMessage = { kind: 'start'; file: File; options: ProcessingOptions } | { kind: 'cancel' };
let cancelled = false;
self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  if (event.data.kind === 'cancel') { cancelled = true; return; }
  cancelled = false;
  void processHealthFile(event.data.file, event.data.options,
    (progress) => postMessage({ kind: 'progress', progress }), () => cancelled
  ).then((result) => {
    if (cancelled) return;
    postMessage({ kind: 'csv-chunk', text: result.rows.map(summaryRowToCsv).join('\r\n') + '\r\n' });
    postMessage({ kind: 'complete', warnings: result.warnings, platform: result.platform,
      coverage: [...new Set(result.rows.map((r) => r.category))].map((category) => ({ category, count: result.rows.filter((r) => r.category === category && r.value !== '').length })) });
  }).catch((error: unknown) => {
    if (!cancelled) postMessage({ kind: 'error', message: error instanceof Error ? error.message : 'Unknown processing error.' });
  });
};
