import { randomUUID } from "node:crypto";
const h = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const money = (n, currency = "CAD") =>
  new Intl.NumberFormat("en-CA", { style: "currency", currency }).format(
    (Number(n) || 0) / 100,
  );
const date = (s) => (s ? h(s) : "—");
const field = (label, name, type = "text", extra = "") =>
  `<label>${label}<input name="${name}" type="${type}" ${extra}></label>`;
const button = (label) => `<button type="submit">${label}</button>`;
const form = (action, body, extra = "") =>
  `<form action="${action}" method="post" ${extra}><input type="hidden" name="key" value="${randomUUID()}">${body}</form>`;
const options = (items, label = "Select an account") =>
  `<option value="">${label}</option>${items
    .map((a) => `<option value="${h(a.id)}">${h(a.name)}</option>`)
    .join("")}`;
const empty = (title, detail) =>
  `<div class="empty"><span class="empty-icon">✳</span><strong>${title}</strong><p>${detail}</p></div>`;
const panel = (title, sub, body, cls = "") =>
  `<section class="panel ${cls}"><div class="panel-head"><div><h2>${title}</h2>${
    sub ? `<p>${sub}</p>` : ""
  }</div></div>${body}</section>`;
const currency = (s, n) =>
  money(n, s.currency || s.settings?.currency || "CAD");
const titlebar = (eyebrow, title, text) =>
  `<header class="page-heading"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p>${text}</p></div></header>`;
const accountSelect = (accounts, name = "account", required = true) =>
  `<label>Account<select name="${name}" ${required ? "required" : ""}>${options(
    accounts,
  )}</select></label>`;
const list = (rows) => `<div class="rows">${rows.join("")}</div>`;
const badge = (text, kind = "") =>
  `<span class="badge ${kind}">${h(text)}</span>`;
