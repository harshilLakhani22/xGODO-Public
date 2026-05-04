import { addData, fail, getData } from './data';
import {
  getFirefoxPackage,
  getInstalledPackageNamesPreview,
  isFirefoxPackageName,
  resolveFirefoxPackage,
  setFirefoxPackage,
} from './browser';
import {
  stages,
  Stage,
  ScreenState,
  setStage,
  steps,
  setSteps,
  getStageObject,
  ScreenHandle,
} from './Stage';
import { getAllNodes, hideSystemUIs } from './util';
import { toPublicInputSummary, validateAndResolveInputs } from './inputs';
import { captureDebugArtifacts } from './helpers';
import { dismissOpenInYouTubeDialog } from './youtube';

const MAX_STILL_SCREENS = 5;
const MAX_STUCK_SCREEN_MS = 60_000;
const UNKNOWN_DIAGNOSTIC_THRESHOLD = 3;

async function relaunchFirefoxInPlace(): Promise<boolean> {
  await agent.actions.launchApp(getFirefoxPackage(), true);
  await sleep(5_000);

  let screenContent = await agent.actions.screenContent();
  if (await hideSystemUIs(screenContent)) {
    screenContent = await agent.actions.screenContent();
  }
  if (await dismissOpenInYouTubeDialog(screenContent)) {
    screenContent = await agent.actions.screenContent();
  }

  return getAllNodes(screenContent).some((node: any) => isFirefoxPackageName(node.packageName));
}

async function main() {
  console.log('Automation started');

  const validation = validateAndResolveInputs(agent.arguments?.jobVariables ?? {});
  if (!validation.ok) {
    addData({
      inputValidationError: validation,
      receivedJobVariables: agent.arguments?.jobVariables ?? {},
    });
    await fail(validation.code);
    return;
  }

  const resolvedInputs = validation.inputs;
  const runId = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  addData({
    runId,
    keyword: resolvedInputs.keyword,
    niche: resolvedInputs.niche,
    input: toPublicInputSummary(resolvedInputs),
    results: [],
  });

  // Gemini API will be used only when scoring is required (no preflight).

  const installedAppsResult = await agent.actions.listApps();
  const installedApps = (installedAppsResult as any).appList || installedAppsResult;
  const firefoxPackage = resolveFirefoxPackage(installedApps);
  if (!firefoxPackage) {
    addData({
      installedAppPackagesPreview: getInstalledPackageNamesPreview(installedApps, 60),
    });
    await fail('FIREFOX_NOT_INSTALLED');
    return;
  }
  setFirefoxPackage(firefoxPackage);
  addData({ firefoxPackage });

  await setStage(Stage.Launch);
  await stages.find(stage => stage.name === Stage.Launch)?.defaultHandle();

  let screenCount: { screen: (keyof typeof ScreenState) | 'Unknown', count: number, firstSeenAt: number } | undefined;

  do {
    await setSteps(steps - 1);

    const currentStageObject = await getStageObject();
    let screenContent = await agent.actions.screenContent();

    if (await hideSystemUIs(screenContent)) {
      screenContent = await agent.actions.screenContent();
    }
    if (await dismissOpenInYouTubeDialog(screenContent)) {
      screenContent = await agent.actions.screenContent();
    }

    let screenState: keyof typeof ScreenState | undefined;
    let screenHandle: ScreenHandle | undefined;

    let maxDetectSteps = 3;
    while (maxDetectSteps-- > 0 && !screenState && !screenHandle) {
      for (const [screenStateDetect, screenHandleDetect] of Object.entries(currentStageObject.screenHandles)) {
        const detect = await screenHandleDetect.detectScreen(screenContent);
        if (detect) {
          screenState = screenStateDetect as keyof typeof ScreenState;
          screenHandle = screenHandleDetect;
          break;
        }
      }
      if (!screenState) {
        await sleep(5_000);
        screenContent = await agent.actions.screenContent();
        if (await hideSystemUIs(screenContent)) {
          screenContent = await agent.actions.screenContent();
        }
        if (await dismissOpenInYouTubeDialog(screenContent)) {
          screenContent = await agent.actions.screenContent();
        }
      }
    }

    console.log('Detected screen:', screenState || 'Unknown');

    await agent.utils.outOfSteps.storeScreen(
      screenContent,
      currentStageObject.name,
      screenState || 'Unknown',
      steps,
      screenState ? ScreenshotRecord.LOW_QUALITY : ScreenshotRecord.HIGH_QUALITY,
    );

    if (!screenCount || screenCount.screen !== (screenState || 'Unknown')) {
      screenCount = {
        screen: screenState || 'Unknown',
        count: 1,
        firstSeenAt: Date.now(),
      };
    } else {
      screenCount.count++;
    }

    // Capture debug artifacts when Unknown persists
    if (
      screenCount.screen === 'Unknown' &&
      screenCount.count >= UNKNOWN_DIAGNOSTIC_THRESHOLD &&
      screenCount.count % UNKNOWN_DIAGNOSTIC_THRESHOLD === 0
    ) {
      console.warn(
        `Unknown screen detected ${screenCount.count} times (stage: ${currentStageObject.name}). Capturing debug artifacts...`,
      );
      await captureDebugArtifacts(`unknown-${currentStageObject.name}`);
    }

    const stuckForMs = Date.now() - screenCount.firstSeenAt;
    if (stuckForMs > MAX_STUCK_SCREEN_MS) {
      addData({
        stuckScreen: screenCount.screen,
        stuckCount: screenCount.count,
        stuckForMs,
      });
      await fail('SCREEN_STUCK_OVER_60_SECONDS');
      return;
    }

    if (screenCount.count > MAX_STILL_SCREENS) {
      console.log('Stuck on same screen, attempting recovery...');
      addData({
        recoveryStage: currentStageObject.name,
        recoveryScreen: screenCount.screen,
        recoveryCount: screenCount.count,
      });
      const recovered = await relaunchFirefoxInPlace();
      if (!recovered) {
        addData({
          recoveryError: 'Firefox could not be foregrounded after relaunch',
        });
        await fail('FIREFOX_RECOVERY_FAILED');
        return;
      }
      screenCount = undefined;
      continue;
    }

    if (!screenState || !screenHandle) {
      console.log('No screen detected, waiting...');
      await sleep(3_000);
      continue;
    }

    const screenHandled = await screenHandle.handleScreen(screenContent);
    if (!screenHandled) {
      console.error('Failed to handle screen', screenState);
    }
  } while (steps > 0);

  const result = await agent.utils.outOfSteps.submit('outOfSteps');
  if (result.success) {
    const data = getData();
    if (data && Array.isArray(data.outOfStepIds)) {
      addData({ outOfStepIds: [...data.outOfStepIds, result.id] });
    } else {
      addData({ outOfStepIds: [result.id] });
    }
  } else {
    console.error(result.error);
  }
  await fail('OUT_OF_STEPS');
}

main()
  .catch(async e => {
    console.error(e);
    try {
      const result = await agent.utils.reportCrash(e);
      console.log(JSON.stringify(result));
    } catch (reportError) {
      console.error(reportError);
    }
    try {
      console.log('Failing task due to crash');
      await fail('CRASH');
    } catch (failError) {
      console.error(failError);
    }
  })
  .finally(agent.control.stopCurrentAutomation);
