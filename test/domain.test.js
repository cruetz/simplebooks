import assert from "node:assert/strict";
import { test } from "node:test";
import { Books } from "../src/books.js";
const statement = (transactions, account = "123", kind = "bank") => ({
  kind,
  account,
  institution: "Bank",
  currency: "CAD",
  start: "2026-11-01",
  end: "2026-11-30",
  transactions,
});
const transaction = (id, date, amount, name, type = "DEBIT") => ({
  id,
  date,
  amount,
  name,
  type,
});
function setup(t) {
  const b = new Books(":memory:");
  t.after(() => b.close());
  b.settings({ payday: "2026-12-20" });
  const account = b.addAccount({
    name: "Cash",
    type: "bank",
    included: true,
    amount: "800",
    date: "2026-11-10",
  });
  return { b, account };
}
test("recurring bill occurrences have independent payment status", (t) => {
  const { b, account } = setup(t);
  const bill = b.addBill({
    name: "Rent",
    amount: "100",
    due: "2026-11-15",
    recurrence: "monthly",
  });
  b.pay({
    target: bill,
    kind: "bill",
    account,
    amount: "100",
    date: "2026-11-12",
    key: "rent",
  });
  const s = b.snapshot("2026-11-13");
  assert.deepEqual(
    s.bills.map((x) => [x.due, x.remaining]),
    [
      ["2026-11-15", 0],
      ["2026-12-15", 10000],
    ],
  );
  assert.equal(s.projection.available, 60000);
});
test("statement correction is flagged without posting a second movement", (t) => {
  const { b, account } = setup(t);
  b.importStatement(
    account,
    statement([transaction("one", "2026-11-11", -1000, "Cafe")]),
  );
  const result = b.importStatement(
    account,
    statement([
      {
        ...transaction("correction", "2026-11-12", -1200, "Cafe"),
        correctId: "one",
        correctAction: "REPLACE",
      },
    ]),
  );
  assert.equal(result.flagged, 1);
  assert.equal(b.snapshot("2026-11-13").accounts[0].balance, 79000);
});
test("statement baseline can be set after imported history without double counting", (t) => {
  const { b, account } = setup(t);
  b.importStatement(
    account,
    statement([
      transaction("before", "2026-11-11", -1000, "Cafe"),
      transaction("after", "2026-11-13", -2000, "Shop"),
    ]),
  );
  b.setBalance({ account, amount: "750", date: "2026-11-12" });
  assert.equal(b.snapshot("2026-11-13").accounts[0].balance, 73000);
  assert.deepEqual(b.unbalanced(), []);
});
test("a card payment settles a matching card bill and keeps the two legs balanced", (t) => {
  const { b, account } = setup(t);
  const card = b.addAccount({
    name: "Card",
    type: "card",
    amount: "-300",
    date: "2026-11-10",
  });
  const bill = b.addBill({
    name: "Card bill",
    amount: "100",
    due: "2026-11-20",
    card,
  });
  b.importStatement(
    account,
    statement([
      transaction("out", "2026-11-13", -10000, "CREDIT CARD PAYMENT", "XFER"),
    ]),
  );
  b.importStatement(
    card,
    statement(
      [transaction("in", "2026-11-14", 10000, "PAYMENT THANK YOU", "PAYMENT")],
      "456",
      "card",
    ),
  );
  const s = b.snapshot("2026-11-15");
  assert.equal(s.bills.find((x) => x.id === bill).remaining, 0);
  assert.deepEqual(
    s.accounts.map((a) => a.balance),
    [70000, -20000],
  );
  assert.deepEqual(b.unbalanced(), []);
});
test("explicit transfer linking preserves both imported IDs and balances on retry", (t) => {
  const { b, account } = setup(t);
  const other = b.addAccount({
    name: "Savings",
    type: "bank",
    amount: "100",
    date: "2026-11-10",
  });
  b.importStatement(
    account,
    statement([transaction("out", "2026-11-13", -1000, "Withdrawal")]),
  );
  b.importStatement(
    other,
    statement([transaction("in", "2026-11-13", 1000, "Deposit")], "456"),
  );
  let s = b.snapshot("2026-11-15");
  const a = s.transactions.find((x) => x.amount < 0).id,
    c = s.transactions.find((x) => x.amount > 0).id;
  b.linkTransfer({ first: a, second: c });
  b.linkTransfer({ first: a, second: c });
  s = b.snapshot("2026-11-15");
  assert.equal(s.transactions.length, 1);
  assert.deepEqual(
    s.accounts.map((a) => a.balance),
    [79000, 11000],
  );
  assert.equal(
    b.importStatement(
      other,
      statement([transaction("in", "2026-11-13", 1000, "Deposit")], "456"),
    ).duplicate,
    1,
  );
  assert.deepEqual(b.unbalanced(), []);
});
test("corrections persist and can replace simple imports exactly once", (t) => {
  const { b, account } = setup(t);
  b.importStatement(
    account,
    statement([transaction("one", "2026-11-11", -1000, "Cafe")]),
  );
  const correction = {
    ...transaction("change", "2026-11-12", -1200, "Cafe"),
    correctId: "one",
    correctAction: "REPLACE",
  };
  b.importStatement(account, statement([correction]));
  let s = b.snapshot("2026-11-13");
  assert.equal(s.corrections.length, 1);
  assert.equal(s.projection.needsReview, true);
  b.resolveCorrection({ correction: s.corrections[0].id });
  b.resolveCorrection({ correction: s.corrections[0].id });
  s = b.snapshot("2026-11-13");
  assert.equal(s.accounts[0].balance, 78800);
  assert.equal(s.transactions.length, 1);
  assert.equal(s.projection.needsReview, false);
  assert.deepEqual(b.unbalanced(), []);
});
test("deleting a corrected import removes the original movement", (t) => {
  const { b, account } = setup(t);
  b.importStatement(
    account,
    statement([transaction("one", "2026-11-11", -1000, "Cafe")]),
  );
  b.importStatement(
    account,
    statement([{ id: "delete", correctId: "one", correctAction: "DELETE" }]),
  );
  const c = b.snapshot("2026-11-13").corrections[0];
  b.resolveCorrection({ correction: c.id });
  assert.equal(b.snapshot("2026-11-13").accounts[0].balance, 80000);
  assert.deepEqual(b.unbalanced(), []);
});
test("manual card bill payment credits the card and both imported legs reconcile", (t) => {
  const { b, account } = setup(t);
  const card = b.addAccount({
    name: "Card",
    type: "card",
    amount: "-300",
    date: "2026-11-10",
  });
  const bill = b.addBill({
    name: "Card bill",
    amount: "100",
    due: "2026-11-20",
    card,
  });
  b.pay({
    target: bill,
    kind: "bill",
    account,
    amount: "100",
    date: "2026-11-13",
    key: "manual-card",
  });
  b.importStatement(
    account,
    statement([
      transaction("out", "2026-11-13", -10000, "CREDIT CARD PAYMENT", "XFER"),
    ]),
  );
  b.importStatement(
    card,
    statement(
      [transaction("in", "2026-11-14", 10000, "PAYMENT THANK YOU", "PAYMENT")],
      "456",
      "card",
    ),
  );
  const s = b.snapshot("2026-11-15");
  assert.deepEqual(
    s.accounts.map((a) => a.balance),
    [70000, -20000],
  );
  assert.equal(s.transactions.length, 1);
  assert.equal(s.bills[0].remaining, 0);
  assert.deepEqual(b.unbalanced(), []);
});
test("generic merchant payment is not labelled a transfer", (t) => {
  const { b, account } = setup(t);
  b.importStatement(
    account,
    statement([
      transaction("x", "2026-11-13", -1000, "PAYMENT PROCESSOR", "DEBIT"),
    ]),
  );
  assert.equal(
    b.snapshot("2026-11-15").transactions[0].category,
    "Uncategorized",
  );
});
test("opening balances and standalone receivables are balanced journal entries", (t) => {
  const { b } = setup(t);
  b.addOwed({ name: "Alex", amount: "100" });
  const lines = b.db
    .prepare(
      "SELECT dimension, SUM(amount) AS amount FROM lines GROUP BY dimension",
    )
    .all();
  assert.ok(
    lines.some((l) => l.dimension === "receivable" && l.amount === 10000),
  );
  assert.ok(lines.some((l) => l.dimension === "equity" && l.amount === -90000));
  assert.deepEqual(b.unbalanced(), []);
});
test("an owed share reclassifies the outlay and repayment settles the receivable", (t) => {
  const { b, account } = setup(t);
  const out = b.addTransaction({
    account,
    name: "Dinner",
    date: "2026-11-11",
    amount: "-100",
    key: "dinner",
  });
  const loan = b.addOwed({ name: "Alex", amount: "40", source: out });
  const entry = b.addTransaction({
    account,
    name: "Alex",
    date: "2026-11-12",
    amount: "20",
    key: "deposit",
  });
  b.pay({ target: loan, kind: "owed", transaction: entry });
  const rows = b.db
    .prepare(
      "SELECT dimension, SUM(amount) AS amount FROM lines WHERE dimension='receivable' GROUP BY dimension",
    )
    .all();
  assert.equal(rows[0].amount, 2000);
  assert.equal(b.snapshot("2026-11-13").accounts[0].balance, 72000);
  assert.deepEqual(b.unbalanced(), []);
});
test("merchant category choices are remembered and suggestions never replace an explicit choice", (t) => {
  const { b, account } = setup(t);
  b.importStatement(
    account,
    statement([transaction("first", "2026-11-11", -1000, "CAFE ALPHA")]),
  );
  const first = b.snapshot("2026-11-13").transactions[0];
  b.categorize({ transaction: first.id, category: "Dining" });
  b.importStatement(
    account,
    statement([transaction("second", "2026-11-12", -1200, "Cafe Alpha")]),
  );
  let s = b.snapshot("2026-11-13");
  assert.equal(
    s.transactions.find((x) => x.id !== first.id).category,
    "Dining",
  );
  b.addReceipt({
    hash: "dining",
    image: Buffer.from("x"),
    mime: "image/png",
    merchant: "CAFE ALPHA",
    date: "2026-11-11",
    amount: 1000,
    category: "Groceries",
  });
  s = b.snapshot("2026-11-13");
  assert.equal(
    s.transactions.find((x) => x.id === first.id).category,
    "Dining",
  );
  assert.equal(s.receipts[0].category, "Groceries");
});
test("existing account inclusion can be changed", (t) => {
  const { b, account } = setup(t);
  b.updateAccount({ account, included: false });
  assert.equal(b.snapshot("2026-11-13").projection.cash, 0);
});
test("a matched manual receipt uses the imported posting date across baseline", (t) => {
  const { b, account } = setup(t);
  const r = b.addReceipt({
    hash: "cutoff",
    image: Buffer.from("x"),
    mime: "image/png",
    merchant: "Cafe",
    date: "2026-11-10",
    amount: 1000,
  });
  b.recordReceipt({ receipt: r, account });
  b.importStatement(
    account,
    statement([transaction("posted", "2026-11-11", -1000, "Cafe")]),
  );
  assert.equal(b.snapshot("2026-11-12").accounts[0].balance, 79000);
});
test("creation retry keys do not duplicate obligations or accounts", (t) => {
  const { b } = setup(t);
  const one = b.addBill({
    name: "Rent",
    amount: "100",
    due: "2026-12-01",
    key: "rent",
  });
  const two = b.addBill({
    name: "Rent",
    amount: "100",
    due: "2026-12-01",
    key: "rent",
  });
  assert.equal(one, two);
  const a = b.addAccount({
    name: "Savings",
    type: "bank",
    amount: "100",
    date: "2026-11-10",
    key: "savings",
  });
  assert.equal(
    a,
    b.addAccount({
      name: "Savings",
      type: "bank",
      amount: "100",
      date: "2026-11-10",
      key: "savings",
    }),
  );
  assert.equal(b.snapshot("2026-11-13").bills.length, 1);
});
test("multiple bank records cannot arbitrarily claim a single manual receipt", (t) => {
  const { b, account } = setup(t);
  const r = b.addReceipt({
    hash: "ambiguous",
    image: Buffer.from("x"),
    mime: "image/png",
    merchant: "Cafe",
    date: "2026-11-11",
    amount: 1000,
  });
  b.recordReceipt({ receipt: r, account });
  const result = b.importStatement(
    account,
    statement([
      transaction("one", "2026-11-11", -1000, "Cafe"),
      transaction("two", "2026-11-11", -1000, "Cafe"),
    ]),
  );
  assert.ok(result.flagged > 0);
  assert.equal(b.snapshot("2026-11-13").transactions.length, 3);
});
test("payment type alone does not classify a bank purchase as a transfer", (t) => {
  const { b, account } = setup(t);
  b.importStatement(
    account,
    statement([
      transaction("x", "2026-11-13", -1000, "UTILITY COMPANY", "PAYMENT"),
    ]),
  );
  assert.equal(
    b.snapshot("2026-11-15").transactions[0].category,
    "Uncategorized",
  );
});
test("repayment cannot reuse a transfer with two account legs", (t) => {
  const { b, account } = setup(t);
  const card = b.addAccount({
    name: "Card",
    type: "card",
    amount: "-100",
    date: "2026-11-10",
  });
  const bill = b.addBill({
    name: "Card",
    amount: "10",
    due: "2026-11-20",
    card,
  });
  const loan = b.addOwed({ name: "Alex", amount: "10" });
  b.pay({
    target: bill,
    kind: "bill",
    account,
    amount: "10",
    date: "2026-11-11",
    key: "paycard",
  });
  const entry = b.snapshot("2026-11-12").transactions[0].id;
  assert.throws(() =>
    b.pay({ target: loan, kind: "owed", transaction: entry }),
  );
  assert.equal(b.snapshot("2026-11-12").owed[0].remaining, 1000);
});

