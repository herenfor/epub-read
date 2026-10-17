import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: ["dist/**", "src-tauri/**", "docs/**", "scripts/**", ".*/**"],
  },
  {
    name: "reader/react-hooks",
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["**/*.test.ts", "src/test/**"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      // Ref-owned lifetimes need individual review, not automatic dependency additions.
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
