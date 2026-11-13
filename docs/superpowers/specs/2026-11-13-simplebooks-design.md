# SimpleBooks first release

SimpleBooks is an open-source personal finance app. It takes the reliability of double-entry bookkeeping and puts it behind everyday actions like importing a statement, tracking a bill, and recording that a friend paid you back. Its main job is to show what you can spend before payday based on the cash you have and what is due.

## Deployment and access

Run one responsive web app in Docker. Store the SQLite database and receipt images under one configurable server data directory that can be mounted as a persistent volume. A phone and a computer use the same instance. Receipt text recognition runs locally on the server.

For the first release, use the existing reverse proxy's client-certificate authentication as the sole access gate. Keep the container reachable only by the authenticated proxy in normal deployment, with a loopback-only option for local development. Use one shared personal workspace and omit app-level sign-in. Document the proxy setup, persistent volume, and how to back up and restore the data directory consistently.

An app-managed single-user login was the other option. It would make the app usable without a certificate-aware proxy, at the cost of handling passwords and sessions in the first release. Proxy authentication is the simpler choice for the existing setup.

## Everyday workflow

### Import transactions

Create or select a bank or credit card account and upload its statement. Support Quicken QFX and OFX banking and credit card exports first. Show the account, date range, and counts of new, previously imported, and flagged transactions. Remember the institution and account mapping after the first import. Use the bank-issued transaction ID within that source account to skip repeated records. Keep distinct bank IDs separate even when the date, merchant, and amount agree. Make re-imports and retries safe.

The file extensions from the user's bank and card issuers are unverified. This design assumes both can export QFX or OFX. If either cannot, confirm which export that account supplies before choosing its fallback.

Treat credit card payments and transfers between tracked accounts as movements of money. Pair opposite sides of a transfer into one movement when the evidence is clear and let the user confirm ambiguous matches. Each side retains its own imported identity. Purchases affect spending by category when they post. Credit card payments settle the balance and do not become a second expense.

Allow manual entries for cash spending and adjustments, and let users review and change transaction categories. Use merchant rules and receipt details to suggest categories. An explicit category choice takes precedence over later suggestions.

### Scan receipts

Capture a photo on a phone or upload a photo from either device. Read the merchant, purchase date, and total on the server and suggest a category. Let the user correct the result. Try matching in either order, so a receipt can find an earlier import and a later import can find a receipt waiting for a match. Attach automatically only when a single eligible transaction has a strong amount, date, and merchant match. Flag ambiguous matches for review. Retrying the same image upload should reuse the existing receipt.

A photo on its own creates a receipt awaiting a match. It does not change balances or spending. A user can explicitly record it as a paid purchase, for example for a cash receipt. A later statement match to a manually recorded purchase attaches the imported identity to that purchase instead of posting it again.

### Track bills and money owed

Record a bill with a name, amount, due date, and optional monthly recurrence. Track card statement payments as bills with their own due date and remaining amount. A paid or partly paid bill can be linked to a matching imported transaction or a manual payment. A clear match can be applied automatically. Show uncertain matches for review. Each occurrence has its own payment status, and already-paid amounts are excluded from what is due.

Record who owes you money, how much, and optionally when it is expected. Link the amount owed to an existing outlay or record a starting amount owed. Creating the record preserves the current cash balance. Track partial and full repayments. A repayment can be linked to a deposit that has already been imported. Linking an existing payment or deposit updates the ledger classification and the amount still outstanding without moving cash a second time.

### See what is left before payday

Set the next payday as a date. Start with the recorded balance of the cash accounts selected for everyday spending. Subtract the remaining unpaid amounts of bills and credit card payments due before that date, including overdue amounts. Show the calculation, the cash accounts it includes, and the balances' last update dates. Show a shortfall as a negative amount. After the payday date arrives, prompt for the next one before showing a new estimate.

Future wages, unused credit, and expected repayments are excluded. A repayment is included once it is recorded in an included cash account. A credit card purchase with a payment due after payday does not reduce the estimate. For example, with $800 in chequing, $200 in bills due before payday, and $150 in new card purchases due next month, the result is $600.

Let the user initialize each tracked account from a statement balance with an as-of date or enter an opening balance manually. Reconcile the baseline with imported history so earlier purchases remain visible without being applied a second time to the starting balance. Indicate when an included account still needs a starting balance or may be missing recent activity. The dashboard reflects recorded balances, since imports are manual.

## Ledger and reliability

Use balanced journal entries with amounts stored as integer minor units. Each finalized movement must balance within its currency. Store imported identities and receipt links alongside the ledger. Apply changes to financial state atomically, including deduplication and transfer, bill, and repayment matches. A repeat import, retried save, or second device submitting the same link must not duplicate money movement. Keep the journal behind the app's ordinary language.

First-release defaults are one configured currency, one household workspace, and a manually set payday. No bank credentials, live bank feeds, external OCR, business invoicing, or multi-currency conversion are needed. Library selection, the starter category list, and the visual design are implementation decisions. Use the MIT license as the open-source default.

## Release checks

- Import overlapping bank and card statements twice. Confirm balances and categories remain stable and distinct purchases with identical amounts and dates both survive.
- Import both sides of a card payment. Confirm the cash and card balances change once each, spending is unchanged, and any linked card bill's remaining amount reflects the payment.
- Exercise receipt capture, a clear match in both arrival orders, an ambiguous match, and a manual purchase later linked to a statement.
- Exercise an upcoming bill, an overdue bill, a partial payment, a bill due on payday, a card payment due later, and a repayment. Check the dashboard calculation and its breakdown.
- Confirm ledger entries balance, the app works at phone and desktop widths, and a container restart preserves data on the configured volume.
