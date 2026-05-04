import { getFirefoxPackage, isFirefoxPackageName } from './browser';
import { clickNode, getAllNodes, getDeviceScreen, performOCR, tapOcrText } from './util';

export interface CurrentVideoInfo {
  title: string;
  url: string;
  isShort: boolean;
  isWatch: boolean;
}

export interface ResolvedYoutubeVideoInfo extends CurrentVideoInfo {
  pageKind: 'watch' | 'shorts' | 'results' | 'home' | 'unknown';
  detectionMode: 'node_url' | 'ocr_url' | 'ui_only' | 'none';
}

export interface OpenUrlInFirefoxOptions {
  successFallback?: (allNodes: any[]) => boolean;
}

export function extractTitleFromWebViewText(webViewText: string): string {
  return webViewText.replace(/ - YouTube$/, '').trim();
}

const CANONICAL_YOUTUBE_HOST = 'm.youtube.com';
const FIREFOX_ADDRESS_BAR_TOP_MAX = 320;
const FIREFOX_ADDRESS_BAR_VIEW_IDS = new Set([
  'ADDRESSBAR_URL_BOX',
  'org.mozilla.firefox:id/toolbar_wrapper',
  'org.mozilla.firefox:id/mozac_browser_toolbar_url_view',
  'org.mozilla.firefox:id/mozac_browser_toolbar_edit_url_view',
]);

function nodeViewId(node: any): string {
  return typeof node?.viewId === 'string' ? node.viewId : '';
}

function nodeBoundsWidth(node: any): number {
  if (!node?.boundsInScreen) return 0;
  return Math.max(0, (node.boundsInScreen.right ?? 0) - (node.boundsInScreen.left ?? 0));
}

function nodeTextValues(node: any): string[] {
  return [node?.description, node?.text, node?.hintText]
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim())
    .filter(Boolean);
}

