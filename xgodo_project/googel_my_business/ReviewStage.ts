/**
 * Review Stage - Leave a Google Maps Review
 * 
 * MODULAR ARCHITECTURE v3
 * - Each screen handler is in its own file under screens/
 * - State is managed centrally in screens/types.ts
 * - This file only defines the stage structure
 * 
 * Screen Flow:
 * ReviewButtonScreen -> StarRatingScreen -> ReviewTextScreen -> SubmitScreen
 * (DiscardDialog and HomeScreen are recovery handlers)
 */

import { Stage } from './Stage';
import { DEFAULT_MAX_STEPS_PER_STAGE, StageName } from './config';
import { log, sleep } from './util';

// Import screen handlers from modular files
import {
    ReviewButtonScreen,
    StarRatingScreen,
    ReviewTextScreen,
    SubmitScreen,
    DiscardDialog,
    HomeScreen,
    resetReviewState,
} from './screens/index';

// Re-export for external use
export { resetReviewState };

// --- STAGE DEFINITION ---
export const ReviewStage: Stage<{
    ReviewButtonScreen: string;
    StarRatingScreen: string;
    ReviewTextScreen: string;
    SubmitScreen: string;
    DiscardDialog: string;
    HomeScreen: string;
}> = {
    name: StageName.Review,
    maxSteps: DEFAULT_MAX_STEPS_PER_STAGE,
    screens: {
        ReviewButtonScreen: "ReviewButtonScreen",
        StarRatingScreen: "StarRatingScreen",
        ReviewTextScreen: "ReviewTextScreen",
        SubmitScreen: "SubmitScreen",
        DiscardDialog: "DiscardDialog",
        HomeScreen: "HomeScreen",
    },
    defaultHandle: async () => {
        log("ReviewStage: defaultHandle - Unknown screen detected.");
        await sleep(5000);
    },
    screenHandles: {
        ReviewButtonScreen,
        StarRatingScreen,
        ReviewTextScreen,
        SubmitScreen,
        DiscardDialog,
        HomeScreen,
    }
};
