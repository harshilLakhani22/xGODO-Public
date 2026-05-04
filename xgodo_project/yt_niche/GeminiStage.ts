

import { FIREFOX_PACKAGE, DEFAULT_MAX_STEPS_PER_STAGE } from './config';
import { addData, getData, success } from './data';
import { Stage, type ScreenHandles, setStage } from './Stage';
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

interface ScoredVideo {
  title: string;
  url: string;
  score: number;
}

// Module-level flags
let analyzed = false;
let analyzing = false; // Prevents concurrent/repeated API calls while in-flight

async function callGeminiAPI(
  niche: string,
  apiKey: string,
  videos: any[],
  attempt = 1
): Promise<ScoredVideo[] | null> {
  const MAX_RETRIES = 5;
  const BASE_DELAY = 1500;

  const videoListJson = JSON.stringify(
    videos.map((v: any) => ({ title: v.title, url: v.url }))
  );
  const prompt = GEMINI_PROMPT
    .replace('$NICHE', niche)
    .replace('$VIDEO_LIST_JSON', videoListJson);

  console.log(`Calling Gemini API (model: ${GEMINI_MODEL}) for niche: "${niche}"... (attempt ${attempt})`);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      }
    );

    // Handle rate limit with exponential backoff
    if (response.status === 429) {
      if (attempt > MAX_RETRIES) {
        console.log('Max retries reached.');
        return null;
      }
      const delay = BASE_DELAY * Math.pow(2, attempt);
      console.log(`429 detected. Retrying in ${delay}ms (attempt ${attempt})`);
      await new Promise((r) => setTimeout(r, delay));
      return callGeminiAPI(niche, apiKey, videos, attempt + 1);
    }

    if (!response.ok) {
      console.log(`Gemini API error: ${response.status} ${response.statusText}`);
      return null;
    }

    const result = await response.json();
    const text: string = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log(`Gemini raw response: ${text.substring(0, 300)}`);

    try {
      return JSON.parse(text) as ScoredVideo[];
    } catch {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) return JSON.parse(match[0]) as ScoredVideo[];
      console.log('Failed to parse Gemini response as JSON');
      return null;
    }
  } catch (error) {
    console.log('Network error:', error);
    return null;
  }
}

// --- Screen definitions ---

const GeminiStageScreen = {
  Analyze: 'Analyze',
  BestVideo: 'BestVideo',
} as const;

// --- Screen handlers ---

