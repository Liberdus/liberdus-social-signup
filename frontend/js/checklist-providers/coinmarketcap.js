export const coinMarketCapProvider = {
  id: "coinMarketCap",
  title: "CoinMarketCap",
  trackKey: "coinMarketCapOpened",
  footerLink: {
    label: "CoinMarketCap",
    hrefKey: "coinMarketCap",
    fallbackHrefKey: "cmc",
    defaultHref: "https://coinmarketcap.com/community/profile/Liberdus/"
  },
  links: [
    {
      label: "Follow",
      hrefKey: "coinMarketCap",
      fallbackHrefKey: "cmc",
      defaultHref: "https://coinmarketcap.com/community/profile/Liberdus/",
      manualClaimKey: "coinMarketCapFollow"
    }
  ],
  isReady(_session, runtime) {
    return Boolean(runtime.coinMarketCapOpened);
  },
  onLinkClick({ runtime }) {
    runtime.coinMarketCapOpened = true;
  }
};
