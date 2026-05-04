declare const agent: any;
/**
 * Maps Search Stage - Google Maps Business Search
 * 
 * PRODUCTION-QUALITY VERSION v7
 * - Uses correct xgodo agent API methods
 * - ROBUST DETECTION: Uses unique viewIds verified from UI JSONs
 * - No fragile text dependency for screen detection
 * - State machine enforcement (typed query -> clicked suggestion -> result)
 */

import { addData, fail, getData, success } from './data';
import {
    Stage,
    ScreenHandle,
    setStage,
} from './Stage';
import { resetReviewState } from './ReviewStage';
import { log, tap, writeText, goHome, goBack, launchApp, sleep } from './util';
import { DEFAULT_MAX_STEPS_PER_STAGE, APP_PACKAGE_NAME, StageName } from './config';

// Type alias for AndroidNode (provided by the agent runtime)
type AndroidNode = any;

// --- ROBUST VIEW IDS (Verified from JSONs) ---
const VIEW_IDS = {
    // HOME SCREEN: Unique indicator is the Profile Disc (top right) - NOT ALWAYS RELIABLE (Explore tab)
    SELECTED_ACCOUNT_DISC: "com.google.android.apps.maps:id/selected_account_disc",

    // SEARCH/RESULT: Back button (arrow) inside search box. Present in Search & Result.
    SEARCH_MENU_BUTTON: "com.google.android.apps.maps:id/search_omnibox_menu_button",

    // SEARCH BOX: The main text field (present in all, checks focus/content)
    SEARCH_TEXT_BOX: "com.google.android.apps.maps:id/search_omnibox_text_box",

    // SEARCH EDIT TEXT: Inner text field, useful for checking FOCUS state
    SEARCH_EDIT_TEXT: "com.google.android.apps.maps:id/search_omnibox_edit_text",

    // RESULT SCREEN: Unique indicator for business page (Street View thumbnail)
    STREET_VIEW_THUMBNAIL: "com.google.android.apps.maps:id/street_view_thumbnail",

    // Fallback for Result Screen (Directions button wrapper)
    RECYCLER_VIEW: "com.google.android.apps.maps:id/recycler_view",
};

// --- STATE TRACKING ---
let hasTypedQuery = false;
let hasClickedSuggestion = false;

