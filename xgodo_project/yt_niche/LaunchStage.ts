/**
 * Launch Stage - Open Firefox and navigate to YouTube
 *
 * Flow:
 * 1. HomeScreen          → launch Firefox
 * 2. OpenInYouTubeDialog → dismiss "Open in YouTube" dialog (click Cancel)
 * 3. FirefoxOpen         → Firefox open but YouTube not loaded → navigate to YouTube
 * 4. YouTubeReady        → "Search YouTube" button visible → go to Search stage
 */

import { FIREFOX_PACKAGE, YOUTUBE_URL, DEFAULT_MAX_STEPS_PER_STAGE } from './config';
import { addData } from './data';
import { Stage, type ScreenHandles, setStage } from './Stage';
import { getAllNodes, isOnHomeScreen, clickNode } from './util';

// --- Screen definitions ---

const LaunchStageScreen = {
  HomeScreen: 'HomeScreen',
  OpenInYouTubeDialog: 'OpenInYouTubeDialog',
  FirefoxOpen: 'FirefoxOpen',
  YouTubeReady: 'YouTubeReady',
} as const;

// --- Helpers ---

/** True when the YouTube search button is visible — means YouTube is fully loaded */
function isYouTubeLoaded(allNodes: any[]): boolean {
  return allNodes.some((n: any) =>
    n.text === 'Search YouTube' &&
    n.className === 'android.widget.Button' &&
    n.packageName === FIREFOX_PACKAGE
  );
}

/** Navigate to YouTube by clicking the Firefox URL bar and typing the URL */
async function navigateToYouTube(allNodes: any[]): Promise<void> {
  const urlBar = allNodes.find((n: any) => n.viewId === 'ADDRESSBAR_URL_BOX');
  if (urlBar && urlBar.boundsInScreen) {
    await clickNode(urlBar);
  } else {
    // Fallback: tap URL bar by known coordinates
    await agent.utils.randomClick(180, 84, 807, 210);
  }
  await sleep(1000);
  await agent.actions.copyText(YOUTUBE_URL);
  await agent.actions.paste();
  await sleep(800);
  await agent.actions.inputKey(66); // KEYCODE_ENTER
  await sleep(4000);
  addData({ action: 'Navigated to YouTube URL' });
}

// --- Screen handlers ---

const LaunchHandles = {
  HomeScreen: {
    detectScreen: async (screenContent) => {
      return isOnHomeScreen(screenContent);
    },
    handleScreen: async () => {
      console.log('On home screen, launching Firefox...');
      await agent.actions.launchApp(FIREFOX_PACKAGE, true);
      await sleep(3000);
      addData({ action: 'Launched Firefox' });
      return true;
    },
  },

  OpenInYouTubeDialog: {
    detectScreen: async (screenContent) => {
      const allNodes = getAllNodes(screenContent);
      return allNodes.some((n: any) =>
        n.viewId === 'org.mozilla.firefox:id/alertTitle' &&
        n.text === 'Open in YouTube'
      );
    },
    handleScreen: async (screenContent) => {
      console.log('"Open in YouTube" dialog detected, clicking Cancel...');
      const allNodes = getAllNodes(screenContent);
      const cancelBtn = allNodes.find((n: any) =>
        n.viewId === 'android:id/button2' &&
        n.text === 'Cancel' &&
        n.clickable
      );
      if (cancelBtn && cancelBtn.boundsInScreen) {
        await clickNode(cancelBtn);
      } else {
        await agent.actions.goBack();
      }
      await sleep(1000);
      return true;
    },
  },

  // Firefox is open but YouTube is not loaded yet — navigate there
  FirefoxOpen: {
    detectScreen: async (screenContent) => {
      const allNodes = getAllNodes(screenContent);
      const inFirefox = allNodes.some((n: any) => n.packageName === FIREFOX_PACKAGE);
      if (!inFirefox) return false;
      return !isYouTubeLoaded(allNodes);
    },
    handleScreen: async (screenContent) => {
      console.log('Firefox open but YouTube not loaded, navigating...');
      const allNodes = getAllNodes(screenContent);
      await navigateToYouTube(allNodes);
      return true;
    },
  },

  // "Search YouTube" button is visible = YouTube is fully loaded
  YouTubeReady: {
    detectScreen: async (screenContent) => {
      const allNodes = getAllNodes(screenContent);
      return isYouTubeLoaded(allNodes);
    },
    handleScreen: async () => {
      console.log('YouTube ready in Firefox, transitioning to Search stage...');
      addData({ action: 'YouTube loaded' });
      await setStage(Stage.Search);
      return true;
    },
  },
} as const satisfies ScreenHandles<keyof typeof LaunchStageScreen>;

// --- Stage definition ---

const LaunchStage = {
  name: 'Launch',
  maxSteps: DEFAULT_MAX_STEPS_PER_STAGE,
  screens: LaunchStageScreen,
  screenHandles: LaunchHandles,
  defaultHandle: async () => {
    console.log('Starting Launch stage - going home then launching Firefox...');
    await agent.actions.goHome();
    await sleep(1000);
    await agent.actions.launchApp(FIREFOX_PACKAGE, true);
    await sleep(3000);
  },
} as const satisfies Stage<typeof LaunchStageScreen>;

export default LaunchStage;