const GeminiHandles = {
  /**
   * Call Gemini API to score videos and navigate to the best one
   */
  Analyze: {
    detectScreen: async (screenContent) => {
      if (analyzed || analyzing) return false; // Skip if done or in-flight
      const allNodes = getAllNodes(screenContent);
      return allNodes.some((n: any) => n.packageName === FIREFOX_PACKAGE);
    },
    handleScreen: async () => {
      if (analyzing) return true; // Already in-flight — tell main loop we're handling it

      analyzing = true;

      const { niche, apiKey } = agent.arguments.jobVariables;
      const collectedVideos = getData().collectedVideos || [];

      if (collectedVideos.length === 0) {
        console.log('No collected videos to analyze');
        analyzing = false;
        return false;
      }

      const scores = await callGeminiAPI(niche, apiKey, collectedVideos);

      if (!scores || scores.length === 0) {
        console.log('Gemini API returned no scores');
        analyzing = false;
        return false;
      }

      // Find the highest-scoring video
      const best = scores.reduce((top, curr) => curr.score > top.score ? curr : top);
      console.log(`Best video: "${best.title}" — score: ${best.score}`);

      addData({ geminiScores: scores, bestVideo: best });
      analyzed = true;
      analyzing = false;

      // Navigate — same approach as LaunchStage.navigateToYouTube:
      // click URL bar (coordinate tap), paste URL, press Enter
      const freshContent = await agent.actions.screenContent();
      const freshAllNodes = getAllNodes(freshContent);
      const urlBar = freshAllNodes.find((n: any) => n.viewId === 'ADDRESSBAR_URL_BOX');
      console.log(`Navigating to best video: ${best.url}`);
      if (urlBar && urlBar.boundsInScreen) {
        await clickNode(urlBar);
      } else {
        agent.utils.randomClick(180, 84, 807, 210); // fallback: tap URL bar area
      }
      await sleep(1000);
      await agent.actions.copyText(best.url);
      await agent.actions.paste();
      await sleep(800);
      await agent.actions.inputKey(66); // KEYCODE_ENTER
      await sleep(4000);

      // Poll until video page loads, dismissing "Open in YouTube" dialog if it appears
      for (let i = 0; i < 10; i++) {
        const checkContent = await agent.actions.screenContent();
        const checkNodes = getAllNodes(checkContent);

        // Dismiss "Open in YouTube" dialog (same as LaunchStage.OpenInYouTubeDialog)
        const openInYtDialog = checkNodes.find((n: any) =>
          n.viewId === 'org.mozilla.firefox:id/alertTitle' &&
          n.text === 'Open in YouTube'
        );
        if (openInYtDialog) {
          console.log('"Open in YouTube" dialog — clicking Cancel...');
          const cancelBtn = checkNodes.find((n: any) =>
            n.viewId === 'android:id/button2' && n.text === 'Cancel' && n.clickable
          );
          if (cancelBtn) {
            await clickNode(cancelBtn);
          } else {
            await agent.actions.goBack();
          }
          await sleep(1500);
          continue;
        }

        const urlBox = checkNodes.find((n: any) => n.viewId === 'ADDRESSBAR_URL_BOX');
        const urlDesc: string = urlBox?.description ?? '';
        console.log(`Nav check ${i + 1}/10: "${urlDesc.substring(0, 80)}"`);
        if (urlDesc.includes('youtube.com/shorts/') || urlDesc.includes('youtube.com/watch')) {
          console.log('Video page confirmed!');
          break;
        }
        await sleep(2000);
      }

      return true;
    },
  },

  /**
   * Best video page is loaded — either hand off to ExploreStage (if
   * loopNumber > 0) or submit success directly.
   */
  BestVideo: {
    detectScreen: async (screenContent) => {
      if (!analyzed) return false;
      const allNodes = getAllNodes(screenContent);
      const inFirefox = allNodes.some((n: any) => n.packageName === FIREFOX_PACKAGE);
      if (!inFirefox) return false;

      // Regular video page: "Share this video" button present
      const onVideoPage = allNodes.some((n: any) =>
        n.text === 'Share this video' &&
        n.className === 'android.widget.Button'
      );
      if (onVideoPage) return true;

      // Shorts or regular video: URL bar contains a YouTube video URL
      const urlBox = allNodes.find((n: any) => n.viewId === 'ADDRESSBAR_URL_BOX');
      const urlDesc = urlBox?.description ?? '';
      return urlDesc.includes('youtube.com/shorts/') || urlDesc.includes('youtube.com/watch');
    },
    handleScreen: async () => {
      const { keyword, niche, loopNumber } = agent.arguments.jobVariables;
      const { bestVideo, geminiScores, collectedVideos } = getData();
      const loopCount = Number(loopNumber) || 0;

      if (loopCount > 0) {
        console.log(`Best video loaded. Starting Explore stage (${loopCount} hop(s))...`);
        await setStage(Stage.Explore);
        return true;
      }

      console.log('Best video loaded, task complete!');
      await success({ keyword, niche, bestVideo, geminiScores, collectedVideos });
      return true;
    },
  },
} as const satisfies ScreenHandles<keyof typeof GeminiStageScreen>;

// --- Stage definition ---

const GeminiStage = {
  name: 'Gemini',
  maxSteps: DEFAULT_MAX_STEPS_PER_STAGE,
  screens: GeminiStageScreen,
  screenHandles: GeminiHandles,
  defaultHandle: async () => {
    console.log('Gemini stage default: waiting...');
    await sleep(2000);
  },
} as const satisfies Stage<typeof GeminiStageScreen>;

export default GeminiStage;