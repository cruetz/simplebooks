# SimpleBooks

SimpleBooks is a personal finance app for one shared household. It imports OFX and QFX bank and credit-card statements, tracks bills and money owed, and estimates cash available before payday. Amounts are stored as integer cents; the first release supports CAD only. Receipt images and extracted details stay on the server; Tesseract performs OCR locally.

## Run with Docker

Install Docker and the Compose plugin, then run:

```sh
docker compose up --build -d
```

The default configuration publishes `127.0.0.1:3000` on the host only. Set `SIMPLEBOOKS_PORT` to change the host port, and set `TZ` to an IANA timezone if it differs from `America/Edmonton`. The app uses the server's local calendar date for payday. Data, including receipt images, is stored in the `simplebooks-data` Docker volume. The image runs as the unprivileged `node` user. If replacing the named volume with a bind mount, ensure that directory is writable by the container's node user. If running with a read-only root filesystem, provide a writable temporary directory at `/tmp` for OCR.

**Access control is provided by your reverse proxy, not the app.** Configure the proxy to require and validate a client certificate for every request, including receipt images, and forward the original `Host` header. Terminate TLS at the proxy. Do not expose the application port publicly or route around that proxy. For a proxy running on the host, connect it to `127.0.0.1:3000`; its HTTPS origin must match the forwarded `Host`. For a proxy in Docker, remove the host `ports` mapping and attach both containers to a private network; proxy to `simplebooks:3000`. Confirm the proxy rejects requests without a valid client certificate before allowing remote access. The built-in loopback endpoint is intended only for trusted local development.

## Local development

Node.js 22.13 or later and Tesseract with English and orientation language data are required. Run `npm test` and `npm start`, then visit `http://127.0.0.1:3000`. Set `DATA_DIR` to choose the data directory; its default is `./data`. Set `HOST`, `PORT`, and `TZ` as needed. Use the Docker setup and authenticated proxy for remote access.

## Backup and restore

The SQLite database uses write-ahead logging. Back up the **entire** data directory while the application is stopped, including any SQLite sidecar files, to avoid an inconsistent copy. Receipt images live inside the database. The following example uses the supplied named volume and a local `backups` directory:

```sh
mkdir -p backups
docker compose stop simplebooks
docker run --rm -v simplebooks_simplebooks-data:/data:ro -v "$(pwd)/backups:/backup" alpine tar -czf /backup/simplebooks.tar.gz -C /data .
docker compose start simplebooks
```

The actual volume name depends on the Compose project name; inspect it with `docker volume ls` and substitute it in the command. Keep backups somewhere secure and test them periodically. To restore, stop the app, restore the archive to a **new empty volume or directory**, ensure its files are writable by the container's node user, then configure the service to use it and start the app. For example, create a new volume and extract the backup with a temporary container before changing the Compose volume mapping. Keep the existing data until the restored instance has been checked. Do not copy only the main SQLite file from a running instance.

## Import and reconciliation

Import one account per OFX or QFX statement. No account setup or opening balance is required. The default **Automatically match or create** option uses the full source account ID, institution identifier and its kind (including the organization namespace for FID), currency, bank/card kind, branch, and bank account type. It never matches by display name or last four digits. New bank accounts are included in the payday calculation; cards are excluded. Change inclusion on Accounts as needed.

For an existing manually created account, select it on its first import. Existing mappings from the previous version need one explicit selection to confirm the additional source details. Missing, masked, organization-name-only, or ambiguous identities require selecting an existing account or deliberately choosing **Create a new account**. Subsequent imports of weakly identified accounts still require an explicit selection. A mapping cannot silently switch to a different source account. Choose the existing destination on repeat uploads; only choose Create a new account when it really is separate.

When the account has no starting balance, a sufficiently complete statement establishes one: its dated ledger balance minus the signed sum of unique imported transactions, as of the day before the statement range starts. This preserves credit-card signs and counts transactions on the first day exactly once. Calculation requires explicit range boundaries, matching midnight end/ledger boundaries, a consistent timezone offset, transactions within the range, and no corrections or unmatched existing activity in the covered interval. Available credit is never a balance. OFX's range end is exclusive, and omitted time/zone means midnight GMT: a November export ending `20261201` with a ledger balance at `20261201` covers through November 30. Rows dated December 1 prevent automatic inference. Partial-day exports, mismatched timezones, missing ranges, and balances outside the range remain unresolved rather than guessing. These rules follow the [OFX 2.3 specification, sections 2.5.1 and 3.2.7–3.2.8](https://financialdataexchange.org/wp-content/uploads/2025/12/OFX-Banking-Specification-v2.3.pdf).

Without that evidence, transactions are still saved and the account shows **Needs balance**. Add a known balance with its as-of date on Accounts, or import a later statement with sufficient coverage. An unresolved included account prevents a payday estimate. Imports never replace an established starting balance. Older transactions remain visible; those on or before the balance date are not applied again. To intentionally reconcile a balance, use the account's **Update starting balance** form. Importing older history does not extend balance estimates backward before the established starting date.

Repeated and overlapping imports use the bank-issued ID within the mapped source account, including repeated rows within a file. Conflicting amounts or posting dates for an existing ID reject the entire import for investigation; issuer-supplied corrections remain in the existing review workflow. Retrying the same submitted form is idempotent, including explicit account creation. Account creation, mapping, transactions, and balance initialization are saved together or rolled back together.

Receipt uploads accept JPEG, PNG, and WebP images. If an issuer sends a correction, review it on the transactions page. Simple unlinked corrections can be applied there; resolve linked transactions separately before applying a complex correction. The dashboard warns when a correction is unresolved. If an imported row might duplicate a purchase recorded from a receipt, review the receipt and select the matching imported transaction. Automatic matching is conservative; transactions that do not have a clear match require manual review. Imports are manual, so balances may be missing recent activity. Full transaction coverage still depends on the issuer honoring the exported statement range; filtered exports cannot be detected reliably.

### Existing databases

On startup, an atomic migration adds nullable `accounts.source_identity` and replaces the old institution/account/kind unique index with an identity lookup index. The old index could conflate accounts with different branches or bank account types. Existing account IDs, balances, transaction IDs, and mappings are preserved. Identity uniqueness and ambiguous matching are checked inside the import's SQLite write transaction; incomplete identities can legitimately belong to separate explicitly selected accounts.

Back up the stopped application's entire data directory before an upgrade, as described above. The migration is idempotent. To roll back to the previous application version, restore the pre-upgrade backup: its narrower unique index may not support distinct accounts created with this version. Never test this migration using the live data directory.

## License

[MIT](LICENSE).
