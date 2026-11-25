# Changelog

## 0.2.3

- README: **Let your agent do it**, a copy-paste prompt for Claude Code, Codex, Cursor or Copilot. The agent finds
  the release build, runs release-lint, explains each finding and fixes it at its source (app config, EAS profile, env
  vars).
- **Claude Code plugin.** `/plugin marketplace add harpreetkbadhan/release-lint`, then
  `/plugin install app-release-lint@release-lint`, then type `/app-release-lint`. The skill is now named
  `app-release-lint` to match; its file path is unchanged.
- No changes to the CLI.

## 0.2.2

- No false alarms from the Sentry SDK: its built-in Spotlight URL (`http://localhost:8969/stream`) and links to Sentry's
  own domains (`develop.sentry.dev`, `*.sentry.io`) are no longer reported. Found by scanning a real Sentry-enabled app.
- Framework URLs such as React Native's `http://localhost:8081/` are now also ignored in plain JavaScript bundles, not
  only in Hermes ones. An app's own URLs next to them are still reported.
- README: the quick-start command no longer has an inline `#` comment, which zsh (the macOS default shell) passed on
  as extra arguments when copied.

## 0.2.1

- New rule `secret/google-oauth-client-secret`: Google OAuth client secrets (`GOCSPX-…`) in the bundle or Expo config.
  Thanks [@techkayacodes](https://github.com/techkayacodes) (#7), the first outside contribution.
- New rule `secret/mapbox-secret-token`: Mapbox secret tokens (`sk.…`); public `pk.` tokens are never reported.
  Thanks [@konpeeyush](https://github.com/konpeeyush) (#9).

## 0.2.0

- **`.apk` support.** Reads the binary XML `AndroidManifest.xml` (UTF-16 and UTF-8 string pools; attribute names
  recovered from the resource map when an obfuscator stripped them). Tested on real release and debug APKs.
- **SARIF output:** `--sarif <path>` writes a SARIF 2.1.0 report for GitHub code scanning, with stable fingerprints.
  The GitHub Action has a matching `sarif` input.
- Secret patterns live in their own file with a one-line-per-rule test table, so adding a rule is a two-file change.

## 0.1.1

- In GitHub Actions, findings now appear as annotations on the run page and as a table in the job summary.
- A GitHub Action: `uses: harpreetkbadhan/release-lint@v0`.

## 0.1.0

First release.

- Reads `.ipa` and `.aab` files in place: zip (with zip64), binary and XML plists, the entitlements in the iOS code
  signature, the App Bundle's protobuf manifest, Hermes bytecode (verified on v98 and v99; other versions fall back to approximate strings) and the embedded Expo config.
- Rules for leaked secret keys, localhost / private network / tunnel / staging hosts, non-production deep link domains,
  debuggable and development-signed builds, development bundles and shipped source maps.
- Text and JSON reports, `--fail-on`, `--ignore`, and `release-lint.config.json`.
