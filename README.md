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

Import one account per OFX or QFX statement, and choose the corresponding tracked account. Create accounts and set a dated starting balance, or choose the statement's closing balance during import. Receipt uploads accept JPEG, PNG, and WebP images. Transactions on or before that date remain visible but are not applied again to the balance. Repeated imports use the bank-issued ID within the mapped source account. If an issuer sends a correction, review it on the transactions page. Simple unlinked corrections can be applied there; resolve linked transactions separately before applying a complex correction. The dashboard warns when a correction is unresolved. If an imported row might duplicate a purchase recorded from a receipt, review the receipt and select the matching imported transaction. Automatic matching is conservative; transactions that do not have a clear match require manual review. Imports are manual, so balances may be missing recent activity.

## License

[MIT](LICENSE).
