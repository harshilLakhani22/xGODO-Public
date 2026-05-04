
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
    agent.utils.randomClick(left, top, right, bottom);
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

export async function hideSystemUIs(screenContent: AndroidNode) {

  const notificationNode = (await agent.actions.allScreensContent()).flatMap(screen => getAllNodes(screen))
    .find(node => node.viewId === "com.android.systemui:id/expandableNotificationRow" && node.actions.includes(agent.constants.ACTION_DISMISS));

  if (notificationNode) {
    await agent.actions.nodeAction(
      notificationNode,
      agent.constants.ACTION_DISMISS,
    );
    await sleep(1000);
    return true;
  }

  const closeNode = screenContent
    .find(node => node.viewId === "android:id/aerr_close" && node.clickable);

  if (closeNode) {
    await agent.actions.nodeAction(
      closeNode,
      agent.constants.ACTION_CLICK,
    );
    await sleep(2000);
    return true;
  }

  const closeButton = screenContent.allNodes().every(node => node.packageName === PHONE_PACKAGE_NAME) &&
    screenContent.allNodes().find(node => ([`${PHONE_PACKAGE_NAME}:id/btn_ussd_dialog_cancel`, `${PHONE_PACKAGE_NAME}:id/btn_negative`, `${PHONE_PACKAGE_NAME}:id/btn_neutral`] as (string | undefined)[]).includes(node.viewId));

  if (closeButton) {
    if (closeButton.actions.includes(agent.constants.ACTION_CLICK)) {
      await agent.actions.nodeAction(
        closeButton,
        agent.constants.ACTION_CLICK,
      );
    } else {
      const { left, right, top, bottom } = closeButton.boundsInScreen;
      agent.utils.randomClick(left, top, right, bottom);
    }
    await sleep(5_000);
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