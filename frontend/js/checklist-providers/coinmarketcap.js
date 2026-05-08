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
  getStatusText({ runtime }) {
    return runtime.coinMarketCapOpened ? "Opened this session." : "Follow Liberdus on CoinMarketCap.";
  },
  onLinkClick({ runtime }) {
    runtime.coinMarketCapOpened = true;
  }
};
