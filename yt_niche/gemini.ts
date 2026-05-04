export interface GeminiCandidate {
  id: string;
  title: string;
}

export interface GeminiScoredCandidate extends GeminiCandidate {
  score: number;
}

export type GeminiFailureKind =
  | 'invalid_api_key'
  | 'access_denied'
  | 'transient'
  | 'response_error'
  | 'unknown';

export class GeminiApiError extends Error {
  kind: GeminiFailureKind;
  httpStatus?: number;
  googleStatus?: string;
  googleReason?: string;

  constructor(params: {
    message: string;
    kind: GeminiFailureKind;
    httpStatus?: number;
    googleStatus?: string;
    googleReason?: string;
  }) {
    super(params.message);
    this.name = 'GeminiApiError';
    this.kind = params.kind;
    this.httpStatus = params.httpStatus;
    this.googleStatus = params.googleStatus;
    this.googleReason = params.googleReason;
  }
}

const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1500;

function normalizeTitle(raw: string): string {
  return (raw || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function buildPrompt(niche: string, candidates: GeminiCandidate[]): string {
  return `You are scoring YouTube video titles for niche relevance.

Niche keyword: "${niche}"

Task:
- Score each title from 0 to 100 as match-to-niche.
- 0 = irrelevant, 100 = highly niche-specific.
- Be strict. Prefer precision over generosity.

Return format:
- Return ONLY valid JSON.
- No markdown, no commentary.
- Use this exact shape:
{
  "scores": [
    { "id": "candidate-id", "score": 0 }
  ]
}

Rules:
- Keep every provided id exactly unchanged.
- Include every provided id exactly once.
- score must be an integer in [0, 100].

Candidates:
${JSON.stringify(candidates)}`;
}

function stripMarkdownFences(rawText: string): string {
  return rawText
    .replace(/^```json/i, '')
    .replace(/^```/i, '')
    .replace(/```$/i, '')
    .trim();
}

function extractJsonPayloadText(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
  ) {
    return trimmed;
  }

  const fenced = stripMarkdownFences(trimmed);
  if (
    (fenced.startsWith('[') && fenced.endsWith(']')) ||
    (fenced.startsWith('{') && fenced.endsWith('}'))
  ) {
    return fenced;
  }

  const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!arrayMatch && !objectMatch) return null;
  if (arrayMatch && !objectMatch) return arrayMatch[0];
  if (!arrayMatch && objectMatch) return objectMatch[0];

  const firstArrayIndex = trimmed.indexOf('[');
  const firstObjectIndex = trimmed.indexOf('{');
  return firstArrayIndex >= 0 && (firstArrayIndex < firstObjectIndex || firstObjectIndex < 0)
    ? arrayMatch![0]
    : objectMatch![0];
}

function toScoreEntries(payload: unknown): any[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const record = payload as Record<string, unknown>;
  const arrayKeys = ['scores', 'results', 'predictions', 'items', 'data', 'videos', 'matches'];
  for (const key of arrayKeys) {
    const candidate = record[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  const entries = Object.entries(record);
  if (entries.length === 0) return [];

  const looksLikeIdToScoreMap = entries.every(([, value]) =>
    typeof value === 'number' ||
    typeof value === 'string' ||
    (!!value && typeof value === 'object' && ('score' in (value as Record<string, unknown>)))
  );

  if (!looksLikeIdToScoreMap) return [];

  return entries.map(([id, value]) => {
    if (value && typeof value === 'object') {
      return { id, score: (value as any).score };
    }
    return { id, score: value };
  });
}

function clampScore(rawScore: unknown): number {
  const parsed = Number(rawScore);
  if (!Number.isFinite(parsed)) return 0;
  if (parsed < 0) return 0;
  if (parsed > 100) return 100;
  return Math.round(parsed);
}

async function sleepMs(ms: number) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeMessage(raw: string): string {
  return raw.replace(/key=AIza[0-9A-Za-z_-]+/g, 'key=[REDACTED]').trim();
}

function parseGoogleErrorPayload(errorBody: string): {
  message: string;
  googleStatus?: string;
  googleReason?: string;
} {
  try {
    const parsed = JSON.parse(errorBody);
    const error = parsed?.error ?? {};
    const googleStatus = typeof error.status === 'string' ? error.status : undefined;
    const message = typeof error.message === 'string' ? error.message : errorBody;
    const details = Array.isArray(error.details) ? error.details : [];
    const googleReason = details.find((detail: any) => typeof detail?.reason === 'string')?.reason;
    return {
      message: sanitizeMessage(message || errorBody),
      googleStatus,
      googleReason,
    };
  } catch {
    return {
      message: sanitizeMessage(errorBody),
    };
  }
}

function classifyHttpError(status: number, errorBody: string): GeminiApiError {
  const parsed = parseGoogleErrorPayload(errorBody);
  const googleStatus = parsed.googleStatus;
  const googleReason = parsed.googleReason;

  let kind: GeminiFailureKind = 'unknown';
  if (status === 429 || status >= 500) {
    kind = 'transient';
  } else if (googleReason === 'API_KEY_INVALID') {
    kind = 'invalid_api_key';
  } else if (
    googleStatus === 'PERMISSION_DENIED' ||
    googleReason === 'SERVICE_DISABLED' ||
    googleReason === 'API_KEY_SERVICE_BLOCKED'
  ) {
    kind = 'access_denied';
  } else if (status === 400 && googleStatus === 'INVALID_ARGUMENT') {
    kind = googleReason === 'API_KEY_INVALID' ? 'invalid_api_key' : 'response_error';
  }

  return new GeminiApiError({
    message: `Gemini API error ${status}: ${parsed.message}`.slice(0, 600),
    kind,
    httpStatus: status,
    googleStatus,
    googleReason,
  });
}

function classifyNetworkError(error: unknown): GeminiApiError {
  const message = sanitizeMessage(error instanceof Error ? error.message : String(error));
  return new GeminiApiError({
    message: `Gemini request failed: ${message}`.slice(0, 600),
    kind: 'transient',
  });
}

function classifyResponseError(message: string): GeminiApiError {
  return new GeminiApiError({
    message: sanitizeMessage(message).slice(0, 600),
    kind: 'response_error',
  });
}

function shouldRetryGeminiError(error: unknown): boolean {
  return isGeminiApiError(error) ? error.kind === 'transient' : true;
}

async function requestGeminiContent(params: {
  apiKey: string;
  model?: string;
  prompt: string;
  contextLabel?: string;
}): Promise<string> {
  const { apiKey, prompt, contextLabel } = params;
  const model = (params.model || DEFAULT_GEMINI_MODEL).trim() || DEFAULT_GEMINI_MODEL;
  let useJsonMimeType = true;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[Gemini] ${contextLabel || 'request'} attempt ${attempt}/${MAX_RETRIES}`);
      const generationConfig: Record<string, unknown> = {
        temperature: 0.1,
      };
      if (useJsonMimeType) {
        generationConfig.responseMimeType = 'application/json';
      }

      let response: Response;
      try {
        response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig,
            }),
          },
        );
      } catch (error) {
        throw classifyNetworkError(error);
      }

      if (!response.ok) {
        const errorBody = await response.text();
        const classified = classifyHttpError(response.status, errorBody);

        if (response.status === 400 && useJsonMimeType && classified.kind === 'response_error') {
          console.log('[Gemini] 400 with JSON mime mode, retrying without responseMimeType');
          useJsonMimeType = false;
          if (attempt < MAX_RETRIES) {
            await sleepMs(400);
            continue;
          }
        }

        if (!shouldRetryGeminiError(classified) || attempt === MAX_RETRIES) {
          throw classified;
        }

        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`[Gemini] transient HTTP error ${response.status}, retrying in ${delay}ms`);
        await sleepMs(delay);
        continue;
      }

      const result = await response.json();
      const parts = result?.candidates?.[0]?.content?.parts;
      const text: string = Array.isArray(parts)
        ? parts.map((part: any) => (typeof part?.text === 'string' ? part.text : '')).join('\n').trim()
        : '';

      if (!text) {
        throw classifyResponseError('Gemini response did not contain text output');
      }

      return text;
    } catch (error) {
      if (!shouldRetryGeminiError(error) || attempt === MAX_RETRIES) {
        throw error;
      }
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`[Gemini] ${contextLabel || 'request'} failed, retrying in ${delay}ms`, error);
      await sleepMs(delay);
    }
  }

  throw classifyResponseError('Gemini request failed unexpectedly');
}

