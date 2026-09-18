import { FlatCompat } from "@eslint/eslintrc";

// The only linting this repo carries is Next's own default ruleset. The two
// `eslint-disable-next-line react-hooks/exhaustive-deps` comments in the code
// were referencing exactly this rule long before any linter was configured.
const compat = new FlatCompat();

const flat = [
  ...compat.extends("next/core-web-vitals"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      ".next-release/**",
      "release/**",
      "reference/**",
      "scripts/**",
      "electron/**",
    ],
  },
];

export default flat;