test("card bill cannot link an unrelated merchant expense", (t) => {
  const { b, account } = setup(t);
  const card = b.addAccount({
    name: "Card",
    type: "card",
    amount: "-100",
    date: "2026-11-10",
  });
  const bill = b.addBill({
    name: "Card",
    amount: "10",
    due: "2026-11-20",
    card,
  });
  const expense = b.addTransaction({
    name: "Other merchant",
    account,
    amount: "-10",
    date: "2026-11-11",
    key: "expense",
  });
  assert.throws(() =>
    b.pay({ target: bill, kind: "bill", transaction: expense }),
  );
  assert.equal(b.snapshot("2026-11-12").bills[0].remaining, 1000);
});

test("a transfer cannot erase a linked receivable", (t) => {
  const { b, account } = setup(t);
  const other = b.addAccount({
    name: "Savings",
    type: "bank",
    amount: "100",
    date: "2026-11-10",
  });
  const expense = b.addTransaction({
    name: "Dinner",
    account,
    amount: "-20",
    date: "2026-11-11",
    key: "out",
  });
  b.addOwed({ name: "Alex", amount: "10", source: expense });
  const deposit = b.addTransaction({
    name: "Deposit",
    account: other,
    amount: "20",
    date: "2026-11-11",
    key: "in",
  });
  assert.throws(() => b.linkTransfer({ first: expense, second: deposit }));
  assert.deepEqual(b.unbalanced(), []);
});