export function isGeminiApiError(error: unknown): error is GeminiApiError {
  return error instanceof GeminiApiError;
}

export function toGeminiFailureCode(
  error: GeminiApiError,
  phase: 'preflight' | 'search_scoring' | 'suggestion_scoring',
): string {
  if (error.kind === 'invalid_api_key') return 'GEMINI_API_KEY_INVALID';
  if (error.kind === 'access_denied') return 'GEMINI_API_ACCESS_DENIED';
  if (phase === 'preflight') return 'GEMINI_API_PRECHECK_FAILED';
  if (phase === 'suggestion_scoring') return 'GEMINI_SUGGESTION_SCORING_FAILED';
  return 'GEMINI_SEARCH_SCORING_FAILED';
}

export async function validateGeminiAccess(apiKey: string, model?: string): Promise<void> {
  const prompt = `Return ONLY valid JSON: {"ok":true}`;
  const text = await requestGeminiContent({
    apiKey,
    model,
    prompt,
    contextLabel: 'preflight',
  });
  const payloadText = extractJsonPayloadText(text);
  if (!payloadText) {
    throw classifyResponseError(`Gemini preflight response was not JSON. text=${text.slice(0, 200)}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    throw classifyResponseError(`Gemini preflight JSON could not be parsed. payload=${payloadText.slice(0, 200)}`);
  }

  if (!parsed || parsed.ok !== true) {
    throw classifyResponseError(`Gemini preflight returned unexpected payload. payload=${payloadText.slice(0, 200)}`);
  }
}

export async function scoreCandidatesWithGemini(params: {
  niche: string;
  apiKey: string;
  model?: string;
  candidates: GeminiCandidate[];
  contextLabel?: string;
}): Promise<GeminiScoredCandidate[]> {
  const { niche, apiKey, candidates, contextLabel, model } = params;
  if (candidates.length === 0) return [];

  const prompt = buildPrompt(niche, candidates);
  const scoreMap = new Map<string, number>();
  candidates.forEach(candidate => scoreMap.set(candidate.id, 0));
  const text = await requestGeminiContent({
    apiKey,
    model,
    prompt,
    contextLabel: contextLabel || 'scoring',
  });

  const jsonPayloadText = extractJsonPayloadText(text);
  if (!jsonPayloadText) {
    throw classifyResponseError(`Gemini response did not contain JSON payload. text=${text.slice(0, 200)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonPayloadText);
  } catch {
    throw classifyResponseError(`Gemini JSON could not be parsed. payload=${jsonPayloadText.slice(0, 200)}`);
  }

  const scoreEntries = toScoreEntries(parsed);
  if (scoreEntries.length === 0) {
    throw classifyResponseError(`Gemini JSON payload had no score entries. payload=${jsonPayloadText.slice(0, 200)}`);
  }

  let matchedCount = 0;
  scoreEntries.forEach((entry: any, index: number) => {
    let id = typeof entry?.id === 'string' ? entry.id : '';

    if (!id || !scoreMap.has(id)) {
      const entryTitle = typeof entry?.title === 'string' ? normalizeTitle(entry.title) : '';
      if (entryTitle) {
        const titleMatch = candidates.find(candidate => normalizeTitle(candidate.title) === entryTitle);
        if (titleMatch) id = titleMatch.id;
      }
    }

    if ((!id || !scoreMap.has(id)) && Number.isInteger(entry?.index)) {
      const idx = Number(entry.index);
      if (idx >= 0 && idx < candidates.length) {
        id = candidates[idx].id;
      }
    }

    if ((!id || !scoreMap.has(id)) && scoreEntries.length === candidates.length && candidates[index]) {
      id = candidates[index].id;
    }

    if (!id || !scoreMap.has(id)) return;
    scoreMap.set(id, clampScore(entry?.score));
    matchedCount++;
  });

  if (matchedCount === 0 && scoreEntries.length === candidates.length) {
    scoreEntries.forEach((entry: any, index: number) => {
      const candidate = candidates[index];
      if (!candidate) return;
      scoreMap.set(candidate.id, clampScore(entry?.score));
    });
  }

  return candidates.map(candidate => ({
    ...candidate,
    score: scoreMap.get(candidate.id) ?? 0,
  }));
}

export function pickBestScored<T extends { score: number }>(items: T[]): T {
  if (items.length === 0) {
    throw new Error('Cannot pick best from empty list');
  }
  let best = items[0];
  for (let i = 1; i < items.length; i++) {
    if (items[i].score > best.score) {
      best = items[i];
    }
  }
  return best;
}
