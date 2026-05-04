import { DEFAULT_MAX_STEPS_PER_STAGE } from './config';
import { addData, fail, getData } from './data';
import { getResolvedInputs } from './inputs';
import { Stage, type ScreenHandles, setStage } from './Stage';
import { type VideoLink } from './types';
import { clickNode, getAllNodes, performOCR } from './util';
import { extractClickableVideoCandidates, extractOcrVideoCandidates, normalizeVideoTitle } from './videoCandidates';
import { isFirefoxPackageName } from './browser';
import {
  buildYoutubeSearchResultsUrl,
  isFirefoxStartPage,
  isYoutubeSearchResultsPage,
  isYoutubeShortUrl,
  normalizeYoutubeUrl,
  openUrlInFirefox,
  resolveCurrentYoutubeVideoInfo,
  waitForYoutubeVideoPage,
} from './youtube';

const MAX_SCROLLS_WITHOUT_PROGRESS = 8;
const OPEN_VIDEO_PAGE_MAX_CHECKS = 4;

const collectedVideos: VideoLink[] = [];
const visitedResultKeys = new Set<string>();
let activeRunId = '';
let pendingTitle = '';
let noProgressScrolls = 0;

const CollectStageScreen = {
  FirefoxLanding: 'FirefoxLanding',
  SearchResults: 'SearchResults',
  ShortsPlayer: 'ShortsPlayer',
  VideoPage: 'VideoPage',
} as const;

function getKeyword(): string {
  return getResolvedInputs().keyword;
}

function isFirefoxOnboardingLikePage(allNodes: any[]): boolean {
  const textPool = allNodes
    .map((node: any) => [node?.text, node?.description, node?.hintText].filter(Boolean).join(' '))
    .join(' ')
    .toLowerCase();

  return (
    textPool.includes('welcome to firefox') ||
    textPool.includes('add firefox widget') ||
    textPool.includes('instantly pick up where you left off') ||
    textPool.includes('choose your address bar') ||
    textPool.includes('more private')
  );
}

function resetStateIfNeeded() {
  const runId = String(getData().runId || '');
  if (runId && runId !== activeRunId) {
    activeRunId = runId;
    collectedVideos.length = 0;
    visitedResultKeys.clear();
    pendingTitle = '';
    noProgressScrolls = 0;
  }
}

function getTargetCount(): number {
  return getResolvedInputs().searchResultsCount;
}

function recordSearchShortfall(targetCount: number) {
  addData({
    searchCandidates: [...collectedVideos],
    searchCollectionTarget: targetCount,
    searchCollectionShortfall: {
      stage: 'Collect',
      requested: targetCount,
      collected: collectedVideos.length,
    },
  });
}

function recordCollectedVideo(video: VideoLink) {
  const normalizedUrl = normalizeYoutubeUrl(video.url);
  if (!normalizedUrl || isYoutubeShortUrl(normalizedUrl)) {
    return;
  }

  const normalizedTitle = normalizeVideoTitle(video.title);
  const alreadyExists = collectedVideos.some(existing => {
    const existingUrl = normalizeYoutubeUrl(existing.url);
    if (normalizedUrl && existingUrl) {
      return existingUrl === normalizedUrl;
    }
    if (normalizedUrl || existingUrl) {
      return false;
    }
    return !!normalizedTitle && normalizeVideoTitle(existing.title) === normalizedTitle;
  });
  if (alreadyExists) {
    return;
  }

  collectedVideos.push({
    title: normalizeVideoTitle(video.title),
    url: normalizedUrl,
  });
  addData({
    searchCandidates: [...collectedVideos],
    collectedVideos: [...collectedVideos],
    searchCollectedCount: collectedVideos.length,
  });
}

async function scrollSearchResults(allNodes: any[]): Promise<boolean> {
  const webView = allNodes.find((node: any) => node.className === 'android.webkit.WebView');
  if (!webView) return false;

  await agent.actions.nodeAction(webView, 4096);
  await sleep(1500);
  return true;
}

async function tryOpenSearchCandidate(node: any): Promise<boolean> {
  const attempts: Array<() => Promise<void>> = [];
  if (Array.isArray(node?.actions) && node.actions.includes(agent.constants.ACTION_CLICK)) {
    attempts.push(async () => {
      await agent.actions.nodeAction(node, agent.constants.ACTION_CLICK);
    });
  }
  if (node?.boundsInScreen) {
    attempts.push(async () => {
      await clickNode(node);
    });
  }

  for (const attempt of attempts) {
    await attempt();
    await sleep(1800);
    const opened = await waitForYoutubeVideoPage(OPEN_VIDEO_PAGE_MAX_CHECKS);
    if (opened) {
      const info = await resolveCurrentYoutubeVideoInfo();
      addData({
        lastCollectPageKind: info?.pageKind || 'unknown',
        lastCollectDetectionMode: info?.detectionMode || 'none',
        lastResolvedYoutubeUrl: info?.url || '',
      });
      return true;
    }
  }

  return false;
}

