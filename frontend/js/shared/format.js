import { ethers } from "./ethers.js";

export function normalizeAddress(value) {
  return ethers.isAddress(value) ? ethers.getAddress(value) : "";
}

export function formatAddressShort(value) {
  if (!value || !ethers.isAddress(value)) return String(value ?? "");
  const normalized = ethers.getAddress(value);
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

export function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

