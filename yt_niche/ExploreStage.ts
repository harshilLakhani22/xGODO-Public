import { DEFAULT_MAX_STEPS_PER_STAGE } from './config';
import { addData, fail, getData, success } from './data';
import {
  isGeminiApiError,
  pickBestScored,
  scoreCandidatesWithGemini,
  toGeminiFailureCode,
} from './gemini';
import { getResolvedInputs } from './inputs';
import { Stage, type ScreenHandles } from './Stage';
import { type ResultRow, type VideoLink } from './types';
import { clickNode, getAllNodes, performOCR } from './util';
import { extractClickableVideoCandidates, extractOcrVideoCandidates, normalizeVideoTitle } from './videoCandidates';
import {
  getCurrentVideoInfo,
  isYoutubeShortUrl,
  isYoutubeVideoPage,
  normalizeYoutubeUrl,
  openUrlInFirefox,
  waitForYoutubeVideoPage,
} from './youtube';

interface CollectedSuggestionCandidate extends VideoLink {
  id: string;
  key: string;
}

interface RankedSuggestionCandidate extends CollectedSuggestionCandidate {
  score: number;
}

const MAX_SUGGESTION_SCROLLS = 8;
const OPEN_SUGGESTION_PAGE_MAX_CHECKS = 3;

const ExploreStageScreen = {
  YouTubeVideoPage: 'YouTubeVideoPage',
} as const;

let activeRunId = '';
let currentDepth = 0;
let processingHop = false;
let sourceVideoUrl = '';
let sourceVideoTitle = '';
let watchedSourceKey = '';
let pendingSuggestionTitle = '';
let noProgressScrolls = 0;
let collectedSuggestions: CollectedSuggestionCandidate[] = [];
let pendingBestSelection: RankedSuggestionCandidate | null = null;
const visitedSuggestionKeys = new Set<string>();
const visitedVideoUrls = new Set<string>();

function resetHopState() {
  pendingSuggestionTitle = '';
  noProgressScrolls = 0;
  collectedSuggestions = [];
  pendingBestSelection = null;
  visitedSuggestionKeys.clear();
}

async function watchSourceVideoIfNeeded(currentUrl: string, watchSeconds: number) {
  if (watchSeconds <= 0) {
    return;
  }

  const normalizedUrl = normalizeYoutubeUrl(currentUrl);
  if (!normalizedUrl) {
    return;
  }

  const watchKey = `${currentDepth}::${normalizedUrl}`;
  if (watchedSourceKey === watchKey) {
    return;
  }

  addData({
    exploreDepth: currentDepth,
    watchingVideo: {
      url: normalizedUrl,
      seconds: watchSeconds,
      phase: currentDepth === 0 ? 'initial_best_video' : 'selected_suggestion',
    },
  });
  await sleep(watchSeconds * 1000);
  watchedSourceKey = watchKey;
}

function markVisitedVideoUrl(url: string) {
  const normalizedUrl = normalizeYoutubeUrl(url);
  if (normalizedUrl) {
    visitedVideoUrls.add(normalizedUrl);
  }
}

function syncVisitedVideoUrls() {
  const results = Array.isArray(getData().results) ? getData().results : [];
  results.forEach((row: any) => {
    if (row && typeof row.url === 'string') {
      markVisitedVideoUrl(row.url);
    }
  });

  if (sourceVideoUrl) {
    markVisitedVideoUrl(sourceVideoUrl);
  }

  if (pendingBestSelection?.url) {
    markVisitedVideoUrl(pendingBestSelection.url);
  }
}

function resetStateIfNeeded() {
  const runId = String(getData().runId || '');
  if (runId && runId !== activeRunId) {
    activeRunId = runId;
    currentDepth = 0;
    processingHop = false;
    sourceVideoUrl = '';
    sourceVideoTitle = '';
    watchedSourceKey = '';
    visitedVideoUrls.clear();
    resetHopState();
  }
}