test("a positive card-only payment can settle its associated card bill", (t) => {
  const { b } = setup(t);
  const card = b.addAccount({
    name: "Card",
    type: "card",
    amount: "-100",
    date: "2026-11-10",
  });
  const bill = b.addBill({
    name: "Card",
    amount: "10",
    due: "2026-12-20",
    card,
  });
  b.importStatement(
    card,
    statement(
      [transaction("card-payment", "2026-11-11", 1000, "Payment", "PAYMENT")],
      "456",
      "card",
    ),
  );
  const entry = b.snapshot("2026-11-12").transactions[0].id;
  b.pay({ target: bill, kind: "bill", transaction: entry });
  assert.equal(b.snapshot("2026-11-12").bills[0].remaining, 0);
});

test("a user can resolve a manual receipt against a selected imported candidate", (t) => {
  const { b, account } = setup(t);
  const receipt = b.addReceipt({
    hash: "merge",
    image: Buffer.from("x"),
    mime: "image/png",
    merchant: "Cafe",
    date: "2026-11-11",
    amount: 1000,
  });
  b.recordReceipt({ receipt, account });
  b.importStatement(
    account,
    statement([
      transaction("one", "2026-11-11", -1000, "Cafe"),
      transaction("two", "2026-11-11", -1000, "Cafe"),
    ]),
  );
  const imported = b
    .snapshot("2026-11-12")
    .transactions.find(
      (x) => !b.db.prepare("SELECT 1 FROM receipts WHERE entry=?").get(x.id),
    );
  b.linkReceipt({ receipt, transaction: imported.id });
  const s = b.snapshot("2026-11-12");
  assert.equal(s.transactions.length, 2);
  assert.equal(s.accounts[0].balance, 78000);
  assert.equal(s.receipts[0].entry, imported.id);
  assert.deepEqual(b.unbalanced(), []);
});

