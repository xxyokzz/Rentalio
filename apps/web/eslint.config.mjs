import nextConfig from "eslint-config-next/core-web-vitals";

export default [
  {
    ignores: [
      ".next/**",
      "next-env.d.ts",
      "src/shared/api/types.generated.ts",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  ...nextConfig,
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      // Kontrak OpenAPI menghasilkan tipe dengan properti opsional; akses
      // defensif sudah dilakukan di komponen, jadi aturan ini tidak perlu.
      "@typescript-eslint/no-explicit-any": "error",
      "react/no-unescaped-entities": "off",
    },
  },
  {
    files: ["e2e/**/*.ts", "*.config.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];
