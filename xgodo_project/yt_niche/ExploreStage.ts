/**
 * Explore Stage — After GeminiStage picks the best video, this stage
 * traverses YouTube Shorts' recommendation graph by scrolling through
 * the Shorts carousel and picking the best niche match at each hop.
 *
 * Flow (repeated loopNumber times):
 * 1. ShortsPlaying — a Short is loaded in Firefox
 *    a. On first entry, seed the chain with the GeminiStage bestVideo (depth 0)
 *    b. Scroll forward (suggestionsPerLoop) times using ACTION_SCROLL_FORWARD on
 *       the WebView — each scroll advances the Shorts carousel by one video
 *    c. After each scroll, read title from WebView.text and URL from
 *       ADDRESSBAR_URL_BOX.description
 *    d. Call Gemini to score the collected suggestions against the niche
 *    e. Navigate to the best-scoring suggestion
 *    f. currentDepth++ → when depth reaches loopNumber, call success()
 *
 * Job variables required:
 *   niche            — the niche keyword (shared with GeminiStage)
 *   apiKey           — Gemini API key (shared with GeminiStage)
 *   loopNumber       — how many explore hops to perform (e.g. 3)
 *   suggestionsPerLoop — how many Shorts to scroll past per hop (e.g. 4)
 */

import { FIREFOX_PACKAGE, DEFAULT_MAX_STEPS_PER_STAGE } from './config';
import { addData, getData, success } from './data';
import { Stage, type ScreenHandles } from './Stage';
import { getAllNodes, clickNode } from './util';

const GEMINI_MODEL = 'gemini-2.5-flash-lite';

const GEMINI_PROMPT = `You are an expert content classification AI.

Your task is to analyze a list of YouTube video titles and determine how strongly each video matches the following niche:

NICHE:
"$NICHE"

SCORING RULES:
- Score must be an integer from 0 to 100.
- 0 = completely unrelated to the niche.
- 100 = perfectly matches the niche.
- Consider keywords, intent, topic relevance, and audience alignment.
- Be strict and realistic in scoring (avoid giving all high scores).

IMPORTANT:
- Return ONLY valid JSON.
- Do NOT include explanations.
- Do NOT include markdown.
- Do NOT include comments.
- Output must be a JSON array.
- Preserve original title and url exactly as provided.

REQUIRED OUTPUT FORMAT:
[
  {
    "title": "original title here",
    "url": "original url here",
    "score": 0-100
  }
]

Here is the list of videos:
$VIDEO_LIST_JSON`;

interface ExploredVideo {
  title: string;
  url: string;
  score: number;
  depth: number;
  source: 'search_result' | 'suggested';
}

interface ScoredVideo {
  title: string;
  url: string;
  score: number;
}

// Module-level state — persists across screen handler calls within this stage
let currentDepth = 0;
const exploredChain: ExploredVideo[] = [];

// --- Helpers ---

