import {
  completeGitHubLoginIfPresent,
  fetchGitHubSession,
  isGitHubAuthConfigured,
  logoutGitHubSession,
  startGitHubLogin
} from "../shared/github-auth.js";

export const gitHubProvider = {
  id: "github",
  title: "GitHub",
  sessionKey: "githubSession",
  connectingKey: "isConnectingGitHub",
  configKeys: ["githubAuth"],
  footerLink: { label: "GitHub", hrefKey: "githubOrg", fallbackHrefKey: "github", defaultHref: "https://github.com/Liberdus" },
  links: [
    { label: "Star", hrefKey: "githubRepo", defaultHref: "https://github.com/Liberdus/web-client-v2" },
    { label: "Follow", hrefKey: "githubOrg", fallbackHrefKey: "github", defaultHref: "https://github.com/Liberdus" }
  ],
  isConfigured: isGitHubAuthConfigured,
  isReady(session) {
    return Boolean(session?.star?.starred);
  },
  getStatusText({ session, configured, config }) {
    const profile = session?.profile || null;
    const star = session?.star || null;
    const name = profile?.username ? `@${profile.username}` : "GitHub account";
    const targetRepo = star?.targetRepo || config.githubAuth?.targetRepo || "Liberdus/web-client-v2";

    if (star?.starred) return `${name} starred ${targetRepo}`;
    if (profile?.id && star?.error) return `${name} connected; repo star check is unavailable`;
    if (profile?.id) return `${name} connected; star ${targetRepo} and recheck`;
    return configured
      ? `Star ${targetRepo} and connect your GitHub account.`
      : "GitHub sign-in is not configured.";
  },
  getAuthButtonText({ connecting, session }) {
    if (connecting) return "Opening...";
    return session?.profile?.id ? "Recheck" : "Sign in";
  },
  async start({ runtime, showMessage }) {
    if (runtime.githubSession?.profile?.id) {
      runtime.githubSession = await fetchGitHubSession(runtime.config, { required: true });
      showMessage(runtime.githubSession.star?.starred ? "GitHub repo star confirmed." : "GitHub repo star not found yet.");
      return { staysOnPage: true };
    }

    await startGitHubLogin(runtime.config);
    return { redirecting: true };
  },
  async disconnect({ runtime }) {
    await logoutGitHubSession(runtime.config);
  },
  complete: completeGitHubLoginIfPresent,
  fetchSession: fetchGitHubSession,
  getSuccessMessage(session) {
    return session?.star?.starred ? "GitHub repo star confirmed." : "GitHub account connected.";
  }
};
