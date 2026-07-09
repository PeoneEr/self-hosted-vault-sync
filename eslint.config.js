import tsparser from '@typescript-eslint/parser';
import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';

// Same rule set the Obsidian community plugin catalog's automated review
// runs against submissions — running it locally/in CI catches these before
// a real submission does, instead of discovering them one release at a time.
export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: './tsconfig.json' },
      // Obsidian plugins run in an Electron renderer (browser globals:
      // document, window, navigator, activeDocument, ...) on top of a
      // Node-based build toolchain.
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    // Test/mock files aren't shipped in the plugin bundle and aren't seen
    // by the catalog's review, so the rules relaxed here don't affect real
    // compliance — they're all well-known false positives for mock-based
    // Jest tests: referencing a mock method without calling it to assert on
    // it (unbound-method), loosely-typed mock helpers and response chains
    // (no-explicit-any, no-unsafe-*), and a literal ".obsidian" stand-in for
    // "some configDir value" in test fixtures (hardcoded-config-path).
    files: ['src/__tests__/**/*.ts', 'src/__mocks__/**/*.ts'],
    languageOptions: {
      globals: { ...globals.jest },
    },
    rules: {
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      'obsidianmd/hardcoded-config-path': 'off',
    },
  },
  {
    // __mocks__/obsidian.ts stands in for the real Obsidian API when it
    // isn't available (Jest). It can't use Obsidian's own createDiv()/
    // createEl() helpers to build its own mock of them — that's circular.
    files: ['src/__mocks__/**/*.ts'],
    rules: {
      'obsidianmd/prefer-create-el': 'off',
    },
  },
  {
    // Deliberate trade-offs, each made once here rather than scattered as
    // inline eslint-disable comments (which the recommended config's
    // eslint-comments/no-restricted-disable rule blocks for obsidianmd/*
    // and no-deprecated specifically, precisely to force a real decision
    // instead of a silent per-line suppression):
    files: ['src/settings.ts', 'src/main.ts'],
    rules: {
      // trashFile()/setDestructive() need Obsidian 1.6.6+/1.13.0+; this
      // plugin targets minAppVersion 1.4.0 so it still installs on mobile
      // builds capped below 1.13 (see manifest.json / versions.json).
      'obsidianmd/prefer-file-manager-trash-file': 'off',
      '@typescript-eslint/no-deprecated': 'off',
      // The declarative settings API (getSettingDefinitions) needs Obsidian
      // 1.13.0+ for search integration — same minAppVersion constraint.
      'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
      // "https://" (a URL scheme) and "QR" (an acronym) are correct as
      // written; the rule's suggested all-caps/all-lowercase rewrite for
      // these two specific strings would read as a typo, not a fix.
      'obsidianmd/ui/sentence-case': 'off',
    },
  },
  {
    // Same rationale as the settings.ts/main.ts block above, different
    // strings: the rule's suggested rewrites here are "https://" (a URL
    // scheme, not proper-noun capitalization), "obsidian://..." (a URI
    // placeholder), and lowercasing the pronoun "I" mid-sentence — all
    // three are correct as written; the rule's fix would introduce a typo.
    files: ['src/onboardingWizard.ts'],
    rules: {
      'obsidianmd/ui/sentence-case': 'off',
    },
  },
  {
    ignores: ['main.js', 'esbuild.config.mjs', 'eslint.config.js', 'node_modules/**'],
  },
]);
