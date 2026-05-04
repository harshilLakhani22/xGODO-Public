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

import { FIREFOX_PACKAGE, DEFAULT_MAX_STEPS_PER_STAGE } from './config';
import { addData } from './data';
import { Stage, type ScreenHandles, setStage } from './Stage';
import { getAllNodes, clickNode, performOCR, tapOcrText } from './util';

// --- Helpers ---

function getKeyword(): string {
  return agent.arguments.jobVariables.keyword;
}

/** Find the YouTube search button by its known text and class */
function findSearchButton(allNodes: any[]): any | undefined {
  return allNodes.find((n: any) =>
    n.text === 'Search YouTube' &&
    n.className === 'android.widget.Button' &&
    n.packageName === FIREFOX_PACKAGE
  );
}

/** True when YouTube page is loaded (Search YouTube button present) */
function isYouTubeLoaded(allNodes: any[]): boolean {
  return !!findSearchButton(allNodes);
}

// --- Screen definitions ---

const SearchStageScreen = {
  YouTubeHome: 'YouTubeHome',
  YouTubeSearchFocused: 'YouTubeSearchFocused',
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
      const inFirefox = allNodes.some((n: any) => n.packageName === FIREFOX_PACKAGE);
      if (!inFirefox) return false;

      if (!isYouTubeLoaded(allNodes)) return false;

      // Search dialog is already open
      const isSearchFocused = allNodes.some((n: any) =>
        n.className === 'android.widget.EditText' &&
        n.hintText === 'Search YouTube'
      );
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

      // Primary: "Search YouTube" button — known from real device node tree
      const searchBtn = findSearchButton(allNodes);
      if (searchBtn && searchBtn.boundsInScreen) {
        console.log('Clicking "Search YouTube" button...');
        await clickNode(searchBtn);
        await sleep(1500);
        addData({ action: 'Clicked Search YouTube button' });
        return true;
      }

      // OCR fallback
      console.log('Search button not found via nodes, trying OCR fallback...');
      const ocr = await performOCR();
      if (ocr) {
        console.log(`OCR (${ocr.text.length} chars): ${ocr.text.substring(0, 200)}`);
        if (await tapOcrText(ocr.lines, t => t.includes('search youtube') || t === 'search')) {
          await sleep(1500);
          addData({ action: 'Clicked search bar via OCR' });
          return true;
        }
      }

      // Last resort: use OCR bounding box center of the WebView area
      console.log('OCR fallback failed, cannot locate search bar');
      return false;
    },
  },

  /**
   * YouTube search input is active — EditText with hintText "Search YouTube" is focused
   */
  YouTubeSearchFocused: {
    detectScreen: async (screenContent) => {
      const allNodes = getAllNodes(screenContent);
      const inFirefox = allNodes.some((n: any) => n.packageName === FIREFOX_PACKAGE);
      if (!inFirefox) return false;

      return allNodes.some((n: any) =>
        n.className === 'android.widget.EditText' &&
        n.hintText === 'Search YouTube'
      );
    },
    handleScreen: async (screenContent) => {
      const keyword = getKeyword();
      console.log(`Search input active, typing keyword: "${keyword}"`);

      const allNodes = getAllNodes(screenContent);

      // Ensure the search input is focused
      const searchInput = allNodes.find((n: any) =>
        n.className === 'android.widget.EditText' &&
        n.hintText === 'Search YouTube'
      );
      if (searchInput) {
        await agent.actions.nodeAction(searchInput, agent.constants.ACTION_CLICK);
        await sleep(500);
      }

      // Paste keyword (copy to clipboard then paste — works reliably in web inputs)
      await agent.actions.copyText(keyword);
      await agent.actions.paste();
      await sleep(1500);

      // Refresh screen content after pasting — node references may be stale
      const freshContent = await agent.actions.screenContent();
      const freshNodes = getAllNodes(freshContent);

      // Submit: find Search button from fresh nodes and click via accessibility action
      const searchBtn = freshNodes.find((n: any) =>
        n.className === 'android.widget.Button' &&
        n.text === 'Search' &&
        n.hintText === 'Search YouTube'
      );
      if (searchBtn) {
        console.log('Submitting via ACTION_CLICK on Search button...');
        await agent.actions.nodeAction(searchBtn, agent.constants.ACTION_CLICK);
      } else {
        // Fallback: Enter key
        console.log('Search button not found in fresh nodes, pressing Enter...');
        await agent.actions.inputKey(66);
      }
      await sleep(3000);

      addData({ action: 'Searched keyword', keyword });
      return true;
    },
  },

  /**
   * YouTube search results page is visible
   */
  YouTubeSearchResults: {
    detectScreen: async (screenContent) => {
      const allNodes = getAllNodes(screenContent);
      const inFirefox = allNodes.some((n: any) => n.packageName === FIREFOX_PACKAGE);
      if (!inFirefox) return false;

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
    handleScreen: async () => {
      const keyword = getKeyword();
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
