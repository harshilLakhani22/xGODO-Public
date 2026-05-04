export interface ResolvedInputs {
  keyword: string;
  niche: string;
  geminiApiKey: string;
  geminiModel: string;
  searchResultsCount: number;
  suggestionsPerLoop: number;
  loopCount: number;
  watchSecondsPerVideo: number;
}

export type InputValidationResult =
  | { ok: true; inputs: ResolvedInputs }
  | { ok: false; code: string; message: string };

const DEFAULT_SEARCH_RESULTS_COUNT = 4;
const DEFAULT_SUGGESTIONS_PER_LOOP = 4;
const DEFAULT_LOOP_COUNT = 3;
const DEFAULT_WATCH_SECONDS_PER_VIDEO = 45;
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

function readString(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

function firstNonEmptyString(jobVariables: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = readString(jobVariables[key]);
    if (value) return value;
  }
  return '';
}

function firstDefined(jobVariables: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = jobVariables[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function resolveCountInput(jobVariables: Record<string, unknown>, keys: string[]): unknown {
  const explicit = firstDefined(jobVariables, keys);
  if (explicit !== undefined) {
    return explicit;
  }
  return firstDefined(jobVariables, ['x']);
}

function parseInteger(raw: unknown, fallback: number, minimum: number): number | null {
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minimum || Math.floor(parsed) !== parsed) {
    return null;
  }
  return parsed;
}

function parsePositiveInt(raw: unknown, fallback: number): number | null {
  return parseInteger(raw, fallback, 1);
}

function parseNonNegativeInt(raw: unknown, fallback: number): number | null {
  return parseInteger(raw, fallback, 0);
}

export function validateAndResolveInputs(jobVariablesRaw: unknown): InputValidationResult {
  const jobVariables = (jobVariablesRaw ?? {}) as Record<string, unknown>;

  const keyword = firstNonEmptyString(jobVariables, ['keyword', 'searchKeyword', 'niche']);
  if (!keyword) {
    return {
      ok: false,
      code: 'MISSING_KEYWORD',
      message: 'Missing required input: keyword (or legacy fallback niche)',
    };
  }

  const niche = firstNonEmptyString(jobVariables, ['niche']) || keyword;

  const geminiApiKey = firstNonEmptyString(jobVariables, ['geminiApiKey', 'apiKey']);
  if (!geminiApiKey) {
    return {
      ok: false,
      code: 'MISSING_GEMINI_API_KEY',
      message: 'Missing required input: geminiApiKey (or apiKey)',
    };
  }

  const geminiModel =
    firstNonEmptyString(jobVariables, ['geminiModel', 'model']) || DEFAULT_GEMINI_MODEL;

  const searchResultsCount = parsePositiveInt(
    resolveCountInput(jobVariables, ['searchResultsCount', 'resultsCount']),
    DEFAULT_SEARCH_RESULTS_COUNT,
  );
  if (!searchResultsCount) {
    return {
      ok: false,
      code: 'INVALID_SEARCH_RESULTS_COUNT',
      message: 'searchResultsCount must be a positive integer',
    };
  }

  const suggestionsPerLoop = parsePositiveInt(
    resolveCountInput(jobVariables, ['suggestionsPerLoop', 'suggestedCount']),
    DEFAULT_SUGGESTIONS_PER_LOOP,
  );
  if (!suggestionsPerLoop) {
    return {
      ok: false,
      code: 'INVALID_SUGGESTIONS_PER_LOOP',
      message: 'suggestionsPerLoop must be a positive integer',
    };
  }

  const loopCount = parseNonNegativeInt(
    firstDefined(jobVariables, ['loopCount', 'loopNumber']),
    DEFAULT_LOOP_COUNT,
  );
  if (loopCount === null) {
    return {
      ok: false,
      code: 'INVALID_LOOP_COUNT',
      message: 'loopCount (or loopNumber) must be a non-negative integer',
    };
  }

  const watchSecondsPerVideo = parseNonNegativeInt(
    firstDefined(jobVariables, ['watchSecondsPerVideo', 'watchSeconds', 'watchDurationSeconds']),
    DEFAULT_WATCH_SECONDS_PER_VIDEO,
  );
  if (watchSecondsPerVideo === null) {
    return {
      ok: false,
      code: 'INVALID_WATCH_SECONDS_PER_VIDEO',
      message: 'watchSecondsPerVideo (or watchSeconds) must be a non-negative integer',
    };
  }

  return {
    ok: true,
    inputs: {
      keyword,
      niche,
      geminiApiKey,
      geminiModel,
      searchResultsCount,
      suggestionsPerLoop,
      loopCount,
      watchSecondsPerVideo,
    },
  };
}

export function getResolvedInputs(): ResolvedInputs {
  const result = validateAndResolveInputs(agent.arguments?.jobVariables ?? {});
  if (!result.ok) {
    throw new Error(`${result.code}: ${result.message}`);
  }
  return result.inputs;
}

export function toPublicInputSummary(inputs: ResolvedInputs) {
  return {
    keyword: inputs.keyword,
    niche: inputs.niche,
    geminiModel: inputs.geminiModel,
    searchResultsCount: inputs.searchResultsCount,
    suggestionsPerLoop: inputs.suggestionsPerLoop,
    loopCount: inputs.loopCount,
    watchSecondsPerVideo: inputs.watchSecondsPerVideo,
  };
}
