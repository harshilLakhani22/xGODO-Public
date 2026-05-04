/**
 * Login Stage - Example stage for app authentication
 *
 * This stage handles the login flow of an app.
 * Customize the screen detection and handling for your target app.
 */

import { APP_PACKAGE_NAME, DEFAULT_MAX_STEPS_PER_STAGE } from "./config";
import { Stage, type ScreenHandles, setStage } from "./Stage";

/**
 * Define the screens this stage can handle
 * Add more screens as needed (e.g., TwoFactorAuth, ForgotPassword)
 */
const LoginStageScreen = {
  LoginForm: "LoginForm",
  // Add more screens here:
  // LoadingScreen: "LoadingScreen",
  // ErrorDialog: "ErrorDialog",
} as const;

/**
 * Screen handlers - detect and handle each screen type
 */
const LoginHandles = {
  LoginForm: {
    /**
     * Detect if the login form is displayed
     * Customize this to match your app's login screen
     */
    detectScreen: async (screenContent) => {
      // Example: Look for a login button or username field
      // Customize these selectors for your target app
      const hasLoginButton = !!screenContent.findAdvanced(
        filter => filter.hasPackageName(APP_PACKAGE_NAME) &&
          filter.text(t => !!t?.toLowerCase().includes("login") ||
            !!t?.toLowerCase().includes("sign in"))
      );
      const hasUsernameField = !!screenContent.findAdvanced(
        filter => filter.isEditText() &&
          filter.hasPackageName(APP_PACKAGE_NAME)
      );
      return hasLoginButton || hasUsernameField;
    },

    /**
     * Handle the login form - enter credentials and submit
     */
    handleScreen: async (screenContent) => {

      // Find and fill username field
      // Customize the selector for your app
      const usernameField = screenContent.filterAdvanced(
        filter => filter.isEditText() &&
          filter.hasPackageName(APP_PACKAGE_NAME)
      ).find(
        node => node.hintText?.toLowerCase().includes("username") ||
          node.hintText?.toLowerCase().includes("email")
      );

      if (usernameField) {
        usernameField.randomClick();
        await sleep(500);
        // Use job variables for credentials
        await agent.actions.writeText(agent.arguments.jobVariables.username || "");
        await sleep(500);
      }

      // Find and fill password field
      const passwordField = (await agent.actions.screenContent()).filterAdvanced(
        filter => filter.isEditText() &&
          filter.hasPackageName(APP_PACKAGE_NAME)
      ).find(
        node => node.isPassword
      );

      if (passwordField) {
        passwordField.randomClick();
        await sleep(500);
        await agent.actions.writeText(agent.arguments.jobVariables.password || "");
        await sleep(500);
      }

      // Find and click login button
      const loginButton = (await agent.actions.screenContent()).findAdvanced(
        filter => filter.hasPackageName(APP_PACKAGE_NAME) &&
          filter.isClickable() &&
          filter.text(t => !!t?.toLowerCase().includes("login") ||
            !!t?.toLowerCase().includes("sign in"))
      );

      if (loginButton) {
        loginButton.randomClick();
        await sleep(3_000);
        // Transition to the next stage
        await setStage(Stage.Action);
        return true;
      }

      return false;
    },
  },
} as const satisfies ScreenHandles<keyof typeof LoginStageScreen>;

/**
 * Export the stage definition
 */
const LoginStage = {
  name: "Login",
  maxSteps: DEFAULT_MAX_STEPS_PER_STAGE,
  screens: LoginStageScreen,
  screenHandles: LoginHandles,

  /**
   * Called when entering this stage
   * Launch the app and wait for it to load
   */
  defaultHandle: async () => {
    await agent.actions.launchApp(APP_PACKAGE_NAME, true);
    await sleep(3_000);
  },
} as const satisfies Stage<typeof LoginStageScreen>;

export default LoginStage;
