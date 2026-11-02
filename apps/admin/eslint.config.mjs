import nextConfig from "eslint-config-next/core-web-vitals";

export default [
  {
    ignores: [".next/**", "next-env.d.ts", "node_modules/**"],
  },
  ...nextConfig,
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "react/no-unescaped-entities": "off",
    },
  },
];
