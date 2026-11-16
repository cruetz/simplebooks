# Import account resolution

This change is based on `61008f6a297da905bedaa9a13494a8476ade42f0` and keeps the existing Node/SQLite journal. Work and verification use an isolated desktop checkout and synthetic data.

## Decisions

- Make account selection optional on the import form. Resolve a complete identity automatically; otherwise require an explicit destination or a deliberate new account. Do not infer identity from names, merchants, balances, or last four digits.
- Keep the existing nullable opening balance as the unresolved state. Transactions can import before a balance exists, and the existing account balance form supplies a narrow correction path.
- Infer a first opening balance only from a declared full-day transaction range anchored by its closing ledger balance. OFX ends are exclusive: require midnight start/end and a matching midnight ledger boundary, with consistent timezone offsets; all posted dates must precede the end. Subtract all distinct source transactions, including rows already imported, to avoid overlap errors. Save the opening on the prior day because journal baselines are end-of-day values.
- Preserve all established starting balances. Rebasing on every upload would make repeated or older files change current money and could overwrite a manual correction. Older transactions remain history without extending balance calculations backward.
- Retain the existing correction, receipt, and transfer workflows. Source-ID conflicts without an explicit correction reject the import atomically.

## Migration and review

`accounts.source_identity` stores the richer source identity. Legacy source mappings are retained and require an explicit selection once. The old unique index omitted branch and bank account subtype; it is replaced by an identity lookup index. All identity decisions and mutations occur inside `BEGIN IMMEDIATE`, including repeat-form protection. The migration and repeated startup are tested with a synthetic database containing the original schema, balanced journal entries, source mappings, and imports.

An independent review identified missing FID organization scoping and exclusive end-boundary semantics; both have dedicated regressions. FID is now qualified by ORG, and missing ORG requires explicit selection. Timestamped partial-day and timezone-mismatched coverage remains unresolved. Source: [OFX 2.3, sections 2.5.1 and 3.2.7–3.2.8](https://financialdataexchange.org/wp-content/uploads/2025/12/OFX-Banking-Specification-v2.3.pdf).

Rollback must use a pre-upgrade backup if new accounts would collide under the old index. No production settings, credentials, real financial data, proxy, or deployment files are involved in this implementation.

## Verification coverage

Domain and parser tests cover bank and card initialization, signed cents, duplicate IDs within a statement, overlapping and older imports, existing manual balances, full and incomplete identities, weak-identity form retries, legacy migration, conflicting IDs, corrections, extra existing activity, missing or partial-day coverage, and arithmetic overflow. HTTP tests cover importing from an empty installation, repeat uploads, restart persistence, unresolved balances, and explicit creation for weak identities.

The package's only check is `npm test` (`node --test`). There is no build, lint, or dependency-install step. Tests use temporary or in-memory databases only.

Verified on 2026-11-16:

- `npm test` on portable Node 22.13.0: **79 passed, 0 failed**. Node 22 emits its expected experimental SQLite warning.
- `node --test` on desktop Node 24.22.1: **79 passed, 0 failed**.
- `node --check` for every source and test JavaScript file and `git diff --check`: passed.
- Independent follow-up review: both identified issues fixed; no remaining blockers. Reviewer independently ran 28 parser/domain tests and direct reproductions.
- Docker image verification was unavailable because the local Docker Desktop engine was not running. Node 22 runtime verification used an official portable download instead.

The desktop has no Tesseract executable, so OCR tests exercise the existing unavailable/unreadable fallback. OCR implementation and deployment files are unchanged.