function dashboard(s) {
  const p = s.projection || {};
  const accounts = p.accounts || [];
  const due = p.bills || [];
  return `${titlebar(
    "OVERVIEW",
    "Overview",
    "Know what is available before your next payday.",
  )}
  ${
    p.needsReview
      ? '<div class="notice"><strong>Possible duplicates or corrections need review</strong><p>Resolve the flagged items before relying on your balance. <a href="/transactions">Review transactions →</a> · <a href="/receipts">Review receipts →</a></p></div>'
      : ""
  }<div class="dashboard-grid"><section class="hero"><div class="hero-top"><span>BEFORE PAYDAY</span><span class="spark">✳</span></div>${
    p.available == null
      ? `<h2>${
          p.needsAccounts
            ? "Include a spending account"
            : p.needsBalance
            ? "Add a starting balance"
            : "Set your payday"
        }</h2><p>${
          p.needsAccounts
            ? "Add or include a cash account to calculate your estimate."
            : p.needsBalance
            ? "An included account needs a starting balance before we can calculate your estimate."
            : "Add your next payday to see what is left after upcoming bills."
        }</p>`
      : `<h2 class="${p.available < 0 ? "negative" : ""}">${currency(
          s,
          p.available,
        )}</h2><p>Available to spend before ${date(p.payday)}.</p>`
  }<a class="hero-link" href="${
    p.needsAccounts || p.needsBalance ? "/accounts" : "/settings"
  }">${
    p.needsAccounts
      ? "Add or include an account"
      : p.needsBalance
      ? "Update account balance"
      : p.available == null
      ? "Set payday"
      : "Update payday"
  } <span>↗</span></a></section>
  <section class="panel calculation"><div class="panel-head"><div><h2>The breakdown</h2><p>Based on recorded balances and unpaid bills.</p></div></div><div class="calc-row"><span>Included cash accounts</span><strong>${currency(
    s,
    accounts.reduce((n, a) => n + Number(a.balance || 0), 0),
  )}</strong></div><div class="calc-row"><span>Bills due before payday</span><strong>− ${currency(
    s,
    due.reduce((n, b) => n + Number(b.remaining || 0), 0),
  )}</strong></div><div class="calc-row total"><span>Available</span><strong>${
    p.available == null ? "—" : currency(s, p.available)
  }</strong></div><p class="fine">Future wages, expected repayments and unused credit are excluded.</p></section></div>
  <div class="section-title"><div><p class="eyebrow">THE DETAILS</p><h2>Your financial snapshot</h2></div></div><div class="grid-two">${panel(
    "Accounts",
    "Your recorded balances, updated when you import.",
    accounts.length
      ? list(
          accounts.map(
            (a) =>
              `<div class="row"><div><strong>${h(
                a.name,
              )}</strong><small>Last updated ${date(
                a.updated || a.date || a.asOf,
              )}</small></div><strong>${
                a.balance == null ? "Needs balance" : currency(s, a.balance)
              }</strong></div>`,
          ),
        )
      : empty(
          "No spending accounts yet",
          'Add a cash account and starting balance to get going. <a href="/accounts">Add an account →</a>',
        ),
  )}${panel(
    "Coming up",
    "Unpaid bills before your next payday.",
    due.length
      ? list(
          due.map(
            (b) =>
              `<div class="row"><div><strong>${h(
                b.name,
              )}</strong><small>Due ${date(
                b.due,
              )}</small></div><strong>${currency(
                s,
                b.remaining,
              )}</strong></div>`,
          ),
        )
      : empty(
          "Nothing due yet",
          'Add a bill to see it in your payday calculation. <a href="/bills">Add a bill →</a>',
        ),
  )}</div>${panel(
    "Spending by category",
    "Recorded purchases across all dates.",
    (() => {
      const categories = {};
      for (const t of s.transactions || [])
        if (
          t.spending > 0 &&
          t.category !== "Transfer" &&
          t.category !== "Repayment"
        )
          categories[t.category || "Uncategorized"] =
            (categories[t.category || "Uncategorized"] || 0) + t.spending;
      const entries = Object.entries(categories).sort((a, b) => b[1] - a[1]);
      return entries.length
        ? list(
            entries.map(
              ([name, amount]) =>
                `<div class="row"><strong>${h(name)}</strong><strong>${currency(
                  s,
                  amount,
                )}</strong></div>`,
            ),
          )
        : empty(
            "No spending recorded",
            "Import a statement or add a transaction to see categories.",
          );
    })(),
  )}`;
}
function accountsPage(s) {
  const accounts = s.accounts || [];
  return `${titlebar(
    "YOUR ACCOUNTS",
    "Accounts",
    "Keep your recorded balances in one place.",
  )}
 <div class="grid-two">${panel(
   "Tracked accounts",
   "Balances reflect your latest recorded activity.",
   accounts.length
     ? list(
         accounts.map(
           (a) =>
             `<div class="row"><div><strong>${h(a.name)}</strong><small>${
               a.type === "card" ? "Credit card" : "Cash account"
             } ${
               a.included ? " · Included before payday" : ""
             }</small></div><div class="align-right"><strong>${
               a.balance == null ? "Needs balance" : currency(s, a.balance)
             }</strong><small>As of ${date(
               a.updated || a.date || a.asOf,
             )}</small></div></div><details><summary>Update starting balance</summary>${form(
               "/accounts/balance",
               `<input type="hidden" name="account" value="${h(
                 a.id,
               )}"><div class="fields">${field(
                 "Statement balance",
                 "amount",
                 "number",
                 'step="0.01" required',
               )}${field("As of", "date", "date", "required")}</div>${button(
                 "Save balance",
               )}`,
             )}</details>${form(
               "/accounts/update",
               `<input type="hidden" name="account" value="${h(
                 a.id,
               )}"><label class="check"><input type="checkbox" name="included" ${
                 a.included ? "checked" : ""
               }> Include in before payday calculation</label>${button(
                 "Update account",
               )}`,
             )}`,
         ),
       )
     : empty(
         "No accounts yet",
         "Add an account using a statement or opening balance.",
       ),
 )}${panel(
   "Add an account",
   "Use a balance and date from your statement.",
   form(
     "/accounts",
     `${field(
       "Account name",
       "name",
       "text",
       'required maxlength="100" placeholder="e.g. Everyday chequing"',
     )}<label>Account type<select name="type"><option value="bank">Bank / cash</option><option value="card">Credit card</option></select></label><div class="fields">${field(
       "Opening balance",
       "amount",
       "number",
       'step="0.01" placeholder="0.00"',
     )}${field(
       "Balance as of",
       "date",
       "date",
     )}</div><label class="check"><input type="checkbox" name="included"> Include in before payday calculation</label>${button(
       "Add account",
     )}`,
   ),
 )}</div>`;
}
function transactionsPage(s) {
  const tx = s.transactions || [],
    accounts = s.accounts || [];
  return `${titlebar(
    "MONEY IN & OUT",
    "Transactions",
    "Review your activity and keep spending organized.",
  )}
 ${
   (s.matchReviews || []).length
     ? panel(
         "Possible duplicate transactions",
         "Compare each imported transaction with the manual entries before relying on the balance.",
         list(
           s.matchReviews.map(
             (r) =>
               `<div class="receipt-row"><p><strong>${h(
                 r.transaction.name,
               )}</strong> · ${date(r.transaction.date)} · ${currency(
                 s,
                 r.transaction.amount,
               )}</p>${form(
                 "/transactions/manual-match",
                 `<input type="hidden" name="review" value="${h(
                   r.id,
                 )}"><label>Existing manual transaction<select name="manual" required>${options(
                   r.candidates.map((c) => ({
                     id: c.id,
                     name: `${c.date} · ${c.name}`,
                   })),
                   "Choose a match",
                 )}</select></label>${button("Link as the same purchase")}`,
               )}${form(
                 "/transactions/manual-dismiss",
                 `<input type="hidden" name="review" value="${h(
                   r.id,
                 )}">${button("These are separate transactions")}`,
               )}</div>`,
           ),
         ),
       )
     : ""
 }<div class="toolbar"><a class="button secondary" href="/import">↑ Import statement</a><a class="button" href="#manual">+ Add transaction</a></div>${
   (s.corrections || []).length
     ? `<div class="notice"><strong>Statement corrections need review</strong><p>Some corrections were skipped. Review them against your bank statement and make any needed adjustment manually.</p>${(
         s.corrections || []
       )
         .map(
           (c) =>
             `<p>${h(c.action || "Correction")} for bank ID ${h(
               c.original_id || c.source_id || "unknown",
             )}</p>${form(
               "/transactions/correction",
               `<input type="hidden" name="correction" value="${h(
                 c.id,
               )}">${button("Apply correction")}`,
             )}`,
         )
         .join("")}</div>`
     : ""
 }${panel(
   "Activity",
   `${tx.length} recorded transaction${tx.length === 1 ? "" : "s"}.`,
   tx.length
     ? list(
         tx.map(
           (t) =>
             `<div class="row transaction"><div class="transaction-icon">${
               Number(t.amount) < 0 ? "↗" : "↙"
             }</div><div class="grow"><strong>${h(
               t.merchant || t.name || t.description || "Transaction",
             )}</strong><small>${date(t.date)} · ${h(
               (s.accounts || []).find((a) => a.id === t.account)?.name || "",
             )} ${t.category ? " · " + h(t.category) : ""}${
               t.legs?.length > 1
                 ? "<br>" +
                   t.legs
                     .map(
                       (leg) =>
                         `${h(
                           accounts.find((a) => a.id === leg.account)?.name ||
                             "Account",
                         )} ${currency(s, leg.amount)}`,
                     )
                     .join(" → ")
                 : ""
             }</small></div><div class="align-right"><strong>${currency(
               s,
               t.amount,
             )}</strong><details><summary>Edit category</summary>${form(
               "/transactions/category",
               `<input type="hidden" name="transaction" value="${h(
                 t.id,
               )}">${field(
                 "Category",
                 "category",
                 "text",
                 `value="${h(t.category || "")}" required`,
               )}${button("Save")}`,
             )}</details></div></div>`,
         ),
       )
     : empty(
         "A fresh start",
         "Import a statement or add a transaction to see your activity.",
       ),
 )}${panel(
   "Review a transfer",
   "Link two opposite transactions between tracked accounts.",
   form(
     "/transactions/transfer",
     `<label>First transaction<select name="first" required>${options(
       tx.map((t) => ({
         id: t.id,
         name: `${t.date} · ${t.name} · ${currency(s, t.amount)}`,
       })),
       "Choose transaction",
     )}</select></label><label>Second transaction<select name="second" required>${options(
       tx.map((t) => ({
         id: t.id,
         name: `${t.date} · ${t.name} · ${currency(s, t.amount)}`,
       })),
       "Choose transaction",
     )}</select></label>${button("Link transfer")}`,
   ),
 )}<div id="manual">${panel(
   "Add a transaction",
   "Record cash spending or an adjustment.",
   form(
     "/transactions",
     `${accountSelect(accounts)}<div class="fields">${field(
       "Description",
       "name",
       "text",
       'required maxlength="200"',
     )}${field(
       "Date",
       "date",
       "date",
       "required",
     )}</div><div class="fields">${field(
       "Amount",
       "amount",
       "number",
       'required step="0.01" placeholder="Use a negative amount for spending"',
     )}${field(
       "Category",
       "category",
       "text",
       'placeholder="e.g. Groceries"',
     )}</div>${button("Add transaction")}`,
   ),
 )}</div>`;
}
function importPage(s) {
  return `${titlebar(
    "BRING YOUR ACTIVITY IN",
    "Import a statement",
    "Upload an OFX or QFX file from your bank or card provider.",
  )}${panel(
    "Statement import",
    "Repeated imports are safe. Previously imported bank IDs are skipped.",
    form(
      "/import",
      `${accountSelect(
        s.accounts || [],
      )}<label>Statement file<input name="statement" type="file" accept=".ofx,.qfx,application/x-ofx" required></label><label class="check"><input type="checkbox" name="applyBalance"> Use the statement closing balance as the account balance</label>${button(
        "Import statement",
      )}`,
      'enctype="multipart/form-data"',
    ),
  )}<div class="notice"><strong>Before you import</strong><p>Set an opening balance and its date on the account. Earlier transactions stay visible without being counted twice.</p></div>`;
}
function receiptsPage(s) {
  const receipts = s.receipts || [],
    tx = s.transactions || [],
    accounts = s.accounts || [];
  return `${titlebar(
    "SAVE THE LITTLE DETAILS",
    "Receipts",
    "Capture receipts, then match them to your transactions.",
  )}
 <div class="grid-two">${panel(
   "Add a receipt",
   "Photos are read locally on this server. Use JPEG, PNG, or WebP; convert HEIC photos before uploading. A receipt alone does not change your balance.",
   form(
     "/receipts",
     `<label>Receipt photo<input type="file" name="receipt" accept="image/jpeg,image/png,image/webp" capture="environment" required></label>${button(
       "Upload receipt",
     )}`,
     'enctype="multipart/form-data"',
   ),
 )}${panel(
   "How matching works",
   "",
   `<p class="body-copy">A clear match attaches automatically. If there is more than one possibility, choose the right transaction below. You can also record a receipt as a paid purchase.</p>`,
 )}</div>
 ${panel(
   "Your receipts",
   `${receipts.length} saved.`,
   receipts.length
     ? list(
         receipts.map(
           (r) =>
             `<div class="receipt-row"><div class="row"><div><strong>${h(
               r.merchant || "Receipt",
             )}</strong><small>${date(r.date)} · ${currency(
               s,
               r.amount,
             )}</small></div>${badge(
               r.matches?.length
                 ? "Review match"
                 : r.entry
                 ? "Matched"
                 : "Awaiting match",
               r.entry && !r.matches?.length ? "good" : "warm",
             )}</div><div class="receipt-actions"><a href="/receipts/${h(
               r.id,
             )}/image" target="_blank" rel="noopener">View photo ↗</a><details><summary>${
               r.matches?.length
                 ? "Review possible match"
                 : r.entry
                 ? "Edit details"
                 : "Review or record"
             }</summary>${form(
               "/receipts/update",
               `<input type="hidden" name="receipt" value="${h(
                 r.id,
               )}"><div class="fields">${field(
                 "Merchant",
                 "merchant",
                 "text",
                 `value="${h(r.merchant || "")}"`,
               )}${field(
                 "Date",
                 "date",
                 "date",
                 `value="${h(r.date || "")}"`,
               )}</div>${field(
                 "Total",
                 "amount",
                 "number",
                 `step="0.01" value="${h(
                   r.amount == null ? "" : (Number(r.amount) / 100).toFixed(2),
                 )}"`,
               )}${field(
                 "Category",
                 "category",
                 "text",
                 `value="${h(r.category || "")}"`,
               )}${button("Save details")}`,
             )}${
               !r.entry || r.matches?.length
                 ? form(
                     "/receipts/link",
                     `<input type="hidden" name="receipt" value="${h(
                       r.id,
                     )}"><label>Match a transaction<select name="transaction" required>${options(
                       [...tx]
                         .filter(
                           (t) =>
                             !r.entry ||
                             (r.matches || []).some((m) => m.id === t.id),
                         )
                         .sort(
                           (a, b) =>
                             Number(
                               (r.matches || []).some((m) => m.id === b.id),
                             ) -
                             Number(
                               (r.matches || []).some((m) => m.id === a.id),
                             ),
                         )
                         .map((t) => ({
                           id: t.id,
                           name: `${t.date} · ${
                             t.merchant || t.name || "Transaction"
                           } · ${currency(s, t.amount)}`,
                         })),
                       "Choose transaction",
                     )}</select></label>${button("Attach receipt")}`,
                   )
                 : ""
             }${
               !r.entry
                 ? form(
                     "/receipts/record",
                     `<input type="hidden" name="receipt" value="${h(
                       r.id,
                     )}">${accountSelect(accounts)}${button(
                       "Record as paid purchase",
                     )}`,
                   )
                 : ""
             }</details></div></div>`,
         ),
       )
     : empty(
         "No receipts yet",
         "Upload a photo to save it here and look for a match.",
       ),
 )}`;
}
function billsPage(s) {
  const bills = s.bills || [],
    accounts = s.accounts || [],
    tx = s.transactions || [];
  return `${titlebar(
    "PLAN AHEAD",
    "Bills",
    "Track what is due and record payments as they happen.",
  )}
 <div class="grid-two">${panel(
   "Bills & payments",
   "Remaining amounts are used in your payday calculation.",
   bills.length
     ? list(
         bills.map(
           (b) =>
             `<div class="receipt-row"><div class="row"><div><strong>${h(
               b.name,
             )}</strong><small>Due ${date(
               b.due,
             )}</small></div><div class="align-right"><strong>${currency(
               s,
               b.remaining,
             )}</strong><small>${
               Number(b.remaining) > 0 ? "remaining" : "Paid"
             }</small></div></div>${
               Number(b.remaining) > 0
                 ? paymentForm("bill", b, accounts, tx, s)
                 : ""
             }</div>`,
         ),
       )
     : empty("No bills yet", "Add a bill to see what is coming up."),
 )}${panel(
   "Add a bill",
   "Keep recurring bills and card payments in view.",
   form(
     "/bills",
     `${field(
       "Bill name",
       "name",
       "text",
       'required maxlength="100"',
     )}<div class="fields">${field(
       "Amount due",
       "amount",
       "number",
       'step="0.01" min="0.01" required',
     )}${field(
       "Due date",
       "due",
       "date",
       "required",
     )}</div><label class="check"><input type="checkbox" name="recurring"> Repeat monthly</label><label>Credit card (optional)<select name="card">${options(
       accounts.filter((a) => a.type === "card"),
       "None",
     )}</select></label>${button("Add bill")}`,
   ),
 )}</div>`;
}
function paymentForm(kind, item, accounts, tx, s) {
  const candidates = tx.filter((t) =>
    item.card
      ? (t.legs || []).some(
          (leg) => leg.account === item.card && leg.amount > 0,
        )
      : (t.legs || []).length === 1 &&
        (t.legs || []).some((leg) =>
          kind === "owed" ? leg.amount > 0 : leg.amount < 0,
        ),
  );
  return `<details><summary>Record or link a payment</summary>${
    item.card
      ? '<p class="fine">A card-only payment means you confirm it was funded outside tracked accounts; no tracked cash withdrawal is recorded.</p>'
      : ""
  }${form(
    "/payments",
    `<input type="hidden" name="kind" value="${kind}"><input type="hidden" name="target" value="${h(
      item.id,
    )}"><label>Link an existing transaction (optional)<select name="transaction">${options(
      candidates.map((t) => ({
        id: t.id,
        name: `${t.date} · ${
          t.merchant || t.name || "Transaction"
        } · ${currency(s, t.amount)}`,
      })),
      "Record a new payment instead",
    )}</select></label>${accountSelect(
      accounts,
      "account",
      false,
    )}<div class="fields">${field(
      "Amount",
      "amount",
      "number",
      'step="0.01" min="0.01"',
    )}${field("Date", "date", "date")}</div>${button("Save payment")}`,
  )}</details>`;
}
function owedPage(s) {
  const owed = s.owed || [],
    accounts = s.accounts || [],
    tx = s.transactions || [];
  return `${titlebar(
    "KEEP TRACK TOGETHER",
    "Money owed",
    "Track shared expenses and repayments without counting cash twice.",
  )}<div class="grid-two">${panel(
    "Outstanding",
    "Expected repayments are excluded until received.",
    owed.length
      ? list(
          owed.map(
            (o) =>
              `<div class="receipt-row"><div class="row"><div><strong>${h(
                o.name,
              )}</strong><small>${
                o.due ? "Expected " + date(o.due) : "No expected date"
              }</small></div><strong>${currency(
                s,
                o.remaining,
              )}</strong></div>${
                Number(o.remaining) > 0
                  ? paymentForm("owed", o, accounts, tx, s)
                  : ""
              }</div>`,
          ),
        )
      : empty("All clear", "Add money someone owes you to track it here."),
  )}${panel(
    "Add money owed",
    "This does not change your cash balance.",
    form(
      "/owed",
      `${field(
        "Person or description",
        "name",
        "text",
        'required maxlength="100"',
      )}<div class="fields">${field(
        "Amount owed",
        "amount",
        "number",
        'step="0.01" min="0.01" required',
      )}${field(
        "Expected date (optional)",
        "due",
        "date",
      )}</div><label>Related transaction (optional)<select name="transaction">${options(
        tx.map((t) => ({
          id: t.id,
          name: `${t.date} · ${t.merchant || t.name || "Transaction"}`,
        })),
        "None",
      )}</select></label>${button("Add amount owed")}`,
    ),
  )}</div>`;
}
function settingsPage(s) {
  return `${titlebar(
    "MAKE IT YOURS",
    "Settings",
    "Set the date that guides your payday estimate.",
  )}${panel(
    "Next payday",
    "Bills due before this date are included. Update it after payday arrives.",
    form(
      "/settings",
      `${field(
        "Next payday",
        "payday",
        "date",
        `value="${h(s.payday || s.settings?.payday || "")}" required`,
      )}${button("Save payday")}`,
    ),
  )}`;
}
export function renderPage(path, s, { message = "", error = "" } = {}) {
  const pages = {
    "/": dashboard,
    "/accounts": accountsPage,
    "/transactions": transactionsPage,
    "/import": importPage,
    "/receipts": receiptsPage,
    "/bills": billsPage,
    "/owed": owedPage,
    "/settings": settingsPage,
  };
  const render = pages[path];
  if (!render) return null;
  const nav = [
    ["/", "Overview", "◫"],
    ["/transactions", "Transactions", "↔"],
    ["/accounts", "Accounts", "▣"],
    ["/bills", "Bills", "▤"],
    ["/receipts", "Receipts", "▧"],
    ["/owed", "Money owed", "♡"],
    ["/settings", "Settings", "⚙"],
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SimpleBooks</title><link rel="stylesheet" href="/style.css"></head><body><div class="app-shell"><aside class="sidebar"><a class="brand" href="/"><span class="brand-mark">s.</span><span>simple<span>books</span><small>YOUR MONEY, SIMPLIFIED</small></span></a><p class="nav-label">WORKSPACE</p><nav aria-label="Main navigation">${nav
    .map(
      ([url, label, icon]) =>
        `<a href="${url}" ${
          path === url ? 'aria-current="page"' : ""
        }><span>${icon}</span>${label}</a>`,
    )
    .join(
      "",
    )}</nav><div class="side-note"><span>✳</span><strong>Your workspace</strong><p>Balances reflect the activity you have recorded.</p></div></aside><main><div class="mobile-brand"><a href="/">simple<span>books</span></a><span>PERSONAL FINANCE</span></div>${
    message
      ? `<div class="flash success" role="status">${h(message)}</div>`
      : ""
  }${
    error ? `<div class="flash error" role="alert">${h(error)}</div>` : ""
  }${render(s)}</main></div></body></html>`;
}
