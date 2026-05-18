import {
  completeLinkedInLoginIfPresent,
  fetchLinkedInSession,
  isLinkedInAuthConfigured,
  logoutLinkedInSession,
  startLinkedInLogin
} from "../shared/linkedin-auth.js";

export const linkedInProvider = {
  id: "linkedin",
  title: "LinkedIn",
  sessionKey: "linkedinSession",
  connectingKey: "isConnectingLinkedIn",
  configKeys: ["linkedinAuth"],
  requirementLabel: "One required",
  footerLink: { label: "LinkedIn", hrefKey: "linkedin", defaultHref: "https://www.linkedin.com/company/liberdus" },
  links: [
    { label: "Follow", hrefKey: "linkedin", defaultHref: "https://www.linkedin.com/company/liberdus", manualClaimKey: "linkedinFollow" }
  ],
  isConfigured: isLinkedInAuthConfigured,
  isReady(session) {
    return Boolean(session?.profile?.id);
  },
  getAuthButtonText({ connecting }) {
    return connecting ? "Opening..." : "Sign in";
  },
  async start({ runtime }) {
    await startLinkedInLogin(runtime.config);
    return { redirecting: true };
  },
  async disconnect({ runtime }) {
    await logoutLinkedInSession(runtime.config);
  },
  complete: completeLinkedInLoginIfPresent,
  fetchSession: fetchLinkedInSession,
  getSuccessMessage() {
    return "LinkedIn account connected.";
  }
};
