import { isFirefoxPackageName } from './browser';
import { getDeviceScreen, type OcrLine } from './util';

export interface ClickableVideoCandidate {
  title: string;
  key: string;
  node: any;
  rawText: string;
  top: number;
  left: number;
}

const CONTROL_LABELS = new Set([
  'all',
  'videos',
  'video',
  'shorts',
  'live',
  'gaming',
  'news',
  'recently uploaded',
  'watched',
  'new to you',
  'filters',
  'filter',
  'search',
  'search youtube',
  'share',
  'download',
  'save',
  'subscribe',
  'subscribed',
  'play all',
  'mix',
  'open app',
]);

function normalizeText(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function normalizeCandidateText(raw: string): string {
  return normalizeText(raw).replace(/\s+/g, ' ').trim();
}

export function normalizeVideoTitle(raw: string): string {
  return (raw || '').replace(/\s+/g, ' ').trim();
}

function nodeArea(node: any): number {
  if (!node?.boundsInScreen) return Number.MAX_SAFE_INTEGER;
  const width = Math.max(0, (node.boundsInScreen.right ?? 0) - (node.boundsInScreen.left ?? 0));
  const height = Math.max(0, (node.boundsInScreen.bottom ?? 0) - (node.boundsInScreen.top ?? 0));
  return width * height;
}

export function looksLikeShortTitle(title: string): boolean {
  const normalized = normalizeVideoTitle(title).toLowerCase();
  return normalized.includes('#short') || normalized.includes(' shorts ') || normalized.endsWith(' shorts');
}

function nodeText(node: any): string {
  return [node?.text, node?.description, node?.hintText]
    .map(value => (typeof value === 'string' ? value : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function isLikelyMetadataLine(line: string): boolean {
  const normalized = normalizeText(line);
  if (!normalized) return true;
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(normalized)) return true;
  if (/^[\d\s:.,]+$/.test(normalized)) return true;

  const metadataHints = [
    ' views',
    ' view',
    ' ago',
    ' watching',
    ' subscribers',
    ' subscriber',
    ' channel',
    ' playlist',
    ' episodes',
  ];

  return metadataHints.some(hint => normalized.includes(hint));
}

function isLikelyVideoTitle(line: string): boolean {
  const normalized = normalizeText(line);
  if (!normalized) return false;
  if (CONTROL_LABELS.has(normalized)) return false;
  if (normalized.length < 10) return false;
  if (normalized.split(/\s+/).length < 3) return false;
  if (normalized.startsWith('sort by')) return false;
  if (normalized.includes('search results')) return false;
  if (normalized.includes('search or enter address')) return false;
  if (normalized.includes('comments')) return false;
  if (normalized.includes('description')) return false;
  if (normalized.includes('youtube.com')) return false;
  if (normalized.endsWith('- youtube') || normalized.endsWith('| youtube')) return false;
  return !isLikelyMetadataLine(line);
}

function extractVideoTitleFromRaw(raw: string): string {
  const lines = raw
    .split(/\n+/)
    .map(line => normalizeVideoTitle(line))
    .filter(Boolean);

  for (const line of lines) {
    if (isLikelyVideoTitle(line)) {
      return line;
    }
  }

  const collapsed = normalizeVideoTitle(raw);
  if (!collapsed) return '';

  const bulletTrimmed = collapsed.split(/\s+(?:\u2022|\u00b7)\s+/)[0]?.trim() || '';
  if (isLikelyVideoTitle(bulletTrimmed)) {
    return bulletTrimmed;
  }

  return '';
}

function findClickableContainerForNode(allNodes: any[], targetNode: any): any | undefined {
  if (!targetNode?.boundsInScreen) return undefined;
  const targetBounds = targetNode.boundsInScreen;

  const containers = allNodes
    .filter((node: any) =>
      node.clickable &&
      node.boundsInScreen &&
      node.boundsInScreen.left <= targetBounds.left &&
      node.boundsInScreen.right >= targetBounds.right &&
      node.boundsInScreen.top <= targetBounds.top &&
      node.boundsInScreen.bottom >= targetBounds.bottom
    )
    .sort((left, right) => nodeArea(left) - nodeArea(right));

  return containers[0];
}

function resolveClickableNode(allNodes: any[], node: any): any | undefined {
  if (node?.clickable && node?.boundsInScreen) {
    return node;
  }

  const container = findClickableContainerForNode(allNodes, node);
  if (container?.boundsInScreen) {
    return container;
  }

  // Fallback: allow tapping the node bounds even if it isn't marked clickable.
  if (node?.boundsInScreen) {
    return node;
  }

  return undefined;
}

function hasResultCardContext(rawText: string): boolean {
  const normalizedRaw = normalizeCandidateText(rawText);
  if (!normalizedRaw) return false;

  const metadataHints = [' views', ' view', ' ago', ' subscribers', ' subscriber', ' channel'];
  if (metadataHints.some(hint => normalizedRaw.includes(hint))) {
    return true;
  }

  if (rawText.includes('\u2022') || rawText.includes('\u00b7')) {
    return true;
  }

  return /\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(normalizedRaw);
}

function looksLikeFirefoxLandingText(rawText: string): boolean {
  const normalized = normalizeCandidateText(rawText);
  if (!normalized) return false;

  const firefoxHints = [
    'welcome to firefox',
    'collect the things that matter to you',
    'group together similar searches',
    'shortcuts',
    'collections',
    'add firefox widget',
    'start every search from your phone',
    'instantly pick up where you left off',
    'start synchronising',
    'choose your address bar',
  ];

  return firefoxHints.some(hint => normalized.includes(hint));
}

function looksLikePageChromeCandidate(title: string, rawText: string): boolean {
  const normalizedTitle = normalizeText(title);
  const normalizedRaw = normalizeCandidateText(rawText);
  if (!normalizedTitle || !normalizedRaw) return true;

  if (normalizedTitle === 'youtube' || normalizedTitle === 'youtube shorts') return true;
  if (normalizedTitle.endsWith('- youtube') || normalizedTitle.endsWith('| youtube')) return true;
  if (normalizedTitle.includes('search or enter address')) return true;
  if (normalizedTitle.includes('youtube.com')) return true;
  if (normalizedRaw.includes('search or enter address')) return true;
  if (normalizedRaw.includes('open app') && normalizedRaw.includes('subscribe') && normalizedRaw.includes('comments')) {
    return true;
  }
  if (looksLikeFirefoxLandingText(rawText)) {
    return true;
  }
  if (normalizedRaw.includes('search results') && !hasResultCardContext(rawText)) {
    return true;
  }
  if (!hasResultCardContext(rawText) && normalizedTitle.includes('youtube')) {
    return true;
  }

  return false;
}

function isImplausiblyBroadCandidate(bounds: any, width: number, height: number): boolean {
  const candidateWidth = Math.max(0, (bounds.right ?? 0) - (bounds.left ?? 0));
  const candidateHeight = Math.max(0, (bounds.bottom ?? 0) - (bounds.top ?? 0));
  const widthRatio = width > 0 ? candidateWidth / width : 0;
  const heightRatio = height > 0 ? candidateHeight / height : 0;

  return widthRatio >= 0.9 && heightRatio >= 0.4;
}

export function extractClickableVideoCandidates(
  allNodes: any[],
  options?: {
    minTop?: number;
    minWidthRatio?: number;
    minHeight?: number;
    maxBottomMargin?: number;
    includeShorts?: boolean;
  },
): ClickableVideoCandidate[] {
  const { width, height } = getDeviceScreen();
  const minTop = options?.minTop ?? 220;
  const minWidthRatio = options?.minWidthRatio ?? 0.58;
  const minHeight = options?.minHeight ?? 90;
  const maxBottom = height - (options?.maxBottomMargin ?? 110);
  const includeShorts = options?.includeShorts ?? false;

  const byKey = new Map<string, ClickableVideoCandidate>();
  const candidates = allNodes.filter((node: any) =>
    isFirefoxPackageName(node.packageName) &&
    node.boundsInScreen &&
    (typeof node.text === 'string' || typeof node.description === 'string')
  );

  for (const node of candidates) {
    const clickableNode = resolveClickableNode(allNodes, node);
    if (!clickableNode?.boundsInScreen) continue;

    const bounds = clickableNode.boundsInScreen;
    const candidateWidth = bounds.right - bounds.left;
    const candidateHeight = bounds.bottom - bounds.top;
    if (bounds.top < minTop || bounds.bottom > maxBottom) continue;
    if (candidateWidth < width * minWidthRatio || candidateHeight < minHeight) continue;
    if (isImplausiblyBroadCandidate(bounds, width, height)) continue;

    const rawText = nodeText(node) || nodeText(clickableNode);
    const title = extractVideoTitleFromRaw(rawText);
    if (!title) continue;
    if (!includeShorts && looksLikeShortTitle(title)) continue;
    if (looksLikePageChromeCandidate(title, rawText)) continue;

    const normalizedTitle = normalizeText(title);
    const normalizedRawText = normalizeCandidateText(rawText);
    const candidateKey = `${normalizedTitle}||${normalizedRawText}`;
    const existing = byKey.get(candidateKey);
    const nextCandidate: ClickableVideoCandidate = {
      title,
      key: candidateKey,
      node: clickableNode,
      rawText,
      top: bounds.top,
      left: bounds.left,
    };

    if (
      !existing ||
      nextCandidate.top < existing.top ||
      (nextCandidate.top === existing.top && nextCandidate.left < existing.left)
    ) {
      byKey.set(candidateKey, nextCandidate);
    }
  }

  return [...byKey.values()].sort((a, b) => (a.top - b.top) || (a.left - b.left));
}

export function extractOcrVideoCandidates(
  lines: OcrLine[],
  options?: {
    minTop?: number;
    maxBottomMargin?: number;
    includeShorts?: boolean;
  },
): ClickableVideoCandidate[] {
  const { width, height } = getDeviceScreen();
  const minTop = options?.minTop ?? 220;
  const maxBottom = height - (options?.maxBottomMargin ?? 110);
  const includeShorts = options?.includeShorts ?? false;

  const byKey = new Map<string, ClickableVideoCandidate>();

  for (const line of lines) {
    if (!line.boundingBox) continue;
    const bounds = line.boundingBox;
    if (bounds.top < minTop || bounds.bottom > maxBottom) continue;

    const title = normalizeVideoTitle(line.text || '');
    if (!title) continue;
    if (!includeShorts && looksLikeShortTitle(title)) continue;
    if (!isLikelyVideoTitle(title)) continue;

    const normalizedTitle = normalizeText(title);
    const key = `${normalizedTitle}||ocr||${Math.round(bounds.top / 6)}||${Math.round(bounds.left / 6)}`;
    if (byKey.has(key)) continue;

    byKey.set(key, {
      title,
      key,
      node: { boundsInScreen: bounds },
      rawText: title,
      top: bounds.top,
      left: bounds.left,
    });
  }

  return [...byKey.values()].sort((a, b) => (a.top - b.top) || (a.left - b.left));
}
