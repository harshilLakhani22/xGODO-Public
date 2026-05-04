declare const agent: any;

import { addData, fail, getData, success } from './data';
import { Stage } from './Stage';
import { log, tap, writeText, sleep, scrollDown, getAllNodes, goBack } from './util';
import { DEFAULT_MAX_STEPS_PER_STAGE } from './config';

type AndroidNode = any;

// --- VIEW IDENTIFIERS ---
const VIEW_IDS = {
    REVIEWS_TAB_TEXT: "REVIEWS",
    RATE_AND_REVIEW_TEXT: "Rate and review",
    POST_BUTTON_TEXT: "Post",
    POST_BUTTON_ID: "com.google.android.apps.maps:id/floatingBottomPostButton",
    EDIT_TEXT_ID: "com.google.android.apps.maps:id/contentEditText",
    EDIT_TEXT_CLASS: "android.widget.EditText",
    RATING_SEEK_BAR_CLASS: "android.widget.SeekBar",
};

// --- STATE TRACKING ---
let hasSelectRating = false;

// Helper to find node with text
function findNodeByText(nodes: AndroidNode[], text: string): AndroidNode | undefined {
    return nodes.find(n => n.text === text || (n.text && n.text.includes(text)));
}

export const RateBusinessStage: Stage<{
    BusinessOverviewScreen: string;
    ReviewsTabScreen: string;
    RatingScreen: string;
    WritingReviewScreen: string;
}> = {
    name: 'RateBusiness',
    maxSteps: DEFAULT_MAX_STEPS_PER_STAGE,
    screens: {
        BusinessOverviewScreen: "BusinessOverviewScreen",
        ReviewsTabScreen: "ReviewsTabScreen",
        RatingScreen: "RatingScreen",
        WritingReviewScreen: "WritingReviewScreen",
    },
    defaultHandle: async () => {
        log("RateBusinessStage: defaultHandle - No matching screen found.");
        await sleep(2000);
    },
    screenHandles: {

        // 1. BUSINESS OVERVIEW
        BusinessOverviewScreen: {
            detectScreen: async (screenContent: AndroidNode): Promise<boolean> => {
                if (hasSelectRating) return false;

                const nodes = getAllNodes(screenContent);
                const reviewsTab = findNodeByText(nodes, VIEW_IDS.REVIEWS_TAB_TEXT);
                const rateSection = findNodeByText(nodes, VIEW_IDS.RATE_AND_REVIEW_TEXT);
                const seekBar = nodes.find((n: AndroidNode) => n.className === VIEW_IDS.RATING_SEEK_BAR_CLASS);

                // CRITICAL FIX: explicit exclusions
                // If we are clearly on the reviews tab (selected OR content visible), DO NOT detect Overview.
                if (reviewsTab && reviewsTab.isSelected) return false;
                if (rateSection) return false;
                if (seekBar) return false;

                // Otherwise, we assume Overview (or some state where we want to try navigating TO reviews)
                return true;
            },
            handleScreen: async (screenContent: AndroidNode): Promise<boolean> => {
                log("BusinessOverviewScreen: Handling... Looking for 'REVIEWS' tab.");

                let nodes = getAllNodes(screenContent);
                let reviewsTab = findNodeByText(nodes, VIEW_IDS.REVIEWS_TAB_TEXT);

                if (reviewsTab) {
                    if (reviewsTab.isSelected) {
                        // Looked like we detected Overview but tab IS selected? 
                        // Should be caught by detectScreen exclusion, but safety check.
                        log("BusinessOverviewScreen: Tab is selected. Skipping to next loop.");
                        return true;
                    }

                    log("BusinessOverviewScreen: Found 'REVIEWS' tab. Tapping it...");
                    if (reviewsTab.clickable && reviewsTab.actions?.includes(agent.constants.ACTION_CLICK)) {
                        await reviewsTab.performAction(agent.constants.ACTION_CLICK);
                    } else {
                        const b = reviewsTab.boundsInScreen;
                        await tap((b.left + b.right) / 2, (b.top + b.bottom) / 2);
                    }
                    await sleep(3000);
                    return true;
                }

                log("BusinessOverviewScreen: 'REVIEWS' tab not visible. Scrolling once...");
                await scrollDown();
                await sleep(2000);

                // Re-read
                let screens = await agent.actions.allScreensContent();
                let allNodesNew = screens.flatMap((s: any) => getAllNodes(s));

                // Check for tab again
                reviewsTab = findNodeByText(allNodesNew, VIEW_IDS.REVIEWS_TAB_TEXT);
                if (reviewsTab) {
                    log("BusinessOverviewScreen: Found 'REVIEWS' tab after scroll. Tapping...");
                    if (reviewsTab.clickable && reviewsTab.actions?.includes(agent.constants.ACTION_CLICK)) {
                        await reviewsTab.performAction(agent.constants.ACTION_CLICK);
                    } else {
                        const b = reviewsTab.boundsInScreen;
                        await tap((b.left + b.right) / 2, (b.top + b.bottom) / 2);
                    }
                    await sleep(3000);
                    return true;
                }

                // Fallback: search for "Rate and review" TEXT (not tab)
                log("BusinessOverviewScreen: Switching to manual scroll search for 'Rate and review' section...");
                let rateSection = findNodeByText(allNodesNew, VIEW_IDS.RATE_AND_REVIEW_TEXT);

                let attempts = 0;
                while (!rateSection && attempts < 10) {
                    attempts++;
                    log(`BusinessOverviewScreen: Scroll search (Attempt ${attempts}/10)...`);
                    await scrollDown();
                    await sleep(2000);

                    screens = await agent.actions.allScreensContent();
                    allNodesNew = screens.flatMap((s: any) => getAllNodes(s));
                    rateSection = findNodeByText(allNodesNew, VIEW_IDS.RATE_AND_REVIEW_TEXT);
                }

                if (rateSection) {
                    log("BusinessOverviewScreen: Found 'Rate and review' section. Tapping to focus...");
                    const b = rateSection.boundsInScreen;
                    await tap((b.left + b.right) / 2, (b.top + b.bottom) / 2);
                    await sleep(2000);
                    return true; // Now ReviewsTabScreen should detect it
                }

                log("BusinessOverviewScreen: ERROR - Could not find REVIEWS tab OR Rate Section.");
                await fail("Could not find REVIEWS tab or Rate Section");
                return false;
            }
        },

        // 2. REVIEWS TAB (Find Stars / SeekBar)
        ReviewsTabScreen: {
            detectScreen: async (screenContent: AndroidNode): Promise<boolean> => {
                if (hasSelectRating) return false;

                const nodes = getAllNodes(screenContent);
                const reviewsTab = findNodeByText(nodes, VIEW_IDS.REVIEWS_TAB_TEXT);
                const rateSection = findNodeByText(nodes, VIEW_IDS.RATE_AND_REVIEW_TEXT);
                const seekBar = nodes.find((n: AndroidNode) => n.className === VIEW_IDS.RATING_SEEK_BAR_CLASS);

                // Positive matches
                if (reviewsTab && reviewsTab.isSelected) return true;
                if (rateSection) return true;
                if (seekBar) return true;

                return false;
            },
            handleScreen: async (screenContent: AndroidNode): Promise<boolean> => {
                log("ReviewsTabScreen: Active. Looking for Rating SeekBar...");

                const targetRating = (getData().starRating || 5);

                let nodes = getAllNodes(screenContent);
                let seekBar = nodes.find((n: AndroidNode) => n.className === VIEW_IDS.RATING_SEEK_BAR_CLASS);

                // Scroll loop to find SeekBar
                let attempts = 0;
                while (!seekBar && attempts < 10) {
                    attempts++;
                    log(`ReviewsTabScreen: Rating bar not visible. Scrolling down (Attempt ${attempts}/10)...`);
                    await scrollDown();
                    await sleep(2000);

                    const screens = await agent.actions.allScreensContent();
                    const allNodesNew = screens.flatMap((s: any) => getAllNodes(s));
                    seekBar = allNodesNew.find((n: AndroidNode) => n.className === VIEW_IDS.RATING_SEEK_BAR_CLASS);
                }

                if (seekBar) {
                    log(`ReviewsTabScreen: Found Rating SeekBar! Applying rating: ${targetRating} of 5...`);

                    // DYNAMIC ACTION ID LOOKUP
                    const targetLabel = `Rate ${targetRating} of 5`;
                    let actionId: number | undefined;

                    // Inspect actionLabels
                    if (seekBar.actionLabels && Array.isArray(seekBar.actionLabels)) {
                        const matchedAction = seekBar.actionLabels.find((al: any) => al.label === targetLabel);
                        if (matchedAction) {
                            actionId = matchedAction.id;
                            log(`ReviewsTabScreen: Found dynamic action ID ${actionId} for "${targetLabel}"`);
                        }
                    }

                    if (actionId) {
                        await agent.actions.nodeAction(seekBar, actionId);
                        hasSelectRating = true;
                        await sleep(3000);
                        return true;
                    } else {
                        log(`ReviewsTabScreen: WARNING - No action ID for "${targetLabel}". Available: ${JSON.stringify(seekBar.actionLabels)}`);
                        // Fallback tapping logic could go here, but let's fail for safety per user request for "fix"
                        await fail(`Could not find accessibility action for rating ${targetRating}`);
                        return false;
                    }
                }

                log("ReviewsTabScreen: ERROR - Could not find Rating SeekBar.");
                await fail("Could not find Rating SeekBar");
                return false;
            }
        },

        // 3. RATING SCREEN
        RatingScreen: {
            // ... (keep as placeholder)
            detectScreen: async () => false,
            handleScreen: async () => false
        },

        // 4. WRITING REVIEW SCREEN
        WritingReviewScreen: {
            detectScreen: async (screenContent: AndroidNode): Promise<boolean> => {
                const nodes = getAllNodes(screenContent);
                // 1. Primary: Specific ID
                const postButton = nodes.find((n: AndroidNode) => n.viewId === VIEW_IDS.POST_BUTTON_ID);
                const editText = nodes.find((n: AndroidNode) => n.viewId === VIEW_IDS.EDIT_TEXT_ID);

                if (postButton && editText) return true;

                // 2. Secondary: Text/Class Fallback (e.g., Simulator)
                const postButtonText = nodes.find((n: AndroidNode) => n.text === VIEW_IDS.POST_BUTTON_TEXT || n.contentDescription === VIEW_IDS.POST_BUTTON_TEXT);
                const editTextClass = nodes.find((n: AndroidNode) => n.className === VIEW_IDS.EDIT_TEXT_CLASS);

                // Additional check to confirm it's actually the review screen and not some other form
                const hasDetailedReviewHint = nodes.some((n: AndroidNode) =>
                    n.text === "Share details of your own experience" ||
                    n.text === "Tell others about your experience"
                );

                if (postButtonText && (editTextClass || hasDetailedReviewHint)) return true;

                return false;
            },
            handleScreen: async (screenContent: AndroidNode): Promise<boolean> => {
                log("WritingReviewScreen: Detected. Writing review...");

                const reviewText = getData().reviewText || "Great place!";
                const nodes = getAllNodes(screenContent);

                // Find Elements (with Fallback)
                let editText = nodes.find((n: AndroidNode) => n.viewId === VIEW_IDS.EDIT_TEXT_ID);
                if (!editText) {
                    editText = nodes.find((n: AndroidNode) => n.className === VIEW_IDS.EDIT_TEXT_CLASS);
                }

                let postButton = nodes.find((n: AndroidNode) => n.viewId === VIEW_IDS.POST_BUTTON_ID);
                if (!postButton) {
                    postButton = nodes.find((n: AndroidNode) => n.text === VIEW_IDS.POST_BUTTON_TEXT || n.contentDescription === VIEW_IDS.POST_BUTTON_TEXT);
                }

                if (editText && postButton) {
                    if (editText.text === reviewText) {
                        log("WritingReviewScreen: Text verified. Clicking 'Post'...");

                        // 2. Click Post button
                        if (postButton.clickable && postButton.actions?.includes(agent.constants.ACTION_CLICK)) {
                            await agent.actions.nodeAction(postButton, agent.constants.ACTION_CLICK);
                        } else {
                            const b = postButton.boundsInScreen;
                            await tap((b.left + b.right) / 2, (b.top + b.bottom) / 2);
                        }

                        await sleep(5000);

                        await success({ reviewSubmitted: true }, true);
                        return true;
                    } else {
                        log(`WritingReviewScreen: Writing "${reviewText}"...`);

                        // 1. Focus the input
                        if (editText.clickable && editText.actions?.includes(agent.constants.ACTION_CLICK)) {
                            await agent.actions.nodeAction(editText, agent.constants.ACTION_CLICK);
                        } else {
                            const b = editText.boundsInScreen;
                            await tap((b.left + b.right) / 2, (b.top + b.bottom) / 2);
                        }

                        await sleep(1000);
                        await writeText(reviewText);
                        await sleep(2000);

                        log("WritingReviewScreen: Closing keyboard to reveal Post button...");
                        await goBack(); // Dismiss keyboard
                        await sleep(2000);

                        // Return true to let the loop re-detect and re-call handleScreen (where text will match)
                        return true;
                    }
                }

                await fail("Failed to interact with review form (elements missing despite detection?)");
                return false;
            }
        }
    }
};
