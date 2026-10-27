import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // Disable React Compiler rules. The project does not use React Compiler
      "react-hooks/react-compiler": "off",
      "react-hooks/set-state-in-effect": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      // Tag spelling has one rule: lib/tags.ts canonicalName (mirrors the
      // backend's tag_names.canonical_name, lora tokens left alone).
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name=/^replace(All)?$/][arguments.0.regex.pattern='\\\\s+'][arguments.1.value='_']",
          message: "Use canonicalName from lib/tags.ts for tag spelling.",
        },
      ],
    },
  },
  {
    files: ["src/lib/tags.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
);
