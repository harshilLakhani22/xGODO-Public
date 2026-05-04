import { DEFAULT_MAX_STEPS_PER_STAGE } from './config';
import { addData, fail, getData, success } from './data';
import {
  isGeminiApiError,
  pickBestScored,
  scoreCandidatesWithGemini,
  toGeminiFailureCode,
} from './gemini';
import { getResolvedInputs } from './inputs';
import { Stage, type ScreenHandles, setStage } from './Stage';
import { type ResultRow, type VideoLink } from './types';
import { getAllNodes } from './util';
import { isYoutubeVideoPage, openUrlInFirefox, waitForYoutubeVideoPage } from './youtube';
import { isFirefoxPackageName } from './browser';

interface RankedSearchVideo extends VideoLink {
  id: string;
  score: number;
}

const GeminiStageScreen = {
  Analyze: 'Analyze',
  BestVideo: 'BestVideo',
} as const;

let analyzed = false;
let analyzing = false;
let activeRunId = '';

function resetStateIfNeeded() {
  const runId = String(getData().runId || '');
  if (runId && runId !== activeRunId) {
    activeRunId = runId;
    analyzed = false;
    analyzing = false;
  }
}

function getSearchCandidates(): VideoLink[] {
  const data = getData();
  if (Array.isArray(data.searchCandidates)) {
    return data.searchCandidates as VideoLink[];
  }
  if (Array.isArray(data.collectedVideos)) {
    return data.collectedVideos as VideoLink[];
  }
  return [];
}

const GeminiHandles = {
  Analyze: {
    detectScreen: async (screenContent) => {
      resetStateIfNeeded();
      if (analyzed || analyzing) return false;
      const allNodes = getAllNodes(screenContent);
      return allNodes.some((node: any) => isFirefoxPackageName(node.packageName));
    },

    handleScreen: async () => {
      resetStateIfNeeded();
      if (analyzing) return true;
      analyzing = true;

      try {
        const inputs = getResolvedInputs();
        const searchCandidates = getSearchCandidates();
        if (searchCandidates.length === 0) {
          addData({ geminiError: 'No collected search results to score' });
          await fail('NO_SEARCH_RESULTS_TO_SCORE');
          return true;
        }

        const candidates = searchCandidates.map((video, index) => ({
          id: `search-${index}`,
          title: video.title,
        }));

        const scoredCandidates = await scoreCandidatesWithGemini({
          niche: inputs.niche,
          apiKey: inputs.geminiApiKey,
          model: inputs.geminiModel,
          candidates,
          contextLabel: 'initial search scoring',
        });

        const scoreMap = new Map<string, number>();
        scoredCandidates.forEach(item => scoreMap.set(item.id, item.score));

        const rankedSearchVideos: RankedSearchVideo[] = searchCandidates.map((video, index) => {
          const id = `search-${index}`;
          return {
            id,
            title: video.title,
            url: video.url,
            score: scoreMap.get(id) ?? 0,
          };
        });

        const best = pickBestScored(rankedSearchVideos);

        const firstResult: ResultRow = {
          title: best.title,
          link: best.url,
          url: best.url,
          niche: inputs.niche,
          matchScore: best.score,
          step: 0,
          source: 'search_result',
        };

        addData({
          searchScoredVideos: rankedSearchVideos.map(video => ({
            title: video.title,
            url: video.url,
            matchScore: video.score,
          })),
          bestVideo: {
            title: best.title,
            url: best.url,
            score: best.score,
          },
          results: [firstResult],
        });

        const navigated = await openUrlInFirefox(best.url);
        const loaded = navigated && await waitForYoutubeVideoPage();
        if (!loaded) {
          addData({ navigationError: 'Best video page did not load in time' });
          await fail('BEST_VIDEO_NAVIGATION_FAILED');
          return true;
        }

        analyzed = true;
        return true;
      } catch (error) {
        console.error('Gemini analyze failed:', error);
        if (isGeminiApiError(error)) {
          addData({
            geminiFailureStage: 'search_scoring',
            geminiFailureKind: error.kind,
            geminiFailureStatus: error.googleStatus || error.googleReason || error.httpStatus || '',
            geminiError: error.message,
          });
          await fail(toGeminiFailureCode(error, 'search_scoring'));
          return true;
        }

        addData({
          geminiFailureStage: 'search_scoring',
          geminiFailureKind: 'unknown',
          geminiError: String(error),
        });
        await fail('GEMINI_SEARCH_SCORING_FAILED');
        return true;
      } finally {
        analyzing = false;
      }
    },
  },

  BestVideo: {
    detectScreen: async (screenContent) => {
      resetStateIfNeeded();
      if (!analyzed) return false;
      return isYoutubeVideoPage(getAllNodes(screenContent));
    },

    handleScreen: async () => {
      const inputs = getResolvedInputs();

      if (inputs.loopCount > 0) {
        await setStage(Stage.Explore);
        return true;
      }

      const results = Array.isArray(getData().results) ? getData().results : [];
      await success({
        keyword: inputs.keyword,
        niche: inputs.niche,
        results,
      });
      return true;
    },
  },
} as const satisfies ScreenHandles<keyof typeof GeminiStageScreen>;

const GeminiStage = {
  name: 'Gemini',
  maxSteps: DEFAULT_MAX_STEPS_PER_STAGE,
  screens: GeminiStageScreen,
  screenHandles: GeminiHandles,
  defaultHandle: async () => {
    console.log('Gemini stage: waiting...');
    await sleep(2000);
  },
} as const satisfies Stage<typeof GeminiStageScreen>;

export default GeminiStage;
