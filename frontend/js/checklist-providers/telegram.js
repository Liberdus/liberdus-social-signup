import {
  completeTelegramLoginIfPresent,
  fetchTelegramSession,
  isTelegramAuthConfigured,
  logoutTelegramSession,
  startTelegramLogin
} from "../shared/telegram-auth.js";

export const telegramProvider = {
  id: "telegram",
  title: "Telegram",
  sessionKey: "telegramSession",
  connectingKey: "isConnectingTelegram",
  configKeys: ["telegramAuth"],
  requirementLabel: "One required",
  footerLink: { label: "Telegram", hrefKey: "telegram", defaultHref: "https://t.me/LiberdusOfficial" },
  links: [
    { label: "Join", hrefKey: "telegram", defaultHref: "https://t.me/LiberdusOfficial" }
  ],
  isConfigured: isTelegramAuthConfigured,
  isReady(session) {
    return Boolean(session?.profile?.id);
  },
  getAuthButtonText({ connecting }) {
    return connecting ? "Opening..." : "Sign in";
  },
  async start({ runtime, showMessage }) {
    runtime.telegramSession = await startTelegramLogin(runtime.config);
    showMessage("Telegram account connected.", "success");
    return { staysOnPage: true };
  },
  async disconnect({ runtime }) {
    await logoutTelegramSession(runtime.config);
  },
  complete: completeTelegramLoginIfPresent,
  fetchSession: fetchTelegramSession,
  getSuccessMessage() {
    return "Telegram account connected.";
  }
};
