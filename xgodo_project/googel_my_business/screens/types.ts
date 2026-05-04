/**
 * Shared types, constants, and state for Review Screen Handlers
 */

declare const agent: any;

// Type alias for AndroidNode
export type AndroidNode = any;

// --- VIEW IDS (Verified from JSONs) ---
export const VIEW_IDS = {
    // Business Page Indicators (Different phones have different ViewIDs)
    STREET_VIEW_THUMBNAIL: "com.google.android.apps.maps:id/street_view_thumbnail",
    ACTION_BAR_RECYCLER: "com.google.android.apps.maps:id/recycler_view",
    HEADER_LAYOUT: "com.google.android.apps.maps:id/expandingscrollview_container",
    PLACE_NESTED_SCROLL_VIEW: "com.google.android.apps.maps:id/place_nested_scroll_view",
    BUSINESS_PLACE_CARD: "com.google.android.apps.maps:id/business_place_card",
    PHOTOS_TAB_VIEW: "com.google.android.apps.maps:id/photos_tab_view",
    SAVE_ACTION_BUTTON: "com.google.android.apps.maps:id/save_action_button",

    // Ratings - NO RELIABLE VIEW ID FOOUND in dumps for SeekBar
    RATING_STARS_CONTAINER: "com.google.android.apps.maps:id/rating_stars_container", // Keep for now, might exist on some devices

    // Review Input & Submit
    POST_BUTTON: "com.google.android.apps.maps:id/floatingBottomPostButton",

    // Dialog
    DIALOG_TITLE: "com.google.android.apps.maps:id/dialog_title",
    DIALOG_NEGATIVE_BUTTON: "com.google.android.apps.maps:id/dialog_negative_button",
    DIALOG_POSITIVE_BUTTON: "com.google.android.apps.maps:id/dialog_positive_button",

    // Alternative IDs for different phone layouts
    ALTERNATIVE_REVIEW_INPUTS: [
        "com.google.android.apps.maps:id/contentEditText",
        "com.google.android.apps.maps:id/review_text",
        "com.google.android.apps.maps:id/edit_text",
        "com.google.android.apps.maps:id/review_input",
        "com.google.android.apps.maps:id/text_input",
    ],
};

// Text hints to identify the review input field (robust fallback)
export const REVIEW_TEXT_HINTS = [
    "tell others about your experience",
    "share details of your own experience",
    "write your review",
    "describe your experience",
    "share more about your experience",
];

// Business Page ViewIDs - check ANY of these to detect business page
export const BUSINESS_PAGE_INDICATORS = [
    VIEW_IDS.STREET_VIEW_THUMBNAIL,
    VIEW_IDS.HEADER_LAYOUT,
    // VIEW_IDS.SEARCH_OMNIBOX, // REMOVED: Common to many screens (like search results), causes false positives
    VIEW_IDS.PLACE_NESTED_SCROLL_VIEW,
    VIEW_IDS.BUSINESS_PLACE_CARD,
    VIEW_IDS.PHOTOS_TAB_VIEW,
    VIEW_IDS.SAVE_ACTION_BUTTON,
];

// --- STATE TRACKING (Module-level singleton) ---
export const reviewState = {
    hasClickedReviewButton: false,
    hasSwitchedToReviewsTab: false,
    hasSelectedStars: false,
    hasTypedReview: false,
    scrollAttempts: 0,
    recoveryAttempts: 0, // Track how many times we've reset state for recovery
    keyboardDismissAttempts: 0, // Track goBack() attempts to prevent loop with DiscardDialog
};

// Reset state for fresh start
export function resetReviewState(): void {
    reviewState.hasClickedReviewButton = false;
    reviewState.hasSwitchedToReviewsTab = false;
    reviewState.hasSelectedStars = false;
    reviewState.hasTypedReview = false;
    reviewState.scrollAttempts = 0;
    reviewState.recoveryAttempts = 0;
    reviewState.keyboardDismissAttempts = 0;
}

// --- HELPER: Screen Handle Type ---
export interface ScreenHandle {
    detectScreen: (screenContent: AndroidNode) => Promise<boolean>;
    handleScreen: (screenContent: AndroidNode) => Promise<boolean>;
}
