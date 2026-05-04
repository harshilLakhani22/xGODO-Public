/**
 * Shared Utilities for YouTube Shorts Upload Automation
 * Helper functions for UI interaction and system management
 */

import { APP_PACKAGE_NAME } from './config';

const PHONE_PACKAGE_NAME = 'com.android.phone';

/**
 * Hide system UI dialogs (notifications, crash dialogs, phone dialogs)
 * that might overlay on top of the app.
 */
export async function hideSystemUIs(screenContent: AndroidNode) {
    const allNodes = screenContent.allNodes ? screenContent.allNodes() : [];

    // ─── Handle Android permission dialogs ───
    // These appear from com.google.android.permissioncontroller (or com.android.permissioncontroller)
    // e.g., "Allow YouTube to take pictures and record video?"
    const permissionPackages = [
        "com.google.android.permissioncontroller",
        "com.android.permissioncontroller",
        "com.android.packageinstaller",
    ];
    const hasPermissionDialog = allNodes.some(
        (node: AndroidNode) => permissionPackages.some(pkg => node.packageName === pkg)
    );
    if (hasPermissionDialog) {
        console.log("[Utils] 🔐 Permission dialog detected, looking for 'Allow' button...");
        // Priority order: "While using the app" > "Only this time" > "Allow"
        const allowTexts = [
            "While using the app",
            "Only this time",
            "Allow",
            "ALLOW",
            "Allow all the time",
        ];
        for (const text of allowTexts) {
            const allowButton = allNodes.find(
                (node: AndroidNode) =>
                    node.text === text &&
                    node.clickable &&
                    permissionPackages.some(pkg => node.packageName === pkg)
            );
            if (allowButton) {
                console.log(`[Utils] ✅ Tapping permission button: "${text}"`);
                await allowButton.randomClick();
                await sleep(2000);
                return true;
            }
        }
        // Fallback: find any clickable button in the permission dialog
        const anyButton = allNodes.find(
            (node: AndroidNode) =>
                node.clickable &&
                node.className === "android.widget.Button" &&
                permissionPackages.some(pkg => node.packageName === pkg) &&
                node.text && !node.text.toLowerCase().includes("deny") &&
                !node.text.toLowerCase().includes("don't allow")
        );
        if (anyButton) {
            console.log(`[Utils] ✅ Tapping fallback permission button: "${anyButton.text}"`);
            await anyButton.randomClick();
            await sleep(2000);
            return true;
        }
        console.log("[Utils] ⚠️ Permission dialog found but no suitable button to tap");
    }

    // ─── Handle notification overlays ───
    const notificationNode = (await agent.actions.allScreensContent()).flatMap((screen: AndroidNode) => getAllNodes(screen))
        .find((node: AndroidNode) => node.viewId === "com.android.systemui:id/expandableNotificationRow" && node.actions.includes(agent.constants.ACTION_DISMISS));
    if (notificationNode) {
        await agent.actions.nodeAction(notificationNode, agent.constants.ACTION_DISMISS);
        await sleep(1000);
        return true;
    }

    // ─── Handle crash dialogs ───
    const closeNode = screenContent
        .find((node: AndroidNode) => node.viewId === "android:id/aerr_close" && node.clickable);
    if (closeNode) {
        await agent.actions.nodeAction(closeNode, agent.constants.ACTION_CLICK);
        await sleep(2000);
        return true;
    }

    // ─── Handle phone dialogs ───
    const closeButton = screenContent.allNodes().every((node: AndroidNode) => node.packageName === PHONE_PACKAGE_NAME) &&
        screenContent.allNodes().find((node: AndroidNode) => [`${PHONE_PACKAGE_NAME}:id/btn_ussd_dialog_cancel`, `${PHONE_PACKAGE_NAME}:id/btn_negative`, `${PHONE_PACKAGE_NAME}:id/btn_neutral`].includes(node.viewId || ''));
    if (closeButton) {
        if (closeButton.actions.includes(agent.constants.ACTION_CLICK)) {
            await agent.actions.nodeAction(closeButton, agent.constants.ACTION_CLICK);
        }
        else {
            const { left, right, top, bottom } = closeButton.boundsInScreen;
            agent.utils.randomClick(left, top, right, bottom);
        }
        await sleep(5000);
        return true;
    }
    return false;
}

