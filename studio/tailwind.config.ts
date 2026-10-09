import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{js,ts,jsx,tsx,mdx}", "./components/**/*.{js,ts,jsx,tsx}", "./lib/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        studio: {
          bg: "#121212",
          panel: "#1a1a1a",
          raised: "#222222",
          border: "#2e2e2e",
          muted: "#9a9a9a",
          accent: "#f97316",
          "accent-hover": "#fb923c",
        },
      },
    },
  },
  plugins: [],
};

export default config;
