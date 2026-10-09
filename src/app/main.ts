import './styles.css';
import { MEASUREMENT_TYPES, type SupportedTypeKey } from '../health/measurementTypes';
import { csvPreamble } from '../health/csv';
import { getStartDateFor28DayWindow, toDateInputValue } from '../health/dateRange';
import type { ImportWarning, ProcessingOptions, ProgressUpdate } from '../health/models';
import HealthProcessorWorker from '../workers/healthProcessor.worker.ts?worker&inline';

const strings = {
  en: {
    privacy: 'Your file is processed on this computer. Nothing is uploaded; this app works offline.',
    file: 'Apple Health XML / ZIP or Google/Fitbit ZIP', period: 'Period (last 28 days)', start: 'Start date', end: 'End date',
    periodHint: 'Choose an end date. The start date is set automatically, including 28 calendar days.',
    zone: 'Time zone for step totals', zoneHint: 'Choose the time zone where the data was recorded. Existing daily summaries and sleep date labels are kept as exported.',
    data: 'Measurements', locked: '(locked)', unlocked: '(editable)', lockHint: 'Hold this box for five seconds to change the measurements.',
    temperature: 'Temperature means nightly skin/wrist temperature. Deviation is nightly temperature minus the exported baseline. Missing values stay blank.',
    process: 'Process', cancel: 'Cancel', status: 'Status', initial: 'Choose a file to begin.', processing: 'Reading your file locally…',
    ready: 'Ready. Review the coverage and notes, then save the CSV.', cancelled: 'Processing cancelled.', error: 'Error',
    results: 'Export details', platform: 'Detected format', days: 'days with measurements (out of 28)', download: 'Save CSV',
    reading: 'Reading ZIP', parsing: 'Processing XML', records: 'selected records', workerError: 'The local processor could not start. Try opening this file in another browser.'
  },
  nl: {
    privacy: 'Uw bestand wordt op deze computer verwerkt. Er wordt niets geüpload; deze app werkt offline.',
    file: 'Apple Health XML / ZIP of Google/Fitbit ZIP', period: 'Periode (laatste 28 dagen)', start: 'Startdatum', end: 'Einddatum',
    periodHint: 'Kies een einddatum. De startdatum wordt automatisch ingesteld: 28 kalenderdagen inclusief de einddatum.',
    zone: 'Tijdzone voor stappentotalen', zoneHint: 'Kies de tijdzone waarin de gegevens zijn gemeten. Datums van dagsamenvattingen en slaap blijven zoals geëxporteerd.',
    data: 'Gegevens', locked: '(vergrendeld)', unlocked: '(aanpasbaar)', lockHint: 'Houd dit vak vijf seconden ingedrukt om de gegevenskeuze aan te passen.',
    temperature: 'Temperatuur is de nachtelijke huid-/polstemperatuur. Het verschil is de nachttemperatuur min de geëxporteerde baseline. Ontbrekende waarden blijven leeg.',
    process: 'Verwerken', cancel: 'Annuleren', status: 'Status', initial: 'Kies een bestand om te beginnen.', processing: 'Bestand wordt lokaal gelezen…',
    ready: 'Klaar. Controleer de gegevens en opmerkingen en sla daarna de CSV op.', cancelled: 'Verwerking geannuleerd.', error: 'Fout',
    results: 'Exportgegevens', platform: 'Gevonden formaat', days: 'dagen met metingen (van 28)', download: 'CSV opslaan',
    reading: 'ZIP-bestand lezen', parsing: 'XML verwerken', records: 'geselecteerde records', workerError: 'De lokale verwerker kon niet starten. Probeer het bestand in een andere browser te openen.'
  }
};
type Language = keyof typeof strings;
let language: Language = 'en';
const t = () => strings[language];
const form = document.querySelector<HTMLFormElement>('#converter-form')!;
const fileInput = document.querySelector<HTMLInputElement>('#file')!;
const typeOptions = document.querySelector<HTMLDivElement>('#type-options')!;
const dataTypesFieldset = document.querySelector<HTMLFieldSetElement>('#data-types-fieldset')!;
const typeLockLabel = document.querySelector<HTMLSpanElement>('#type-lock-label')!;
const startDateInput = document.querySelector<HTMLInputElement>('#start-date')!;
const endDateInput = document.querySelector<HTMLInputElement>('#end-date')!;
const zoneInput = document.querySelector<HTMLSelectElement>('#time-zone')!;
const processButton = document.querySelector<HTMLButtonElement>('#process')!;
const cancelButton = document.querySelector<HTMLButtonElement>('#cancel')!;
const downloadButton = document.querySelector<HTMLButtonElement>('#download')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const progress = document.querySelector<HTMLProgressElement>('#progress')!;
let csvParts: BlobPart[] = [];
let outputUrl: string | undefined;
let outputFilename: string | undefined;
let currentWorker: Worker | undefined;
const EXCLUSIVE_LONG_PRESS_MS = 600;
const DATA_TYPES_UNLOCK_PRESS_MS = 5_000;

