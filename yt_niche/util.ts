
import { addData } from './data';
import { safeAllScreensContent } from './helpers';

const PHONE_PACKAGE_NAME = 'com.android.phone';

/** Get device screen dimensions */
export function getDeviceScreen(): { width: number; height: number } {
  const info = agent.info.getDeviceInfo();
  return { width: info.width, height: info.height };
}

/** OCR line with text and bounding box (in screen coordinates) */
export interface OcrLine {
  text: string;
  boundingBox?: { left: number; top: number; right: number; bottom: number };
}

/** OCR result with full text and lines with bounding boxes */
export interface OcrResult {
  text: string;
  lines: OcrLine[];
}

/**
 * Take a screenshot and run built-in OCR to extract text from the screen.
 * Bounding boxes are scaled back to actual screen coordinates.
 */
export async function performOCR(): Promise<OcrResult | null> {
  try {
    const { width, height } = getDeviceScreen();
    const ss = await agent.actions.screenshot(width, height, 80);
    if (!ss?.screenshot) {
      console.log('OCR: screenshot failed');
      return null;
    }

    const scaleX = ss.originalWidth / ss.compressedWidth;
    const scaleY = ss.originalHeight / ss.compressedHeight;

    const result = await agent.actions.recognizeText(ss.screenshot);
    const text = result.text || '';
    const lines: OcrLine[] = result.textBlocks?.flatMap((b: any) =>
      b.lines.map((l: any) => {
        const bb = l.boundingBox;
        return {
          text: l.text as string,
          boundingBox: bb ? {
            left: Math.round(bb.left * scaleX),
            top: Math.round(bb.top * scaleY),
            right: Math.round(bb.right * scaleX),
            bottom: Math.round(bb.bottom * scaleY),
          } : undefined,
        };
      })
    ) || [];
    return { text, lines };
  } catch (err) {
    console.error(`OCR error: ${err}`);
    return null;
  }
}

/**
 * Find an OCR line matching a pattern and tap its center.
 * Returns true if found and tapped.
 */
export async function tapOcrText(
  lines: OcrLine[],
  pattern: string | ((text: string) => boolean),
): Promise<boolean> {
  const match = lines.find(l => {
    if (!l.boundingBox) return false;
    const lower = l.text.toLowerCase();
    return typeof pattern === 'string' ? lower.includes(pattern) : pattern(lower);
  });
  if (match?.boundingBox) {
    const { left, top, right, bottom } = match.boundingBox;
    console.log(`OCR tap: "${match.text}" at [${left},${top},${right},${bottom}]`);
    await agent.utils.randomClick(left, top, right, bottom);
    return true;
  }
  return false;
}

/**
 * Returns all nodes from a screen content object
 */
export function getAllNodes(screenContent: AndroidNode): any[] {
  return screenContent.allNodes();
}

/**
 * Returns true if the device is currently showing the home/launcher screen
 */
export function isOnHomeScreen(screenContent: AndroidNode): boolean {
  const nodes = screenContent.allNodes();
  const launcherPackages = [
    'com.android.launcher',
    'com.android.launcher2',
    'com.android.launcher3',
    'com.google.android.apps.nexuslauncher',
    'com.sec.android.app.launcher',
    'com.miui.home',
    'com.huawei.android.launcher',
  ];
  return nodes.some((n: any) =>
    launcherPackages.some(pkg => n.packageName?.startsWith(pkg))
  );
}

/**
 * Clicks a node using its boundsInScreen coordinates
 */
export async function clickNode(node: any): Promise<void> {
  const { left, right, top, bottom } = node.boundsInScreen;
  await agent.utils.randomClick(left, top, right, bottom);
}

