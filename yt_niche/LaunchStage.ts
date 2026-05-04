import { DEFAULT_MAX_STEPS_PER_STAGE, YOUTUBE_URL } from './config';
import { addData } from './data';
import { Stage, type ScreenHandles, setStage } from './Stage';
import { getFirefoxPackage, isFirefoxPackageName } from './browser';
import {
  clickNode,
  getAllNodes,
  handleFirefoxOnboarding,
  handleFirefoxDefaultBrowserPrompt as handleSharedFirefoxDefaultBrowserPrompt,
  isFirefoxDefaultBrowserPrompt as isSharedFirefoxDefaultBrowserPrompt,
  isOnHomeScreen,
  performOCR,
  tapOcrText,
} from './util';
import {
  getYoutubeReadyMode,
  isFirefoxStartPage,
  isYoutubeReadyPage,
  openUrlInFirefox,
} from './youtube';

const LaunchStageScreen = {
  HomeScreen: 'HomeScreen',
  OpenInYouTubeDialog: 'OpenInYouTubeDialog',
  DefaultBrowserPrompt: 'DefaultBrowserPrompt',
  ContinueScreen: 'ContinueScreen',
  FirefoxStartPage: 'FirefoxStartPage',
  FirefoxOpen: 'FirefoxOpen',
  YouTubeReady: 'YouTubeReady',
} as const;

