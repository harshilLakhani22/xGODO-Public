/**
 * Search Stage - Type the keyword into the YouTube search bar
 *
 * Flow:
 * 1. YouTubeHome          → "Search YouTube" button visible → click it
 * 2. YouTubeSearchFocused → search input focused → type keyword and submit
 * 3. YouTubeSearchResults → results page visible → success
 *
 * OCR fallback used when "Search YouTube" button is not found via nodes.
 */

import { DEFAULT_MAX_STEPS_PER_STAGE } from './config';
import { addData } from './data';
import { Stage, type ScreenHandles, setStage } from './Stage';
import { getAllNodes, clickNode, performOCR, tapOcrText, getDeviceScreen } from './util';
import { getResolvedInputs } from './inputs';
import { isFirefoxPackageName } from './browser';
import {
  buildYoutubeSearchResultsUrl,
  getCurrentYoutubeUrlFromNodes,
  isYoutubeHomeLikePage,
  isYoutubeSearchResultsPage,
  openUrlInFirefox,
} from './youtube';

// --- Helpers ---

function getKeyword(): string {
  return getResolvedInputs().keyword;
}

function isVideosLabel(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === 'videos' || normalized === 'video';
}

function findVideosFilterNode(allNodes: any[]): any | undefined {
  const direct = allNodes.find((node: any) =>
    isFirefoxPackageName(node.packageName) &&
    node.clickable &&
    node.boundsInScreen?.top < 700 &&
    (isVideosLabel(node.text) || isVideosLabel(node.description))
  );
  if (direct) return direct;

  const labelNode = allNodes.find((node: any) =>
    isFirefoxPackageName(node.packageName) &&
    node.boundsInScreen?.top < 700 &&
    (isVideosLabel(node.text) || isVideosLabel(node.description))
  );
  if (!labelNode?.boundsInScreen) return undefined;

  const labelBounds = labelNode.boundsInScreen;
  return allNodes.find((node: any) =>
    isFirefoxPackageName(node.packageName) &&
    node.clickable &&
    node.boundsInScreen?.top < 700 &&
    node.boundsInScreen.left <= labelBounds.left &&
    node.boundsInScreen.right >= labelBounds.right &&
    node.boundsInScreen.top <= labelBounds.top &&
    node.boundsInScreen.bottom >= labelBounds.bottom
  );
}

