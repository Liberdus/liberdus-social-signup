export const coinMarketCapProvider = {
  id: "coinMarketCap",
  title: "CoinMarketCap",
  trackKey: "coinMarketCapOpened",
  links: [
    {
      label: "Follow",
      hrefKey: "coinMarketCap",
      fallbackHrefKey: "cmc",
      defaultHref: "https://coinmarketcap.com/community/profile/Liberdus/"
    }
  ],
  isReady(_session, runtime) {
    return Boolean(runtime.coinMarketCapOpened);
  },
  onLinkClick({ runtime }) {
    runtime.coinMarketCapOpened = true;
  }
};