for (const [key, definition] of Object.entries(MEASUREMENT_TYPES)) {
  const label = document.createElement('label'); label.className = 'checkbox';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox'; checkbox.name = 'types'; checkbox.value = key; checkbox.checked = true;
  enableExclusiveLongPress(checkbox);
  label.append(checkbox, document.createTextNode(` ${definition.en}`)); typeOptions.append(label);
}
const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? ['Europe/Amsterdam', 'Europe/Madrid', 'Europe/London', 'America/New_York', 'America/Los_Angeles'];
for (const zone of [...new Set(['UTC', browserZone, ...supported])].sort()) {
  const option = document.createElement('option'); option.value = zone; option.textContent = zone; zoneInput.append(option);
}
zoneInput.value = browserZone;
lockDataTypes(); enableDataTypesUnlock();
endDateInput.value = toDateInputValue(new Date()); syncStartDate();
endDateInput.addEventListener('input', syncStartDate);
function syncStartDate(): void { startDateInput.value = getStartDateFor28DayWindow(endDateInput.value) ?? ''; }

const text = (id: string, value: string) => { document.getElementById(id)!.textContent = value; };
function applyLanguage(): void {
  document.documentElement.lang = language;
  const s = t();
  for (const [id, value] of Object.entries({ 'privacy-note': s.privacy, 'file-label': s.file, 'period-label': s.period, 'start-label': s.start, 'end-label': s.end, 'period-hint': s.periodHint, 'zone-label': s.zone, 'zone-hint': s.zoneHint, 'data-label': s.data, 'lock-hint': s.lockHint, 'temperature-hint': s.temperature, process: s.process, cancel: s.cancel, 'status-heading': s.status, 'results-heading': s.results, download: s.download })) text(id, value);
  typeLockLabel.textContent = dataTypesFieldset.classList.contains('data-types-locked') ? s.locked : s.unlocked;
  for (const label of typeOptions.querySelectorAll('label')) {
    const input = label.querySelector('input')!;
    const definition = MEASUREMENT_TYPES[input.value as SupportedTypeKey];
    label.childNodes[1].nodeValue = ` ${language === 'nl' ? definition.label : definition.en}`;
  }
  setStatus(s.initial);
}
document.querySelector<HTMLSelectElement>('#language-select')!.addEventListener('change', (event) => {
  language = (event.target as HTMLSelectElement).value as Language;
  document.getElementById('language-choice')!.hidden = true;
  document.getElementById('converter-content')!.hidden = false;
  applyLanguage(); fileInput.focus();
});

form.addEventListener('submit', (event) => {
  event.preventDefault(); const file = fileInput.files?.[0]; if (!file) return;
  const options: ProcessingOptions = {
    selectedTypes: Array.from(form.querySelectorAll<HTMLInputElement>('input[name="types"]:checked')).map((item) => item.value as SupportedTypeKey),
    startDate: startDateInput.value, endDate: endDateInput.value, timeZone: zoneInput.value
  };
  if (!options.selectedTypes.length) return setStatus(language === 'nl' ? 'Selecteer minimaal één gegevenstype.' : 'Select at least one measurement.', true);
  currentWorker?.terminate(); clearOutput(); csvParts = [csvPreamble()]; setBusy(true);
  progress.hidden = false; progress.value = 0; setStatus(t().processing);
  try {
    const worker = new HealthProcessorWorker(); currentWorker = worker;
    worker.onmessage = (event: MessageEvent) => handleWorkerMessage(event.data, worker);
    worker.onerror = () => finishWithError(t().workerError);
    worker.postMessage({ kind: 'start', file, options });
  } catch { finishWithError(t().workerError); }
});

