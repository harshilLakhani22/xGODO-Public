/**
 * ReviewButtonScreen - Find and click review button or rating stars
 * 
 * Detects business page and handles:
 * - Clicking Reviews tab
 * - Clicking star SeekBar via action labels
 * - Clicking "Write a review" button
 */

declare const agent: any;

import { VIEW_IDS, BUSINESS_PAGE_INDICATORS, reviewState, AndroidNode, ScreenHandle } from './types';
import { log, tap, sleep, scrollDown } from '../util';
import { getData } from '../data';

const MAX_SCROLL_ATTEMPTS = 10;

export const ReviewButtonScreen: ScreenHandle = {
    detectScreen: async (screenContent: AndroidNode): Promise<boolean> => {
        const MAX_RECOVERY_ATTEMPTS = 3;

        // RECOVERY: If we clicked stars but are STILL on business page, we need to retry
        // This happens when the star click didn't actually navigate us
        if (reviewState.hasClickedReviewButton || reviewState.hasSelectedStars) {
            // Check if we're still on the business page (state inconsistency)
            const stillOnBusinessPage = BUSINESS_PAGE_INDICATORS.some(viewId =>
                screenContent.findByIdOne(viewId)
            );

            // Also check for text indicators of business page
            const allNodes: AndroidNode[] = screenContent.allNodes();
            const hasReviewsTab = allNodes.some(node => {
                const text = (node.text || "").toLowerCase();
                return text === "reviews" || text === "overview" || text === "photos" || text === "updates";
            });

            if (stillOnBusinessPage || hasReviewsTab) {
                // Check if we've exceeded max recovery attempts
                if (reviewState.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
                    log(`ReviewButtonScreen: RECOVERY FAILED after ${MAX_RECOVERY_ATTEMPTS} attempts. Giving up.`);
                    // Don't reset state - let defaultHandle deal with this
                    return false;
                }

                reviewState.recoveryAttempts++;
                log(`ReviewButtonScreen: RECOVERY attempt ${reviewState.recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS} - Still on business page after star click, resetting state...`);
                reviewState.hasClickedReviewButton = false;
                reviewState.hasSelectedStars = false;
                reviewState.scrollAttempts = 0;
                return true; // Let this handler retry
            }

            return false; // Not on business page, let other handlers run
        }

        // 1. Check for any Business Page indicators (ViewIDs)
        const hasBusinessPageViewId = BUSINESS_PAGE_INDICATORS.some(viewId => {
            const node = screenContent.findByIdOne(viewId);
            return node && node.isVisibleToUser;
        });

        // SPECIAL CASE: The 'expandingscrollview_container' (HEADER_LAYOUT) can exist on Feed/Update screens too.
        // If we found it, we MUST also verify we see the main tabs (Overview, Reviews, Photos) to be sure.
        if (hasBusinessPageViewId) {
            const headerNode = screenContent.findByIdOne(VIEW_IDS.HEADER_LAYOUT);
            // If we found the header layout, let's look for tab text to confirm it's actually the business page
            if (headerNode && headerNode.isVisibleToUser) {
                const allNodes: AndroidNode[] = screenContent.allNodes();
                const hasTabs = allNodes.some(node => {
                    const text = (node.text || "").toLowerCase();
                    return (text === "overview" || text === "reviews" || text === "photos") && node.isVisibleToUser;
                });

                if (!hasTabs) {
                    log("ReviewButtonScreen: Found header layout but NO tabs (Overview/Reviews). Likely on Feed/Updates screen. Returning false.");
                    return false;
                }
            }

            return true;
        }

        // 2. Check for text indicators (Reviews tab, Write a review, etc.)
        const allNodes: AndroidNode[] = screenContent.allNodes();
        for (const node of allNodes) {
            const text = (node.text || "").toLowerCase();
            if (text.includes("write a review") ||
                text.includes("add a review") ||
                text === "reviews" ||
                text.includes("rate and review")) {
                return true;
            }
        }

        return false;
    },


    handleScreen: async (screenContent: AndroidNode): Promise<boolean> => {
        log("ReviewButtonScreen: Looking for review button/link...");

        const currentNodes = screenContent.allNodes();
        const data = getData();
        const targetRating = data.starRating || 5;

        // 1. STRATEGY A: Switch to "Reviews" tab first (if not already there)
        // This is crucial because stars/write-review buttons are often only visible on this tab
        if (!reviewState.hasSwitchedToReviewsTab) {
            // Check if we are already selected
            const reviewsTab = currentNodes.find(node => {
                const text = (node.text || "").toLowerCase();
                const desc = (node.contentDescription || "").toLowerCase();
                return (text === "reviews" || desc === "reviews") && node.isVisibleToUser;
            });

            if (reviewsTab) {
                if (reviewsTab.isSelected) {
                    log("ReviewButtonScreen: 'Reviews' tab is already selected.");
                    reviewState.hasSwitchedToReviewsTab = true;
                } else {
                    log("ReviewButtonScreen: Found 'Reviews' tab, clicking to switch...");
                    if (reviewsTab.clickable) {
                        await reviewsTab.performAction(agent.constants.ACTION_CLICK);
                    } else if (reviewsTab.parent && reviewsTab.parent.clickable) {
                        await reviewsTab.parent.performAction(agent.constants.ACTION_CLICK);
                    } else {
                        await tap(reviewsTab.text, false);
                    }
                    reviewState.hasSwitchedToReviewsTab = true;
                    await sleep(3000); // Wait for tab content to load
                    return true;
                }
            } else {
                log("ReviewButtonScreen: 'Reviews' tab not found (yet).");
            }
        }

        // 2. STRATEGY B: Find Rating Stars via Content Description (Robust)
        // UI Dump shows elements with content-desc="Rate 5 of 5"
        const targetDesc = `Rate ${targetRating} of 5`;

        // Exact match first
        const starNode = currentNodes.find(node =>
            (node.contentDescription || "").includes(targetDesc) && node.isVisibleToUser
        );

        if (starNode) {
            log(`ReviewButtonScreen: Found star rating via content-desc '${targetDesc}', clicking...`);
            if (starNode.clickable) {
                await starNode.performAction(agent.constants.ACTION_CLICK);
            } else {
                // Fallback to spatial click if for some reason it catches a non-clickable wrapper
                const { left, right, top, bottom } = starNode.boundsInScreen;
                await tap((left + right) / 2, (top + bottom) / 2);
            }

            reviewState.hasClickedReviewButton = true;
            reviewState.hasSelectedStars = true; // We clicked specific stars
            await sleep(2000);
            return true;
        }

        // 3. STRATEGY C: "Write a review" / "Rate and review" Button
        const writeReviewNode = currentNodes.find(node => {
            const text = (node.text || "").toLowerCase();
            const desc = (node.contentDescription || "").toLowerCase();
            return (text.includes("write a review") || text.includes("rate and review") ||
                desc.includes("write a review") || desc.includes("rate and review")) &&
                node.isVisibleToUser;
        });

        if (writeReviewNode) {
            log(`ReviewButtonScreen: Found '${writeReviewNode.text || writeReviewNode.contentDescription}' button, clicking...`);
            if (writeReviewNode.clickable) {
                await writeReviewNode.performAction(agent.constants.ACTION_CLICK);
            } else {
                await tap(writeReviewNode.text || "Write a review", false);
            }
            reviewState.hasClickedReviewButton = true;
            await sleep(2000);
            return true;
        }

        // 4. Fallback: Scroll down
        if (reviewState.scrollAttempts < MAX_SCROLL_ATTEMPTS) {
            reviewState.scrollAttempts++;
            log(`ReviewButtonScreen: Review elements not found, scrolling down (attempt ${reviewState.scrollAttempts}/${MAX_SCROLL_ATTEMPTS})...`);
            await scrollDown();
            await sleep(2000);
            return true;
        }

        log("ReviewButtonScreen: Failed to find review mechanics after max scrolling.");
        return true; // Keep trying? Or fail?
    }
};
