// Compiled from util.ts - DO NOT EDIT DIRECTLY
// This file is auto-generated when saving the TypeScript source

const PHONE_PACKAGE_NAME = 'com.android.phone';
export async function hideSystemUIs(screenContent: AndroidNode) {
    const notificationNode = (await agent.actions.allScreensContent()).flatMap((screen: AndroidNode) => getAllNodes(screen))
        .find((node: AndroidNode) => node.viewId === "com.android.systemui:id/expandableNotificationRow" && node.actions.includes(agent.constants.ACTION_DISMISS));
    if (notificationNode) {
        await agent.actions.nodeAction(notificationNode, agent.constants.ACTION_DISMISS);
        await sleep(1000);
        return true;
    }
    const closeNode = screenContent
        .find((node: AndroidNode) => node.viewId === "android:id/aerr_close" && node.clickable);
    if (closeNode) {
        await agent.actions.nodeAction(closeNode, agent.constants.ACTION_CLICK);
        await sleep(2000);
        return true;
    }
    const closeButton = screenContent.allNodes().every((node: AndroidNode) => node.packageName === PHONE_PACKAGE_NAME) &&
        screenContent.allNodes().find((node: AndroidNode) => [`${PHONE_PACKAGE_NAME}:id/btn_ussd_dialog_cancel`, `${PHONE_PACKAGE_NAME}:id/btn_negative`, `${PHONE_PACKAGE_NAME}:id/btn_neutral`].includes(node.viewId || ''));
    if (closeButton) {
        if (closeButton.actions.includes(agent.constants.ACTION_CLICK)) {
            await agent.actions.nodeAction(closeButton, agent.constants.ACTION_CLICK);
        }
        else {
            const { left, right, top, bottom } = closeButton.boundsInScreen;
            agent.utils.randomClick(left, top, right, bottom);
        }
        await sleep(5000);
        return true;
    }
    return false;
}
