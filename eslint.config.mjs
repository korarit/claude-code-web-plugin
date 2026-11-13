import js from "@eslint/js";
import tseslint from "typescript-eslint";
import boundaries from "eslint-plugin-boundaries";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.harness-web/**",
      "apps/api/test/**",
      "eslint.config.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      boundaries,
    },
    settings: {
      "boundaries/elements": [
        { type: "core", pattern: "packages/core/src/**" },
        { type: "contracts", pattern: "packages/contracts/src/**" },
        {
          type: "api-domain",
          pattern: "apps/api/src/modules/*/domain/**",
          capture: ["module"],
        },
        {
          type: "api-application",
          pattern: "apps/api/src/modules/*/application/**",
          capture: ["module"],
        },
        {
          type: "api-infrastructure",
          pattern: "apps/api/src/modules/*/infrastructure/**",
          capture: ["module"],
        },
        {
          type: "api-presentation",
          pattern: "apps/api/src/modules/*/presentation/**",
          capture: ["module"],
        },
        { type: "api-root", pattern: "apps/api/src", partialMatch: false },
        { type: "web", pattern: "apps/web/src/**" },
      ],
      "boundaries/include": ["packages/**/*.ts", "apps/**/*.ts", "apps/**/*.tsx"],
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          policies: [
            {
              from: { element: { type: "core" } },
              allow: { to: { element: { type: "core" } } },
            },
            {
              from: { element: { type: "contracts" } },
              allow: {
                to: [{ element: { type: "core" } }, { element: { type: "contracts" } }],
              },
            },
            {
              from: { element: { type: "api-domain" } },
              allow: {
                to: [
                  { element: { type: "core" } },
                  { element: { type: "contracts" } },
                  {
                    element: {
                      type: "api-domain",
                      captured: { module: "{{ from.element.captured.module }}" },
                    },
                  },
                ],
              },
            },
            {
              from: { element: { type: "api-application" } },
              allow: {
                to: [
                  { element: { type: "core" } },
                  { element: { type: "contracts" } },
                  {
                    element: {
                      type: "api-domain",
                      captured: { module: "{{ from.element.captured.module }}" },
                    },
                  },
                  {
                    element: {
                      type: "api-application",
                      captured: { module: "{{ from.element.captured.module }}" },
                    },
                  },
                ],
              },
            },
            {
              from: { element: { type: "api-infrastructure" } },
              allow: {
                to: [
                  { element: { type: "core" } },
                  { element: { type: "contracts" } },
                  {
                    element: {
                      type: "api-domain",
                      captured: { module: "{{ from.element.captured.module }}" },
                    },
                  },
                  {
                    element: {
                      type: "api-application",
                      captured: { module: "{{ from.element.captured.module }}" },
                    },
                  },
                  {
                    element: {
                      type: "api-infrastructure",
                      captured: { module: "{{ from.element.captured.module }}" },
                    },
                  },
                ],
              },
            },
            {
              from: { element: { type: "api-presentation" } },
              allow: {
                to: [
                  { element: { type: "core" } },
                  { element: { type: "contracts" } },
                  {
                    element: {
                      type: "api-domain",
                      captured: { module: "{{ from.element.captured.module }}" },
                    },
                  },
                  {
                    element: {
                      type: "api-application",
                      captured: { module: "{{ from.element.captured.module }}" },
                    },
                  },
                  {
                    element: {
                      type: "api-presentation",
                      captured: { module: "{{ from.element.captured.module }}" },
                    },
                  },
                ],
              },
            },
            {
              from: { element: { type: "api-root" } },
              allow: {
                to: [
                  { element: { type: "core" } },
                  { element: { type: "contracts" } },
                  { element: { type: "api-root" } },
                  { element: { type: "api-domain" } },
                  { element: { type: "api-application" } },
                  { element: { type: "api-infrastructure" } },
                  { element: { type: "api-presentation" } },
                ],
              },
            },
            {
              from: { element: { type: "web" } },
              allow: {
                to: [
                  { element: { type: "core" } },
                  { element: { type: "contracts" } },
                  { element: { type: "web" } },
                ],
              },
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!(node:|\\./|\\.\\./)).+",
              message: "packages/core must have zero external or workspace dependencies.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/api/src/modules/*/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!(node:|@core/|@contracts/|\\./|\\.\\./)).+",
              message: "Domain layer must have zero external dependencies.",
            },
            {
              group: ["@contracts", "@contracts/*"],
              allowTypeImports: true,
              message: "Domain layer may only use type-only imports from @contracts/*.",
            },
          ],
        },
      ],
    },
  },
);