async function submitExploreSuccess() {
  const inputs = getResolvedInputs();
  const results = Array.isArray(getData().results) ? getData().results : [];
  await success({
    keyword: inputs.keyword,
    niche: inputs.niche,
    results,
  });
}

function recordSuggestionShortfall(requested: number) {
  addData({
    exploreDepth: currentDepth,
    suggestionCollectionShortfall: {
      stage: 'Explore',
      requested,
      collected: collectedSuggestions.length,
    },
  });
}

function recordCollectedSuggestion(video: VideoLink, key: string): boolean {
  const normalizedUrl = normalizeYoutubeUrl(video.url);
  if (!normalizedUrl || isYoutubeShortUrl(normalizedUrl)) {
    return false;
  }

  syncVisitedVideoUrls();
  if (visitedVideoUrls.has(normalizedUrl)) {
    return false;
  }

  const normalizedTitle = normalizeVideoTitle(video.title);
  const alreadyExists = collectedSuggestions.some(existing => {
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
    return false;
  }

  collectedSuggestions.push({
    id: `suggest-${collectedSuggestions.length}`,
    key: key || `${normalizedTitle.toLowerCase()}||${normalizedUrl}`,
    title: normalizeVideoTitle(video.title),
    url: normalizedUrl,
  });

  addData({
    exploreDepth: currentDepth,
    suggestedCandidates: collectedSuggestions.map(candidate => ({
      title: candidate.title,
      url: candidate.url,
    })),
    suggestedCollectedCount: collectedSuggestions.length,
  });
  return true;
}

async function scrollSuggestions(allNodes: any[]): Promise<boolean> {
  const webView = allNodes.find((node: any) => node.className === 'android.webkit.WebView');
  if (!webView) return false;

  await agent.actions.nodeAction(webView, 4096);
  await sleep(1500);
  return true;
}

async function openBestSuggestion(candidate: RankedSuggestionCandidate): Promise<boolean> {
  const navigated = await openUrlInFirefox(candidate.url);
  if (!navigated) {
    return false;
  }

  return waitForYoutubeVideoPage();
}

async function tryOpenSuggestionCandidate(node: any, sourceUrl: string): Promise<boolean> {
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

    if (await waitForYoutubeVideoPage(OPEN_SUGGESTION_PAGE_MAX_CHECKS)) {
      const info = await getCurrentVideoInfo();
      const openedUrl = normalizeYoutubeUrl(info?.url || '');
      if (openedUrl && openedUrl !== sourceUrl) {
        return true;
      }
    }
  }

  return false;
}

async function scoreAndOpenNextSuggestion(inputs: ReturnType<typeof getResolvedInputs>): Promise<boolean> {
  syncVisitedVideoUrls();

  const eligibleSuggestions = collectedSuggestions.filter(candidate => {
    const normalizedUrl = normalizeYoutubeUrl(candidate.url);
    return normalizedUrl ? !visitedVideoUrls.has(normalizedUrl) : true;
  });

  if (eligibleSuggestions.length === 0) {
    recordSuggestionShortfall(inputs.suggestionsPerLoop);
    addData({
      exploreDepth: currentDepth,
      suggestionsFound: collectedSuggestions.length,
      suggestionsRequired: inputs.suggestionsPerLoop,
    });
    await fail('NOT_ENOUGH_SUGGESTIONS_FOUND');
    return true;
  }

  let scoredCandidates;
  try {
    scoredCandidates = await scoreCandidatesWithGemini({
      niche: inputs.niche,
      apiKey: inputs.geminiApiKey,
      model: inputs.geminiModel,
      candidates: eligibleSuggestions.map(candidate => ({
        id: candidate.id,
        title: candidate.title,
      })),
      contextLabel: `explore hop ${currentDepth + 1}`,
    });
  } catch (error) {
    if (isGeminiApiError(error)) {
      addData({
        geminiFailureStage: 'suggestion_scoring',
        geminiFailureKind: error.kind,
        geminiFailureStatus: error.googleStatus || error.googleReason || error.httpStatus || '',
        geminiError: error.message,
      });
      await fail(toGeminiFailureCode(error, 'suggestion_scoring'));
      return true;
    }

    addData({
      geminiFailureStage: 'suggestion_scoring',
      geminiFailureKind: 'unknown',
      geminiError: String(error),
    });
    await fail('GEMINI_SUGGESTION_SCORING_FAILED');
    return true;
  }

  const scoreMap = new Map<string, number>();
  scoredCandidates.forEach(item => scoreMap.set(item.id, item.score));

  const rankedSuggestions: RankedSuggestionCandidate[] = eligibleSuggestions.map(candidate => ({
    ...candidate,
    score: scoreMap.get(candidate.id) ?? 0,
  }));

  const bestSuggestion = pickBestScored(rankedSuggestions);
  pendingBestSelection = bestSuggestion;
  syncVisitedVideoUrls();

  addData({
    exploreDepth: currentDepth,
    lastExploreScores: rankedSuggestions.map(candidate => ({
      title: candidate.title,
      url: candidate.url,
      score: candidate.score,
    })),
    nextSuggestedVideo: {
      title: bestSuggestion.title,
      url: bestSuggestion.url,
      score: bestSuggestion.score,
    },
  });

  const loaded = await openBestSuggestion(bestSuggestion);
  if (!loaded) {
    addData({
      exploreDepth: currentDepth,
      selectedSuggestion: bestSuggestion,
    });
    await fail('SUGGESTED_VIDEO_LOAD_FAILED');
    return true;
  }

  return true;
}

