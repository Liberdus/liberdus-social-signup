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
  requirementLabel: "One required",
  footerLink: { label: "Discord", hrefKey: "discord", defaultHref: "https://liberdus.com/discord" },
  links: [
    { label: "Join", hrefKey: "discord", defaultHref: "https://liberdus.com/discord" }
  ],
  isConfigured: isDiscordAuthConfigured,
  isReady(session) {
    return Boolean(session?.profile?.username);
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