test("spending excludes the portion allocated to a receivable", (t) => {
  const { b, account } = setup(t);
  const entry = b.addTransaction({
    name: "Dinner",
    account,
    amount: "-100",
    date: "2026-11-11",
    key: "expense",
  });
  b.addOwed({ name: "Alex", amount: "40", source: entry });
  assert.equal(
    b.snapshot("2026-11-12").transactions.find((t) => t.id === entry).spending,
    6000,
  );
});

test("automatic transfer matching cannot erase an allocated receivable", (t) => {
  const { b, account } = setup(t);
  const card = b.addAccount({
    name: "Card",
    type: "card",
    amount: "-100",
    date: "2026-11-10",
  });
  const expense = b.addTransaction({
    name: "Card payment",
    account,
    amount: "-20",
    date: "2026-11-11",
    key: "out",
  });
  b.addOwed({ name: "Alex", amount: "10", source: expense });
  b.categorize({ transaction: expense, category: "Transfer" });
  b.importStatement(
    card,
    statement(
      [transaction("in", "2026-11-11", 2000, "Payment", "PAYMENT")],
      "456",
      "card",
    ),
  );
  const s = b.snapshot("2026-11-12");
  assert.equal(s.transactions.length, 2);
  assert.equal(
    b.db
      .prepare(
        "SELECT SUM(amount) AS n FROM lines WHERE dimension='receivable'",
      )
      .get().n,
    1000,
  );
  assert.deepEqual(b.unbalanced(), []);
});

