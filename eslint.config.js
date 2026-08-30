// @ts-check
/**
 * Lint config.
 *
 * `tsc` already runs with most of the strict flags on, so the rules that earn
 * their place here are the ones a type checker structurally cannot see: a
 * promise nobody awaits, a condition that is always true, a `catch` that
 * swallows. Those are the bugs this project would actually ship.
 *
 * Where a rule is only an opinion about style, it is set to whatever the
 * codebase already does rather than the rule's default. A linter that starts
 * by demanding 54 unrelated edits gets turned off within the week.
 *
 * Formatting lives here too, via @stylistic, so there is no second tool and
 * no second config to keep in sync.
 */

import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import tseslint from "typescript-eslint";

/** `node:test` returns a promise that the runner awaits. Callers must not. */
const NODE_TEST_CALLS = {
  from: /** @type {const} */ ("package"),
  package: "node:test",
  name: ["describe", "it", "test", "before", "after", "beforeEach", "afterEach"],
};

export default tseslint.config(
  {
    // Nothing here is ours to lint.
    ignores: ["node_modules/**", "dist/**", "out/**", "coverage/**"],
  },

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    files: ["**/*.ts"],
    plugins: { "@stylistic": stylistic },
    rules: {
      // --- Formatting. Matches what the codebase already does. ---
      "@stylistic/indent": ["error", 2, { SwitchCase: 1 }],
      "@stylistic/quotes": ["error", "double", {
        avoidEscape: true,
        // A backtick string holding double quotes is the readable form.
        // Without this the fixer "helpfully" escapes every one of them.
        allowTemplateLiterals: "avoidEscape",
      }],
      "@stylistic/semi": ["error", "always"],
      "@stylistic/comma-dangle": ["error", "always-multiline"],
      "@stylistic/eol-last": ["error", "always"],
      "@stylistic/no-trailing-spaces": "error",

      // --- The reason this project has a linter at all. ---

      // An unawaited promise in the answer path fails silently, and the
      // caller gets a half-built window with no error to explain it.
      "@typescript-eslint/no-floating-promises": ["error", {
        allowForKnownSafeCalls: [NODE_TEST_CALLS],
      }],
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/return-await": ["error", "always"],

      // `verbatimModuleSyntax` is on, so a missing `type` on an import is a
      // runtime import of something that only exists at compile time.
      "@typescript-eslint/consistent-type-imports": ["error", {
        fixStyle: "inline-type-imports",
      }],

      // An `_`-prefixed name is the documented way to say "required by the
      // signature, unused on purpose".
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],

      // Swallowing an error in a pipeline that redacts client records is how
      // a leak gets to look like a clean run.
      "no-empty": ["error", { allowEmptyCatch: false }],

      // `Embedder.embed` returns a promise, and the mock and cache
      // implementations satisfy it without doing any I/O. Marking those
      // `async` is how you implement the interface, not an oversight.
      "@typescript-eslint/require-await": "off",

      // --- Style rules, set to the existing convention. ---

      // 63 type aliases, 0 interfaces.
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      // 121 `T[]`, 8 `Array<T>`.
      "@typescript-eslint/array-type": ["error", { default: "array" }],

      // This corpus is dates, dollar amounts and token counts. Interpolating
      // a number is the normal case, not a smell. Everything looser than a
      // number still has to be converted explicitly.
      "@typescript-eslint/restrict-template-expressions": ["error", {
        allowNumber: true,
      }],

      // `process.env["ANTHROPIC_API_KEY"]` is deliberate: bracket access on an
      // index signature says the key may be absent, which is the point.
      "@typescript-eslint/dot-notation": ["error", {
        allowIndexSignaturePropertyAccess: true,
      }],
    },
  },

  {
    // Tests feed malformed input on purpose, so the rules that assume
    // well-formed values flag the fixture rather than finding anything.
    files: ["tests/**/*.ts", "evals/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      // `assert.ok(entry !== undefined && entry.admitted)` names both things
      // the test is claiming. `entry?.admitted` passes for the same inputs
      // but reads as one claim, and a failure says less about which half broke.
      "@typescript-eslint/prefer-optional-chain": "off",
    },
  },

  {
    // The config lints itself, but it is not part of the tsconfig project.
    files: ["eslint.config.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