function normalizeUiText(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function nodeUiText(node: any): string {
  return [node?.text, node?.description, node?.hintText]
    .map(normalizeUiText)
    .filter(Boolean)
    .join(' ');
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

function findNodeByStandaloneText(allNodes: any[], value: string): any | undefined {
  const target = value.trim().toLowerCase();
  return allNodes.find((node: any) => {
    const text = normalizeUiText(node?.text);
    const description = normalizeUiText(node?.description);
    return text === target || description === target;
  });
}

function findSelectableNodeOnSameRow(allNodes: any[], targetNode: any): any | undefined {
  if (!targetNode?.boundsInScreen) return undefined;

  const targetBounds = targetNode.boundsInScreen;
  const centerY = (targetBounds.top + targetBounds.bottom) / 2;

  return allNodes.find((node: any) =>
    node !== targetNode &&
    node.boundsInScreen &&
    node.boundsInScreen.left >= targetBounds.right - 16 &&
    node.boundsInScreen.top <= centerY &&
    node.boundsInScreen.bottom >= centerY &&
    (
      node.clickable ||
      (Array.isArray(node.actions) && (
        node.actions.includes(agent.constants.ACTION_CLICK) ||
        node.actions.includes(16) ||
        node.actions.includes(4)
      ))
    )
  );
}

async function getVisibleNodes(screenContent: AndroidNode): Promise<any[]> {
  const currentNodes = getAllNodes(screenContent);

  const allScreens = await safeAllScreensContent();
  if (allScreens.length > 0) {
    return allScreens.flatMap((screen: any) => getAllNodes(screen));
  }

  return currentNodes;
}

function isFirefoxDefaultBrowserPromptByNodes(allNodes: any[]): boolean {
  const textPool = allNodes.map(nodeUiText).join(' ');
  const hasFirefox = textPool.includes('firefox');
  const hasBrowserPrompt = textPool.includes('default browser') || textPool.includes('browser app');
  const hasChoiceContext = textPool.includes('chrome') || textPool.includes('current default');
  const hasAction = textPool.includes('set as default') || textPool.includes('cancel');

  return hasFirefox && hasAction && (hasBrowserPrompt || hasChoiceContext);
}

function isFirefoxDefaultBrowserPromptByOcrText(text: string): boolean {
  const normalized = normalizeUiText(text);
  if (!normalized) return false;

  return (
    normalized.includes('firefox') &&
    (normalized.includes('default browser') || normalized.includes('browser app')) &&
    (normalized.includes('set as default') || normalized.includes('cancel'))
  );
}

function detectFirefoxOnboardingAction(allNodes: any[]): {
  actionLabel: 'continue' | 'not now';
  step: string;
} | null {
  const textPool = allNodes.map(nodeUiText).join(' ');
  if (!textPool.includes('firefox')) return null;

  if (textPool.includes('welcome to firefox')) {
    return { actionLabel: 'continue', step: 'welcome' };
  }
  if (textPool.includes('add firefox widget') || textPool.includes('more private')) {
    return { actionLabel: 'not now', step: 'widget_prompt' };
  }
  if (textPool.includes('instantly pick up where you left off') || textPool.includes('start synchronising')) {
    return { actionLabel: 'not now', step: 'sync_prompt' };
  }
  if (textPool.includes('choose your address bar')) {
    return { actionLabel: 'continue', step: 'address_bar_choice' };
  }

  return null;
}

function findActionButtonByLabel(allNodes: any[], label: string): any | undefined {
  const target = label.trim().toLowerCase();
  const direct = allNodes.find((node: any) =>
    node.clickable && normalizeUiText(node?.text) === target
  );
  if (direct) return direct;

  const labelNode = findNodeByStandaloneText(allNodes, label);
  if (!labelNode) return undefined;

  return (
    findClickableContainerForNode(allNodes, labelNode) ||
    findSelectableNodeOnSameRow(allNodes, labelNode) ||
    labelNode
  );
}

export async function handleFirefoxOnboarding(screenContent: AndroidNode): Promise<boolean> {
  const allNodes = await getVisibleNodes(screenContent);
  const step = detectFirefoxOnboardingAction(allNodes);
  if (!step) return false;

  console.log(`[FirefoxOnboarding] Detected step: ${step.step}. Clicking "${step.actionLabel}"`);
  addData({
    firefoxOnboardingStep: step.step,
    firefoxOnboardingAction: step.actionLabel,
  });

  const actionButton = findActionButtonByLabel(allNodes, step.actionLabel);
  if (actionButton?.boundsInScreen) {
    await clickBestEffort(actionButton);
    await sleep(1300);
    return true;
  }

  const ocr = await performOCR();
  if (ocr && await tapOcrText(ocr.lines, t => t.trim() === step.actionLabel)) {
    await sleep(1300);
    return true;
  }

  return false;
}

export async function isFirefoxDefaultBrowserPrompt(screenContent: AndroidNode): Promise<boolean> {
  const allNodes = await getVisibleNodes(screenContent);
  if (isFirefoxDefaultBrowserPromptByNodes(allNodes)) {
    return true;
  }

  const ocr = await performOCR();
  return !!ocr && isFirefoxDefaultBrowserPromptByOcrText(ocr.text);
}



function findCancelButton(allNodes: any[]): any | undefined {
  const direct = allNodes.find((node: any) =>
    node.clickable &&
    nodeUiText(node).includes('cancel')
  );
  if (direct) return direct;

  const labelNode = allNodes.find((node: any) => nodeUiText(node).includes('cancel'));
  return labelNode ? findClickableContainerForNode(allNodes, labelNode) : undefined;
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

export async function handleFirefoxDefaultBrowserPrompt(screenContent: AndroidNode): Promise<boolean> {
  const allNodes = await getVisibleNodes(screenContent);
  let promptDetected = isFirefoxDefaultBrowserPromptByNodes(allNodes);

  if (!promptDetected) {
    const initialOcr = await performOCR();
    promptDetected = !!initialOcr && isFirefoxDefaultBrowserPromptByOcrText(initialOcr.text);
    if (!promptDetected) {
      return false;
    }
  }

  console.log('Default-browser chooser detected. Clicking Cancel...');

  addData({
    defaultBrowserPromptOutcome: 'started',
  });

  const cancelButton = findCancelButton(allNodes);
  if (cancelButton) {
    await clickBestEffort(cancelButton);
    await sleep(1200);
    
    if (!await isFirefoxDefaultBrowserPrompt(await agent.actions.screenContent())) {
      addData({ defaultBrowserPromptOutcome: 'cancelled' });
      return true;
    }
  }

  const ocr = await performOCR();
  if (ocr) {
    if (await tapOcrText(ocr.lines, t => t.includes('cancel'))) {
      await sleep(1200);
      if (!await isFirefoxDefaultBrowserPrompt(await agent.actions.screenContent())) {
        addData({ defaultBrowserPromptOutcome: 'cancelled_ocr' });
        return true;
      }
    }
  }

  // Ultimate fallback: go back to dismiss the prompt.
  await agent.actions.goBack();
  await sleep(1200);
  const dismissed = !await isFirefoxDefaultBrowserPrompt(await agent.actions.screenContent());
  addData({
    defaultBrowserPromptOutcome: dismissed ? 'dismissed_back' : 'failed',
  });
  return dismissed;
}

export async function hideSystemUIs(screenContent: AndroidNode) {

  const notificationNode = (await safeAllScreensContent()).flatMap((screen: any) => getAllNodes(screen))
    .find((node: any) => node.viewId === "com.android.systemui:id/expandableNotificationRow" && node.actions.includes(agent.constants.ACTION_DISMISS));

  if (notificationNode) {
    await agent.actions.nodeAction(
      notificationNode,
      agent.constants.ACTION_DISMISS,
    );
    await sleep(1000);
    return true;
  }

  const closeNode = screenContent
    .find((node: any) => node.viewId === "android:id/aerr_close" && node.clickable);

  if (closeNode) {
    await agent.actions.nodeAction(
      closeNode,
      agent.constants.ACTION_CLICK,
    );
    await sleep(2000);
    return true;
  }

  const closeButton = screenContent.allNodes().every((node: any) => node.packageName === PHONE_PACKAGE_NAME) &&
    screenContent.allNodes().find((node: any) => ([`${PHONE_PACKAGE_NAME}:id/btn_ussd_dialog_cancel`, `${PHONE_PACKAGE_NAME}:id/btn_negative`, `${PHONE_PACKAGE_NAME}:id/btn_neutral`] as (string | undefined)[]).includes(node.viewId));

  if (closeButton) {
    if (closeButton.actions.includes(agent.constants.ACTION_CLICK)) {
      await agent.actions.nodeAction(
        closeButton,
        agent.constants.ACTION_CLICK,
      );
    } else {
      const { left, right, top, bottom } = closeButton.boundsInScreen;
      await agent.utils.randomClick(left, top, right, bottom);
    }
    await sleep(5_000);
    return true;
  }

  if (await handleFirefoxOnboarding(screenContent)) {
    return true;
  }

  if (await handleFirefoxDefaultBrowserPrompt(screenContent)) {
    return true;
  }

  // OCR fallback: tap permission dialog buttons missed by accessibility tree
  const ocr = await performOCR();
  if (ocr) {
    const tapped = await tapOcrText(ocr.lines, t =>
      t === 'allow' ||
      t === 'while using the app' ||
      t === 'only this time' ||
      t === 'allow all the time',
    );
    if (tapped) {
      await sleep(1500);
      return true;
    }
  }

  return false;

}