cancelButton.addEventListener('click', () => {
  currentWorker?.terminate(); currentWorker = undefined; clearOutput(); setBusy(false);
  progress.hidden = true; setStatus(t().cancelled);
});
downloadButton.addEventListener('click', () => {
  if (!outputUrl || !outputFilename) return;
  const anchor = document.createElement('a'); anchor.href = outputUrl; anchor.download = outputFilename;
  document.body.append(anchor); anchor.click(); anchor.remove();
});
window.addEventListener('pagehide', () => { currentWorker?.terminate(); clearOutput(); });

function setBusy(busy: boolean): void {
  processButton.disabled = busy; fileInput.disabled = busy; endDateInput.disabled = busy; zoneInput.disabled = busy;
  dataTypesFieldset.disabled = busy;
  cancelButton.hidden = !busy;
}
function handleWorkerMessage(message: { kind: string; [key: string]: unknown }, worker: Worker): void {
  if (worker !== currentWorker) return;
  if (message.kind === 'csv-chunk') csvParts.push(message.text as string);
  else if (message.kind === 'progress') renderProgress(message.progress as ProgressUpdate);
  else if (message.kind === 'complete') {
    // Random per-export ID: no personal data, device identifiers or persistent tracking.
    const randomBytes = crypto.getRandomValues(new Uint8Array(16));
    const exportId = Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    outputFilename = `wearable-health-${exportId}.csv`;
    outputUrl = URL.createObjectURL(new Blob(csvParts, { type: 'text/csv;charset=utf-8' }));
    csvParts = []; worker.terminate(); currentWorker = undefined; setBusy(false);
    downloadButton.disabled = false; progress.value = 100; setStatus(t().ready);
    showResults(message.platform as string, message.coverage as { category: string; count: number }[], message.warnings as ImportWarning[]);
  } else if (message.kind === 'error') finishWithError(message.message as string);
}
function renderProgress(update: ProgressUpdate): void {
  const percent = update.totalBytes ? Math.min(99, Math.round(update.bytesRead / update.totalBytes * 100)) : 0;
  progress.value = percent;
  setStatus(`${update.phase === 'reading' ? t().reading : t().parsing}: ${percent}% — ${update.recordsMatched.toLocaleString()} ${t().records}.`);
}
function showResults(platform: string, coverage: { category: string; count: number }[], warnings: ImportWarning[]): void {
  document.getElementById('results')!.hidden = false; text('platform', `${t().platform}: ${platform}`);
  const list = document.getElementById('coverage')!; list.replaceChildren();
  const nlNames: Record<string, string> = { 'Sleep duration': 'Slaapduur', Steps: 'Stappen', HRV: 'HRV', 'Resting heart rate': 'Rusthartslag', 'Nightly temperature': 'Nachttemperatuur', 'Temperature deviation': 'Temperatuurverschil' };
  for (const row of coverage) { const li = document.createElement('li'); li.textContent = `${language === 'nl' ? nlNames[row.category] ?? row.category : row.category}: ${row.count} ${t().days}`; list.append(li); }
  const notes = document.getElementById('warnings')!; notes.replaceChildren();
  for (const warning of warnings) { const li = document.createElement('li'); li.textContent = warningText(warning); notes.append(li); }
}
function warningText(w: ImportWarning): string {
  const messages: Record<string, [string, string]> = {
    preferred_google: ['Newer Google daily summaries were used where legacy Fitbit summaries disagree.', 'Nieuwere Google-dagsamenvattingen zijn gebruikt waar oudere Fitbit-samenvattingen afwijken.'],
    duplicate_sleep: ['Repeated sleep records with matching durations were counted once.', 'Herhaalde slaaprecords met dezelfde slaapduur zijn eenmaal meegeteld.'],
    missing_baseline: ['Temperature deviation is blank where the baseline is missing.', 'Het temperatuurverschil is leeg waar de baseline ontbreekt.'],
    apple_no_baseline: ['Apple XML does not provide a baseline through this importer. Temperature deviation remains blank.', 'Deze importer haalt geen baseline uit Apple XML. Het temperatuurverschil blijft leeg.'],
    legacy_no_baseline: ['Legacy computed temperature has no explicit baseline. Temperature deviation remains blank.', 'De oudere temperatuursamenvatting bevat geen expliciete baseline. Het temperatuurverschil blijft leeg.'],
    invalid_records: ['Invalid or missing measurements were excluded.', 'Ongeldige of ontbrekende metingen zijn uitgesloten.'],
    conflicting_values: ['Conflicting values were found. Affected daily values are blank.', 'Er zijn tegenstrijdige waarden gevonden. De betreffende dagwaarden zijn leeg.'],
    conflicting_sleep: ['Conflicting or overlapping sleep records were found. Affected sleep totals are blank.', 'Er zijn tegenstrijdige of overlappende slaaprecords gevonden. De betreffende slaaptotalen zijn leeg.'],
    missing_metric: ['This selected measurement was not found in the export.', 'Dit geselecteerde gegevenstype is niet gevonden in de export.'],
    no_measurements: ['No measurements found in this period. Check the selected end date.', 'Geen metingen gevonden in deze periode. Controleer de gekozen einddatum.'],
    legacy_step_timezone: ['Legacy step timestamps have no offset; this importer treats them as UTC before grouping in your selected timezone. Check against the app.', 'Oudere stappentijdstippen bevatten geen tijdzone; deze importer behandelt ze als UTC en groepeert ze in de gekozen tijdzone. Vergelijk met de app.']
  };
  return (messages[w.code]?.[language === 'nl' ? 1 : 0] ?? w.code) + (w.detail ? ` (${w.detail})` : '');
}
function finishWithError(message: string): void {
  currentWorker?.terminate(); currentWorker = undefined; clearOutput(); setBusy(false);
  progress.hidden = true; setStatus(`${t().error}: ${message}`, true);
}
function clearOutput(): void {
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = undefined; outputFilename = undefined; csvParts = []; downloadButton.disabled = true; document.getElementById('results')!.hidden = true;
}
function setStatus(message: string, error = false): void { status.textContent = message; status.classList.toggle('error', error); }

