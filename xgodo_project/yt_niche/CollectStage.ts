/**
 * Collect Stage - Click each of the first 4 search result videos,
 * collect the title and URL via Firefox Share → "Copy to clipboard"
 *
 * Flow (repeated 4 times):
 * 1. SearchResults → find video cards, click the next one
 * 2. VideoPage     → read title from description node, click "Share this video"
 * 3. ShareSheet    → click "Copy to clipboard" → read URL from clipboard → go back
 * 4. After 4 videos collected → success
 */

import { FIREFOX_PACKAGE, DEFAULT_MAX_STEPS_PER_STAGE } from './config';
import { addData } from './data';
import { Stage, type ScreenHandles, setStage } from './Stage';
import { getAllNodes } from './util';

const VIDEOS_TO_COLLECT = 4;

interface VideoData {
  title: string;
  url: string;
}

// In-memory storage — persists across screen handlers within a single run
const collectedVideos: VideoData[] = [];
let pendingTitle = '';

// --- Screen definitions ---

const CollectStageScreen = {
  SearchResults: 'SearchResults',
  ShortsPlayer: 'ShortsPlayer',
  VideoPage: 'VideoPage',
  ShareSheet: 'ShareSheet',
} as const;

// --- Screen handlers ---

const CollectHandles = {
  /**
   * YouTube search results — detect video cards and click the next one
   */
  SearchResults: {
    detectScreen: async (screenContent) => {
      const allNodes = getAllNodes(screenContent);
      const inFirefox = allNodes.some((n: any) => n.packageName === FIREFOX_PACKAGE);
      if (!inFirefox) return false;

      // Not on video page (which has "Share this video" button)
      const onVideoPage = allNodes.some((n: any) =>
        n.text === 'Share this video' && n.className === 'android.widget.Button'
      );
      if (onVideoPage) return false;

      // Not on share sheet
      const onShareSheet = allNodes.some((n: any) =>
        n.viewId === 'org.mozilla.firefox:id/shareWrapper'
      );
      if (onShareSheet) return false;

      // Search results: has "filter" or "search results" text
      return allNodes.some((n: any) =>
        n.text?.toLowerCase()?.includes('filter') ||
        n.description?.toLowerCase()?.includes('filter') ||
        n.text?.toLowerCase()?.includes('search results') ||
        n.description?.toLowerCase()?.includes('search results')
      );
    },
    handleScreen: async (screenContent) => {
      const videoIndex = collectedVideos.length;
      console.log(`Search results: collecting video ${videoIndex + 1}/${VIDEOS_TO_COLLECT}`);

      const allNodes = getAllNodes(screenContent);

      // Video cards: View nodes that are both clickable and scrollable with a non-empty description
      // The description IS the video title as exposed by the YouTube WebView accessibility tree
      const videoCards = allNodes.filter((n: any) =>
        n.className === 'android.view.View' &&
        n.clickable &&
        n.isScrollable &&
        n.description &&
        n.description.length > 5 &&
        n.packageName === FIREFOX_PACKAGE
      );

      console.log(`Found ${videoCards.length} video cards`);

      if (videoCards.length === 0) {
        console.log('No video cards found, scrolling to load more...');
        const webView = allNodes.find((n: any) => n.className === 'android.webkit.WebView');
        if (webView) {
          await agent.actions.nodeAction(webView, 4096); // ACTION_SCROLL_FORWARD
          await sleep(1500);
        }
        return false;
      }

      // Skip cards whose title matches something already collected.
      // card.description includes the full title + metadata, so a substring match works.
      const collectedTitles = collectedVideos.map(v => v.title).filter(Boolean);
      const targetCard = videoCards.find(card =>
        !collectedTitles.some(title => card.description?.includes(title))
      ) ?? videoCards[0];

      console.log(`Clicking video ${videoIndex + 1}: "${targetCard.description}"`);
      await agent.actions.nodeAction(targetCard, agent.constants.ACTION_CLICK);
      await sleep(3000);
      return true;
    },
  },

  /**
   * YouTube Shorts player — video opened in the Shorts carousel instead of a
   * standard video page.  The "Share this video" button is marked
   * isImportantForAccessibility=false in this UI, so we skip the share-sheet
   * flow and instead read the title + URL directly from the accessibility tree:
   *   • Title  → android.webkit.WebView.text  (page title, strip " - YouTube")
   *   • URL    → ADDRESSBAR_URL_BOX.description (e.g. "m.youtube.com/shorts/ID …")
   */
  ShortsPlayer: {
    detectScreen: async (screenContent) => {
      const allNodes = getAllNodes(screenContent);
      const inFirefox = allNodes.some((n: any) => n.packageName === FIREFOX_PACKAGE);
      if (!inFirefox) return false;

      // Don't match the share sheet
      const onShareSheet = allNodes.some((n: any) =>
        n.viewId === 'org.mozilla.firefox:id/shareWrapper'
      );
      if (onShareSheet) return false;

      // Shorts player: Firefox address bar contains a /shorts/ URL
      const urlBox = allNodes.find((n: any) => n.viewId === 'ADDRESSBAR_URL_BOX');
      return (urlBox?.description ?? '').includes('youtube.com/shorts/');
    },
    handleScreen: async (screenContent) => {
      const allNodes = getAllNodes(screenContent);

      // Extract video ID / URL from the Firefox address bar
      const urlBox = allNodes.find((n: any) => n.viewId === 'ADDRESSBAR_URL_BOX');
      const urlDesc: string = urlBox?.description ?? '';
      const urlMatch = urlDesc.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/);
      if (!urlMatch) {
        console.log('ShortsPlayer: could not extract URL from address bar');
        return false;
      }
      const url = `https://youtube.com/shorts/${urlMatch[1]}`;

      // Extract title from WebView page title ("Video Title - YouTube" → "Video Title")
      const webView = allNodes.find((n: any) => n.className === 'android.webkit.WebView');
      const title = (webView?.text ?? '').replace(/ - YouTube$/, '').trim();

      console.log(`Shorts player: title="${title}", url="${url}"`);

      collectedVideos.push({ title, url });
      console.log(`Collected ${collectedVideos.length}/${VIDEOS_TO_COLLECT} videos`);
      addData({ collectedVideos: [...collectedVideos] });

      if (collectedVideos.length >= VIDEOS_TO_COLLECT) {
        console.log('All videos collected, transitioning to Gemini stage...');
        await agent.actions.goBack();
        await sleep(2000);
        await setStage(Stage.Gemini);
        return true;
      }

      // Go back to search results and scroll down so the next card is first
      await agent.actions.goBack();
      await sleep(2000);
      const freshContent = await agent.actions.screenContent();
      const freshNodes = getAllNodes(freshContent);
      const resultsWebView = freshNodes.find((n: any) => n.className === 'android.webkit.WebView');
      if (resultsWebView) {
        console.log('Scrolling search results to advance past collected video...');
        await agent.actions.nodeAction(resultsWebView, 4096); // ACTION_SCROLL_FORWARD
        await sleep(1500);
      }

      return true;
    },
  },

  /**
   * YouTube video page — read title, then click "Share this video"
   */
  VideoPage: {
    detectScreen: async (screenContent) => {
      const allNodes = getAllNodes(screenContent);
      const inFirefox = allNodes.some((n: any) => n.packageName === FIREFOX_PACKAGE);
      if (!inFirefox) return false;

      // Don't match the share sheet
      const onShareSheet = allNodes.some((n: any) =>
        n.viewId === 'org.mozilla.firefox:id/shareWrapper'
      );
      if (onShareSheet) return false;

      // Not a Shorts page
      const urlBox = allNodes.find((n: any) => n.viewId === 'ADDRESSBAR_URL_BOX');
      const urlDesc = urlBox?.description ?? '';
      if (urlDesc.includes('youtube.com/shorts/')) return false;

      // Match: "Share this video" button (standard video page)
      const hasShareThisVideo = allNodes.some((n: any) =>
        n.text === 'Share this video' &&
        n.className === 'android.widget.Button'
      );
      if (hasShareThisVideo) return true;

      // Also match: regular video page with just "Share" button + watch URL
      const hasShareBtn = allNodes.some((n: any) =>
        n.text === 'Share' &&
        n.className === 'android.widget.Button' &&
        n.clickable
      );
      return hasShareBtn && urlDesc.includes('youtube.com/watch');
    },
    handleScreen: async (screenContent) => {
      const allNodes = getAllNodes(screenContent);

      // Title: View node that is scrollable and has a non-empty description
      // The YouTube WebView exposes the video title as the accessibility description
      const titleNode = allNodes.find((n: any) =>
        n.className === 'android.view.View' &&
        n.isScrollable &&
        n.description &&
        n.description.length > 5 &&
        n.packageName === FIREFOX_PACKAGE
      );
      pendingTitle = titleNode?.description || '';

      // Fall back to WebView page title if no description node found
      if (!pendingTitle) {
        const webView = allNodes.find((n: any) => n.className === 'android.webkit.WebView');
        pendingTitle = (webView?.text ?? '').replace(/ - YouTube$/, '').trim();
      }
      console.log(`Video title: "${pendingTitle}"`);

      // Try "Share this video" first; fall back to "Share" (movie/special video pages)
      const shareBtn = allNodes.find((n: any) =>
        (n.text === 'Share this video' || n.text === 'Share') &&
        n.className === 'android.widget.Button' &&
        n.clickable
      );
      if (!shareBtn) {
        console.log('Share button not found');
        return false;
      }

      console.log(`Clicking "${shareBtn.text}"...`);
      await agent.actions.nodeAction(shareBtn, agent.constants.ACTION_CLICK);
      await sleep(2000);
      return true;
    },
  },

  /**
   * Firefox share sheet — click "Copy to clipboard", read URL, go back
   */
  ShareSheet: {
    detectScreen: async (screenContent) => {
      const allNodes = getAllNodes(screenContent);
      return allNodes.some((n: any) =>
        n.viewId === 'org.mozilla.firefox:id/shareWrapper'
      );
    },
    handleScreen: async (screenContent) => {
      const allNodes = getAllNodes(screenContent);

      // The "Copy to clipboard" entry: find the appName label, then click its clickable ViewGroup parent
      const copyLabel = allNodes.find((n: any) =>
        n.viewId === 'org.mozilla.firefox:id/appName' &&
        n.text === 'Copy to clipboard'
      );
      if (!copyLabel) {
        console.log('"Copy to clipboard" label not found in share sheet');
        return false;
      }

      // Find the clickable parent ViewGroup by walking backwards in the flat node list.
      // In DFS order, parents appear before children — the nearest clickable ViewGroup
      // before the label IS the "Copy to clipboard" button.
      const labelIndex = allNodes.indexOf(copyLabel);
      const copyGroup = allNodes.slice(0, labelIndex).reverse().find((n: any) =>
        n.className === 'android.view.ViewGroup' && n.clickable
      );

      if (!copyGroup) {
        console.log('"Copy to clipboard" parent button not found');
        return false;
      }

      console.log('Clicking "Copy to clipboard" parent button...');
      await agent.actions.nodeAction(copyGroup, agent.constants.ACTION_CLICK);
      await sleep(1000);

      // Read the URL from clipboard (Firefox "Copy to clipboard" copies current page URL)
      const clipboardResult = await agent.actions.reverseCopy();
      const url = clipboardResult.text || '';
      console.log(`URL from clipboard: "${url}"`);

      // Save video entry using the title captured in VideoPage handler
      collectedVideos.push({ title: pendingTitle, url });
      console.log(`Collected ${collectedVideos.length}/${VIDEOS_TO_COLLECT} videos`);
      addData({ collectedVideos: [...collectedVideos] });

      if (collectedVideos.length >= VIDEOS_TO_COLLECT) {
        console.log('All videos collected, transitioning to Gemini stage...');
        await agent.actions.goBack();
        await sleep(2000);
        await setStage(Stage.Gemini);
        return true;
      }

      // Go back to search results and scroll down so the next card is first
      await agent.actions.goBack();
      await sleep(2000);
      const freshContent = await agent.actions.screenContent();
      const freshNodes = getAllNodes(freshContent);
      const resultsWebView = freshNodes.find((n: any) => n.className === 'android.webkit.WebView');
      if (resultsWebView) {
        console.log('Scrolling search results to advance past collected video...');
        await agent.actions.nodeAction(resultsWebView, 4096); // ACTION_SCROLL_FORWARD
        await sleep(1500);
      }

      return true;
    },
  },
} as const satisfies ScreenHandles<keyof typeof CollectStageScreen>;

// --- Stage definition ---

const CollectStage = {
  name: 'Collect',
  maxSteps: DEFAULT_MAX_STEPS_PER_STAGE * 2, // More steps: 4 videos × 3 screens each
  screens: CollectStageScreen,
  screenHandles: CollectHandles,
  defaultHandle: async () => {
    console.log('Collect stage default: waiting...');
    await sleep(2000);
  },
} as const satisfies Stage<typeof CollectStageScreen>;

export default CollectStage;