/**
 * Check if YouTube app is currently in the foreground
 */
export function isYouTubeOpen(allNodes: any[]): boolean {
    return allNodes.some((node) => node.packageName === APP_PACKAGE_NAME);
}

/**
 * Find a node by its text content (case-insensitive partial match)
 */
export function findNodeByText(allNodes: any[], text: string): any | undefined {
    return allNodes.find(
        (node) => node.text && node.text.toLowerCase().includes(text.toLowerCase())
    );
}

/**
 * Find a node by its description (case-insensitive partial match)
 */
export function findNodeByDescription(allNodes: any[], description: string): any | undefined {
    return allNodes.find(
        (node) => node.description && node.description.toLowerCase().includes(description.toLowerCase())
    );
}

/**
 * Find a clickable node by text content
 */
export function findClickableByText(allNodes: any[], text: string): any | undefined {
    return allNodes.find(
        (node) => node.text &&
            node.text.toLowerCase().includes(text.toLowerCase()) &&
            node.clickable
    );
}

/**
 * Find a clickable node by description
 */
export function findClickableByDescription(allNodes: any[], description: string): any | undefined {
    return allNodes.find(
        (node) => node.description &&
            node.description.toLowerCase().includes(description.toLowerCase()) &&
            node.clickable
    );
}

/**
 * Find a node by viewId
 */
export function findNodeByViewId(allNodes: any[], viewId: string): any | undefined {
    return allNodes.find((node) => node.viewId === viewId);
}

/**
 * Find an editable text field (EditText)
 */
export function findEditText(allNodes: any[]): any | undefined {
    return allNodes.find(
        (node) => node.className === 'android.widget.EditText' &&
            node.packageName === APP_PACKAGE_NAME
    );
}

/**
 * Find an editable text field by hint or resource ID
 */
export function findEditTextByHint(allNodes: any[], hint: string): any | undefined {
    return allNodes.find(
        (node) => node.className === 'android.widget.EditText' &&
            node.packageName === APP_PACKAGE_NAME &&
            (
                (node.text && node.text.toLowerCase().includes(hint.toLowerCase())) ||
                (node.description && node.description.toLowerCase().includes(hint.toLowerCase()))
            )
    );
}

/**
 * Set text on an input field using nodeAction
 * Uses ACTION_SET_TEXT which is the xgodo way to input text
 * Data must be an object { text: "..." }, NOT a raw string
 */
export async function setTextOnNode(node: any, text: string) {
    console.log(`[Utils] setTextOnNode: setting text "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
    // First click to focus
    await node.randomClick();
    await sleep(500);
    // Use nodeAction to set text — data must be an object
    await agent.actions.nodeAction(node, agent.constants.ACTION_SET_TEXT, { text });
    console.log("[Utils] ✅ setTextOnNode complete");
    await sleep(500);
}

/**
 * Wait for a screen condition to be met
 * @param conditionFn - Function that checks the screen and returns true/false
 * @param maxAttempts - Maximum number of attempts
 * @param intervalMs - Polling interval in milliseconds
 * @returns true if condition was met, false if timed out
 */
export async function waitForCondition(
    conditionFn: (allNodes: any[]) => boolean,
    maxAttempts: number = 10,
    intervalMs: number = 2000
): Promise<boolean> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const screenContent = await agent.actions.screenContent();
        const allNodes = screenContent.allNodes();

        if (conditionFn(allNodes)) {
            return true;
        }

        if (attempt < maxAttempts) {
            await sleep(intervalMs);
        }
    }
    return false;
}