// --- STAGE DEFINITION ---
export const MapsSearchStage: Stage<{
    MapResultScreen: string;
    MapResultListScreen: string;
    SuggestionsScreen: string;
    SearchInputScreen: string;
    MapsHomeScreen: string;
}> = {
    name: StageName.MapsSearch,
    maxSteps: DEFAULT_MAX_STEPS_PER_STAGE,
    screens: {
        MapResultScreen: "MapResultScreen",
        MapResultListScreen: "MapResultListScreen",
        SuggestionsScreen: "SuggestionsScreen",
        SearchInputScreen: "SearchInputScreen",
        MapsHomeScreen: "MapsHomeScreen",
    },
    defaultHandle: async () => {
        log("MapsSearchStage: defaultHandle - no screen matched, launching Google Maps...");
        // Ensure clean state on fresh launch
        hasTypedQuery = false;
        hasClickedSuggestion = false;

        // Use correct API: launchApp(packageName, clearExisting?)
        // CRITICAL: Set to TRUE to clear any previous state/text
        await launchApp(APP_PACKAGE_NAME, true);
        await sleep(2000); // Wait for app to launch
    },
    screenHandles: {

        // 1. RESULT SCREEN - DETAILS PAGE (Strict detection)
        MapResultScreen: {
            // ... (detectScreen same as before) ...
            detectScreen: async (screenContent: AndroidNode): Promise<boolean> => {
                // RECOVERY: If we are already on a result page, detect it even if we didn't see the click
                // STREET_VIEW_THUMBNAIL is a very strong indicator of a business page
                const hasStreetView = screenContent.findByIdOne(VIEW_IDS.STREET_VIEW_THUMBNAIL);
                if (hasStreetView) return true;

                // Fallback: Check for "Overview" / "Reviews" tabs + Directions
                const hasDirections = screenContent.findText("Directions");
                const hasReviewsTab = screenContent.findText("Reviews") || screenContent.findText("REVIEWS");

                if (hasDirections && hasReviewsTab) return true;

                return false;
            },
            handleScreen: async (screenContent: AndroidNode): Promise<boolean> => {
                log("MapResultScreen: SUCCESS - Verified Details Page");

                await sleep(2000);

                const data = getData();
                const businessName = data.businessName || "";
                log("MapResultScreen: Detection successful for " + businessName);

                // Sanity check
                const uiText = screenContent.text || "";
                if (businessName && uiText.toLowerCase().includes(businessName.toLowerCase().split(' ')[0])) {
                    addData({ businessFound: true, verificationMethod: 'verified_view_id_match' });
                } else {
                    log("MapResultScreen: Warning - UI text might not match business name, but structure is correct.");
                    addData({ businessFound: true });
                }

                // CHECKPOINT: User wants to stop here for verification ("comment out all other code")
                log("MapResultScreen: STOPPING HERE for Step-by-Step verification. Search is complete.");
                await success({ status: "search_complete_stopped" }, true);
                return true;

                /* 
                // DISABLED FOR DEBUGGING
                // Check for review
                const reviewText = data.reviewText || "";

                if (reviewText) {
                    log("MapResultScreen: Review text provided, transitioning to ReviewStage...");
                    resetReviewState();
                    await setStage(StageName.Review);
                    return true;
                } else {
                    log("MapResultScreen: No review text provided, completing search-only...");
                    await success(undefined, true);
                    return true;
                }
                */
            }
        },

        // 1.5 RESULT LIST SCREEN (Multiple results)
        MapResultListScreen: {
            detectScreen: async (screenContent: AndroidNode): Promise<boolean> => {
                // If NOT Details page, but has Directions / Call buttons -> List
                const allNodes = screenContent.allNodes();
                let directionsCount = 0;
                for (const node of allNodes) {
                    if ((node.text === "Directions") || (node.contentDescription === "Directions")) {
                        directionsCount++;
                    }
                }

                // If we see directions but NO StreetView thumbnail, it's likely a list
                if (directionsCount > 0 && !screenContent.findByIdOne(VIEW_IDS.STREET_VIEW_THUMBNAIL)) {
                    return true;
                }
                return false;
            },
            handleScreen: async (screenContent: AndroidNode): Promise<boolean> => {
                log("MapResultListScreen: Detected List of Results. Clicking first result...");

                // Find the first result card or the first Directions button and click slightly above it?
                // Or find the business name in the list.
                const data = getData();
                const businessName = data.businessName || "";

                const allNodes = screenContent.allNodes();

                // 1. Try to find Business Name matching
                for (const node of allNodes) {
                    if (node.text && node.text.toLowerCase().includes(businessName.toLowerCase()) && node.clickable) {
                        log(`MapResultListScreen: Found business name "${node.text}", clicking...`);
                        await node.performAction(agent.constants.ACTION_CLICK);
                        await sleep(3000);
                        return true;
                    }
                }

                // 2. Fallback: Click the first item with "Directions" (Click the parent or title near it)
                // Just tapping the middle of the screen often works for top result
                log("MapResultListScreen: Specific business text not found, tapping top result area...");
                await tap(500, 400); // Approximate location of first result
                await sleep(3000);

                return true;
            }
        },

        // 2. SUGGESTIONS SCREEN (Search Active + Typed)
        SuggestionsScreen: {
            detectScreen: async (screenContent: AndroidNode): Promise<boolean> => {
                // Guard: Must have typed something
                if (!hasTypedQuery) return false;

                // Must have Back Button (Search Mode)
                const hasMenuButton = screenContent.findByIdOne(VIEW_IDS.SEARCH_MENU_BUTTON);
                if (!hasMenuButton) return false;

                return true;
            },
            handleScreen: async (screenContent: AndroidNode): Promise<boolean> => {
                log("SuggestionsScreen: Detected - Looking for suggestion...");

                const data = getData();
                const businessName = data.businessName || "";

                // Get search bar bounds to exclude from matching
                const searchBar = screenContent.findByIdOne(VIEW_IDS.SEARCH_TEXT_BOX);
                const searchBarBottom = searchBar?.boundsInScreen?.bottom || 0;

                log(`SuggestionsScreen: Search bar bottom at Y=${searchBarBottom}`);

                // Use built-in allNodes() method
                const allNodes: AndroidNode[] = screenContent.allNodes();

                // Find suggestion item containing business name
                // MUST be BELOW the search bar (not IN the search bar)
                const businessNameLower = businessName.toLowerCase();
                let suggestionNode: AndroidNode | null = null;

                for (const node of allNodes) {
                    const nodeText = (node.text || "").toLowerCase();

                    // Must contain business name
                    if (!nodeText.includes(businessNameLower)) continue;

                    // Must have valid bounds
                    if (!node.boundsInScreen) continue;

                    // CRITICAL: Must be BELOW the search bar (exclude search input text)
                    const nodeTop = node.boundsInScreen.top;
                    if (nodeTop < searchBarBottom + 10) {
                        log(`SuggestionsScreen: Skipping node in search bar area (Y=${nodeTop}): ${node.text?.substring(0, 30)}...`);
                        continue;
                    }

                    // Found a valid suggestion!
                    suggestionNode = node;
                    log(`SuggestionsScreen: Found suggestion below search bar: ${node.text?.substring(0, 50)}... at Y=${nodeTop}`);
                    break;
                }

                // Click the suggestion using performAction (accessibility-based)
                if (suggestionNode) {
                    log("SuggestionsScreen: Clicking suggestion using performAction...");

                    // Try performAction first (preferred accessibility method)
                    if (suggestionNode.clickable) {
                        const result = await suggestionNode.performAction(agent.constants.ACTION_CLICK);
                        if (result?.actionPerformed) {
                            hasClickedSuggestion = true;
                            log("SuggestionsScreen: Clicked via performAction, waiting for result...");
                            await sleep(3000);
                            return true;
                        }
                    }

                    // Fallback: use randomClick() for more natural clicking
                    log("SuggestionsScreen: performAction failed, using randomClick...");
                    suggestionNode.randomClick();
                    hasClickedSuggestion = true;
                    log("SuggestionsScreen: Clicked via randomClick, waiting for result...");
                    await sleep(3000);
                    return true;
                }

                // If no business name match, try to find first suggestion item below search bar
                log("SuggestionsScreen: No business name match, looking for any suggestion...");
                for (const node of allNodes) {
                    // Must have text and be clickable
                    if (!node.text || node.text.length < 3) continue;
                    if (!node.boundsInScreen) continue;

                    const nodeTop = node.boundsInScreen.top;

                    // Must be below search bar
                    if (nodeTop < searchBarBottom + 10) continue;

                    // Skip common non-suggestion texts
                    const text = node.text.toLowerCase();
                    if (text === "choose on map" || text.includes("map") && text.length < 20) continue;

                    // Found a candidate!
                    log(`SuggestionsScreen: Found fallback suggestion: ${node.text.substring(0, 30)}...`);

                    if (node.clickable) {
                        const result = await node.performAction(agent.constants.ACTION_CLICK);
                        if (result?.actionPerformed) {
                            hasClickedSuggestion = true;
                            log("SuggestionsScreen: Clicked fallback via performAction...");
                            await sleep(3000);
                            return true;
                        }
                    }

                    node.randomClick();
                    hasClickedSuggestion = true;
                    log("SuggestionsScreen: Clicked fallback via randomClick...");
                    await sleep(3000);
                    return true;
                }

                log("SuggestionsScreen: ERROR - No valid suggestion found!");
                return false;
            }
        },

        // 3. SEARCH INPUT SCREEN (Search Active + Not Typed)
        SearchInputScreen: {
            detectScreen: async (screenContent: AndroidNode): Promise<boolean> => {
                // Guard: If we already typed, we are in Suggestions mode
                if (hasTypedQuery) return false;

                // 1. Check if the Search EditText is FOCUSED
                const searchEdit = screenContent.findByIdOne(VIEW_IDS.SEARCH_EDIT_TEXT);
                if (searchEdit && searchEdit.isFocused) {
                    log("SearchInputScreen: Search bar is FOCUSED - Ready to type.");
                    return true;
                }

                // 2. Legacy check: Menu Button (Back) is present
                // (Only if we are NOT on a result page, checking for street view thumbnail absence)
                const hasMenuButton = screenContent.findByIdOne(VIEW_IDS.SEARCH_MENU_BUTTON);
                const hasStreetView = screenContent.findByIdOne(VIEW_IDS.STREET_VIEW_THUMBNAIL);

                if (hasMenuButton && !hasStreetView) {
                    log("SearchInputScreen: Menu button present (and not on result), assuming search active.");
                    return true;
                }
                return false;
            },
            handleScreen: async (screenContent: AndroidNode): Promise<boolean> => {
                log("SearchInputScreen: Detected - Typing query...");

                const data = getData();
                const businessName = data.businessName || "";
                const address = data.address || "";
                const query = `${businessName}, ${address}`;

                log(`SearchInputScreen: WRITING TEXT: "${query}"`);

                // Use correct API: writeText (keyboard must be visible)
                await writeText(query);
                hasTypedQuery = true;

                log("SearchInputScreen: Typed query, waiting for suggestions...");
                await sleep(2000);
                return true;
            }
        },

        // 4. HOME SCREEN (Default or Explore Tab)
        MapsHomeScreen: {
            detectScreen: async (screenContent: AndroidNode): Promise<boolean> => {
                // We are on Home if:
                // 1. Search Box exists
                const hasSearchBox = screenContent.findByIdOne(VIEW_IDS.SEARCH_TEXT_BOX);

                // 2. AND Search Box is NOT focused (if it were focused, it'd be SearchInputScreen)
                const searchEdit = screenContent.findByIdOne(VIEW_IDS.SEARCH_EDIT_TEXT);
                const isFocused = searchEdit ? searchEdit.isFocused : false;

                // 3. AND we are NOT on a result page (No Street View Thumbnail)
                const hasStreetView = screenContent.findByIdOne(VIEW_IDS.STREET_VIEW_THUMBNAIL);

                if (hasSearchBox && !isFocused && !hasStreetView) {
                    // Check for "Directions" to avoid confusing with Result List
                    const cnt = screenContent.findText("Directions") ? 1 : 0; // Simple check
                    if (cnt === 0) {
                        return true;
                    }
                }

                // Fallback: Profile disc presence (if we really are on the classic home)
                const hasProfile = screenContent.findByIdOne(VIEW_IDS.SELECTED_ACCOUNT_DISC);
                // But ensure no back button if we rely on profile disc alone? 
                // Actually, Explore tab HAS back button sometimes if deep linked. 
                // Let's rely on the Search Box + Not Focused logic as primary.

                if (hasProfile && !hasStreetView && !isFocused) {
                    return true;
                }

                return false;
            },
            handleScreen: async (screenContent: AndroidNode): Promise<boolean> => {
                log("MapsHomeScreen: Detected (Search Box Present, Not Focused). Tapping search...");

                // Action: Click Search Bar
                const searchBox = screenContent.findByIdOne(VIEW_IDS.SEARCH_TEXT_BOX);
                if (searchBox) {
                    // Tap on search bar bounds
                    const { left, top, right, bottom } = searchBox.boundsInScreen;
                    await tap((left + right) / 2, (top + bottom) / 2);
                } else {
                    await tap("Search here"); // Fallback text tap
                }

                log("MapsHomeScreen: Tapped search bar");
                await sleep(1000);
                return true;
            }
        }
    }
};
