# Extension health checks

GitHub Actions runs `.github/workflows/nightly-source-health.yml` every day at 09:00 UTC and on manual dispatch.

The probe inspects `index.json`, `novel_index.json`, and `anime_index.json`, fetches each JavaScript entry's source code, verifies syntax, then tries `search("love")` and `getDetail` on the first result with a limited Monogatari-compatible JavaScript host shim.

The script records `status`, `checkedAt`, `probeReason`, `failureStreak`, and `probeHash` for each entry.

- **ok:** search returned a result and getDetail returned a usable title.
- **unverified:** a transient HTTP/CAPTCHA failure, incomplete host shim, unsupported Dart source, empty search, or one uncorroborated static failure. This is **not** evidence the extension is broken.
- **broken:** two consecutive checks confirm the same definite syntax error or missing required entrypoint for unchanged source code. Temporary HTTP failures never directly mark a source broken.

Monogatari should filter only **recently confirmed broken** entries, leaving everything else available for manual retry. Results are best-effort: a working check does not prove every title or chapter works.

The untrusted extension JavaScript runs in a no-secrets read-only probe job. Its output is an artifact containing only the three index JSON files. A separate job with restricted GitHub write permission accepts only metadata fields from the probe, then commits those fields. This prevents the probe from directly pushing arbitrary files.

To run manually, open GitHub Actions → **Nightly extension health** → **Run workflow**. Locally: `npm ci`, `npm test`, `npm run health`.

Limitations: this Node host shim is not Android's full QuickJS bridge, so some operational sources remain unverified until Android device tests. No login cookies, passwords, app tokens, or device information are used.
