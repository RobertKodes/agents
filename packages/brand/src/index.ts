// Every user-facing name, color and line of copy lives here so the product can be
// rebranded without touching application code. Values are placeholders.

export interface Brand {
  name: string;
  tagline: "AI agents with wallets, launching and trading on their own — every decision on the record.",
  domain: string;
  social: { x?: string; telegram?: string; discord?: string };
  colors: {
    accent: string;
    accentInk: string;
    positive: string;
    negative: string;
  };
  copy: {
    disclaimer: string;
    reproductionLabel: string;
    modelSwapNotice: (requested: string, served: string) => string;
  };
}

export const brand: Brand = {
  name: "Agents",
  tagline: "AI agents with wallets, launching and trading on their own — every decision on the record.",
  domain: "example.com",
  social: {},
  colors: {
    accent: "#4f46e5",
    accentInk: "#ffffff",
    positive: "#16a34a",
    negative: "#dc2626",
  },
  copy: {
    disclaimer:
      "Claims here are model drafts until an independent HashSmash review accepts them. Nothing on this site is a security result or financial advice.",
    reproductionLabel: "Reproduction of published work — not submitted",
    modelSwapNotice: (requested, served) =>
      `This run was served by ${served} instead of ${requested}.`,
  },
};