const CollectHandles = {
  FirefoxLanding: {
    detectScreen: async (screenContent) => {
      resetStateIfNeeded();
      const allNodes = getAllNodes(screenContent);
      const inFirefox = allNodes.some((node: any) => isFirefoxPackageName(node.packageName));
      if (!inFirefox) return false;

      const info = await resolveCurrentYoutubeVideoInfo(screenContent);
      if (info?.isWatch || info?.isShort) return false;

      if (isYoutubeSearchResultsPage(allNodes)) return false;

      const resolvedUrl = normalizeYoutubeUrl(info?.url || '');
      if (!resolvedUrl || !resolvedUrl.includes('youtube.com')) return true;

      return isFirefoxStartPage(allNodes) || isFirefoxOnboardingLikePage(allNodes);
    },

    handleScreen: async () => {
      resetStateIfNeeded();
      const keyword = getKeyword();
      const resultsUrl = buildYoutubeSearchResultsUrl(keyword);
      addData({
        collectRecovery: 'firefox_landing_or_onboarding',
        collectRecoveryUrl: resultsUrl,
      });

      await openUrlInFirefox(resultsUrl, {
        successFallback: isYoutubeSearchResultsPage,
      });
      await sleep(1500);
      return true;
    },
  },

  SearchResults: {
    detectScreen: async (screenContent) => {
      resetStateIfNeeded();
      const allNodes = getAllNodes(screenContent);
      const inFirefox = allNodes.some((node: any) => isFirefoxPackageName(node.packageName));
      if (!inFirefox) return false;

      const info = await resolveCurrentYoutubeVideoInfo(screenContent);
      addData({
        lastCollectPageKind: info?.pageKind || 'unknown',
        lastCollectDetectionMode: info?.detectionMode || 'none',
        lastResolvedYoutubeUrl: info?.url || '',
      });
      if (info?.isWatch || info?.isShort) return false;

      if (isYoutubeSearchResultsPage(allNodes)) return true;

      const hasResultsLabel = allNodes.some((node: any) =>
        node.text?.toLowerCase()?.includes('search results') ||
        node.description?.toLowerCase()?.includes('search results')
      );
      const hasFilterLabel = allNodes.some((node: any) =>
        node.text?.toLowerCase()?.includes('filter') ||
        node.description?.toLowerCase()?.includes('filter')
      );

      return hasResultsLabel && hasFilterLabel;
    },

    handleScreen: async (screenContent) => {
      resetStateIfNeeded();
      const targetCount = getTargetCount();
      if (collectedVideos.length >= targetCount) {
        await setStage(Stage.Gemini);
        return true;
      }

      let allNodes = getAllNodes(screenContent);
      const keyword = getKeyword();

      // Hard guard: never collect candidates unless we are truly on YouTube search results.
      if (!isYoutubeSearchResultsPage(allNodes)) {
        const recoverUrl = buildYoutubeSearchResultsUrl(keyword);
        addData({
          collectRecovery: 'not_on_youtube_results_in_collect',
          collectRecoveryUrl: recoverUrl,
        });
        await openUrlInFirefox(recoverUrl, {
          successFallback: isYoutubeSearchResultsPage,
        });
        await sleep(1500);
        return true;
      }
      
      // Dismiss keyboard or autocomplete dropdown if it's obscuring the results
      const isSearchFocused = allNodes.some((node: any) => 
        node?.className === 'android.widget.EditText' &&
        node?.isFocused &&
        !String(node?.viewId || '').toLowerCase().includes('mozac_browser_toolbar') &&
        !String(node?.viewId || '').toLowerCase().includes('addressbar') &&
        !String(node?.viewId || '').toLowerCase().includes('edit_url')
      );
      if (isSearchFocused) {
        console.log('Collect: Search input is focused, dismissing keyboard/dropdown...');
        await agent.actions.goBack();
        await sleep(1500);
        allNodes = getAllNodes(await agent.actions.screenContent());
      }

      let visibleCandidates = extractClickableVideoCandidates(allNodes, {
        minTop: 180, // Reduced from 220 to catch videos higher up if search bar is small
        minWidthRatio: 0.62,
      });

      if (visibleCandidates.length === 0) {
        const ocr = await performOCR();
        if (ocr) {
          const ocrCandidates = extractOcrVideoCandidates(ocr.lines, {
            minTop: 220,
          });
          if (ocrCandidates.length > 0) {
            visibleCandidates = ocrCandidates;
            addData({ searchCandidateSource: 'ocr' });
          }
        }
      }

      addData({
        visibleSearchTitles: visibleCandidates.slice(0, 10).map(candidate => candidate.title),
      });

      const chosenCandidate = visibleCandidates.find(candidate => !visitedResultKeys.has(candidate.key));
      if (!chosenCandidate) {
        const scrolled = await scrollSearchResults(allNodes);
        noProgressScrolls++;

        if (noProgressScrolls > MAX_SCROLLS_WITHOUT_PROGRESS) {
          recordSearchShortfall(targetCount);
          if (collectedVideos.length > 0) {
            await setStage(Stage.Gemini);
            return true;
          }
          addData({ searchCollectionError: 'Insufficient unique search results found' });
          await fail('SEARCH_RESULTS_NOT_ENOUGH');
          return true;
        }

        return scrolled;
      }

      noProgressScrolls = 0;
      pendingTitle = normalizeVideoTitle(chosenCandidate.title);
      console.log(
        `Collect: opening search result ${collectedVideos.length + 1}/${targetCount}: "${pendingTitle}"`,
      );

      const opened = await tryOpenSearchCandidate(chosenCandidate.node);
      visitedResultKeys.add(chosenCandidate.key);
      if (!opened) {
        addData({
          lastSearchOpenFailure: {
            title: pendingTitle,
            key: chosenCandidate.key,
          },
          lastCollectUnknownReason: 'Candidate tap did not resolve to a watch or shorts page',
        });
        await sleep(1200);
      }
      return true;
    },
  },

  ShortsPlayer: {
    detectScreen: async (screenContent) => {
      resetStateIfNeeded();
      const allNodes = getAllNodes(screenContent);
      const inFirefox = allNodes.some((node: any) => isFirefoxPackageName(node.packageName));
      if (!inFirefox) return false;

      const info = await resolveCurrentYoutubeVideoInfo(screenContent);
      addData({
        lastCollectPageKind: info?.pageKind || 'unknown',
        lastCollectDetectionMode: info?.detectionMode || 'none',
        lastResolvedYoutubeUrl: info?.url || '',
      });
      return !!info?.isShort;
    },

    handleScreen: async () => {
      resetStateIfNeeded();
      console.log('Collect: opened a Shorts result, skipping and returning to search results...');
      await agent.actions.goBack();
      await sleep(2000);
      return true;
    },
  },

  VideoPage: {
    detectScreen: async (screenContent) => {
      resetStateIfNeeded();
      const allNodes = getAllNodes(screenContent);
      const inFirefox = allNodes.some((node: any) => isFirefoxPackageName(node.packageName));
      if (!inFirefox) return false;

      const info = await resolveCurrentYoutubeVideoInfo(screenContent);
      addData({
        lastCollectPageKind: info?.pageKind || 'unknown',
        lastCollectDetectionMode: info?.detectionMode || 'none',
        lastResolvedYoutubeUrl: info?.url || '',
      });
      return !!info?.isWatch;
    },

    handleScreen: async (screenContent) => {
      resetStateIfNeeded();
      const targetCount = getTargetCount();
      let info = await resolveCurrentYoutubeVideoInfo(screenContent);
      if (!info?.url || !info.isWatch) {
        await sleep(800);
        info = await resolveCurrentYoutubeVideoInfo(await agent.actions.screenContent());
      }
      addData({
        lastCollectPageKind: info?.pageKind || 'unknown',
        lastCollectDetectionMode: info?.detectionMode || 'none',
        lastResolvedYoutubeUrl: info?.url || '',
      });
      if (!info?.url || !info.isWatch) {
        addData({
          lastCollectUnknownReason: 'Watch page opened but URL/title could not be resolved after OCR recovery',
        });
        await agent.actions.goBack();
        await sleep(2000);
        return true;
      }

      if (isYoutubeShortUrl(info.url)) {
        await agent.actions.goBack();
        await sleep(2000);
        return true;
      }

      const title = normalizeVideoTitle(info.title || pendingTitle || `Video ${collectedVideos.length + 1}`);
      recordCollectedVideo({ title, url: info.url });
      pendingTitle = '';

      if (collectedVideos.length >= targetCount) {
        await setStage(Stage.Gemini);
        return true;
      }

      await agent.actions.goBack();
      await sleep(2000);
      return true;
    },
  },
} as const satisfies ScreenHandles<keyof typeof CollectStageScreen>;

const CollectStage = {
  name: 'Collect',
  maxSteps: DEFAULT_MAX_STEPS_PER_STAGE * 3,
  screens: CollectStageScreen,
  screenHandles: CollectHandles,
  defaultHandle: async () => {
    console.log('Collect stage: waiting for search results...');
    await sleep(2000);
  },
} as const satisfies Stage<typeof CollectStageScreen>;

export default CollectStage;
