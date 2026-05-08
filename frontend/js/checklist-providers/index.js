import { discordProvider } from "./discord.js";
import { telegramProvider } from "./telegram.js";
import { linkedInProvider } from "./linkedin.js";
import { gitHubProvider } from "./github.js";
import { coinMarketCapProvider } from "./coinmarketcap.js";

export const checklistProviders = [
  discordProvider,
  telegramProvider,
  linkedInProvider,
  gitHubProvider,
  coinMarketCapProvider
];
