const { createDiscordProvider } = require("./discord");
const { createTelegramProvider } = require("./telegram");
const { createLinkedInProvider } = require("./linkedin");
const { createGitHubProvider } = require("./github");

function createSocialProviders(context) {
  const providers = [
    createDiscordProvider(context),
    createTelegramProvider(context),
    createLinkedInProvider(context),
    createGitHubProvider(context)
  ];
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const routes = new Map();

  for (const provider of providers) {
    for (const [routeKey, route] of Object.entries(provider.routes || {})) {
      routes.set(routeKey, { ...route, provider });
    }
  }

  return {
    providers,
    providerById,
    getRoute(method, pathname) {
      return routes.get(`${method} ${pathname}`) || null;
    },
    pruneExpired(now) {
      providers.forEach((provider) => provider.pruneExpired?.(now));
    },
    getHealth() {
      return providers.reduce((health, provider) => ({
        ...health,
        ...(provider.getHealth?.() || {})
      }), {});
    },
    getPublicConfig() {
      return providers.reduce((config, provider) => {
        const providerConfig = provider.getPublicConfig?.() || {};
        return {
          ...config,
          ...providerConfig,
          socialLinks: {
            ...(config.socialLinks || {}),
            ...(providerConfig.socialLinks || {})
          }
        };
      }, { socialLinks: {} });
    },
    getSessionsFromCookies(request) {
      return Object.fromEntries(providers.map((provider) => [
        provider.id,
        provider.getSessionFromCookie?.(request) || null
      ]));
    },
    async refreshSessions(sessions) {
      for (const provider of providers) {
        const session = sessions[provider.id];
        if (session && provider.refreshSession) {
          await provider.refreshSession(session);
        }
      }
    },
    getVerificationSnapshot(sessions) {
      return providers.reduce((snapshot, provider) => ({
        ...snapshot,
        [provider.id]: provider.getVerification?.(sessions[provider.id]) || { connected: false }
      }), {});
    },
    buildSocialAccounts(sessions, now) {
      return providers
        .map((provider) => provider.buildSocialAccount?.(sessions[provider.id], now))
        .filter(Boolean);
    }
  };
}

module.exports = {
  createSocialProviders
};