function enableExclusiveLongPress(checkbox: HTMLInputElement): void {
  let timer: number | undefined;
  let longPressTriggered = false;
  const clearTimer = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  };
  checkbox.addEventListener('pointerdown', () => {
    longPressTriggered = false;
    timer = window.setTimeout(() => {
      longPressTriggered = true;
      checkbox.closest('label')?.classList.add('long-press-active');
      selectOnlyType(checkbox);
    }, EXCLUSIVE_LONG_PRESS_MS);
  });
  checkbox.addEventListener('pointerup', clearTimer);
  checkbox.addEventListener('pointercancel', clearTimer);
  checkbox.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse') clearTimer();
  });
  checkbox.addEventListener('contextmenu', (event) => {
    if (longPressTriggered) event.preventDefault();
  });
  checkbox.addEventListener('click', (event) => {
    checkbox.closest('label')?.classList.remove('long-press-active');
    if (!longPressTriggered) return;
    event.preventDefault();
    selectOnlyType(checkbox);
    longPressTriggered = false;
  });
}

function selectOnlyType(selected: HTMLInputElement): void {
  for (const checkbox of form.querySelectorAll<HTMLInputElement>('input[name="types"]')) {
    checkbox.checked = checkbox === selected;
  }
}

function lockDataTypes(): void {
  for (const checkbox of form.querySelectorAll<HTMLInputElement>('input[name="types"]')) {
    checkbox.disabled = true;
  }
  dataTypesFieldset.classList.add('data-types-locked');
  dataTypesFieldset.classList.remove('data-types-unlocked');
  typeLockLabel.textContent = t().locked;
}

function enableDataTypesUnlock(): void {
  let timer: number | undefined;
  let unlocked = false;
  const cancel = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
    dataTypesFieldset.classList.remove('data-types-unlocking');
  };
  const unlock = () => {
    unlocked = true;
    cancel();
    for (const checkbox of form.querySelectorAll<HTMLInputElement>('input[name="types"]')) {
      checkbox.disabled = false;
    }
    dataTypesFieldset.classList.remove('data-types-locked');
    dataTypesFieldset.classList.add('data-types-unlocked');
    typeLockLabel.textContent = t().unlocked;
  };
  dataTypesFieldset.addEventListener('pointerdown', () => {
    if (unlocked) return;
    dataTypesFieldset.classList.add('data-types-unlocking');
    timer = window.setTimeout(unlock, DATA_TYPES_UNLOCK_PRESS_MS);
  });
  dataTypesFieldset.addEventListener('pointerup', cancel);
  dataTypesFieldset.addEventListener('pointercancel', cancel);
  dataTypesFieldset.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse') cancel();
  });
}
