/**
 * StarRatingScreen - Select the appropriate star rating
 * 
 * Detects star rating UI and handles:
 * - SeekBar with action labels (most robust)
 * - Spatial tap fallback
 * - Generic star element clicks
 */

declare const agent: any;

import { VIEW_IDS, reviewState, AndroidNode, ScreenHandle } from './types';
import { log, tap, sleep } from '../util';
import { getData } from '../data';

export const StarRatingScreen: ScreenHandle = {
    detectScreen: async (screenContent: AndroidNode): Promise<boolean> => {
        // Must have clicked review button first
        if (!reviewState.hasClickedReviewButton) return false;
        // Should not have selected stars yet
        if (reviewState.hasSelectedStars) return false;

        // 1. Search for SeekBar with "Rate X of 5" actions
        const allNodes: AndroidNode[] = screenContent.allNodes();
        for (const node of allNodes) {
            if (node.className === "android.widget.SeekBar") {
                const actions = node.actionLabels || [];
                if (actions.some((l: any) => (l.label || "").includes("Rate 5 of 5"))) {
                    log("StarRatingScreen: Detected via SeekBar Action Labels");
                    return true;
                }
            }
        }

        // 2. Fallback checks (Text)
        for (const node of allNodes) {
            const desc = (node.contentDescription || "").toLowerCase();
            const text = (node.text || "").toLowerCase();

            if (desc.includes("star") ||
                (desc.includes("rating") && desc.includes("of 5")) ||
                text.includes("how was your experience") ||
                text.includes("rate and review")) {
                return true;
            }
        }

        return false;
    },

    handleScreen: async (screenContent: AndroidNode): Promise<boolean> => {
        log("StarRatingScreen: Selecting star rating...");

        const data = getData();
        const targetRating = data.starRating || 5;
        log(`StarRatingScreen: Target rating is ${targetRating} stars`);

        // 1. Find SeekBar via Action Labels (Robust)
        let ratingBar = null;
        const allNodesScan = screenContent.allNodes();
        for (const node of allNodesScan) {
            if (node.className === "android.widget.SeekBar") {
                const actions = node.actionLabels || [];
                if (actions.some((l: any) => (l.label || "").includes("Rate 5 of 5"))) {
                    ratingBar = node;
                    break;
                }
            }
        }

        if (ratingBar) {
            log(`StarRatingScreen: Found rating bar (Action Label Match)`);

            const targetLabel = `Rate ${targetRating} of 5`;
            const actions = ratingBar.actionLabels || [];
            const actionObj = actions.find((l: any) => (l.label || "").includes(targetLabel));

            if (actionObj && actionObj.id) {
                log(`StarRatingScreen: Found Action ID for "${targetLabel}": ${actionObj.id}`);
                try {
                    await ratingBar.performAction(actionObj.id);
                    reviewState.hasSelectedStars = true;
                    await sleep(1500);
                    return true;
                } catch (e) {
                    log(`StarRatingScreen: Action failed (${e}), falling back to spatial click`);
                }
            } else {
                log(`StarRatingScreen: Action label "${targetLabel}" not found. Trying spatial fallback.`);
            }

            // SPATIAL FALLBACK
            if (ratingBar.boundsInScreen) {
                const { left, right, top, bottom } = ratingBar.boundsInScreen;
                const pct = (targetRating * 0.2) - 0.1;
                const targetX = left + (right - left) * pct;
                const targetY = (top + bottom) / 2;

                log(`StarRatingScreen: Tapping RatingBar at (${Math.round(targetX)}, ${Math.round(targetY)}) for ${targetRating} stars`);
                await tap(targetX, targetY);
                reviewState.hasSelectedStars = true;
                await sleep(1500);
                return true;
            }
        }

        // 2. Generic star element search
        log("StarRatingScreen: Specific SeekBar not found, trying generic search...");
        const allNodes: AndroidNode[] = screenContent.allNodes();

        const starNodes: AndroidNode[] = [];
        for (const node of allNodes) {
            const desc = (node.contentDescription || "").toLowerCase();
            if (desc.includes("star") && node.clickable && node.boundsInScreen) {
                starNodes.push(node);
            }
        }

        // Sort by X position (left to right)
        starNodes.sort((a: AndroidNode, b: AndroidNode) =>
            a.boundsInScreen.left - b.boundsInScreen.left
        );

        if (starNodes.length >= targetRating) {
            const targetStar = starNodes[targetRating - 1];
            log(`StarRatingScreen: Clicking star ${targetRating} of ${starNodes.length}`);

            await targetStar.performAction(agent.constants.ACTION_CLICK);
            reviewState.hasSelectedStars = true;
            await sleep(1500);
            return true;
        }

        log("StarRatingScreen: Could not find star elements");
        return false;
    }
};