function normalizeText(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function normalizeKeyword(raw: string): string {
  return (raw || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function nodeText(node: any): string {
  return [node?.text, node?.description, node?.hintText]
    .map(normalizeText)
    .filter(Boolean)
    .join(' ');
}

function isSearchLabel(raw: unknown): boolean {
  const normalized = normalizeText(raw);
  return normalized === 'search' || normalized === 'search youtube';
}

function isSearchInputNode(node: any): boolean {
  return isFirefoxPackageName(node?.packageName) &&
    node?.className === 'android.widget.EditText' &&
    (
      nodeText(node).includes('search youtube') ||
      isSearchLabel(node?.text) ||
      isSearchLabel(node?.hintText) ||
      isSearchLabel(node?.description)
    );
}

function isActiveSearchInputNode(node: any): boolean {
  if (!isFirefoxPackageName(node?.packageName)) return false;
  if (!node?.boundsInScreen) return false;
  if ((node.boundsInScreen.top ?? Number.MAX_SAFE_INTEGER) > 360) return false;
  
  const textPool = nodeText(node);
  if (textPool.includes('search or enter address')) return false;
  if (textPool.includes('youtube.com') || textPool.includes('http')) return false;
  
  const viewId = typeof node?.viewId === 'string' ? node.viewId.toLowerCase() : '';
  if (
    viewId.includes('mozac_browser_toolbar') ||
    viewId.includes('toolbar_wrapper') ||
    viewId.includes('addressbar') ||
    viewId.includes('edit_url') ||
    viewId.includes('url_view')
  ) {
    return false;
  }
  
  return !!node?.isEditable || node?.className === 'android.widget.EditText' || !!node?.isFocused;
}

function findSearchInput(allNodes: any[]): any | undefined {
  return allNodes.find((node: any) => isSearchInputNode(node)) ||
    allNodes.find((node: any) => isActiveSearchInputNode(node));
}

function findSearchActionButton(allNodes: any[]): any | undefined {
  const candidates = allNodes.filter((node: any) =>
    isFirefoxPackageName(node.packageName) &&
    node.clickable &&
    (
      node.className === 'android.widget.ImageButton' ||
      node.className === 'android.widget.Button' ||
      node.className === 'android.view.View'
    ) &&
    (normalizeText(node?.text) === 'search' || normalizeText(node?.description) === 'search')
  );
  return candidates[0];
}

function findSuggestionNode(allNodes: any[], keyword: string, searchInput?: any): any | undefined {
  const target = normalizeKeyword(keyword);
  if (!target) return undefined;

  const targetWords = target.split(' ').filter(Boolean).slice(0, 3).join(' '); // Use first 3 words for fuzzy match

  const inputBottom = searchInput?.boundsInScreen?.bottom ?? 0;
  const { height } = getDeviceScreen();
  const maxBottom = Math.floor(height * 0.78);

  const matchingTextNode = allNodes.find((node: any) => {
    if (!node?.boundsInScreen) return false;
    if ((node.boundsInScreen.top ?? 0) <= inputBottom) return false;
    if ((node.boundsInScreen.bottom ?? 0) >= maxBottom) return false;

    const text = normalizeKeyword(node?.text || node?.description || '');
    if (!text) return false;
    
    // Check exact, startsWith, or if it matches the first few words and is a viable suggestion
    if (text === target || text.startsWith(target) || target.startsWith(text)) {
      return true;
    }
    
    if (targetWords.length > 3 && text.includes(targetWords)) {
      return true;
    }
    
    return false;
  });

  if (!matchingTextNode) return undefined;
  if (matchingTextNode.clickable) return matchingTextNode;
  return findClickableContainerForNode(allNodes, matchingTextNode) || matchingTextNode;
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

function findSearchButton(allNodes: any[]): any | undefined {
  return allNodes.find((node: any) =>
    isFirefoxPackageName(node.packageName) &&
    node.className === 'android.widget.Button' &&
    normalizeText(node?.text) === 'search youtube'
  );
}

function findMobileHeaderSearchNode(allNodes: any[]): any | undefined {
  const direct = allNodes
    .filter((node: any) =>
      isFirefoxPackageName(node.packageName) &&
      node.clickable &&
      (node.boundsInScreen?.top ?? Number.MAX_SAFE_INTEGER) < 450 &&
      !nodeText(node).includes('search or enter address') &&
      (
        isSearchLabel(node?.text) ||
        isSearchLabel(node?.description) ||
        isSearchLabel(node?.hintText)
      )
    )
    .sort((left: any, right: any) => (left.boundsInScreen?.top ?? 0) - (right.boundsInScreen?.top ?? 0));
  if (direct[0]) return direct[0];

  const labelNode = allNodes.find((node: any) =>
    isFirefoxPackageName(node.packageName) &&
    (node.boundsInScreen?.top ?? Number.MAX_SAFE_INTEGER) < 450 &&
    !nodeText(node).includes('search or enter address') &&
    (
      isSearchLabel(node?.text) ||
      isSearchLabel(node?.description) ||
      isSearchLabel(node?.hintText)
    )
  );

  return labelNode ? findClickableContainerForNode(allNodes, labelNode) : undefined;
}

async function waitForSearchInput(maxChecks: number = 3): Promise<boolean> {
  for (let i = 0; i < maxChecks; i++) {
    const content = await agent.actions.screenContent();
    if (findSearchInput(getAllNodes(content))) {
      return true;
    }
    await sleep(500);
  }

  return false;
}

async function waitForSearchResults(maxChecks: number = 4): Promise<boolean> {
  for (let i = 0; i < maxChecks; i++) {
    const content = await agent.actions.screenContent();
    if (isYoutubeSearchResultsPage(getAllNodes(content))) {
      return true;
    }
    await sleep(1200);
  }
  return false;
}

async function tapSearchIconNearInput(searchInput?: any): Promise<boolean> {
  if (!searchInput?.boundsInScreen) return false;
  const bounds = searchInput.boundsInScreen;
  const width = Math.max(0, (bounds.right ?? 0) - (bounds.left ?? 0));
  const height = Math.max(0, (bounds.bottom ?? 0) - (bounds.top ?? 0));
  if (width <= 0 || height <= 0) return false;

  const left = bounds.left + Math.floor(width * 0.82);
  const right = bounds.right - Math.max(6, Math.floor(width * 0.05));
  const top = bounds.top + Math.floor(height * 0.15);
  const bottom = bounds.bottom - Math.floor(height * 0.15);
  await agent.utils.randomClick(left, top, right, bottom);
  return true;
}

async function tapSuggestionOcr(
  lines: { text: string; boundingBox?: { left: number; top: number; right: number; bottom: number } }[],
  keyword: string,
  minTop: number,
): Promise<boolean> {
  const target = normalizeKeyword(keyword);
  if (!target) return false;

  const { height } = getDeviceScreen();
  const maxBottom = Math.floor(height * 0.78);

  const match = lines.find(line => {
    if (!line.boundingBox) return false;
    if (line.boundingBox.top <= minTop + 6) return false;
    if (line.boundingBox.bottom >= maxBottom) return false;
    const text = normalizeKeyword(line.text);
    return text === target || text.startsWith(target) || target.startsWith(text);
  });
  if (!match?.boundingBox) return false;

  const { left, top, right, bottom } = match.boundingBox;
  await agent.utils.randomClick(left, top, right, bottom);
  return true;
}

async function attemptSearchSubmit(keyword: string, searchInput?: any): Promise<string | null> {
  const content = await agent.actions.screenContent();
  const nodes = getAllNodes(content);

  // 1. Try to click the blue exact match text or first suggestion
  const suggestionNode = findSuggestionNode(nodes, keyword, searchInput);
  if (suggestionNode?.boundsInScreen) {
    if (Array.isArray(suggestionNode.actions) && suggestionNode.actions.includes(agent.constants.ACTION_CLICK)) {
      await agent.actions.nodeAction(suggestionNode, agent.constants.ACTION_CLICK);
    } else {
      await clickNode(suggestionNode);
    }
    if (await waitForSearchResults(4)) return 'suggestion_node';
  }

  // 2. Try the search action button (on soft keyboard or UI)
  const searchBtn = findSearchActionButton(nodes);
  if (searchBtn?.boundsInScreen) {
    await clickNode(searchBtn);
    if (await waitForSearchResults(4)) return 'search_icon_node';
  }

  // 3. Coordinate tap on the magnifying glass
  if (await tapSearchIconNearInput(searchInput)) {
    if (await waitForSearchResults(4)) return 'search_icon_bounds';
  }

  // 4. Fallback OCR
  const ocr = await performOCR();
  if (ocr) {
    if (await tapSuggestionOcr(ocr.lines, keyword, searchInput?.boundsInScreen?.top ?? 0)) {
      if (await waitForSearchResults(4)) return 'suggestion_ocr';
    }
    if (await tapOcrText(ocr.lines, t => t.trim() === 'search' || t.trim() === keyword.trim())) {
      if (await waitForSearchResults(4)) return 'search_text_ocr';
    }
  }

  // 5. Try ADB enter key (84 = SEARCH, 66 = ENTER)
  console.log('UI submit failed, using ADB keyevents...');
  try {
    if (agent.control && agent.control.adbShell) {
      await agent.control.adbShell('input keyevent 66');
      await sleep(1000);
      if (await waitForSearchResults(3)) return 'adb_enter';
      
      await agent.control.adbShell('input keyevent 84');
      await sleep(1000);
      if (await waitForSearchResults(3)) return 'adb_search';
    }
  } catch (e) {
    console.warn('ADB shell input failed', e);
  }

  // 6. Direct URL navigation fallback immediately if not resolved
  console.log('Direct URL fallback inside attemptSearchSubmit...');
  if (await openDirectSearchResults(keyword, 'attemptSearchSubmit_failed')) {
    return 'direct_url';
  }

  return null;
}

async function tapSearchOcr(lines: { text: string; boundingBox?: { left: number; top: number; right: number; bottom: number } }[]): Promise<boolean> {
  const match = lines.find(line =>
    !!line.boundingBox &&
    line.boundingBox.top < 450 &&
    isSearchLabel(line.text)
  );
  if (!match?.boundingBox) return false;

  const { left, top, right, bottom } = match.boundingBox;
  await agent.utils.randomClick(left, top, right, bottom);
  return true;
}

async function openDirectSearchResults(keyword: string, reason: string): Promise<boolean> {
  const resultsUrl = buildYoutubeSearchResultsUrl(keyword);
  const navigated = await openUrlInFirefox(resultsUrl, {
    successFallback: isYoutubeSearchResultsPage,
  });
  addData({
    lastSearchUiReason: reason,
    searchEntryMode: 'direct_results_url',
    action: navigated ? 'Opened search results via direct URL' : 'Failed to open search results via direct URL',
    keyword,
  });
  return navigated;
}

// --- Screen definitions ---

const SearchStageScreen = {
  YouTubeHome: 'YouTubeHome',
  YouTubeSearchFocused: 'YouTubeSearchFocused',
  YouTubeSearchSuggestions: 'YouTubeSearchSuggestions',
  YouTubeSearchResults: 'YouTubeSearchResults',
} as const;

// --- Screen handlers ---

const SearchHandles = {
  /**
   * YouTube home loaded — "Search YouTube" button is present, click it
   */
  YouTubeHome: {
    detectScreen: async (screenContent) => {
      const allNodes = getAllNodes(screenContent);
      const inFirefox = allNodes.some((n: any) => isFirefoxPackageName(n.packageName));
      if (!inFirefox) return false;

      if (isYoutubeSearchResultsPage(allNodes)) return false;
      if (!isYoutubeHomeLikePage(allNodes)) return false;

      const isSearchFocused = !!findSearchInput(allNodes);
      const hasResults = allNodes.some((n: any) =>
        n.text?.toLowerCase()?.includes('search results') ||
        n.description?.toLowerCase()?.includes('search results') ||
        n.text?.toLowerCase()?.includes('filters') ||
        n.description?.toLowerCase()?.includes('filters')
      );

      return !isSearchFocused && !hasResults;
    },
    handleScreen: async (screenContent) => {
      const keyword = getKeyword();
      console.log(`YouTube home detected, clicking search bar (keyword: "${keyword}")`);

      const allNodes = getAllNodes(screenContent);
      let fallbackReason = 'No supported YouTube search control was found';

      // Primary: "Search YouTube" button — known from real device node tree
      const searchBtn = findSearchButton(allNodes);
      if (searchBtn && searchBtn.boundsInScreen) {
        console.log('Clicking "Search YouTube" button...');
        await clickNode(searchBtn);
        if (await waitForSearchInput()) {
          addData({
            action: 'Clicked Search YouTube button',
            searchEntryMode: 'youtube_button',
            keyword,
          });
          return true;
        }
        fallbackReason = 'Search YouTube button did not open the search input';
      }

      const searchIcon = findMobileHeaderSearchNode(allNodes);
      if (searchIcon?.boundsInScreen) {
        console.log('Clicking YouTube header search control...');
        if (Array.isArray(searchIcon.actions) && searchIcon.actions.includes(agent.constants.ACTION_CLICK)) {
          await agent.actions.nodeAction(searchIcon, agent.constants.ACTION_CLICK);
        } else {
          await clickNode(searchIcon);
        }
        if (await waitForSearchInput()) {
          addData({
            action: 'Clicked YouTube search icon',
            searchEntryMode: 'youtube_icon',
            keyword,
          });
          return true;
        }
        fallbackReason = 'YouTube search icon did not open the search input';
      }

      console.log('YouTube search controls not actionable via nodes, trying OCR fallback...');
      const ocr = await performOCR();
      if (ocr) {
        console.log(`OCR (${ocr.text.length} chars): ${ocr.text.substring(0, 200)}`);
        if (await tapSearchOcr(ocr.lines)) {
          if (await waitForSearchInput()) {
            addData({
              action: 'Clicked YouTube search via OCR',
              searchEntryMode: 'ocr',
              keyword,
            });
            return true;
          }
          fallbackReason = 'OCR search tap did not open the search input';
        }
      }

      console.log(`Falling back to direct YouTube results URL: ${fallbackReason}`);
      return openDirectSearchResults(keyword, fallbackReason);
    },
  },

  /**
   * YouTube search input is active — EditText with hintText "Search YouTube" is focused
   */
  YouTubeSearchFocused: {
    detectScreen: async (screenContent) => {
      const allNodes = getAllNodes(screenContent);
      const inFirefox = allNodes.some((n: any) => isFirefoxPackageName(n.packageName));
      if (!inFirefox) return false;
      if (isYoutubeSearchResultsPage(allNodes)) return false;
      const url = getCurrentYoutubeUrlFromNodes(allNodes);
      if (url.includes('youtube.com/results') && !url.includes('search_query=')) return false;

      return !!findSearchInput(allNodes);
    },
    handleScreen: async (screenContent) => {
      const keyword = getKeyword();
      console.log(`Search input active, typing keyword: "${keyword}"`);

      const allNodes = getAllNodes(screenContent);

      const searchInput = findSearchInput(allNodes);
      if (searchInput) {
        await agent.actions.nodeAction(searchInput, agent.constants.ACTION_CLICK);
        await sleep(500);
      }

      // Paste keyword
      await agent.actions.copyText(keyword);
      await agent.actions.paste();
      await sleep(1500);

      const submitMode = await attemptSearchSubmit(keyword, searchInput);
      if (!submitMode) {
        console.log('Search submit failed totally, trying direct URL again...');
        await openDirectSearchResults(keyword, 'submit_did_not_open_results');
      }

      addData({ action: 'Searched keyword', keyword, searchSubmitMode: submitMode ?? 'enter_key' });
      return true;
    },
  },

  /**
   * Search suggestions/overlay active (results URL without query)
   */
  YouTubeSearchSuggestions: {
    detectScreen: async (screenContent) => {
      const allNodes = getAllNodes(screenContent);
      const inFirefox = allNodes.some((n: any) => isFirefoxPackageName(n.packageName));
      if (!inFirefox) return false;
      if (isYoutubeSearchResultsPage(allNodes)) return false;

      const url = getCurrentYoutubeUrlFromNodes(allNodes);
      const looksLikeResultsShell = url.includes('youtube.com/results') && !url.includes('search_query=');
      if (!looksLikeResultsShell) return false;

      return !!findSearchInput(allNodes);
    },
    handleScreen: async (screenContent) => {
      const keyword = getKeyword();
      console.log('Search suggestions detected, submitting search...');

      const allNodes = getAllNodes(screenContent);
      const searchInput = findSearchInput(allNodes);
      if (searchInput) {
        await agent.actions.nodeAction(searchInput, agent.constants.ACTION_CLICK);
        await sleep(400);
      }

      await agent.actions.copyText(keyword);
      await agent.actions.paste();
      await sleep(1500);

      const submitMode = await attemptSearchSubmit(keyword, searchInput);
      if (!submitMode) {
        console.log('Search submit failed totally, trying direct URL again...');
        await openDirectSearchResults(keyword, 'suggestions_submit_did_not_open_results');
      }

      addData({ action: 'Submitted search from suggestions', keyword, searchSubmitMode: submitMode ?? 'enter_key' });
      return true;
    },
  },

  /**
   * YouTube search results page is visible
   */
  YouTubeSearchResults: {
    detectScreen: async (screenContent) => {
      const allNodes = getAllNodes(screenContent);
      const inFirefox = allNodes.some((n: any) => isFirefoxPackageName(n.packageName));
      if (!inFirefox) return false;
      if (isYoutubeSearchResultsPage(allNodes)) return true;

      const hasResultsNodes = allNodes.some((n: any) =>
        n.text?.toLowerCase()?.includes('search results') ||
        n.description?.toLowerCase()?.includes('search results') ||
        n.text?.toLowerCase()?.includes('filters') ||
        n.description?.toLowerCase()?.includes('filters')
      );
      if (hasResultsNodes) return true;

      // OCR fallback for results detection
      const ocr = await performOCR();
      if (ocr) {
        const t = ocr.text.toLowerCase();
        return t.includes('filter') || t.includes('search results');
      }

      return false;
    },
    handleScreen: async (screenContent) => {
      const keyword = getKeyword();
      const allNodes = getAllNodes(screenContent);
      const videosFilter = findVideosFilterNode(allNodes);

      if (videosFilter && !videosFilter.isSelected) {
        console.log('Applying "Videos" filter to avoid Shorts...');
        if (Array.isArray(videosFilter.actions) && videosFilter.actions.includes(agent.constants.ACTION_CLICK)) {
          await agent.actions.nodeAction(videosFilter, agent.constants.ACTION_CLICK);
        } else {
          await clickNode(videosFilter);
        }
        await sleep(2200);
        addData({ action: 'Applied Videos filter' });
      } else if (!videosFilter) {
        const ocr = await performOCR();
        if (ocr && await tapOcrText(ocr.lines, t => t.trim() === 'videos')) {
          console.log('Applied "Videos" filter via OCR.');
          await sleep(2200);
          addData({ action: 'Applied Videos filter (OCR)' });
        }
      }

      console.log('YouTube search results loaded, transitioning to Collect stage...');
      addData({ action: 'Search results loaded', keyword });
      await setStage(Stage.Collect);
      return true;
    },
  },
} as const satisfies ScreenHandles<keyof typeof SearchStageScreen>;

// --- Stage definition ---

const SearchStage = {
  name: 'Search',
  maxSteps: DEFAULT_MAX_STEPS_PER_STAGE,
  screens: SearchStageScreen,
  screenHandles: SearchHandles,
  defaultHandle: async () => {
    console.log('Search stage default: waiting for YouTube to settle...');
    await sleep(2000);
  },
} as const satisfies Stage<typeof SearchStageScreen>;

export default SearchStage;