async function callGeminiAPI(
  niche: string,
  apiKey: string,
  videos: { title: string; url: string }[],
  attempt = 1
): Promise<ScoredVideo[] | null> {
  const MAX_RETRIES = 5;
  const BASE_DELAY = 1500;

  const videoListJson = JSON.stringify(videos.map(v => ({ title: v.title, url: v.url })));
  const prompt = GEMINI_PROMPT
    .replace('$NICHE', niche)
    .replace('$VIDEO_LIST_JSON', videoListJson);

  console.log(`Explore: Gemini API (depth ${currentDepth + 1}, attempt ${attempt})...`);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );

    if (response.status === 429) {
      if (attempt > MAX_RETRIES) { console.log('Max retries reached.'); return null; }
      const delay = BASE_DELAY * Math.pow(2, attempt);
      console.log(`429 rate limit. Retrying in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      return callGeminiAPI(niche, apiKey, videos, attempt + 1);
    }

    if (!response.ok) {
      console.log(`Gemini API error: ${response.status} ${response.statusText}`);
      return null;
    }

    const result = await response.json();
    const text: string = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log(`Explore Gemini response: ${text.substring(0, 300)}`);

    try {
      return JSON.parse(text) as ScoredVideo[];
    } catch {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) return JSON.parse(match[0]) as ScoredVideo[];
      console.log('Failed to parse Gemini response as JSON');
      return null;
    }
  } catch (error) {
    console.log('Gemini network error:', error);
    return null;
  }
}


function extractShortsUrl(urlBoxDescription: string): string {
  const match = urlBoxDescription.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/);
  return match ? `https://youtube.com/shorts/${match[1]}` : '';
}

function extractWatchUrl(urlBoxDescription: string): string {
  const match = urlBoxDescription.match(/youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/);
  return match ? `https://www.youtube.com/watch?v=${match[1]}` : '';
}

function extractTitle(webViewText: string): string {
  return webViewText.replace(/ - YouTube$/, '').trim();
}

// --- Screen definitions ---

const ExploreStageScreen = {
  ShortsPlaying: 'ShortsPlaying',
  VideoPage: 'VideoPage',
} as const;

// --- Screen handlers ---

const ExploreHandles = {
  /**
   * A Short is currently playing in Firefox.
   * Scroll through (suggestionsPerLoop) more Shorts to collect suggestions,
   * score them with Gemini, navigate to the best, increment depth.
   * Calls success() when currentDepth reaches loopNumber.
   */
  ShortsPlaying: {
    detectScreen: async (screenContent) => {
      const allNodes = getAllNodes(screenContent);
      const inFirefox = allNodes.some((n: any) => n.packageName === FIREFOX_PACKAGE);
      if (!inFirefox) return false;

      // Don't match the share sheet
      const onShareSheet = allNodes.some((n: any) =>
        n.viewId === 'org.mozilla.firefox:id/shareWrapper'
      );
      if (onShareSheet) return false;

      // Shorts player: address bar contains a /shorts/ URL
      const urlBox = allNodes.find((n: any) => n.viewId === 'ADDRESSBAR_URL_BOX');
      return (urlBox?.description ?? '').includes('youtube.com/shorts/');
    },

    handleScreen: async (screenContent) => {
      const { niche, apiKey, loopNumber, suggestionsPerLoop } = agent.arguments.jobVariables;
      const loopCount = Number(loopNumber) || 3;
      const scrollCount = Number(suggestionsPerLoop) || 4;

      // Guard: re-entry after final success() call
      if (currentDepth >= loopCount) return true;

      // On first entry, seed the chain with the GeminiStage bestVideo at depth 0
      if (currentDepth === 0 && exploredChain.length === 0) {
        const { bestVideo } = getData();
        if (bestVideo) {
          exploredChain.push({ ...bestVideo, depth: 0, source: 'search_result' });
          console.log(`Explore: seeded chain with depth-0 video: "${bestVideo.title}"`);
        }
      }

      console.log(`Explore: hop ${currentDepth + 1}/${loopCount} — scrolling down to reveal recommendations`);

      const allNodes = getAllNodes(screenContent);
      const webView = allNodes.find((n: any) => n.className === 'android.webkit.WebView');
      if (!webView) {
        console.log('Explore: WebView not found — waiting');
        return false;
      }

      // Click Play button if the video is paused (required before scrolling reveals recommendations)
      // Uses coordinate tap (clickNode) because isImportantForAccessibility=false blocks nodeAction
      const playBtn = allNodes.find((n: any) =>
        n.text === 'Play' &&
        n.className === 'android.widget.Button' &&
        n.clickable &&
        n.packageName === FIREFOX_PACKAGE
      );
      if (playBtn) {
        console.log('Explore: clicking Play button to start video...');
        await clickNode(playBtn);
        await sleep(1500);
      }

      // Scroll DOWN the Shorts page to reveal recommendation cards below the player
      for (let i = 0; i < scrollCount; i++) {
        await agent.actions.nodeAction(webView, 4096); // ACTION_SCROLL_FORWARD = scroll page down
        await sleep(1500);
      }

      // Read fresh accessibility tree after scrolling
      const freshContent = await agent.actions.screenContent();
      const freshNodes = getAllNodes(freshContent);

      // Same filter as CollectStage — clickable + isScrollable + description
      const cards = freshNodes.filter((n: any) =>
        n.className === 'android.view.View' &&
        n.clickable &&
        n.isScrollable &&
        n.description &&
        n.description.length > 5 &&
        n.packageName === FIREFOX_PACKAGE
      );

      console.log(`Explore: found ${cards.length} recommendation cards`);

      if (cards.length === 0) {
        console.log('Explore: no recommendation cards found — retrying');
        return false;
      }

      // Score all cards by description with Gemini
      const candidates = cards.map((c: any) => ({ title: c.description, url: c.description }));
      const scores = await callGeminiAPI(niche, apiKey, candidates);
      if (!scores || scores.length === 0) {
        console.log('Explore: Gemini returned no scores — retrying');
        return false;
      }

      const best = scores.reduce((top, curr) => curr.score > top.score ? curr : top);
      console.log(`Explore hop ${currentDepth + 1} best card: score ${best.score}`);

      // Find and click the best card
      const bestCard = freshNodes.find((n: any) =>
        n.className === 'android.view.View' &&
        n.clickable &&
        n.isScrollable &&
        n.description === best.title
      );

      if (!bestCard) {
        console.log('Explore: best card not found in nodes — retrying');
        return false;
      }

      await agent.actions.nodeAction(bestCard, agent.constants.ACTION_CLICK);
      await sleep(3000);

      // Dismiss "Open in YouTube" dialog if it appears
      let afterContent = await agent.actions.screenContent();
      let afterNodes = getAllNodes(afterContent);
      const openInYtDialog = afterNodes.find((n: any) =>
        n.viewId === 'org.mozilla.firefox:id/alertTitle' &&
        n.text === 'Open in YouTube'
      );
      if (openInYtDialog) {
        console.log('"Open in YouTube" dialog — clicking Cancel...');
        const cancelBtn = afterNodes.find((n: any) =>
          n.viewId === 'android:id/button2' && n.text === 'Cancel' && n.clickable
        );
        if (cancelBtn) await clickNode(cancelBtn);
        else await agent.actions.goBack();
        await sleep(1500);
        afterContent = await agent.actions.screenContent();
        afterNodes = getAllNodes(afterContent);
      }

      // Read clean title + URL exactly like CollectStage.ShortsPlayer
      const urlBox = afterNodes.find((n: any) => n.viewId === 'ADDRESSBAR_URL_BOX');
      const afterWebView = afterNodes.find((n: any) => n.className === 'android.webkit.WebView');
      const url = extractShortsUrl(urlBox?.description ?? '') ||
                  extractWatchUrl(urlBox?.description ?? '') ||
                  (urlBox?.description ?? '');
      const title = extractTitle(afterWebView?.text ?? '') || best.title;

      console.log(`Explore hop ${currentDepth + 1}: "${title}" — ${url} (score: ${best.score})`);

      exploredChain.push({ title, url, score: best.score, depth: currentDepth + 1, source: 'suggested' });
      currentDepth++;
      addData({ exploredChain: [...exploredChain] });

      // All hops done — submit success
      if (currentDepth >= loopCount) {
        console.log(`Explore complete after ${loopCount} hop(s). Submitting success.`);
        const { keyword, geminiScores, collectedVideos, bestVideo } = getData();
        await success({ keyword, niche, bestVideo, geminiScores, collectedVideos, exploredChain });
        return true;
      }

      return true;
    },
  },
  /**
   * A regular YouTube video page (watch?v=...) is playing in Firefox.
   * Clicks the Share button to get a clean URL, updates the chain entry if
   * it was recorded by ShortsPlaying with a raw description, then scrolls
   * down to find recommendation cards and follows the best-matching one.
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

      const urlBox = allNodes.find((n: any) => n.viewId === 'ADDRESSBAR_URL_BOX');
      const urlDesc = urlBox?.description ?? '';

      // Must NOT be a Shorts page, MUST have a watch URL
      if (urlDesc.includes('youtube.com/shorts/')) return false;
      return urlDesc.includes('youtube.com/watch');
    },

    handleScreen: async (screenContent) => {
      const { niche, apiKey, loopNumber, suggestionsPerLoop } = agent.arguments.jobVariables;
      const loopCount = Number(loopNumber) || 3;
      const scrollCount = Number(suggestionsPerLoop) || 4;

      // Guard: re-entry after final success() call
      if (currentDepth >= loopCount) return true;

      // Seed chain at depth 0 if bestVideo from GeminiStage is a regular video
      if (currentDepth === 0 && exploredChain.length === 0) {
        const { bestVideo } = getData();
        if (bestVideo) {
          exploredChain.push({ ...bestVideo, depth: 0, source: 'search_result' });
          console.log(`Explore VideoPage: seeded chain with depth-0 video: "${bestVideo.title}"`);
        }
      }

      console.log(`Explore: hop ${currentDepth + 1}/${loopCount} — on regular video page, getting URL via Share`);

      const allNodes = getAllNodes(screenContent);
      const webView = allNodes.find((n: any) => n.className === 'android.webkit.WebView');
      const urlBox = allNodes.find((n: any) => n.viewId === 'ADDRESSBAR_URL_BOX');

      // Fallback URL from address bar
      let currentUrl = extractWatchUrl(urlBox?.description ?? '') || (urlBox?.description ?? '');

      // Click Share button to get a clean URL from clipboard
      const shareBtn = allNodes.find((n: any) =>
        n.text === 'Share' &&
        n.className === 'android.widget.Button' &&
        n.clickable
      );

      if (shareBtn) {
        console.log('Explore VideoPage: clicking Share button...');
        await agent.actions.nodeAction(shareBtn, agent.constants.ACTION_CLICK);
        await sleep(2000);

        const sheetContent = await agent.actions.screenContent();
        const sheetNodes = getAllNodes(sheetContent);
        const onShareSheet = sheetNodes.some((n: any) =>
          n.viewId === 'org.mozilla.firefox:id/shareWrapper'
        );

        if (onShareSheet) {
          const copyLabel = sheetNodes.find((n: any) =>
            n.viewId === 'org.mozilla.firefox:id/appName' &&
            n.text === 'Copy to clipboard'
          );
          if (copyLabel) {
            const labelIndex = sheetNodes.indexOf(copyLabel);
            const copyGroup = sheetNodes.slice(0, labelIndex).reverse().find((n: any) =>
              n.className === 'android.view.ViewGroup' && n.clickable
            );
            if (copyGroup) {
              await agent.actions.nodeAction(copyGroup, agent.constants.ACTION_CLICK);
              await sleep(1000);
              const clipResult = await agent.actions.reverseCopy();
              if (clipResult.text) {
                currentUrl = clipResult.text;
                console.log(`Explore VideoPage: clean URL from clipboard: "${currentUrl}"`);
              }
            }
          }
          // Dismiss share sheet
          await agent.actions.goBack();
          await sleep(1500);
        } else {
          console.log('Explore VideoPage: share sheet did not appear');
        }
      } else {
        console.log(`Explore VideoPage: Share button not found, using address bar URL: "${currentUrl}"`);
      }

      // Update the last chain entry if it was recorded by ShortsPlaying for this depth
      if (exploredChain.length > 0) {
        const last = exploredChain[exploredChain.length - 1];
        if (last.depth === currentDepth && currentUrl) {
          console.log(`Explore VideoPage: refining chain entry at depth ${last.depth} with clean URL`);
          last.url = currentUrl;
          last.title = extractTitle(webView?.text ?? '') || last.title;
        }
      }

      // Get fresh screen after share sheet dismissal
      const videoPageContent = await agent.actions.screenContent();
      const videoPageNodes = getAllNodes(videoPageContent);
      const videoWebView = videoPageNodes.find((n: any) => n.className === 'android.webkit.WebView');

      if (!videoWebView) {
        console.log('Explore VideoPage: WebView not found — retrying');
        return false;
      }

      // Click Play button if the video is paused (required before scrolling reveals recommendations)
      // Uses coordinate tap (clickNode) because isImportantForAccessibility=false blocks nodeAction
      const playBtn = videoPageNodes.find((n: any) =>
        n.text === 'Play' &&
        n.className === 'android.widget.Button' &&
        n.clickable &&
        n.packageName === FIREFOX_PACKAGE
      );
      if (playBtn) {
        console.log('Explore VideoPage: clicking Play button to start video...');
        await clickNode(playBtn);
        await sleep(1500);
      }

      // Scroll DOWN to reveal recommendation cards below the player
      console.log(`Explore VideoPage: scrolling down ${scrollCount} times to reveal recommendations`);
      for (let i = 0; i < scrollCount; i++) {
        await agent.actions.nodeAction(videoWebView, 4096); // ACTION_SCROLL_FORWARD
        await sleep(1500);
      }

      const freshContent = await agent.actions.screenContent();
      const freshNodes = getAllNodes(freshContent);

      const cards = freshNodes.filter((n: any) =>
        n.className === 'android.view.View' &&
        n.clickable &&
        n.isScrollable &&
        n.description &&
        n.description.length > 5 &&
        n.packageName === FIREFOX_PACKAGE
      );

      console.log(`Explore VideoPage: found ${cards.length} recommendation cards`);

      if (cards.length === 0) {
        console.log('Explore VideoPage: no recommendation cards found — retrying');
        return false;
      }

      // Score cards with Gemini
      const candidates = cards.map((c: any) => ({ title: c.description, url: c.description }));
      const scores = await callGeminiAPI(niche, apiKey, candidates);
      if (!scores || scores.length === 0) {
        console.log('Explore VideoPage: Gemini returned no scores — retrying');
        return false;
      }

      const best = scores.reduce((top, curr) => curr.score > top.score ? curr : top);
      console.log(`Explore VideoPage hop ${currentDepth + 1} best card: score ${best.score}`);

      const bestCard = freshNodes.find((n: any) =>
        n.className === 'android.view.View' &&
        n.clickable &&
        n.isScrollable &&
        n.description === best.title
      );

      if (!bestCard) {
        console.log('Explore VideoPage: best card not found in nodes — retrying');
        return false;
      }

      await agent.actions.nodeAction(bestCard, agent.constants.ACTION_CLICK);
      await sleep(3000);

      // Dismiss "Open in YouTube" dialog if it appears
      let afterContent = await agent.actions.screenContent();
      let afterNodes = getAllNodes(afterContent);
      const openInYtDialog = afterNodes.find((n: any) =>
        n.viewId === 'org.mozilla.firefox:id/alertTitle' &&
        n.text === 'Open in YouTube'
      );
      if (openInYtDialog) {
        console.log('"Open in YouTube" dialog — clicking Cancel...');
        const cancelBtn = afterNodes.find((n: any) =>
          n.viewId === 'android:id/button2' && n.text === 'Cancel' && n.clickable
        );
        if (cancelBtn) await clickNode(cancelBtn);
        else await agent.actions.goBack();
        await sleep(1500);
        afterContent = await agent.actions.screenContent();
        afterNodes = getAllNodes(afterContent);
      }

      // Read clean title + URL of where we landed
      const afterUrlBox = afterNodes.find((n: any) => n.viewId === 'ADDRESSBAR_URL_BOX');
      const afterWebView = afterNodes.find((n: any) => n.className === 'android.webkit.WebView');
      const url = extractShortsUrl(afterUrlBox?.description ?? '') ||
                  extractWatchUrl(afterUrlBox?.description ?? '') ||
                  (afterUrlBox?.description ?? '');
      const title = extractTitle(afterWebView?.text ?? '') || best.title;

      console.log(`Explore VideoPage hop ${currentDepth + 1}: "${title}" — ${url} (score: ${best.score})`);

      exploredChain.push({ title, url, score: best.score, depth: currentDepth + 1, source: 'suggested' });
      currentDepth++;
      addData({ exploredChain: [...exploredChain] });

      // All hops done — submit success
      if (currentDepth >= loopCount) {
        console.log(`Explore complete after ${loopCount} hop(s). Submitting success.`);
        const { keyword, geminiScores, collectedVideos, bestVideo } = getData();
        await success({ keyword, niche, bestVideo, geminiScores, collectedVideos, exploredChain });
        return true;
      }

      return true;
    },
  },
} as const satisfies ScreenHandles<keyof typeof ExploreStageScreen>;

// --- Stage definition ---

// Budget: loopNumber × (swipeCount × ~2 steps + Gemini + navigate + detect) ≈ 10 steps/hop
const ExploreStage = {
  name: 'Explore',
  maxSteps: DEFAULT_MAX_STEPS_PER_STAGE * 4,
  screens: ExploreStageScreen,
  screenHandles: ExploreHandles,
  defaultHandle: async () => {
    console.log('Explore stage: waiting for Shorts player to load...');
    await sleep(3000);
  },
} as const satisfies Stage<typeof ExploreStageScreen>;

export default ExploreStage;
