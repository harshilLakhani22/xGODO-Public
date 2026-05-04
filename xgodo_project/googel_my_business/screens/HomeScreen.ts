/**
 * HomeScreen - Crash recovery handler
 * 
 * Detects when app has crashed to home screen and relaunches Maps
 */

import { VIEW_IDS, AndroidNode, ScreenHandle } from './types';
import { log, sleep, launchApp } from '../util';
import { APP_PACKAGE_NAME } from '../config';

// Common launcher package names
const LAUNCHER_PACKAGES = [
    "com.google.android.apps.nexuslauncher", // Pixel
    "com.android.launcher3",
    "com.miui.home", // Xiaomi
    "com.sec.android.app.launcher", // Samsung
    "com.huawei.android.launcher", // Huawei
];

export const HomeScreen: ScreenHandle = {
    detectScreen: async (screenContent: AndroidNode): Promise<boolean> => {
        // 1. If we're still in Maps, NOT on home screen
        if (screenContent.packageName === APP_PACKAGE_NAME) {
            return false;
        }

        // 2. Check for common launcher package names
        const isLauncher = LAUNCHER_PACKAGES.some(pkg =>
            screenContent.packageName?.includes(pkg) ||
            screenContent.packageName?.includes("launcher")
        );

        // 3. Check for Maps-specific IDs (if any exist, we're NOT on home)
        const hasMapsIds = screenContent.findByIdOne("com.google.android.apps.maps:id/search_omnibox_text_box") ||
            screenContent.findByIdOne("com.google.android.apps.maps:id/omnibox_text_box");

        if (hasMapsIds) {
            return false; // Still in Maps
        }

        // 4. Require launcher package OR at least BOTH Play Store AND Chrome visible
        const hasPlayStore = screenContent.findText("Play Store");
        const hasChrome = screenContent.findText("Chrome");

        if (isLauncher || (hasPlayStore && hasChrome)) {
            return true;
        }

        return false;
    },

    handleScreen: async (): Promise<boolean> => {
        log("HomeScreen: CRASH DETECTED (Home Screen). Relaunching Maps...");
        await launchApp(APP_PACKAGE_NAME, true);
        await sleep(5000);
        return true;
    }
};
