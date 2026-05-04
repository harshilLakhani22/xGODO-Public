/**
 * ReviewTextScreen - Type the review text
 * 
 * Detects review text input field and handles:
 * - Finding EditText by className or Text Hint
 * - Typing review text
 * - Dismissing keyboard for Post button visibility
 */

declare const agent: any;

import { VIEW_IDS, REVIEW_TEXT_HINTS, reviewState, AndroidNode, ScreenHandle } from './types';
import { log, tap, writeText, sleep, goBack } from '../util';
import { getData } from '../data';
import { APP_PACKAGE_NAME } from '../config';

export const ReviewTextScreen: ScreenHandle = {
    detectScreen: async (screenContent: AndroidNode): Promise<boolean> => {
        // Must be in Maps package
        if (screenContent.packageName !== APP_PACKAGE_NAME) {
            return false;
        }

        // 1. Check if Post button is visible + we already typed -> yield to SubmitScreen
        if (reviewState.hasTypedReview && screenContent.findByIdOne(VIEW_IDS.POST_BUTTON)) {
            return false;
        }

        // 2. Scan all nodes for EditText or Hint Match
        const allNodes: AndroidNode[] = screenContent.allNodes();
        for (const node of allNodes) {
            // A. Check for EditText Class
            if (node.isEditable ||
                node.className === "android.widget.EditText" ||
                (node.className || "").includes("EditText")) {

                // Auto-correct state if needed
                if (!reviewState.hasSelectedStars) {
                    log("ReviewTextScreen: Detected via generic EditText. Auto-correcting state.");
                    reviewState.hasSelectedStars = true;
                }
                return true;
            }

            // B. Check for Text Hints
            const text = (node.text || "").toLowerCase();
            const hint = (node.hintText || "").toLowerCase();
            const desc = (node.contentDescription || "").toLowerCase();

            // Check against robust list of hints
            const isHintMatch = REVIEW_TEXT_HINTS.some(h =>
                text.includes(h) || hint.includes(h) || desc.includes(h)
            );

            if (isHintMatch) {
                if (!reviewState.hasSelectedStars) {
                    log("ReviewTextScreen: Detected via Text Hint. Auto-correcting state.");
                    reviewState.hasSelectedStars = true;
                }
                return true;
            }
        }

        return false;
    },

    handleScreen: async (screenContent: AndroidNode): Promise<boolean> => {
        log("ReviewTextScreen: Typing review text...");

        // Guard: Already typed, waiting for Post button
        if (reviewState.hasTypedReview) {
            if (reviewState.keyboardDismissAttempts === 0) {
                log("ReviewTextScreen: Review typed. First attempt to dismiss keyboard via Back...");
                reviewState.keyboardDismissAttempts++;
                await goBack();
                await sleep(2000);
                return true;
            }

            log(`ReviewTextScreen: Already dismissed keyboard. Waiting for Post button...`);
            if (screenContent.findByIdOne(VIEW_IDS.POST_BUTTON)) {
                return false; // Yield to SubmitScreen
            }
            await sleep(2000);
            return true;
        }

        const data = getData();
        const reviewText = data.reviewText || "Great experience!";

        // Find the input field again to interact
        const allNodes: AndroidNode[] = screenContent.allNodes();
        let inputNode = null;

        // Try to find by hint first (more specific)
        inputNode = allNodes.find(node => {
            const text = (node.text || "").toLowerCase();
            const hint = (node.hintText || "").toLowerCase();
            const desc = (node.contentDescription || "").toLowerCase();
            return REVIEW_TEXT_HINTS.some(h => text.includes(h) || hint.includes(h) || desc.includes(h));
        });

        // Fallback to any EditText
        if (!inputNode) {
            inputNode = allNodes.find(node =>
                node.isEditable ||
                node.className === "android.widget.EditText" ||
                (node.className || "").includes("EditText")
            );
        }

        if (inputNode) {
            // Skip if already contains our text
            if ((inputNode.text || "") === reviewText) {
                reviewState.hasTypedReview = true;
                return true;
            }

            log("ReviewTextScreen: Found input field, clicking...");
            if (inputNode.clickable) {
                await inputNode.performAction(agent.constants.ACTION_CLICK);
            } else if (inputNode.parent && inputNode.parent.clickable) {
                await inputNode.parent.performAction(agent.constants.ACTION_CLICK);
            } else {
                const { left, right, top, bottom } = inputNode.boundsInScreen;
                await tap((left + right) / 2, (top + bottom) / 2);
            }

            await sleep(1000);
            log(`ReviewTextScreen: Typing: "${reviewText.substring(0, 30)}..."`);
            await writeText(reviewText);

            reviewState.hasTypedReview = true;

            log("ReviewTextScreen: Dismissing keyboard via Back press...");
            reviewState.keyboardDismissAttempts++;
            await sleep(1000);
            await goBack();
            await sleep(1500);
            return true;
        }

        log("ReviewTextScreen: ERROR - Could not find input field to type in.");
        return false;
    }
};