test("a card-only imported payment does not automatically remove the cash reservation", (t) => {
  const { b } = setup(t);
  const card = b.addAccount({
    name: "Card",
    type: "card",
    amount: "-100",
    date: "2026-11-10",
  });
  b.addBill({ name: "Card", amount: "10", due: "2026-11-15", card });
  b.importStatement(
    card,
    statement(
      [transaction("in", "2026-11-11", 1000, "Payment", "PAYMENT")],
      "456",
      "card",
    ),
  );
  const s = b.snapshot("2026-11-12");
  assert.equal(s.bills[0].remaining, 1000);
  assert.equal(s.projection.available, 79000);
});

test("future imported transactions do not change an earlier as-of balance", (t) => {
  const { b, account } = setup(t);
  b.importStatement(
    account,
    statement([transaction("future", "2026-11-15", -1000, "Cafe")]),
  );
  assert.equal(b.snapshot("2026-11-12").accounts[0].balance, 80000);
  assert.equal(b.snapshot("2026-11-15").accounts[0].balance, 79000);
});

test("future manual actuals are rejected", (t) => {
  const { b, account } = setup(t);
  assert.throws(() =>
    b.addTransaction({
      account,
      name: "Future",
      amount: "-10",
      date: "2099-01-01",
      key: "future",
    }),
  );
  assert.equal(b.snapshot("2026-11-12").accounts[0].balance, 80000);
});