function normalizeText(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function nodeText(node: any): string {
  return [node?.text, node?.description, node?.hintText]
    .map(normalizeText)
    .filter(Boolean)
    .join(' ');
}

function isYouTubeLoaded(allNodes: any[]): boolean {
  return isYoutubeReadyPage(allNodes);
}

async function navigateToYouTube(): Promise<boolean> {
  const navigated = await openUrlInFirefox(YOUTUBE_URL, {
    successFallback: isYoutubeReadyPage,
  });
  addData({
    action: navigated ? 'Navigated to YouTube URL' : 'Failed to navigate to YouTube URL',
  });
  return navigated;
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

function findNodeByExactText(allNodes: any[], value: string): any | undefined {
  const target = value.trim().toLowerCase();
  return allNodes.find((node: any) => normalizeText(node?.text) === target);
}

function findClickableByExactText(allNodes: any[], value: string): any | undefined {
  const target = value.trim().toLowerCase();
  const direct = allNodes.find((node: any) =>
    node.clickable &&
    normalizeText(node?.text) === target
  );
  if (direct) return direct;

  const labelNode = findNodeByExactText(allNodes, value);
  return labelNode ? findClickableContainerForNode(allNodes, labelNode) : undefined;
}

function findContinueButton(allNodes: any[]): any | undefined {
  return findClickableByExactText(allNodes, 'continue');
}

function findNotNowButton(allNodes: any[]): any | undefined {
  return findClickableByExactText(allNodes, 'not now') || findClickableByExactText(allNodes, 'skip');
}

function isWelcomeContinueScreen(allNodes: any[]): boolean {
  const hasWelcome = allNodes.some((node: any) => nodeText(node).includes('welcome to firefox'));
  const hasContinueText = allNodes.some((node: any) => normalizeText(node?.text) === 'continue');
  return hasWelcome && hasContinueText;
}

async function isDefaultBrowserPrompt(screenContent: AndroidNode): Promise<boolean> {
  return isSharedFirefoxDefaultBrowserPrompt(screenContent);
}

async function clickBestEffort(node: any): Promise<boolean> {
  if (!node?.boundsInScreen) return false;
  if (Array.isArray(node.actions) && node.actions.includes(agent.constants.ACTION_CLICK)) {
    await agent.actions.nodeAction(node, agent.constants.ACTION_CLICK);
  } else {
    await clickNode(node);
  }
  return true;
}

async function handleDefaultBrowserPrompt(screenContent: AndroidNode): Promise<boolean> {
  const handled = await handleSharedFirefoxDefaultBrowserPrompt(screenContent);
  if (handled) {
    addData({ action: 'Set Firefox as default browser' });
  }
  return handled;
}

function isOpenInYouTubeDialog(allNodes: any[]): boolean {
  return allNodes.some((node: any) =>
    node.viewId === 'org.mozilla.firefox:id/alertTitle' &&
    normalizeText(node.text) === 'open in youtube'
  );
}

async function tryDismissFirefoxInterruption(screenContent: AndroidNode): Promise<boolean> {
  const allNodes = getAllNodes(screenContent);

  if (await handleFirefoxOnboarding(screenContent)) {
    console.log('Firefox interruption: onboarding flow handled.');
    return true;
  }

  if (await isDefaultBrowserPrompt(screenContent)) {
    return handleDefaultBrowserPrompt(screenContent);
  }

  const notNowButton = findNotNowButton(allNodes);
  if (notNowButton) {
    console.log('Firefox interruption: Not now screen detected.');
    await clickBestEffort(notNowButton);
    await sleep(1400);
    return true;
  }

  const continueButton = findContinueButton(allNodes);
  if (isWelcomeContinueScreen(allNodes) || continueButton) {
    console.log('Firefox interruption: welcome/continue screen detected.');
    if (continueButton) {
      await clickBestEffort(continueButton);
      await sleep(1400);
      return true;
    }

    const ocr = await performOCR();
    if (ocr) {
      if (await tapOcrText(ocr.lines, t => t.trim() === 'not now')) {
        await sleep(1400);
        return true;
      }
      if (await tapOcrText(ocr.lines, t => t.trim() === 'continue')) {
        await sleep(1400);
        return true;
      }
    }
  }

  return false;
}

const LaunchHandles = {
  HomeScreen: {
    detectScreen: async (screenContent) => {
      return isOnHomeScreen(screenContent);
    },
    handleScreen: async () => {
      console.log('On home screen, launching Firefox...');
      await agent.actions.launchApp(getFirefoxPackage(), true);
      await sleep(3000);
      addData({ action: 'Launched Firefox' });
      return true;
    },
  },

  OpenInYouTubeDialog: {
    detectScreen: async (screenContent) => {
      return isOpenInYouTubeDialog(getAllNodes(screenContent));
    },
    handleScreen: async (screenContent) => {
      console.log('"Open in YouTube" dialog detected, clicking Cancel...');
      const allNodes = getAllNodes(screenContent);
      const cancelBtn = allNodes.find((node: any) =>
        node.viewId === 'android:id/button2' &&
        normalizeText(node.text) === 'cancel' &&
        node.clickable
      );
      if (cancelBtn?.boundsInScreen) {
        await clickNode(cancelBtn);
      } else {
        await agent.actions.goBack();
      }
      await sleep(1000);
      return true;
    },
  },

  DefaultBrowserPrompt: {
    detectScreen: async (screenContent) => {
      return isDefaultBrowserPrompt(screenContent);
    },
    handleScreen: async (screenContent) => {
      return handleDefaultBrowserPrompt(screenContent);
    },
  },

  ContinueScreen: {
    detectScreen: async (screenContent) => {
      const allNodes = getAllNodes(screenContent);
      return isWelcomeContinueScreen(allNodes) || !!findContinueButton(allNodes) || !!findNotNowButton(allNodes);
    },
    handleScreen: async (screenContent) => {
      const allNodes = getAllNodes(screenContent);
      
      const notNowButton = findNotNowButton(allNodes);
      if (notNowButton) {
        console.log('Firefox onboarding screen detected, clicking Not now...');
        await clickBestEffort(notNowButton);
        await sleep(1500);
        return true;
      }

      const continueButton = findContinueButton(allNodes);
      if (!continueButton) {
        const ocr = await performOCR();
        if (ocr) {
          if (await tapOcrText(ocr.lines, t => t.trim() === 'not now')) {
            await sleep(1200);
            return true;
          }
          if (await tapOcrText(ocr.lines, t => t.trim() === 'continue')) {
            await sleep(1200);
            return true;
          }
        }
        return false;
      }

      console.log('Firefox continue screen detected, clicking Continue...');
      await clickBestEffort(continueButton);
      await sleep(1500);
      return true;
    },
  },

  FirefoxStartPage: {
    detectScreen: async (screenContent) => {
      return isFirefoxStartPage(getAllNodes(screenContent));
    },
    handleScreen: async () => {
      console.log('Firefox start page detected, navigating directly to YouTube...');
      return navigateToYouTube();
    },
  },

  FirefoxOpen: {
    detectScreen: async (screenContent) => {
      const allNodes = getAllNodes(screenContent);
      const inFirefox = allNodes.some((node: any) => isFirefoxPackageName(node.packageName));
      if (!inFirefox) return false;
      return !isYouTubeLoaded(allNodes);
    },
    handleScreen: async (screenContent) => {
      if (await tryDismissFirefoxInterruption(screenContent)) {
        return true;
      }
      console.log('Firefox open but YouTube not loaded, navigating...');
      return navigateToYouTube();
    },
  },

  YouTubeReady: {
    detectScreen: async (screenContent) => {
      return isYoutubeReadyPage(getAllNodes(screenContent));
    },
    handleScreen: async (screenContent) => {
      const readyMode = getYoutubeReadyMode(getAllNodes(screenContent));
      console.log('YouTube ready in Firefox, transitioning to Search stage...');
      addData({
        action: 'YouTube loaded',
        youtubeReadyMode: readyMode ?? 'url_verified',
      });
      await setStage(Stage.Search);
      return true;
    },
  },
} as const satisfies ScreenHandles<keyof typeof LaunchStageScreen>;

const LaunchStage = {
  name: 'Launch',
  maxSteps: DEFAULT_MAX_STEPS_PER_STAGE,
  screens: LaunchStageScreen,
  screenHandles: LaunchHandles,
  defaultHandle: async () => {
    console.log('Starting Launch stage - going home then launching Firefox...');
    await agent.actions.goHome();
    await sleep(1000);
    await agent.actions.launchApp(getFirefoxPackage(), true);
    await sleep(3000);
  },
} as const satisfies Stage<typeof LaunchStageScreen>;

export default LaunchStage;
