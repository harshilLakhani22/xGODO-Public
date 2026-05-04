/**
 * SubmitScreen - Click Post button to submit review
 * 
 * Detects Post button and handles review submission
 */

declare const agent: any;

import { VIEW_IDS, reviewState, AndroidNode, ScreenHandle } from './types';
import { log, tap } from '../util';
import { addData, success } from '../data';

export const SubmitScreen: ScreenHandle = {
    detectScreen: async (screenContent: AndroidNode): Promise<boolean> => {
        // 1. Look for Post Button ViewID (Strongest signal)
        if (screenContent.findByIdOne(VIEW_IDS.POST_BUTTON)) {
            // Auto-recover state
            if (!reviewState.hasTypedReview) {
                log("SubmitScreen: Detected Post button without typing review. Auto-correcting state.");
                reviewState.hasTypedReview = true;
                reviewState.hasSelectedStars = true;
            }
            return true;
        }

        // Should have selected stars at minimum
        if (!reviewState.hasSelectedStars) return false;

        // 2. Fallback: Look for "post" or "submit" text
        const allNodes: AndroidNode[] = screenContent.allNodes();
        for (const node of allNodes) {
            const text = (node.text || "").toLowerCase();
            if ((text === "post" || text === "submit") && node.clickable) {
                return true;
            }
        }
        return false;
    },

    handleScreen: async (screenContent: AndroidNode): Promise<boolean> => {
        log("SubmitScreen: Looking for Post button...");

        // 1. Try specific ViewID
        const postButton = screenContent.findByIdOne(VIEW_IDS.POST_BUTTON);

        if (postButton) {
            log(`SubmitScreen: Found POST BUTTON with ViewID: ${VIEW_IDS.POST_BUTTON}`);

            log("SubmitScreen: Clicking Post button to submit review...");
            if (postButton.clickable) {
                await postButton.performAction(agent.constants.ACTION_CLICK);
            } else if (postButton.boundsInScreen) {
                const { left, right, top, bottom } = postButton.boundsInScreen;
                await tap((left + right) / 2, (top + bottom) / 2);
            }

            addData({ reviewSubmitted: true });
            await success(undefined, true);
            return true;
        }

        // 2. Fallback: Generic text search
        const allNodes: AndroidNode[] = screenContent.allNodes();
        for (const node of allNodes) {
            const text = (node.text || "").toLowerCase();
            if ((text === "post" || text === "submit") &&
                node.clickable && node.boundsInScreen) {

                log(`SubmitScreen: Found generic POST button with text: ${node.text}`);

                log("SubmitScreen: Clicking Post button to submit review...");
                if (node.clickable) {
                    await node.performAction(agent.constants.ACTION_CLICK);
                } else {
                    const { left, right, top, bottom } = node.boundsInScreen;
                    await tap((left + right) / 2, (top + bottom) / 2);
                }

                addData({ reviewSubmitted: true });
                await success(undefined, true);
                return true;
            }
        }

        log("SubmitScreen: Post button not found");
        return false;
    }
};
