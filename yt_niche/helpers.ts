/**
 * Hardening helpers — safe wrappers, diagnostics, and stability utilities.
 *
 * These helpers protect against missing or misbehaving agent APIs,
 * capture debug artifacts when the automation gets stuck, and
 * stabilize node interactions to avoid mid-animation clicks.
 */

import { getAllNodes } from './util';

// ---------------------------------------------------------------------------
// Safe API wrappers
// ---------------------------------------------------------------------------

/**
 * Safely call `agent.actions.allScreensContent()`.
 * Returns an empty array if the API throws or returns a non-array value.
 */
export async function safeAllScreensContent(): Promise<any[]> {
  try {
    const screens = await agent.actions.allScreensContent();
    if (!Array.isArray(screens)) {
      console.warn('safeAllScreensContent: non-array result, returning []');
      return [];
    }
    return screens;
  } catch (error) {
    console.warn('safeAllScreensContent failed:', error);
    return [];
  }
}

/**
 * Safely call `agent.actions.screenContent()`.
 * Returns a minimal stub node on failure so downstream `.allNodes()` / `.find()` won't crash.
 */
export async function safeScreenContent(): Promise<AndroidNode> {
  try {
    return await agent.actions.screenContent();
  } catch (error) {
    console.warn('safeScreenContent failed:', error);
    // Return a minimal object that satisfies the AndroidNode interface
    return { allNodes: () => [], find: () => undefined } as any;
  }
}

/**
 * Safely call `agent.utils.shell(cmd)`.
 * Returns `null` if the API is missing or the command fails.
 */
export async function safeShell(cmd: string): Promise<any | null> {
  try {
    if (!agent.utils || typeof agent.utils.shell !== 'function') {
      console.warn('safeShell: agent.utils.shell not available');
      return null;
    }
    return await agent.utils.shell(cmd);
  } catch (error) {
    console.warn('safeShell failed:', error);
    return null;
  }
}

/**
 * Get display dimensions with multiple fallback strategies:
 * 1. `agent.actions.getDisplaySize()` (if available)
 * 2. Root node bounds from `allScreensContent()`
 * 3. Configurable fallback defaults
 */
export async function safeGetDisplay(
  fallback = { width: 1080, height: 2340 },
): Promise<{ width: number; height: number }> {
  try {
    // Strategy 1: dedicated API
    if (agent.actions.getDisplaySize) {
      const display = await agent.actions.getDisplaySize();
      if (display && display.width > 0 && display.height > 0) {
        return { width: display.width, height: display.height };
      }
    }

    // Strategy 2: root node bounds
    const screens = await safeAllScreensContent();
    const root = screens[0];
    const bounds = root?.boundsInScreen;
    if (bounds && (bounds.right - bounds.left) > 0 && (bounds.bottom - bounds.top) > 0) {
      return {
        width: bounds.right - bounds.left,
        height: bounds.bottom - bounds.top,
      };
    }
  } catch (_) {
    // fall through to fallback
  }

  return fallback;
}

/**
 * Probe whether a binary (e.g. `curl`, `wget`) is available on the device.
 */
export async function hasBinary(bin: string): Promise<boolean> {
  try {
    const result = await safeShell(`which ${bin}`);
    return !!(result && result.stdout && result.stdout.trim());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Stability utilities
// ---------------------------------------------------------------------------

/**
 * Poll `allScreensContent()` until a target node's bounds are stable
 * across `stableCount` consecutive samples taken `interval` ms apart.
 *
 * @param findFn   - Function that receives the flat node list and returns
 *                   the target node (or `undefined` if not found).
 * @param maxWait  - Maximum total wait time in ms (default 3000).
 * @param stableCount  - Number of identical-bounds samples required (default 3).
 * @param interval - Polling interval in ms (default 200).
 * @returns The stabilized node, or the last-found node if timeout reached.
 */
export async function waitForStableNode(
  findFn: (flat: any[]) => any,
  maxWait = 3000,
  stableCount = 3,
  interval = 200,
): Promise<any | undefined> {
  let prevBounds: any = null;
  let stableHits = 0;
  let elapsed = 0;

  while (elapsed < maxWait) {
    try {
      const screens = await safeAllScreensContent();
      const flat = screens.flatMap((screen: any) => getAllNodes(screen));
      const node = findFn(flat);
      const bounds = node?.boundsInScreen || null;

      const same =
        bounds &&
        prevBounds &&
        bounds.left === prevBounds.left &&
        bounds.top === prevBounds.top &&
        bounds.right === prevBounds.right &&
        bounds.bottom === prevBounds.bottom;

      if (same) {
        stableHits++;
      } else {
        stableHits = 0;
      }

      if (bounds) prevBounds = bounds;
      if (stableHits >= stableCount && node) return node;
    } catch (_) {
      // swallow and retry
    }

    await sleep(interval);
    elapsed += interval;
  }

  // Final attempt — return whatever we can find
  try {
    const screens = await safeAllScreensContent();
    const flat = screens.flatMap((screen: any) => getAllNodes(screen));
    return findFn(flat);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Debug artifact capture
// ---------------------------------------------------------------------------

/**
 * Capture and upload debug artifacts: flattened node tree (JSON) +
 * screenshot (PNG). Uses `agent.utils.upload` when available;
 * otherwise logs a summary to console.
 *
 * @param tag  - Prefix for artifact filenames (e.g. `'unknown-loop'`, `'stuck-screen'`).
 */
export async function captureDebugArtifacts(tag: string = 'debug'): Promise<void> {
  const timestamp = Date.now();

  try {
    // 1. Flatten node tree
    const screens = await safeAllScreensContent();
    const flat = screens.flatMap((screen: any) => getAllNodes(screen));
    const jsonPayload = JSON.stringify(flat, null, 2);

    // 2. Upload node tree JSON
    if (agent.utils && typeof agent.utils.upload === 'function') {
      await agent.utils.upload(jsonPayload, `${tag}-${timestamp}.json`);
    } else {
      console.log(`[debug-artifact] ${tag} nodes (${flat.length} total, ${jsonPayload.length} bytes)`);
    }

    // 3. Log top clickable candidates for quick diagnosis
    const clickables = flat
      .filter((n: any) => n.clickable && n.boundsInScreen)
      .slice(0, 8)
      .map((n: any) => ({
        text: n.text ?? '',
        desc: n.description ?? '',
        resourceId: n.viewId ?? '',
        bounds: n.boundsInScreen,
        enabled: n.enabled ?? n.isEnabled ?? true,
      }));
    console.log(`[debug-artifact] ${tag} top-clickables:`, JSON.stringify(clickables));

    // 4. Capture & upload screenshot
    try {
      const screenshot = await agent.actions.screenshot?.(1024, 1024, 80);
      if (screenshot?.screenshot && agent.utils && typeof agent.utils.upload === 'function') {
        await agent.utils.upload(screenshot.screenshot, `${tag}-${timestamp}.png`);
      }
    } catch (ssError) {
      console.warn(`[debug-artifact] screenshot capture failed for ${tag}:`, ssError);
    }
  } catch (error) {
    console.warn('captureDebugArtifacts failed:', error);
  }
}
