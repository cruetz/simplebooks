# SimpleBooks Implementation Plan

**Goal** Build the approved self-hosted first release.

**Architecture** A server-rendered Node web app stores double-entry journal records, import identities, and receipt images in SQLite. Tesseract runs locally. HTML forms provide the main workflows, with a responsive layout for phone and desktop.

**Spec** [First release](../specs/2026-11-13-simplebooks-design.md)

## Ledger and dashboard

- [x] Exercise integer amounts, opening balances with historical imports, partial payments, and the exclusive payday cutoff in `test/simplebooks.test.js`.
- [x] Implement storage, balanced postings, accounts, manual entries, obligations, repayments, and projection in `src/books.js`.
- [x] Run `npm test` and verify the $600 example, negative balances, and excluded future money. (58 tests passed with loopback access.)

## Imports and receipts

- [x] Exercise repeated and overlapping imports, two purchases with the same details, opposite transfer legs, and both receipt arrival orders.
- [x] Implement QFX/OFX parsing in `src/ofx.js`, import and linking in `src/books.js`, and local OCR in `src/receipts.js`.
- [x] Verify a malformed import rolls back, ambiguous matches are reviewable, and repeat uploads preserve the ledger. (Real issuer exports remain unverified.)

## Web and deployment

- [ ] Exercise form submissions, phone receipt capture, and restart persistence through `src/server.js`. (Form submission, receipt upload, and persistence passed; a physical phone capture remains unverified.)
- [x] Implement navigation, financial workflows, and a responsive dashboard in `src/views.js` and `public/style.css`.
- [x] Provide a Docker image, private proxy setup, configurable volume, and backup instructions. Verify the normal startup path and render desktop and phone widths. (Compose config, isolated image startup and volume recreation, nonroot execution, and OCR dependencies passed. Chrome visual checks passed at 1440×1000 and 390×844 for overview, import, and receipts, with no horizontal page overflow. A live client-certificate proxy remains unverified.)
