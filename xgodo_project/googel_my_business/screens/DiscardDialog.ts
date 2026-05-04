/**
 * DiscardDialog - Handle "Discard changes?" dialog
 * 
 * Detects accidental exit dialog and handles:
 * - Clicking Cancel button to stay
 * - Uses ViewIDs for robust detection
 */

declare const agent: any;

import { VIEW_IDS, AndroidNode, ScreenHandle } from './types';
import { log, tap, sleep, goBack } from '../util';

export const DiscardDialog: ScreenHandle = {
    detectScreen: async (screenContent: AndroidNode): Promise<boolean> => {
        // 1. Check for dialog_title ViewID (most reliable)
        const dialogTitle = screenContent.findByIdOne(VIEW_IDS.DIALOG_TITLE);
        if (dialogTitle) {
            const titleText = (dialogTitle.text || "").toLowerCase();
            if (titleText.includes("discard")) {
                log("DiscardDialog: Detected via dialog_title ViewID");
                return true;
            }
        }

        // 2. Check for dialog buttons with ViewIDs
        const negativeBtn = screenContent.findByIdOne(VIEW_IDS.DIALOG_NEGATIVE_BUTTON);
        const positiveBtn = screenContent.findByIdOne(VIEW_IDS.DIALOG_POSITIVE_BUTTON);
        if (negativeBtn && positiveBtn) {
            const posText = (positiveBtn.text || (positiveBtn.contentDescription || "")).toLowerCase();
            if (posText.includes("discard")) {
                log("DiscardDialog: Detected via dialog buttons ViewIDs");
                return true;
            }
        }

        // 3. Fallback: Text search
        const allNodes = screenContent.allNodes();
        for (const node of allNodes) {
            const t = (node.text || "").toLowerCase();
            if (t === "discard changes?" ||
                t === "discard review?" ||
                t === "discard draft?" ||
                t.includes("discard changes") ||
                t === "keep writing") {
                return true;
            }
        }
        return false;
    },

    handleScreen: async (screenContent: AndroidNode): Promise<boolean> => {
        log("DiscardDialog: Discard dialog detected. Clicking 'Cancel' to stay...");

        // 1. Use ViewID for Cancel button
        const cancelBtn = screenContent.findByIdOne(VIEW_IDS.DIALOG_NEGATIVE_BUTTON);
        if (cancelBtn) {
            log("DiscardDialog: Found Cancel button via ViewID, clicking...");
            if (cancelBtn.clickable) {
                await cancelBtn.performAction(agent.constants.ACTION_CLICK);
            } else if (cancelBtn.boundsInScreen) {
                const { left, right, top, bottom } = cancelBtn.boundsInScreen;
                await tap((left + right) / 2, (top + bottom) / 2);
            }
            await sleep(1500);
            return true;
        }

        // 2. Fallback: Find "Cancel" or "Keep writing" by text
        const allNodes = screenContent.allNodes();
        for (const node of allNodes) {
            const t = (node.text || "").toLowerCase();
            if (t === "cancel" || t === "keep writing") {
                log(`DiscardDialog: Found '${node.text}' button, clicking...`);

                // Click parent if clickable
                const parent = node.parent;
                if (parent && parent.clickable) {
                    await parent.performAction(agent.constants.ACTION_CLICK);
                } else if (node.clickable) {
                    await node.performAction(agent.constants.ACTION_CLICK);
                } else if (node.boundsInScreen) {
                    const { left, right, top, bottom } = node.boundsInScreen;
                    await tap((left + right) / 2, (top + bottom) / 2);
                }
                await sleep(1500);
                return true;
            }
        }

        // 3. Last resort: Press back
        log("DiscardDialog: Button not found, pressing back...");
        await goBack();
        await sleep(1000);
        return true;
    }
};