const ExploreHandles = {
  YouTubeVideoPage: {
    detectScreen: async (screenContent) => {
      resetStateIfNeeded();
      if (processingHop) return false;
      return isYoutubeVideoPage(getAllNodes(screenContent));
    },

    handleScreen: async (screenContent) => {
      resetStateIfNeeded();
      if (processingHop) return true;

      processingHop = true;
      try {
        const inputs = getResolvedInputs();
        if (currentDepth >= inputs.loopCount) {
          await submitExploreSuccess();
          return true;
        }

        const info = await getCurrentVideoInfo(screenContent);
        if (!info?.url) {
          return false;
        }

        const currentUrl = normalizeYoutubeUrl(info.url);
        if (!sourceVideoUrl) {
          sourceVideoUrl = currentUrl;
          sourceVideoTitle = normalizeVideoTitle(info.title);
          markVisitedVideoUrl(currentUrl);
        }
        syncVisitedVideoUrls();

        if (pendingBestSelection) {
          const expectedUrl = normalizeYoutubeUrl(pendingBestSelection.url);
          if (expectedUrl && currentUrl !== expectedUrl) {
            addData({
              exploreDepth: currentDepth,
              expectedSuggestionUrl: expectedUrl,
              actualSuggestionUrl: currentUrl,
            });
            await fail('BEST_SUGGESTION_NAVIGATION_MISMATCH');
            return true;
          }

          const newRow: ResultRow = {
            title: normalizeVideoTitle(info.title || pendingBestSelection.title),
            link: currentUrl,
            url: currentUrl,
            niche: inputs.niche,
            matchScore: pendingBestSelection.score,
            step: currentDepth + 1,
            source: 'suggested',
          };

          const previousResults = Array.isArray(getData().results) ? getData().results : [];
          addData({
            results: [...previousResults, newRow],
            exploreDepth: currentDepth + 1,
            lastOpenedSuggestion: {
              title: newRow.title,
              url: newRow.url,
              score: newRow.matchScore,
            },
          });

          currentDepth++;
          sourceVideoUrl = currentUrl;
          sourceVideoTitle = normalizeVideoTitle(info.title || pendingBestSelection.title);
          markVisitedVideoUrl(currentUrl);
          watchedSourceKey = '';
          resetHopState();

          if (currentDepth >= inputs.loopCount) {
            await submitExploreSuccess();
            return true;
          }

          return true;
        }

        if (currentUrl !== sourceVideoUrl) {
          if (info.isShort || isYoutubeShortUrl(currentUrl)) {
            console.log('Explore: opened a Shorts suggestion, skipping...');
            await agent.actions.goBack();
            await sleep(1800);
            return true;
          }

          if (visitedVideoUrls.has(currentUrl)) {
            console.log('Explore: opened a previously visited video, skipping...');
            await agent.actions.goBack();
            await sleep(1800);
            return true;
          }

          recordCollectedSuggestion(
            {
              title: normalizeVideoTitle(info.title || pendingSuggestionTitle || `Suggested Video ${collectedSuggestions.length + 1}`),
              url: currentUrl,
            },
            `${normalizeVideoTitle(pendingSuggestionTitle || info.title).toLowerCase()}||${currentUrl}`,
          );

          await agent.actions.goBack();
          await sleep(1800);
          return true;
        }

        await watchSourceVideoIfNeeded(currentUrl, inputs.watchSecondsPerVideo);

        if (collectedSuggestions.length >= inputs.suggestionsPerLoop) {
          return scoreAndOpenNextSuggestion(inputs);
        }

        const allNodes = getAllNodes(screenContent);
        let visibleCandidates = extractClickableVideoCandidates(allNodes, {
          minTop: 220,
          minWidthRatio: 0.58,
        });

        if (visibleCandidates.length === 0) {
          const ocr = await performOCR();
          if (ocr) {
            const ocrCandidates = extractOcrVideoCandidates(ocr.lines, {
              minTop: 220,
            });
            if (ocrCandidates.length > 0) {
              visibleCandidates = ocrCandidates;
              addData({ exploreCandidateSource: 'ocr' });
            }
          }
        }
        addData({
          exploreVisibleTitles: visibleCandidates.slice(0, 10).map(candidate => candidate.title),
        });

        const normalizedSourceTitle = normalizeVideoTitle(sourceVideoTitle).toLowerCase();
        const nextCandidate = visibleCandidates.find(candidate =>
          !visitedSuggestionKeys.has(candidate.key) &&
          normalizeVideoTitle(candidate.title).toLowerCase() !== normalizedSourceTitle
        );

        if (!nextCandidate) {
          const scrolled = await scrollSuggestions(allNodes);
          noProgressScrolls++;

          if (noProgressScrolls > MAX_SUGGESTION_SCROLLS) {
            recordSuggestionShortfall(inputs.suggestionsPerLoop);
            addData({
              exploreDepth: currentDepth,
              suggestionsFound: collectedSuggestions.length,
              suggestionsRequired: inputs.suggestionsPerLoop,
            });
            if (collectedSuggestions.length > 0) {
              return scoreAndOpenNextSuggestion(inputs);
            }
            await fail('NOT_ENOUGH_SUGGESTIONS_FOUND');
            return true;
          }

          return scrolled;
        }

        noProgressScrolls = 0;
        visitedSuggestionKeys.add(nextCandidate.key);
        pendingSuggestionTitle = normalizeVideoTitle(nextCandidate.title);

        const opened = await tryOpenSuggestionCandidate(nextCandidate.node, sourceVideoUrl);
        if (!opened) {
          addData({
            exploreDepth: currentDepth,
            lastSuggestionOpenFailure: {
              title: pendingSuggestionTitle,
              key: nextCandidate.key,
            },
          });
          await sleep(1200);
        }
        return true;
      } catch (error) {
        console.error('Explore hop failed:', error);
        addData({
          exploreDepth: currentDepth,
          exploreError: String(error),
        });
        await fail('EXPLORE_HOP_FAILED');
        return true;
      } finally {
        processingHop = false;
      }
    },
  },
} as const satisfies ScreenHandles<keyof typeof ExploreStageScreen>;

const ExploreStage = {
  name: 'Explore',
  maxSteps: DEFAULT_MAX_STEPS_PER_STAGE * 6,
  screens: ExploreStageScreen,
  screenHandles: ExploreHandles,
  defaultHandle: async () => {
    console.log('Explore stage: waiting for video page...');
    await sleep(2500);
  },
} as const satisfies Stage<typeof ExploreStageScreen>;

export default ExploreStage;
