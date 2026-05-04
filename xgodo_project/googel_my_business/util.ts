declare const agent: any;
/**
 * Utility functions for automation
 * Uses xgodo agent API: https://xgodo.com/docs/automation
 */

// Type alias for AndroidNode (provided by the agent runtime)
type AndroidNode = any;

const PHONE_PACKAGE_NAME = 'com.android.phone';

export function log(message: string): void {
    console.log(message);
}

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Go to home screen
 * API: agent.actions.goHome()
 */
export async function goHome(): Promise<void> {
    await agent.actions.goHome();
}

/**
 * Press back button
 * API: agent.actions.goBack()
 */
export async function goBack(): Promise<void> {
    await agent.actions.goBack();
}

/**
 * Launch an app by package name
 * API: agent.actions.launchApp(packageName, clearExisting?)
 */
export async function launchApp(packageName: string, clearExisting: boolean = false): Promise<void> {
    await agent.actions.launchApp(packageName, clearExisting);
}

/**
 * Type text (keyboard must be visible)
 * API: agent.actions.writeText(text)
 */
export async function writeText(text: string): Promise<void> {
    await agent.actions.writeText(text);
}

/**
 * Tap at coordinates or find and click text
 * @param target - Either X coordinate (number) or text to find (string)
 * @param yOrStrict - If target is number, this is Y coordinate. If target is string, this is strict match flag.
 */
export async function tap(target: string | number, yOrStrict?: number | boolean): Promise<boolean> {
    if (typeof target === 'number' && typeof yOrStrict === 'number') {
        // Coordinate tap - API: agent.actions.tap(x, y)
        await agent.actions.tap(target, yOrStrict);
        return true;
    } else if (typeof target === 'string') {
        const strict = typeof yOrStrict === 'boolean' ? yOrStrict : false;

        // Text tap logic - find the node and tap its center
        const screens: AndroidNode[] = await agent.actions.allScreensContent();
        let node: AndroidNode | undefined;

        for (const screen of screens) {
            const nodes = getAllNodes(screen);
            if (strict) {
                node = nodes.find((n: AndroidNode) => n.text === target && n.clickable);
            } else {
                node = nodes.find((n: AndroidNode) => n.text?.includes(target) && n.clickable);
            }
            if (node) break;
        }

        if (node) {
            // Tap on center of the node's bounds
            const { left, top, right, bottom } = node.boundsInScreen;
            const centerX = (left + right) / 2;
            const centerY = (top + bottom) / 2;
            await agent.actions.tap(centerX, centerY);
            return true;
        }
    }
    return false;
}

// Helper for getting all nodes flattened
function getAllNodes(node: AndroidNode): AndroidNode[] {
    let nodes: AndroidNode[] = [node];
    if (node.children) {
        for (const child of node.children) {
            nodes = nodes.concat(getAllNodes(child));
        }
    }
    return nodes;
}

/**
 * Hide system UIs like notifications and error dialogs
 * This ensures our automation isn't blocked by system popups
 */
export async function hideSystemUIs(screenContent: AndroidNode): Promise<boolean> {

    // Dismiss expandable notifications
    const allScreens: AndroidNode[] = await agent.actions.allScreensContent();
    const notificationNode = allScreens.flatMap((screen: AndroidNode) => getAllNodes(screen))
        .find((node: AndroidNode) => node.viewId === "com.android.systemui:id/expandableNotificationRow" && node.actions.includes(agent.constants.ACTION_DISMISS));

    if (notificationNode) {
        await agent.actions.nodeAction(
            notificationNode,
            agent.constants.ACTION_DISMISS,
        );
        await sleep(1000);
        return true;
    }

    // Close app error dialogs
    const closeNode = getAllNodes(screenContent)
        .find((node: AndroidNode) => node.viewId === "android:id/aerr_close" && node.clickable);

    if (closeNode) {
        await agent.actions.nodeAction(
            closeNode,
            agent.constants.ACTION_CLICK,
        );
        await sleep(2000);
        return true;
    }

    // Close phone dialogs
    const allNodes = getAllNodes(screenContent);
    const closeButton = allNodes.every((node: AndroidNode) => node.packageName === PHONE_PACKAGE_NAME) &&
        allNodes.find((node: AndroidNode) => ([`${PHONE_PACKAGE_NAME}:id/btn_ussd_dialog_cancel`, `${PHONE_PACKAGE_NAME}:id/btn_negative`, `${PHONE_PACKAGE_NAME}:id/btn_neutral`] as (string | undefined)[]).includes(node.viewId));

    if (closeButton) {
        if (closeButton.actions.includes(agent.constants.ACTION_CLICK)) {
            await agent.actions.nodeAction(
                closeButton,
                agent.constants.ACTION_CLICK,
            );
        } else {
            const { left, right, top, bottom } = closeButton.boundsInScreen;
            const centerX = (left + right) / 2;
            const centerY = (top + bottom) / 2;
            await agent.actions.tap(centerX, centerY);
        }
        await sleep(5_000);
        return true;
    }

    return false;
}

/**
 * Scroll down (swipe up)
 * API: agent.actions.swipe(x1, y1, x2, y2, duration)
 */
export async function scrollDown(): Promise<void> {
    // Swipe from bottom to top (center screen)
    const x = 500;
    const startY = 1600;
    const endY = 600;
    const duration = 500; // ms

    try {
        if (agent.actions.swipe) {
            await agent.actions.swipe(x, startY, x, endY, duration);
        } else {
            console.log("agent.actions.swipe not available");
        }
    } catch (e) {
        console.error("Scroll failed:", e);
    }
}
