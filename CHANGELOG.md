# Changelog

## 0.1.1

- In GitHub Actions, findings now appear as annotations on the run page and as a table in the job summary.
- A GitHub Action: `uses: harpreetkbadhan/release-lint@v0`.

## 0.1.0

First release.

- Reads `.ipa` and `.aab` files in place: zip (with zip64), binary and XML plists, the entitlements in the iOS code
  signature, the App Bundle's protobuf manifest, Hermes bytecode (v94 to v99) and the embedded Expo config.
- Rules for leaked secret keys, localhost / private network / tunnel / staging hosts, non-production deep link domains,
  debuggable and development-signed builds, development bundles and shipped source maps.
- Text and JSON reports, `--fail-on`, `--ignore`, and `release-lint.config.json`.
