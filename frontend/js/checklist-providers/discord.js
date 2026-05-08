import {
  completeDiscordLoginIfPresent,
  fetchDiscordSession,
  isDiscordAuthConfigured,
  logoutDiscordSession,
  startDiscordLogin
} from "../shared/discord-auth.js";

export const discordProvider = {
  id: "discord",
  title: "Discord",
  sessionKey: "discordSession",
  connectingKey: "isConnectingDiscord",
  configKeys: ["discordAuth"],
  footerLink: { label: "Discord", hrefKey: "discord", defaultHref: "https://liberdus.com/discord" },
  links: [
    { label: "Join", hrefKey: "discord", defaultHref: "https://liberdus.com/discord" }
  ],
  isConfigured: isDiscordAuthConfigured,
  isReady(session) {
    return Boolean(session?.profile?.username);
  },
  getStatusText({ session }) {
    if (session?.profile?.username) {
      const name = session.profile.displayName || session.profile.username;
      return session.membership?.isMember
        ? `${name} connected and server membership confirmed`
        : `${name} connected; join the server to complete this optional check`;
    }
    return "Join the Liberdus server and connect your Discord account.";
  },
  getAuthButtonText({ connecting }) {
    return connecting ? "Opening..." : "Sign in";
  },
  async start({ runtime }) {
    await startDiscordLogin(runtime.config);
    return { redirecting: true };
  },
  async disconnect({ runtime }) {
    await logoutDiscordSession(runtime.config);
  },
  complete: completeDiscordLoginIfPresent,
  fetchSession: fetchDiscordSession,
  getSuccessMessage() {
    return "Discord account connected.";
  }
};