test("an estimate requires at least one included cash account", (t) => {
  const { b, account } = setup(t);
  b.updateAccount({ account, included: false });
  const p = b.snapshot("2026-11-12").projection;
  assert.equal(p.needsAccounts, true);
  assert.equal(p.available, null);
});

test("a unique matching imported bill payment applies partially without moving cash twice", (t) => {
  const { b, account } = setup(t);
  b.addBill({ name: "Internet Provider", amount: "100", due: "2026-11-15" });
  b.importStatement(
    account,
    statement([transaction("bill", "2026-11-12", -4000, "Internet Provider")]),
  );
  const s = b.snapshot("2026-11-12");
  assert.equal(s.bills[0].remaining, 6000);
  assert.equal(s.accounts[0].balance, 76000);
  assert.equal(s.projection.available, 70000);
});

test("a paired transfer cannot absorb a third imported leg", (t) => {
  const { b, account } = setup(t);
  const card = b.addAccount({
    name: "Card",
    type: "card",
    amount: "-100",
    date: "2026-11-10",
  });
  const other = b.addAccount({
    name: "Other",
    type: "bank",
    amount: "200",
    date: "2026-11-10",
  });
  b.importStatement(
    account,
    statement([
      transaction("out1", "2026-11-11", -10000, "Credit card payment", "XFER"),
    ]),
  );
  b.importStatement(
    card,
    statement(
      [transaction("in", "2026-11-11", 10000, "Payment", "PAYMENT")],
      "456",
      "card",
    ),
  );
  b.importStatement(
    other,
    statement(
      [
        transaction(
          "out2",
          "2026-11-11",
          -10000,
          "Credit card payment",
          "XFER",
        ),
      ],
      "789",
    ),
  );
  assert.deepEqual(b.unbalanced(), []);
  assert.deepEqual(
    b.snapshot("2026-11-12").accounts.map((a) => a.balance),
    [70000, 0, 10000],
  );
});

test("first import in a new month can match the recurring bill occurrence", (t) => {
  const { b, account } = setup(t);
  b.addBill({
    name: "Internet Provider",
    amount: "50",
    due: "2026-11-15",
    recurrence: "monthly",
  });
  b.importStatement(account, {
    ...statement([
      transaction("dec", "2026-12-15", -5000, "Internet Provider"),
    ]),
    end: "2026-12-31",
  });
  const bills = b.snapshot("2026-12-16").bills;
  assert.equal(bills.find((x) => x.due === "2026-12-15").remaining, 0);
});

test("reusing a payment key with different details is rejected", (t) => {
  const { b, account } = setup(t);
  const bill = b.addBill({ name: "Rent", amount: "100", due: "2026-11-19" });
  const payment = {
    target: bill,
    kind: "bill",
    account,
    amount: "20",
    date: "2026-11-12",
    key: "idempotent",
  };
  b.pay(payment);
  assert.throws(() => b.pay({ ...payment, amount: "30" }));
  assert.equal(b.snapshot("2026-11-12").bills[0].remaining, 8000);
});

