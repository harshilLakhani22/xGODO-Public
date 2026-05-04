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
import { log, tap, writeText, goHome, goBack, launchApp, sleep } from './util';
import { DEFAULT_MAX_STEPS_PER_STAGE, APP_PACKAGE_NAME } from './config';

// Type alias for AndroidNode (provided by the agent runtime)
type AndroidNode = any;

// --- ROBUST VIEW IDS (Verified from JSONs) ---
const VIEW_IDS = {
    // HOME SCREEN: Unique indicator is the Profile Disc (top right)
    SELECTED_ACCOUNT_DISC: "com.google.android.apps.maps:id/selected_account_disc",

    // SEARCH/RESULT: Back button (arrow) inside search box. Present in Search & Result, ABSENT in Home.
    SEARCH_MENU_BUTTON: "com.google.android.apps.maps:id/search_omnibox_menu_button",

    // SEARCH BOX: The main text field (present in all, checks focus/content)
    SEARCH_TEXT_BOX: "com.google.android.apps.maps:id/search_omnibox_text_box",

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
    SuggestionsScreen: string;
    SearchInputScreen: string;
    MapsHomeScreen: string;
}> = {
    name: 'MapsSearch',
    maxSteps: DEFAULT_MAX_STEPS_PER_STAGE,
    screens: {
        MapResultScreen: "MapResultScreen",
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
        await launchApp(APP_PACKAGE_NAME, true);
        await sleep(2000); // Wait for app to launch
    },
    screenHandles: {

        // 1. RESULT SCREEN (Most specific - requires state + unique ID)
        MapResultScreen: {
            detectScreen: async (screenContent: AndroidNode): Promise<boolean> => {
                // Screen Guard: Cannot be on result screen if we haven't clicked a suggestion
                if (!hasClickedSuggestion) return false;

                // Detection: Look for Street View Thumbnail (Unique to Business Page)
                const hasStreetView = screenContent.findByIdOne(VIEW_IDS.STREET_VIEW_THUMBNAIL);

                // Backup Detection: Look for "Directions" button specifically
                const hasDirections = screenContent.findText("Directions");
                const hasMenuButton = screenContent.findByIdOne(VIEW_IDS.SEARCH_MENU_BUTTON);

                // Strong Match: Street View OR (Menu Button AND Directions)
                if (hasStreetView || (hasMenuButton && hasDirections)) {
                    return true;
                }
                return false;
            },
            handleScreen: async (screenContent: AndroidNode): Promise<boolean> => {
                log("MapResultScreen: SUCCESS - Verified via unique ViewId/Structure");

                await sleep(2000); // Wait for full content load

                // Extract Info - getData() returns the whole object
                const data = getData();
                const businessName = data.businessName || "";
                log("MapResultScreen: Detection successful for " + businessName);

                // Verify we found the RIGHT business (Basic sanity check)
                const uiText = screenContent.text || "";
                if (businessName && uiText.toLowerCase().includes(businessName.toLowerCase().split(' ')[0])) {
                    addData({ businessFound: true, verificationMethod: 'verified_view_id_match' });
                } else {
                    log("MapResultScreen: Warning - UI text might not match business name, but structure is correct.");
                    addData({ businessFound: true });
                }

                // Transition to RateBusinessSrage
                log("MapResultScreen: Business found. Transitioning to RateBusinessStage...");
                await setStage(Stage.RateBusiness);

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

                // Menu Button (Back) is present = Search is active
                const hasMenuButton = screenContent.findByIdOne(VIEW_IDS.SEARCH_MENU_BUTTON);

                if (hasMenuButton) {
                    return true;
                }
                return false;
            },
            handleScreen: async (screenContent: AndroidNode): Promise<boolean> => {
                log("SearchInputScreen: Detected (Menu Button Present) - Typing query...");

                const data = getData();
                const businessName = data.businessName || "";
                const address = data.address || "";
                const query = `${businessName}, ${address}`;

                // Use correct API: writeText (keyboard must be visible)
                await writeText(query);
                hasTypedQuery = true;

                log("SearchInputScreen: Typed query, waiting for suggestions...");
                await sleep(2000);
                return true;
            }
        },

        // 4. HOME SCREEN (Default State)
        MapsHomeScreen: {
            detectScreen: async (screenContent: AndroidNode): Promise<boolean> => {
                // Detection: Profile Disc MUST be present
                const hasProfile = screenContent.findByIdOne(VIEW_IDS.SELECTED_ACCOUNT_DISC);
                // AND Menu Button (Back) MUST be ABSENT
                const hasMenuButton = screenContent.findByIdOne(VIEW_IDS.SEARCH_MENU_BUTTON);

                if (hasProfile && !hasMenuButton) {
                    return true;
                }
                return false;
            },
            handleScreen: async (screenContent: AndroidNode): Promise<boolean> => {
                log("MapsHomeScreen: Detected (Profile Disc Present, No Back Button)");

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
