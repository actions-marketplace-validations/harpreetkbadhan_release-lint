# Contributing

Thanks for helping. The most useful contributions are:

- **False alarms.** If release-lint flags something in your app that is fine, open a "False alarm" issue. Paste the
  finding (secrets are already masked), never the app file.
- **New rules.** A key format or a release mistake it should catch. Small rule additions are good first pull requests.

## Development

```sh
npm install
npm test          # Vitest
npm run typecheck
npm run build
node dist/bin.js path/to/app.aab
```

Node 20.19 or newer. No runtime dependencies: please keep it that way.

## Adding a secret rule

1. Add an entry to `SECRET_PATTERNS` in `src/rules.ts`. Anchor the start with `(?<![\w-])`, bound every repeat
   (`{20,256}`, never `+` or `*`), and prefer a provider-specific prefix over "looks random".
2. In `test/rules.test.ts`, add a test that finds it **and** a test for a similar string that must not match. Build the
   fake key from pieces at runtime (`'sk_' + 'live_' + '…'`) so no file contains a complete key.

## Test files

Tests only use tiny synthetic files generated in the tests (`test/helpers/fixtures.ts`). Never add a real app, a
third-party app, or a file someone sent you.

## Pull requests

Conventional commit messages (`feat:`, `fix:`, `docs:`, …), one change per pull request, and `npm test` passing.