test("an imported repayment identifies the sender in the memo without counting cash twice", (t) => {
  const { b, account } = setup(t);
  const owed = b.addOwed({ name: "Alex", amount: "100" });
  b.pay({
    target: owed,
    kind: "owed",
    account,
    amount: "100",
    date: "2026-11-12",
    key: "repay",
  });
  b.importStatement(
    account,
    statement([
      {
        ...transaction(
          "deposit",
          "2026-11-12",
          10000,
          "INTERAC E-TRANSFER AUTODEPOSIT",
          "CREDIT",
        ),
        memo: "Alex",
      },
    ]),
  );
  const s = b.snapshot("2026-11-12");
  assert.equal(s.accounts[0].balance, 90000);
  assert.equal(s.transactions.length, 1);
  assert.equal(s.owed[0].remaining, 0);
});

test("memo sender matching uses complete tokens and refuses multiple competing deposits", (t) => {
  const { b, account } = setup(t);
  const owed = b.addOwed({ name: "Alex", amount: "100" });
  b.pay({
    target: owed,
    kind: "owed",
    account,
    amount: "100",
    date: "2026-11-12",
    key: "repay",
  });
  const result = b.importStatement(
    account,
    statement([
      {
        ...transaction(
          "one",
          "2026-11-12",
          10000,
          "INTERAC AUTODEPOSIT",
          "CREDIT",
        ),
        memo: "Alex",
      },
      {
        ...transaction(
          "two",
          "2026-11-12",
          10000,
          "INTERAC AUTODEPOSIT",
          "CREDIT",
        ),
        memo: "Alex",
      },
    ]),
  );
  assert.ok(result.flagged > 0);
  assert.equal(b.snapshot("2026-11-12").transactions.length, 3);
});

test("ambiguous manual repayments persist for review and can be matched once", (t) => {
  const { b, account } = setup(t);
  const owed = b.addOwed({ name: "Alex", amount: "100" });
  b.pay({
    target: owed,
    kind: "owed",
    account,
    amount: "100",
    date: "2026-11-12",
    key: "repay",
  });
  b.importStatement(
    account,
    statement([
      {
        ...transaction("one", "2026-11-12", 10000, "INTERAC", "CREDIT"),
        memo: "Alex",
      },
      {
        ...transaction("two", "2026-11-12", 10000, "INTERAC", "CREDIT"),
        memo: "Alex",
      },
    ]),
  );
  let s = b.snapshot("2026-11-12");
  assert.equal(s.matchReviews.length, 2);
  assert.equal(s.projection.needsReview, true);
  const review = s.matchReviews[0];
  b.linkManual({ review: review.id, manual: review.candidates[0].id });
  b.linkManual({ review: review.id, manual: review.candidates[0].id });
  s = b.snapshot("2026-11-12");
  assert.equal(s.accounts[0].balance, 100000);
  assert.equal(s.transactions.length, 2);
  assert.deepEqual(b.unbalanced(), []);
});

test("future statement purchases do not appear in spending before posting", (t) => {
  const { b, account } = setup(t);
  b.importStatement(
    account,
    statement([transaction("future", "2026-11-15", -1000, "Cafe")]),
  );
  assert.equal(b.snapshot("2026-11-12").transactions[0].spending, 0);
  assert.equal(b.snapshot("2026-11-15").transactions[0].spending, 1000);
});

test("payday estimate shows a negative shortfall", (t) => {
  const { b } = setup(t);
  b.addBill({ name: "Large bill", amount: "900", due: "2026-11-19" });
  assert.equal(b.snapshot("2026-11-12").projection.available, -10000);
});

test("an invalid later row rolls back the entire import and account mapping", (t) => {
  const { b, account } = setup(t);
  const rows = [
    transaction("valid", "2026-11-11", -1000, "Cafe"),
    transaction("bad", "2026-99-99", -2000, "Shop"),
  ];
  assert.throws(() => b.importStatement(account, statement(rows)));
  const s = b.snapshot("2026-11-12");
  assert.equal(s.accounts[0].balance, 80000);
  assert.equal(s.transactions.length, 0);
  assert.equal(s.accounts[0].source_account, null);
  assert.deepEqual(b.unbalanced(), []);
});