function sanitizeUrlToken(raw: string): string {
  return raw
    .trim()
    .replace(/^[<(\["']+/, '')
    .replace(/[>)\]"',.;:!?]+$/, '');
}

function extractUrlTokens(raw: string): string[] {
  const compact = (raw || '').replace(/\s+/g, ' ').trim();
  if (!compact) return [];

  const tokens = compact
    .split(/\s+/)
    .map(sanitizeUrlToken)
    .filter(Boolean);

  // Include full value first so real address-bar values are preferred.
  return [sanitizeUrlToken(compact), ...tokens];
}

function extractUrlLikeValue(node: any): string {
  const values = nodeTextValues(node);
  for (const value of values) {
    const candidates = extractUrlTokens(value);
    for (const candidate of candidates) {
      if (!candidate || candidate.length < 4) continue;
      if (!/(?:https?:\/\/|youtu\.be|youtube\.com|[a-z0-9-]+\.[a-z]{2,}(?:[/?#]|$))/i.test(candidate)) {
        continue;
      }
      // Avoid false positives from web-search query URLs that embed another URL.
      if (/[?&](q|url|u)=https?:\/\//i.test(candidate)) continue;
      if (candidate.includes('...')) continue;
      if (!parseUrl(candidate)) continue;
      return candidate;
    }
  }
  return '';
}

function parseUrl(rawUrl: string): URL | null {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return null;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

function normalizeHostname(rawUrlOrHost: string): string {
  const parsed = parseUrl(rawUrlOrHost);
  const rawHost = (parsed?.hostname || rawUrlOrHost || '').trim().toLowerCase().replace(/\.+$/, '');
  const host = rawHost.replace(/^www\./, '');

  if (
    host === 'youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'music.youtube.com' ||
    host === 'youtu.be'
  ) {
    return 'youtube.com';
  }

  return host;
}

function normalizePathname(rawUrl: string): string {
  const parsed = parseUrl(rawUrl);
  if (!parsed) return '';
  return parsed.pathname.replace(/\/+$/, '') || '/';
}

export function extractShortsId(rawText: string): string {
  const directMatch = (rawText || '').match(
    /(?:youtube\.com|www\.youtube\.com|m\.youtube\.com|music\.youtube\.com)\/shorts\/([a-zA-Z0-9_-]+)/i,
  );
  if (directMatch?.[1]) {
    return directMatch[1];
  }

  const parsed = parseUrl(rawText);
  if (!parsed || normalizeHostname(parsed.hostname) !== 'youtube.com') return '';

  const segments = parsed.pathname.split('/').filter(Boolean);
  return segments[0] === 'shorts' && segments[1] ? segments[1] : '';
}

export function extractWatchId(rawText: string): string {
  const directMatch = (rawText || '').match(
    /(?:youtube\.com\/watch\?v=|www\.youtube\.com\/watch\?v=|m\.youtube\.com\/watch\?v=|music\.youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/i,
  );
  if (directMatch?.[1]) {
    return directMatch[1];
  }

  const parsed = parseUrl(rawText);
  if (!parsed) return '';

  if (parsed.hostname.toLowerCase() === 'youtu.be') {
    const shortId = parsed.pathname.split('/').filter(Boolean)[0];
    return shortId || '';
  }

  if (normalizeHostname(parsed.hostname) !== 'youtube.com') return '';
  if (parsed.pathname === '/watch') {
    return parsed.searchParams.get('v')?.trim() || '';
  }

  return '';
}

export function extractShortsUrl(rawText: string): string {
  const shortsId = extractShortsId(rawText);
  return shortsId ? `https://${CANONICAL_YOUTUBE_HOST}/shorts/${shortsId}` : '';
}

export function extractWatchUrl(rawText: string): string {
  const watchId = extractWatchId(rawText);
  return watchId ? `https://${CANONICAL_YOUTUBE_HOST}/watch?v=${watchId}` : '';
}

export function isYoutubeWatchUrl(url: string): boolean {
  return normalizeYoutubeUrl(url).includes('youtube.com/watch');
}

export function isYoutubeShortUrl(url: string): boolean {
  return normalizeYoutubeUrl(url).includes('youtube.com/shorts/');
}

export function normalizeYoutubeUrl(rawText: string): string {
  const trimmed = (rawText || '').trim();
  if (!trimmed) return '';

  const shorts = extractShortsUrl(trimmed);
  if (shorts) return shorts;

  const watch = extractWatchUrl(trimmed);
  if (watch) return watch;

  const parsed = parseUrl(trimmed);
  if (!parsed || normalizeHostname(parsed.hostname) !== 'youtube.com') return trimmed;

  const normalizedPath = parsed.pathname.replace(/\/+$/, '') || '/';
  if (normalizedPath === '/') {
    return `https://${CANONICAL_YOUTUBE_HOST}/`;
  }

  return `https://${CANONICAL_YOUTUBE_HOST}${normalizedPath}${parsed.search}`;
}

export function getCurrentFirefoxUrlFromNodes(allNodes: any[]): string {
  const urlNode = findFirefoxVisibleUrlNode(allNodes);
  return normalizeYoutubeUrl(extractUrlLikeValue(urlNode));
}

export function getCurrentYoutubeUrlFromNodes(allNodes: any[]): string {
  return getCurrentFirefoxUrlFromNodes(allNodes);
}

export function buildYoutubeSearchResultsUrl(keyword: string): string {
  const query = encodeURIComponent((keyword || '').trim());
  return `https://${CANONICAL_YOUTUBE_HOST}/results?search_query=${query}`;
}

function hasFirefoxNodes(allNodes: any[]): boolean {
  return allNodes.some((node: any) => isFirefoxPackageName(node.packageName));
}

function hasFirefoxWebView(allNodes: any[]): boolean {
  return allNodes.some((node: any) => node.className === 'android.webkit.WebView');
}

function getNodeTextPool(allNodes: any[]): string {
  return allNodes.map(nodeText).join(' ');
}

function getYoutubeBottomNavCount(allNodes: any[]): number {
  const labels = new Set(['home', 'shorts', 'subscriptions', 'you']);
  const found = new Set<string>();
  const { height } = getDeviceScreen();
  const minTop = Math.floor(height * 0.55);

  allNodes.forEach((node: any) => {
    if (!node?.boundsInScreen) return;
    if ((node.boundsInScreen.top ?? 0) < minTop) return;
    const candidates = [node?.text, node?.description, node?.hintText]
      .map(normalizeText)
      .filter(Boolean);
    candidates.forEach((value: string) => {
      if (labels.has(value)) {
        found.add(value);
      }
    });
  });

  return found.size;
}

function hasYoutubeBranding(allNodes: any[]): boolean {
  return allNodes.some((node: any) => {
    const top = node?.boundsInScreen?.top ?? Number.MAX_SAFE_INTEGER;
    if (top > 520) return false;
    const text = normalizeText(node?.text);
    const description = normalizeText(node?.description);
    return text === 'youtube' || description === 'youtube';
  });
}

function hasYoutubeHomeUiMarkers(allNodes: any[]): boolean {
  const textPool = getNodeTextPool(allNodes);
  const hasBottomNav = getYoutubeBottomNavCount(allNodes) >= 3;
  const hasSearchInput = textPool.includes('search youtube');
  return hasFirefoxWebView(allNodes) && hasBottomNav && (hasYoutubeBranding(allNodes) || hasSearchInput);
}

function hasYoutubeResultsUiMarkers(allNodes: any[]): boolean {
  const textPool = getNodeTextPool(allNodes);
  if (!hasFirefoxWebView(allNodes)) return false;
  if (getYoutubeBottomNavCount(allNodes) < 3) return false;
  const hasResultsWords = textPool.includes('search results') || textPool.includes('filters') || textPool.includes('filter');
  const hasSearchInput = textPool.includes('search youtube');
  return hasResultsWords && (hasSearchInput || hasYoutubeBranding(allNodes));
}

function isLikelyGoogleSearchPage(allNodes: any[]): boolean {
  const textPool = getNodeTextPool(allNodes);
  return (
    textPool.includes('google search') ||
    textPool.includes('about this result') ||
    textPool.includes('all images videos news') ||
    textPool.includes('google terms')
  );
}

function hasYoutubeWatchUiMarkers(allNodes: any[]): boolean {
  if (!hasFirefoxWebView(allNodes)) return false;

  const textPool = getNodeTextPool(allNodes);
  const watchSignals = [
    textPool.includes(' views'),
    textPool.includes(' view'),
    textPool.includes('comments'),
    textPool.includes('subscribe'),
    textPool.includes('share'),
    textPool.includes('save'),
    textPool.includes('report'),
    textPool.includes('open app'),
  ].filter(Boolean).length;

  const hasLongTitle = allNodes.some((node: any) => {
    const title = extractTitleFromWebViewText(node?.text ?? '') || normalizeText(node?.description);
    return title.length >= 12 && !title.includes('search results');
  });

  return (hasYoutubeBranding(allNodes) || textPool.includes('open app')) && watchSignals >= 3 && hasLongTitle;
}

function extractYoutubeUrlFromText(rawText: string): string {
  return normalizeYoutubeUrl(rawText);
}

function extractYoutubeUrlFromOcrText(text: string): string {
  if (!text) return '';

  const compact = text.replace(/\s+/g, '');
  const directMatch = compact.match(
    /(https?:\/\/)?(?:m\.|www\.)?youtube\.com\/(?:watch\?v=[a-zA-Z0-9_-]+|shorts\/[a-zA-Z0-9_-]+|results\?search_query=[^ \n\r]+)/i,
  );
  if (directMatch?.[0]) {
    return extractYoutubeUrlFromText(directMatch[0]);
  }

  const fallbackMatch = compact.match(
    /(?:m\.|www\.)?youtube\.com\/(?:watch\?v=[a-zA-Z0-9_-]+|shorts\/[a-zA-Z0-9_-]+|results\?search_query=[^ \n\r]+)/i,
  );
  if (fallbackMatch?.[0]) {
    return extractYoutubeUrlFromText(fallbackMatch[0]);
  }

  return '';
}

async function resolveCurrentYoutubeUrlFromOcr(): Promise<string> {
  const ocr = await performOCR();
  return extractYoutubeUrlFromOcrText(ocr?.text || '');
}

export async function resolveCurrentYoutubeUrl(screenContent?: AndroidNode): Promise<{
  url: string;
  detectionMode: 'node_url' | 'ocr_url' | 'none';
}> {
  const content = screenContent ?? await agent.actions.screenContent();
  const allNodes = getAllNodes(content);
  const nodeUrl = getCurrentYoutubeUrlFromNodes(allNodes);
  if (nodeUrl) {
    return {
      url: nodeUrl,
      detectionMode: 'node_url',
    };
  }

  const ocrUrl = await resolveCurrentYoutubeUrlFromOcr();
  if (ocrUrl) {
    return {
      url: ocrUrl,
      detectionMode: 'ocr_url',
    };
  }

  return {
    url: '',
    detectionMode: 'none',
  };
}

export function getYoutubeReadyMode(allNodes: any[]): 'url_verified' | 'ui_verified' | null {
  if (!hasFirefoxNodes(allNodes)) return null;

  const url = getCurrentYoutubeUrlFromNodes(allNodes);
  if (url.includes('youtube.com') && !isYoutubeWatchUrl(url) && !isYoutubeShortUrl(url)) {
    return 'url_verified';
  }

  if (hasYoutubeHomeUiMarkers(allNodes) || hasYoutubeResultsUiMarkers(allNodes)) {
    return 'ui_verified';
  }

  return null;
}

export function isYoutubeReadyPage(allNodes: any[]): boolean {
  return getYoutubeReadyMode(allNodes) !== null;
}

export function isYoutubeHomeLikePage(allNodes: any[]): boolean {
  if (!hasFirefoxNodes(allNodes)) return false;

  const url = getCurrentYoutubeUrlFromNodes(allNodes);
  if (url) {
    if (!url.includes('youtube.com')) return false;
    if (isYoutubeWatchUrl(url) || isYoutubeShortUrl(url)) return false;
    if (url.includes('youtube.com/results') || url.includes('search_query=')) return false;
    return true;
  }

  return hasYoutubeHomeUiMarkers(allNodes);
}

export function isYoutubeSearchResultsPage(allNodes: any[]): boolean {
  if (!hasFirefoxNodes(allNodes)) return false;

  const url = getCurrentYoutubeUrlFromNodes(allNodes);
  if (url.includes('youtube.com')) {
    if (isYoutubeWatchUrl(url) || isYoutubeShortUrl(url)) return false;
    if (url.includes('youtube.com/results')) {
      if (url.includes('search_query=')) return true;
      return hasYoutubeResultsUiMarkers(allNodes);
    }
    if (url.includes('search_query=')) return true;
  }

  return hasYoutubeResultsUiMarkers(allNodes);
}

function inferYoutubePageKindFromNodes(allNodes: any[], url: string): 'watch' | 'shorts' | 'results' | 'home' | 'unknown' {
  if (!hasFirefoxNodes(allNodes)) return 'unknown';

  if (isYoutubeShortUrl(url)) return 'shorts';
  if (isYoutubeWatchUrl(url)) return 'watch';
  if (isYoutubeSearchResultsPage(allNodes)) return 'results';
  if (isYoutubeHomeLikePage(allNodes)) return 'home';
  if (hasYoutubeWatchUiMarkers(allNodes)) return 'watch';

  return 'unknown';
}

function normalizeText(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function nodeText(node: any): string {
  return [node?.text, node?.description, node?.hintText]
    .map(normalizeText)
    .filter(Boolean)
    .join(' ');
}

function hasSearchOrEnterAddressLabel(node: any): boolean {
  return nodeText(node).includes('search or enter address');
}

function isFirefoxTopToolbarNode(node: any): boolean {
  return isFirefoxPackageName(node?.packageName) && node?.boundsInScreen?.top < FIREFOX_ADDRESS_BAR_TOP_MAX;
}

function isFirefoxAddressBarNode(node: any): boolean {
  if (!isFirefoxTopToolbarNode(node)) return false;

  const viewId = nodeViewId(node);
  const lowerViewId = viewId.toLowerCase();
  if (
    lowerViewId.includes('search_selector') ||
    lowerViewId.includes('tab_button') ||
    lowerViewId.includes('menubutton')
  ) {
    return false;
  }

  return (
    FIREFOX_ADDRESS_BAR_VIEW_IDS.has(viewId) ||
    hasSearchOrEnterAddressLabel(node) ||
    (lowerViewId.includes('toolbar') &&
      !lowerViewId.includes('browser_actions') &&
      (lowerViewId.includes('url') || lowerViewId.includes('edit') || lowerViewId.endsWith('toolbar_wrapper')))
  );
}

function scoreFirefoxAddressBarNode(node: any): number {
  const viewId = nodeViewId(node).toLowerCase();
  let score = 0;

  if (viewId === 'org.mozilla.firefox:id/toolbar_wrapper') score += 100;
  if (viewId === 'addressbar_url_box') score += 90;
  if (viewId.includes('edit_url')) score += 80;
  if (viewId.includes('toolbar') && viewId.includes('url')) score += 70;
  if (hasSearchOrEnterAddressLabel(node)) score += 60;
  if (node.clickable) score += 20;
  if (node.isEditable || node.className === 'android.widget.EditText') score += 20;
  score += Math.min(nodeBoundsWidth(node), 600) / 10;

  return score;
}

function findFirefoxVisibleUrlNode(allNodes: any[]): any | undefined {
  const directCandidates = allNodes
    .filter((node: any) => {
      if (!isFirefoxTopToolbarNode(node)) return false;

      const viewId = nodeViewId(node).toLowerCase();
      if (viewId.includes('search_selector') || viewId.includes('tab_button') || viewId.includes('menubutton')) {
        return false;
      }

      const visibleValue = extractUrlLikeValue(node);
      if (!visibleValue || hasSearchOrEnterAddressLabel(node)) return false;

      return (
        FIREFOX_ADDRESS_BAR_VIEW_IDS.has(nodeViewId(node)) ||
        (viewId.includes('toolbar') && (viewId.includes('url') || viewId.includes('edit')))
      );
    })
    .sort((left, right) => scoreFirefoxAddressBarNode(right) - scoreFirefoxAddressBarNode(left));

  return directCandidates[0];
}

function findClickableContainerForNode(allNodes: any[], targetNode: any): any | undefined {
  if (!targetNode?.boundsInScreen) return undefined;
  const targetBounds = targetNode.boundsInScreen;

  return allNodes.find((node: any) =>
    node.clickable &&
    node.boundsInScreen &&
    node.boundsInScreen.left <= targetBounds.left &&
    node.boundsInScreen.right >= targetBounds.right &&
    node.boundsInScreen.top <= targetBounds.top &&
    node.boundsInScreen.bottom >= targetBounds.bottom
  );
}

function findFirefoxAddressBarNode(allNodes: any[]): any | undefined {
  const directCandidates = allNodes
    .filter((node: any) => isFirefoxAddressBarNode(node))
    .sort((left, right) => scoreFirefoxAddressBarNode(right) - scoreFirefoxAddressBarNode(left));
  if (directCandidates[0]) return directCandidates[0];

  const labelNode = allNodes.find((node: any) =>
    isFirefoxTopToolbarNode(node) && hasSearchOrEnterAddressLabel(node)
  );
  return labelNode ? findClickableContainerForNode(allNodes, labelNode) : undefined;
}

function getCanonicalVideoTarget(rawUrl: string): { kind: 'watch' | 'shorts'; id: string } | null {
  const shortsId = extractShortsId(rawUrl);
  if (shortsId) {
    return { kind: 'shorts', id: shortsId };
  }

  const watchId = extractWatchId(rawUrl);
  if (watchId) {
    return { kind: 'watch', id: watchId };
  }

  return null;
}

function matchesTargetUrl(currentUrl: string, targetUrl: string): boolean {
  const normalizedCurrent = normalizeYoutubeUrl(currentUrl);
  const normalizedTarget = normalizeYoutubeUrl(targetUrl);
  if (!normalizedCurrent || !normalizedTarget) return false;

  const currentVideo = getCanonicalVideoTarget(normalizedCurrent);
  const targetVideo = getCanonicalVideoTarget(normalizedTarget);
  if (currentVideo || targetVideo) {
    return !!currentVideo &&
      !!targetVideo &&
      currentVideo.kind === targetVideo.kind &&
      currentVideo.id === targetVideo.id;
  }

  const currentHost = normalizeHostname(normalizedCurrent);
  const targetHost = normalizeHostname(normalizedTarget);
  if (currentHost && targetHost && currentHost !== targetHost) {
    return false;
  }

  const targetPath = normalizePathname(normalizedTarget);
  const currentPath = normalizePathname(normalizedCurrent);
  if (!targetPath) {
    return false;
  }

  if (targetPath === '/') {
    const parsedCurrent = parseUrl(normalizedCurrent);
    return (
      currentPath === '/' &&
      !!currentHost &&
      currentHost === targetHost &&
      (parsedCurrent?.search || '') === ''
    );
  }

  return currentPath === targetPath;
}

export function isFirefoxStartPage(allNodes: any[]): boolean {
  if (!allNodes.some((node: any) => isFirefoxPackageName(node.packageName))) return false;

  const currentUrl = getCurrentFirefoxUrlFromNodes(allNodes);
  if (currentUrl && currentUrl.includes('youtube.com')) return false;

  const textPool = allNodes.map(nodeText).join(' ');
  const hasAddressHint = textPool.includes('search or enter address');
  const hasFirefoxHomeSection =
    textPool.includes('shortcuts') ||
    textPool.includes('jump back in') ||
    textPool.includes('collections');

  return hasAddressHint && hasFirefoxHomeSection;
}

function isFirefoxAddressInputReady(allNodes: any[]): boolean {
  return allNodes.some((node: any) =>
    isFirefoxTopToolbarNode(node) && (
      node.isEditable ||
      node.className === 'android.widget.EditText' ||
      node.isFocused ||
      nodeViewId(node).toLowerCase().includes('edit_url')
    )
  );
}

async function waitForFirefoxAddressInputReady(maxChecks: number = 3): Promise<boolean> {
  for (let i = 0; i < maxChecks; i++) {
    const content = await agent.actions.screenContent();
    if (isFirefoxAddressInputReady(getAllNodes(content))) {
      return true;
    }
    await sleep(250);
  }

  return false;
}

async function clickFirefoxAddressBar(node: any): Promise<void> {
  if (!node?.boundsInScreen) return;

  if (Array.isArray(node.actions) && node.actions.includes(agent.constants.ACTION_CLICK)) {
    try {
      await agent.actions.nodeAction(node, agent.constants.ACTION_CLICK);
      return;
    } catch (error) {
      console.log('Firefox address bar ACTION_CLICK failed, falling back to coordinate tap', error);
    }
  }

  const bounds = node.boundsInScreen;
  const width = Math.max(0, bounds.right - bounds.left);
  const height = Math.max(0, bounds.bottom - bounds.top);
  const lowerViewId = nodeViewId(node).toLowerCase();

  if (
    lowerViewId === 'org.mozilla.firefox:id/toolbar_wrapper' ||
    hasSearchOrEnterAddressLabel(node)
  ) {
    const safeLeft = bounds.left + Math.max(12, Math.floor(width * 0.28));
    const safeRight = bounds.right - Math.max(10, Math.floor(width * 0.08));
    const safeTop = bounds.top + Math.max(6, Math.floor(height * 0.18));
    const safeBottom = bounds.bottom - Math.max(6, Math.floor(height * 0.18));
    await agent.utils.randomClick(safeLeft, safeTop, safeRight, safeBottom);
    return;
  }

  await clickNode(node);
}

async function focusFirefoxAddressBar(preferOcr: boolean = false): Promise<boolean> {
  const screenContent = await agent.actions.screenContent();
  const allNodes = getAllNodes(screenContent);

  if (!preferOcr) {
    const urlBar = findFirefoxAddressBarNode(allNodes);
    if (urlBar?.boundsInScreen) {
      await clickFirefoxAddressBar(urlBar);
      await sleep(900);
      if (await waitForFirefoxAddressInputReady()) {
        return true;
      }
    }
  }

  const ocr = await performOCR();
  if (ocr && await tapOcrText(ocr.lines, t => t.includes('search or enter address'))) {
    await sleep(900);
    if (await waitForFirefoxAddressInputReady()) {
      return true;
    }
  }

  const refreshedContent = await agent.actions.screenContent();
  const fallbackUrlBar = findFirefoxAddressBarNode(getAllNodes(refreshedContent));
  if (fallbackUrlBar?.boundsInScreen) {
    await clickFirefoxAddressBar(fallbackUrlBar);
    await sleep(900);
    if (await waitForFirefoxAddressInputReady()) {
      return true;
    }
  }

  const { width } = getDeviceScreen();
  await agent.utils.randomClick(
    Math.floor(width * 0.28),
    72,
    Math.floor(width * 0.82),
    190,
  );
  await sleep(900);
  return await waitForFirefoxAddressInputReady();
}

async function typeFirefoxUrl(url: string, preferPaste: boolean): Promise<void> {
  if (preferPaste) {
    await agent.actions.copyText(url);
    await agent.actions.paste();
    return;
  }

  try {
    await agent.actions.writeText(url);
  } catch (error) {
    console.log('writeText failed on URL bar, falling back to paste', error);
    await agent.actions.copyText(url);
    await agent.actions.paste();
  }
}

async function submitFirefoxAddressBar(): Promise<void> {
  try {
    await agent.actions.inputKey(66);
    return;
  } catch (error) {
    console.log('inputKey(66) failed, falling back to adb keyevent', error);
  }

  if (agent.control && typeof agent.control.adbShell === 'function') {
    try {
      await agent.control.adbShell('input keyevent 66');
      return;
    } catch (adbError) {
      console.log('adb keyevent 66 failed, trying keyevent 84', adbError);
      try {
        await agent.control.adbShell('input keyevent 84');
        return;
      } catch (fallbackError) {
        console.log('adb keyevent 84 failed', fallbackError);
      }
    }
  }

  // Last-resort fallback: tap the keyboard action area (bottom-right).
  const { width, height } = getDeviceScreen();
  await agent.utils.randomClick(
    Math.floor(width * 0.75),
    Math.floor(height * 0.86),
    Math.floor(width * 0.99),
    Math.floor(height * 0.99),
  );
  await sleep(500);
}

async function waitForFirefoxUrl(
  targetUrl: string,
  maxChecks: number = 5,
  options: OpenUrlInFirefoxOptions = {},
): Promise<boolean> {
  for (let i = 0; i < maxChecks; i++) {
    const content = await agent.actions.screenContent();
    if (await dismissOpenInYouTubeDialog(content)) {
      continue;
    }

    const allNodes = getAllNodes(content);
    const currentUrl = getCurrentFirefoxUrlFromNodes(allNodes);
    if (i === 0 || i === maxChecks - 1) {
      console.log(`waitForFirefoxUrl check ${i + 1}/${maxChecks}: "${currentUrl || 'EMPTY'}"`);
    }
    if (matchesTargetUrl(currentUrl, targetUrl)) {
      return true;
    }
    if (options.successFallback?.(allNodes)) {
      if (isLikelyGoogleSearchPage(allNodes)) {
        await sleep(1200);
        continue;
      }

      const currentHost = normalizeHostname(currentUrl);
      if ((currentUrl && currentHost === 'youtube.com') || hasYoutubeHomeUiMarkers(allNodes) || hasYoutubeResultsUiMarkers(allNodes)) {
        return true;
      }
    }

    await sleep(1200);
  }

  return false;
}

async function openUrlWithAdbIntent(
  url: string,
  options: OpenUrlInFirefoxOptions = {},
): Promise<boolean> {
  if (!(agent.control && typeof agent.control.adbShell === 'function')) {
    return false;
  }

  const packageName = getFirefoxPackage();
  const escapedUrl = url.replace(/"/g, '\\"');
  const cmd = `am start -a android.intent.action.VIEW -d "${escapedUrl}" ${packageName}`;
  try {
    await agent.control.adbShell(cmd);
    await sleep(2200);
    return await waitForFirefoxUrl(url, 6, options);
  } catch (error) {
    console.log('ADB VIEW intent fallback failed', error);
    return false;
  }
}

export async function dismissOpenInYouTubeDialog(screenContent?: AndroidNode): Promise<boolean> {
  const content = screenContent ?? await agent.actions.screenContent();
  const allNodes = getAllNodes(content);

  const openInYtDialog = allNodes.find((node: any) =>
    node.viewId === 'org.mozilla.firefox:id/alertTitle' &&
    node.text === 'Open in YouTube'
  );

  if (!openInYtDialog) return false;

  const cancelButton = allNodes.find((node: any) =>
    node.viewId === 'android:id/button2' &&
    node.text === 'Cancel' &&
    node.clickable
  );

  if (cancelButton?.boundsInScreen) {
    await clickNode(cancelButton);
  } else {
    await agent.actions.goBack();
  }
  await sleep(1200);
  return true;
}

export async function openUrlInFirefox(
  url: string,
  options: OpenUrlInFirefoxOptions = {},
): Promise<boolean> {
  const attempts = [
    { preferOcr: false, preferPaste: true, label: 'node+paste' },
    { preferOcr: false, preferPaste: false, label: 'node+write' },
    { preferOcr: true, preferPaste: true, label: 'ocr+paste' },
    { preferOcr: true, preferPaste: false, label: 'ocr+write' },
  ];

  for (const [index, attempt] of attempts.entries()) {
    console.log(`Opening URL in Firefox (attempt ${index + 1}/${attempts.length}: ${attempt.label})`);
    const focused = await focusFirefoxAddressBar(attempt.preferOcr);
    if (!focused) {
      console.log('Firefox address bar did not become editable after focus attempt.');
      await sleep(500);
      continue;
    }
    await typeFirefoxUrl(url, attempt.preferPaste);
    await sleep(700);
    try {
      await submitFirefoxAddressBar();
    } catch (error) {
      console.log('Address bar submit failed on this attempt', error);
    }
    await sleep(2200);

    if (await waitForFirefoxUrl(url, 5, options)) {
      return true;
    }
  }

  console.log('All URL-entry attempts failed, trying ADB VIEW intent fallback...');
  if (await openUrlWithAdbIntent(url, options)) {
    return true;
  }

  return false;
}

export async function resolveCurrentYoutubeVideoInfo(
  screenContent?: AndroidNode,
): Promise<ResolvedYoutubeVideoInfo | null> {
  const content = screenContent ?? await agent.actions.screenContent();
  const allNodes = getAllNodes(content);
  if (!hasFirefoxNodes(allNodes)) return null;

  const resolvedUrl = await resolveCurrentYoutubeUrl(content);
  const url = resolvedUrl.url;
  const pageKind = inferYoutubePageKindFromNodes(allNodes, url);

  const webView = allNodes.find((node: any) => node.className === 'android.webkit.WebView');
  let title = extractTitleFromWebViewText(webView?.text ?? '');
  if (!title) {
    const titleNode = allNodes.find((node: any) =>
      isFirefoxPackageName(node.packageName) &&
      (
        typeof node?.text === 'string' ||
        typeof node?.description === 'string'
      ) &&
      !nodeText(node).includes('search or enter address') &&
      !nodeText(node).includes('comments') &&
      !nodeText(node).includes('share') &&
      !nodeText(node).includes('subscribe') &&
      normalizeText(node?.description || node?.text).length >= 12
    );
    title = normalizeVideoTitleFromUi(titleNode?.description ?? titleNode?.text ?? '');
  }

  const detectionMode =
    pageKind === 'watch' || pageKind === 'shorts'
      ? (resolvedUrl.detectionMode === 'none' ? 'ui_only' : resolvedUrl.detectionMode)
      : resolvedUrl.detectionMode;

  if (pageKind === 'unknown' && !url && !title) {
    return {
      title: '',
      url: '',
      isShort: false,
      isWatch: false,
      pageKind,
      detectionMode: 'none',
    };
  }

  return {
    title,
    url,
    isShort: pageKind === 'shorts',
    isWatch: pageKind === 'watch',
    pageKind,
    detectionMode,
  };
}

function normalizeVideoTitleFromUi(raw: string): string {
  return (raw || '').replace(/\s+/g, ' ').replace(/ - YouTube$/i, '').trim();
}

export async function waitForYoutubeVideoPage(maxChecks: number = 12): Promise<boolean> {
  for (let i = 0; i < maxChecks; i++) {
    const content = await agent.actions.screenContent();
    if (await dismissOpenInYouTubeDialog(content)) {
      continue;
    }

    const info = await resolveCurrentYoutubeVideoInfo(content);
    if (info?.isWatch || info?.isShort) {
      return true;
    }
    await sleep(1500);
  }
  return false;
}

export function isYoutubeVideoPage(allNodes: any[]): boolean {
  if (!allNodes.some((node: any) => isFirefoxPackageName(node.packageName))) return false;
  const url = getCurrentYoutubeUrlFromNodes(allNodes);
  return isYoutubeWatchUrl(url) || isYoutubeShortUrl(url) || hasYoutubeWatchUiMarkers(allNodes);
}

export function extractCurrentVideoInfoFromNodes(allNodes: any[]): CurrentVideoInfo | null {
  const url = getCurrentYoutubeUrlFromNodes(allNodes);
  const pageKind = inferYoutubePageKindFromNodes(allNodes, url);
  if (pageKind !== 'watch' && pageKind !== 'shorts') return null;

  const webView = allNodes.find((node: any) => node.className === 'android.webkit.WebView');
  let title = extractTitleFromWebViewText(webView?.text ?? '');
  if (!title) {
    const titleNode = allNodes.find((node: any) =>
      node.className === 'android.view.View' &&
      node.description &&
      node.description.length > 5 &&
      isFirefoxPackageName(node.packageName)
    );
    title = (titleNode?.description ?? '').trim();
  }

  return {
    title,
    url,
    isShort: pageKind === 'shorts',
    isWatch: pageKind === 'watch',
  };
}

export async function getCurrentVideoInfo(screenContent?: AndroidNode): Promise<CurrentVideoInfo | null> {
  const info = await resolveCurrentYoutubeVideoInfo(screenContent);
  if (!info?.isWatch && !info?.isShort) {
    return null;
  }

  return {
    title: info.title,
    url: info.url,
    isShort: info.isShort,
    isWatch: info.isWatch,
  };
}
