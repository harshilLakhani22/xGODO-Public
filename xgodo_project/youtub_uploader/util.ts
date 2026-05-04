
const PHONE_PACKAGE_NAME = 'com.android.phone';

/**
 * Flatten screen content into a flat array of nodes.
 * Works with single screen objects, arrays, or nested structures.
 */
export function getAllNodesFlat(screen: any): any[] {
  if (!screen) return [];
  if (Array.isArray(screen)) return screen.flatMap(getAllNodesFlat);
  if (typeof screen.allNodes === 'function') return screen.allNodes();
  if (Array.isArray(screen.nodes)) return screen.nodes;
  return [];
}

export async function hideSystemUIs(screenContent: AndroidNode) {

  const notificationNode = (await agent.actions.allScreensContent()).flatMap((screen: any) => getAllNodes(screen))
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
      agent.utils.randomClick(left, top, right, bottom);
    }
    await sleep(5_000);
    return true;
  }

  return false;

}

/**
 * Wait for a node (returned by findFn) to have stable boundsInScreen
 * across multiple samples. Prevents clicking during animation/transition.
 *
 * @param findFn  - async function that returns the target node or null
 * @param samples - number of consecutive stable readings required (default 3)
 * @param intervalMs - delay between readings (default 200ms)
 * @returns the stable node, or null if bounds never stabilize
 */
export async function waitForStableNode(
  findFn: () => Promise<any | null>,
  samples: number = 3,
  intervalMs: number = 200,
): Promise<any | null> {
  let lastBounds: { left: number; right: number; top: number; bottom: number } | null = null;
  let stableCount = 0;
  let lastNode: any = null;

  const maxAttempts = samples * 3; // give extra room for instability
  for (let i = 0; i < maxAttempts && stableCount < samples; i++) {
    const node = await findFn();
    if (!node || !node.boundsInScreen) {
      lastBounds = null;
      stableCount = 0;
      lastNode = null;
      await sleep(intervalMs);
      continue;
    }

    const b = node.boundsInScreen;
    if (
      lastBounds &&
      b.left === lastBounds.left &&
      b.right === lastBounds.right &&
      b.top === lastBounds.top &&
      b.bottom === lastBounds.bottom
    ) {
      stableCount++;
      lastNode = node;
    } else {
      stableCount = 1;
      lastBounds = { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
      lastNode = node;
    }

    await sleep(intervalMs);
  }

  if (stableCount >= samples) {
    console.log(`[waitForStableNode] Node stable after ${stableCount} readings, bounds:`, JSON.stringify(lastBounds));
    return lastNode;
  }

  console.warn(`[waitForStableNode] Node never stabilized (got ${stableCount}/${samples} stable readings)`);
  return null;
}

/**
 * Hide the on-screen keyboard if visible.
 * Tries agent.actions.hideKeyboard() first, then falls back to tapping
 * a neutral area at the top-center of the screen.
 *
 * @returns true if a hide action was attempted
 */
export async function hideKeyboardIfVisible(): Promise<boolean> {
  try {
    // Check if keyboard is visible by looking for keyboard-related nodes
    const screens = await agent.actions.allScreensContent();
    const flat = screens.flatMap((s: any) => getAllNodesFlat(s));
    const hasKeyboard = flat.some(
      (n: any) =>
        (n.className && /input.?method|keyboard/i.test(n.className)) ||
        (n.packageName && /inputmethod|keyboard/i.test(n.packageName))
    );

    if (!hasKeyboard) {
      console.log('[hideKeyboardIfVisible] No keyboard detected');
      return false;
    }

    // Try agent's built-in hideKeyboard
    if (typeof agent.actions.hideKeyboard === 'function') {
      console.log('[hideKeyboardIfVisible] Using agent.actions.hideKeyboard()');
      await agent.actions.hideKeyboard();
      await sleep(400);
      return true;
    }

    // Fallback: tap a neutral spot at top-center
    console.log('[hideKeyboardIfVisible] Fallback: tapping neutral area to dismiss');
    const display = typeof agent.actions.getDisplaySize === 'function'
      ? await agent.actions.getDisplaySize()
      : { width: 1080, height: 2400 };
    const tapX = Math.floor(display.width / 2);
    const tapY = Math.floor(display.height * 0.15); // 15% from top
    await agent.actions.click(tapX, tapY);
    await sleep(400);
    return true;
  } catch (e) {
    console.warn('[hideKeyboardIfVisible] Error:', e);
    return false;
  }
}

/**
 * Capture debug artifacts (screen JSON + screenshot + candidate dump)
 * for diagnosing upload-button failures.
 *
 * @param label  - descriptive label for log grouping
 * @param candidates - optional array of candidate nodes to dump
 */
export async function captureDebugArtifacts(
  label: string,
  candidates?: any[],
): Promise<void> {
  const ts = Date.now();
  try {
    // Capture screen content
    const screens = await agent.actions.allScreensContent();
    const flat = screens.flatMap((s: any) => getAllNodesFlat(s));
    console.error(`[DEBUG ${label}] Screen nodes count: ${flat.length}`);

    // Log candidate nodes
    if (candidates && candidates.length > 0) {
      console.error(`[DEBUG ${label}] Candidate nodes (${candidates.length}):`);
      for (const c of candidates.slice(0, 10)) {
        console.error(
          `  text="${c.text}" desc="${c.description}" resourceId="${c.resourceId || c.viewId}" ` +
          `bounds=${JSON.stringify(c.boundsInScreen)} enabled=${c.isEnabled} clickable=${c.clickable}`
        );
      }
    } else {
      console.error(`[DEBUG ${label}] No candidate nodes found`);
    }

    // Capture screenshot
    try {
      const ss = await agent.actions.screenshot(1024, 1024, 100);
      console.error(`[DEBUG ${label}] Screenshot captured (${ss?.screenshot?.length || 0} bytes base64)`);
    } catch (ssErr) {
      console.error(`[DEBUG ${label}] Screenshot failed:`, ssErr);
    }

    // Log a summary of all clickable nodes near the bottom of the screen
    const displayHeight = 2400; // reasonable default
    const bottomNodes = flat.filter(
      (n: any) =>
        n.clickable &&
        n.boundsInScreen &&
        n.boundsInScreen.bottom > displayHeight * 0.7
    );
    if (bottomNodes.length > 0) {
      console.error(`[DEBUG ${label}] Bottom-area clickable nodes (${bottomNodes.length}):`);
      for (const n of bottomNodes.slice(0, 8)) {
        console.error(
          `  text="${n.text}" desc="${n.description}" id="${n.resourceId || n.viewId}" ` +
          `bounds=${JSON.stringify(n.boundsInScreen)}`
        );
      }
    }
  } catch (e) {
    console.error(`[DEBUG ${label}] captureDebugArtifacts error:`, e);
  }
}