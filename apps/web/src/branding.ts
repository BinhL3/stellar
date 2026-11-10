import type { DesktopAppBranding } from "@t3tools/contracts";
import { formatAppDisplayName } from "./branding.logic";

function readInjectedDesktopAppBranding(): DesktopAppBranding | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.desktopBridge?.getAppBranding() ?? null;
}

const injectedDesktopAppBranding = readInjectedDesktopAppBranding();
const hostedAppChannel = import.meta.env.VITE_HOSTED_APP_CHANNEL?.trim().toLowerCase();

export const HOSTED_APP_CHANNEL =
  hostedAppChannel === "latest" || hostedAppChannel === "nightly" ? hostedAppChannel : null;
export const HOSTED_APP_CHANNEL_LABEL =
  HOSTED_APP_CHANNEL === "nightly" ? "Nightly" : HOSTED_APP_CHANNEL === "latest" ? "Latest" : null;
export const APP_BASE_NAME = injectedDesktopAppBranding?.baseName ?? "Stellar";
export const APP_STAGE_LABEL =
  injectedDesktopAppBranding?.stageLabel ??
  HOSTED_APP_CHANNEL_LABEL ??
  (import.meta.env.DEV ? "Dev" : "Beta");
export const APP_DISPLAY_NAME =
  injectedDesktopAppBranding?.displayName ??
  formatAppDisplayName({ baseName: APP_BASE_NAME, stageLabel: APP_STAGE_LABEL });
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";
/**
 * Stellar hides the agent permission modes (Supervised, Auto-accept edits, Auto, Full access):
 * they're coding-agent controls that read as noise in a video editor. Threads keep running in
 * the default mode, Full access.
 */
const SHOW_PERMISSION_CONTROLS = false;
/**
 * A thread that isn't in Full access still shows the control, so there is a way back: without
 * it, a thread started in a stricter mode asks for approval on every tool with no way out.
 */
export const showPermissionControls = (runtimeMode: string) =>
  SHOW_PERMISSION_CONTROLS || runtimeMode !== "full-access";
/** Stellar's chat backdrop is its art, so the sidebar's Dev and Nightly header art stays off. */
export const SHOW_STAGE_ARTWORK = false;
/** Stellar has no terminal: no drawer, no terminal surfaces, no terminal shortcuts. */
export const SHOW_TERMINAL = false;
/** Diffs, branches and pull requests are coding surfaces; Stellar edits video. */
export const SHOW_GIT_SURFACES = false;
/**
 * Stellar has no code projects: every project is a video project, whether or not it has pulled
 * a timeline yet. The costs: branch, commit, open-in-editor and project-script controls never
 * show, so the app can't be used to work on a repository, including its own.
 */
export const VIDEO_ONLY = true;
export const DESKTOP_DOWNLOAD_URL = "https://github.com/BinhL3/stellar/releases";
