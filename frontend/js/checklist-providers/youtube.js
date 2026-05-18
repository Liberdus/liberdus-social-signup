import {
  completeYouTubeLoginIfPresent,
  fetchYouTubeSession,
  isYouTubeAuthConfigured,
  logoutYouTubeSession,
  startYouTubeLogin
} from "../shared/youtube-auth.js";

function getYouTubeName(profile) {
  const channel = profile?.youtubeChannel || null;
  if (channel?.handle) return `@${channel.handle}`;
  return channel?.title || profile?.displayName || profile?.email || "YouTube account";
}

export const youTubeProvider = {
  id: "youtube",
  title: "YouTube",
  sessionKey: "youtubeSession",
  connectingKey: "isConnectingYouTube",
  configKeys: ["youtubeAuth"],
  footerLink: { label: "YouTube", hrefKey: "youtube", defaultHref: "https://www.youtube.com/@Liberdus" },
  links: [
    { label: "Subscribe", hrefKey: "youtube", defaultHref: "https://www.youtube.com/@Liberdus" }
  ],
  isConfigured: isYouTubeAuthConfigured,
  isReady(session) {
    return Boolean(session?.subscription?.subscribed);
  },
  getAuthButtonText({ connecting, session }) {
    if (connecting) return "Opening...";
    return session?.profile?.id ? "Recheck" : "Sign in";
  },
  async start({ runtime, showMessage }) {
    if (runtime.youtubeSession?.profile?.id) {
      runtime.youtubeSession = await fetchYouTubeSession(runtime.config, { required: true });
      showMessage(runtime.youtubeSession.subscription?.subscribed ? "YouTube subscription confirmed." : "YouTube subscription not found yet.");
      return { staysOnPage: true };
    }

    await startYouTubeLogin(runtime.config);
    return { redirecting: true };
  },
  async disconnect({ runtime }) {
    await logoutYouTubeSession(runtime.config);
  },
  complete: completeYouTubeLoginIfPresent,
  fetchSession: fetchYouTubeSession,
  getSuccessMessage(session) {
    const name = getYouTubeName(session?.profile);
    return session?.subscription?.subscribed ? `YouTube subscription confirmed for ${name}.` : `${name} connected.`;
  }
};
