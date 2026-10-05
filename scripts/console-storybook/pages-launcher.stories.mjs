import { story } from "./story.mjs";

export default { title: "Pages/Launcher" };

export const Administrator = { ...story("launcherAdmin") };
export const MultipleClaws = { ...story("launcherMultiple") };
export const SingleClaw = { ...story("launcherSingle") };
export const Unavailable = { ...story("launcherUnavailable") };
export const NoAccess = { ...story("launcherEmpty") };
export const DiscoveryFailure = { ...story("launcherFailure") };
export const Loading = { ...story("launcherLoading") };
export const SignIn = { ...story("launcherLogin") };
