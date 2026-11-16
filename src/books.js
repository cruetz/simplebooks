import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";

const id = () => randomUUID();
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const date = (v) => {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(v || "") ||
    Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ||
    new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v
  )
    throw new Error("A valid date is required");
  return v;
};
const minor = (v) => {
  const m = String(v ?? "")
    .trim()
    .match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error("Enter an amount with at most two decimal places");
  const n =
    (Number(m[2]) * 100 + Number((m[3] || "").padEnd(2, "0"))) *
    (m[1] ? -1 : 1);
  if (!Number.isSafeInteger(n)) throw new Error("Amount is too large");
  return n;
};
const integer = (v) => {
  if (!Number.isSafeInteger(v))
    throw new Error("Amount must be an integer number of cents");
  return v;
};
const name = (v) => {
  if (!String(v || "").trim()) throw new Error("A name is required");
  return String(v).trim();
};
const near = (a, b, days = 3) =>
  Math.abs(Date.parse(a) - Date.parse(b)) <= days * 86400000;
const normalize = (v) =>
  String(v || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
const merchantMatches = (a, b) => {
  a = normalize(a);
  b = normalize(b);
  return a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a));
};

export class Books {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, included INTEGER NOT NULL, opening INTEGER, opening_date TEXT, currency TEXT NOT NULL, institution TEXT, source_account TEXT, updated TEXT);
      CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, date TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, explicit INTEGER NOT NULL DEFAULT 0, memo TEXT, key TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS lines (id TEXT PRIMARY KEY, entry TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE, account TEXT REFERENCES accounts(id), amount INTEGER NOT NULL, currency TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 1, posted TEXT NOT NULL, dimension TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS request_keys (kind TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(kind,key));
      CREATE TABLE IF NOT EXISTS match_reviews (id TEXT PRIMARY KEY, entry TEXT NOT NULL REFERENCES entries(id), candidates TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS merchant_rules (merchant TEXT PRIMARY KEY, category TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS corrections (id TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(id), source_id TEXT NOT NULL, original_id TEXT, action TEXT, payload TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0, UNIQUE(account,source_id));
      CREATE TABLE IF NOT EXISTS suppressed_imports (account TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY(account,source_id));
      CREATE TABLE IF NOT EXISTS merged_entries (old_id TEXT PRIMARY KEY, entry TEXT NOT NULL REFERENCES entries(id));
      CREATE TABLE IF NOT EXISTS imports (account TEXT NOT NULL REFERENCES accounts(id), source_id TEXT NOT NULL, entry TEXT NOT NULL REFERENCES entries(id), PRIMARY KEY(account,source_id));
      CREATE TABLE IF NOT EXISTS obligations (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, amount INTEGER NOT NULL, due TEXT, card TEXT REFERENCES accounts(id), recurrence TEXT, source TEXT REFERENCES entries(id));
      CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, obligation TEXT NOT NULL REFERENCES obligations(id), entry TEXT NOT NULL REFERENCES entries(id), amount INTEGER NOT NULL, key TEXT UNIQUE, UNIQUE(obligation,entry));
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, image BLOB NOT NULL, mime TEXT NOT NULL, merchant TEXT, date TEXT, amount INTEGER, category TEXT, entry TEXT REFERENCES entries(id));
      CREATE INDEX IF NOT EXISTS lines_entry ON lines(entry);
      CREATE INDEX IF NOT EXISTS lines_account_amount ON lines(account,amount);
      CREATE INDEX IF NOT EXISTS lines_amount ON lines(amount);
      CREATE INDEX IF NOT EXISTS imports_entry ON imports(entry);
    `);
    // Preserve legacy mappings and balances; a first explicit selection confirms
    // the richer identity before future imports may match automatically.
    this.atomic(() => {
      if (!this.all('PRAGMA table_info(accounts)').some((c) => c.name === 'source_identity'))
        this.db.exec('ALTER TABLE accounts ADD COLUMN source_identity TEXT');
      this.db.exec(`DROP INDEX IF EXISTS account_source;
        CREATE INDEX IF NOT EXISTS account_identity ON accounts(source_identity)`);
    });
  }
  close() {
    this.db.close();
  }
  all(sql, ...args) {
    return this.db.prepare(sql).all(...args);
  }
  get(sql, ...args) {
    return this.db.prepare(sql).get(...args);
  }
  run(sql, ...args) {
    return this.db.prepare(sql).run(...args);
  }
  atomic(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      if (this.unbalanced().length)
        throw new Error("The journal is unbalanced; no changes were saved");
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  settings(values) {
    if (values)
      this.atomic(() => {
        for (const [k, v] of Object.entries(values)) {
          if (!["currency", "payday"].includes(k))
            throw new Error("Unknown setting");
          if (k === "currency" && v !== "CAD")
            throw new Error("Only CAD is supported");
          if (k === "payday" && v) date(v);
          this.run(
            "INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            k,
            String(v || ""),
          );
        }
      });
    return Object.fromEntries(
      this.all("SELECT key,value FROM settings").map((r) => [r.key, r.value]),
    );
  }
  currency() {
    return this.settings().currency || "CAD";
  }
  account(account) {
    const a = this.get("SELECT * FROM accounts WHERE id=?", account);
    if (!a) throw new Error("Account not found");
    return a;
  }
  retry(kind, v) {
    if (!v.key) return null;
    const record = this.get(
      "SELECT * FROM request_keys WHERE kind=? AND key=?",
      kind,
      v.key,
    );
    if (!record) return null;
    if (record.fingerprint !== JSON.stringify(v))
      throw new Error("Retry key was used with different details");
    return record.result;
  }
  remember(kind, v, result) {
    if (v.key)
      this.run(
        "INSERT INTO request_keys VALUES(?,?,?,?)",
        kind,
        v.key,
        JSON.stringify(v),
        result,
      );
  }
  updateAccount(v) {
    const a = this.account(v.account);
    this.run(
      "UPDATE accounts SET name=?,included=? WHERE id=?",
      v.name === undefined ? a.name : name(v.name),
      v.included === undefined ? a.included : v.included ? 1 : 0,
      v.account,
    );
  }
  suggestCategory(merchant) {
    const rule = this.get(
      "SELECT category FROM merchant_rules WHERE merchant=?",
      normalize(merchant),
    );
    if (rule) return rule.category;
    const n = String(merchant || "").toLowerCase();
    if (/\b(grocery|supermarket|safeway|sobeys|costco)\b/.test(n))
      return "Groceries";
    if (/\b(cafe|coffee|restaurant|pizza)\b/.test(n)) return "Dining";
    if (/\b(shell|esso|petro|gas station)\b/.test(n)) return "Transportation";
    return "Uncategorized";
  }
  addAccount(v) {
    const account = id();
    if (!["bank", "card", "cash"].includes(v.type))
      throw new Error("Invalid account type");
    const opening =
      v.amount === undefined || v.amount === "" ? null : minor(v.amount);
    const openingDate = opening === null ? null : date(v.date);
    return this.atomic(() => {
      const prior = this.retry("account", v);
      if (prior) return prior;
      this.run(
        "INSERT INTO accounts(id,name,type,included,opening,opening_date,currency,updated) VALUES (?,?,?,?,?,?,?,?)",
        account,
        name(v.name),
        v.type,
        v.included ? 1 : 0,
        opening,
        openingDate,
        this.currency(),
        openingDate,
      );
      if (opening !== null) this.applyBalance(account, opening, openingDate);
      this.remember("account", v, account);
      return account;
    });
  }
  applyBalance(account, amount, d) {
    this.account(account);
    this.run(
      "UPDATE accounts SET opening=?,opening_date=?,updated=CASE WHEN updated IS NULL OR updated<? THEN ? ELSE updated END WHERE id=?",
      amount,
      d,
      d,
      d,
      account,
    );
    this.run(
      "UPDATE lines SET applied=CASE WHEN posted>? THEN 1 ELSE 0 END WHERE account=? AND entry NOT IN (SELECT id FROM entries WHERE category='Opening balance')",
      d,
      account,
    );
    this.run(
      "DELETE FROM entries WHERE category='Opening balance' AND key=?",
      `opening:${account}`,
    );
    const entry = id(),
      currency = this.account(account).currency;
    this.run(
      "INSERT INTO entries(id,date,name,category,key) VALUES(?,?,?,?,?)",
      entry,
      d,
      "Opening balance",
      "Opening balance",
      `opening:${account}`,
    );
    this.run(
      "INSERT INTO lines VALUES(?,?,?,?,?,?,?,?)",
      id(),
      entry,
      account,
      amount,
      currency,
      0,
      d,
      "asset",
    );
    this.run(
      "INSERT INTO lines VALUES(?,?,?,?,?,?,?,?)",
      id(),
      entry,
      null,
      -amount,
      currency,
      0,
      d,
      "equity",
    );
  }
  setBalance(v) {
    return this.atomic(() =>
      this.applyBalance(v.account, minor(v.amount), date(v.date)),
    );
  }
  setStatementBalance(v) {
    return this.atomic(() => {
      if (!v.statement.balance)
        throw new Error("Statement has no closing balance");
      this.applyBalance(
        v.account,
        integer(v.statement.balance.amount),
        date(v.statement.balance.date),
      );
    });
  }
  resolveCorrection(v) {
    return this.atomic(() => {
      const c = this.get("SELECT * FROM corrections WHERE id=?", v.correction);
      if (!c) throw new Error("Correction not found");
      if (c.resolved) return;
      const original = this.get(
        "SELECT entry FROM imports WHERE account=? AND source_id=?",
        c.account,
        c.original_id,
      );
      if (!original)
        throw new Error(
          "Original imported transaction was not found; investigate the statement before resolving",
        );
      const entry = original.entry,
        lines = this.all("SELECT * FROM lines WHERE entry=?", entry);
      if (
        lines.length !== 2 ||
        lines.filter((l) => l.account !== null).length !== 1 ||
        this.get("SELECT 1 FROM receipts WHERE entry=?", entry) ||
        this.get("SELECT 1 FROM payments WHERE entry=?", entry) ||
        this.get("SELECT 1 FROM obligations WHERE source=?", entry) ||
        this.get("SELECT COUNT(*) AS n FROM imports WHERE entry=?", entry).n !==
          1
      )
        throw new Error(
          "This transaction is linked to other records or a transfer; reconcile those links before resolving the correction",
        );
      if (c.action === "DELETE") {
        this.run(
          "INSERT OR IGNORE INTO suppressed_imports VALUES(?,?)",
          c.account,
          c.original_id,
        );
        this.run("DELETE FROM imports WHERE entry=?", entry);
        this.run("DELETE FROM entries WHERE id=?", entry);
      } else if (c.action === "REPLACE") {
        const tx = JSON.parse(c.payload);
        date(tx.date);
        integer(tx.amount);
        const account = this.account(c.account);
        this.run(
          "UPDATE entries SET date=?,name=?,memo=? WHERE id=?",
          tx.date,
          name(tx.name || "Transaction"),
          tx.memo || "",
          entry,
        );
        this.run(
          "UPDATE lines SET amount=?,posted=?,applied=? WHERE entry=? AND account=?",
          tx.amount,
          tx.date,
          !account.opening_date || tx.date > account.opening_date ? 1 : 0,
          entry,
          c.account,
        );
        this.run(
          "UPDATE lines SET amount=?,posted=? WHERE entry=? AND account IS NULL",
          -tx.amount,
          tx.date,
          entry,
        );
        this.run(
          "INSERT INTO imports VALUES(?,?,?)",
          c.account,
          c.source_id,
          entry,
        );
      } else
        throw new Error(
          "Unsupported correction action; review the bank statement manually",
        );
      this.run("UPDATE corrections SET resolved=1 WHERE id=?", c.id);
    });
  }
  createEntry({
    date: d,
    name: n,
    category = "Uncategorized",
    amount,
    account,
    key = null,
    memo = "",
    explicit = 0,
  }) {
    const a = this.account(account);
    integer(amount);
    date(d);
    const entry = id();
    this.run(
      "INSERT INTO entries(id,date,name,category,explicit,memo,key) VALUES(?,?,?,?,?,?,?)",
      entry,
      d,
      name(n),
      category,
      explicit,
      memo || "",
      key,
    );
    this.run(
      "INSERT INTO lines VALUES(?,?,?,?,?,?,?,?)",
      id(),
      entry,
      account,
      amount,
      a.currency,
      !a.opening_date || d > a.opening_date ? 1 : 0,
      d,
      "asset",
    );
    this.run(
      "INSERT INTO lines VALUES(?,?,?,?,?,1,?,?)",
      id(),
      entry,
      null,
      -amount,
      a.currency,
      d,
      category === "Transfer" ? "clearing" : amount < 0 ? "expense" : "income",
    );
    this.run(
      "UPDATE accounts SET updated=CASE WHEN updated IS NULL OR updated<? THEN ? ELSE updated END WHERE id=?",
      d,
      d,
      account,
    );
    return entry;
  }
  resolveImportAccount(accountId, statement) {
    if (!['bank', 'card'].includes(statement.kind)) throw new Error('Invalid statement account type');
    if (statement.currency !== this.currency()) throw new Error('Statement currency does not match');
    const source = name(statement.account);
    const institution = String(statement.institution || '');
    const parts = [statement.kind, statement.currency,
      statement.institutionKind || '', institution, statement.branch || '',
      statement.accountType || '', source,
      statement.institutionKind === 'FID' ? statement.organization || '' : ''];
    const identity = JSON.stringify(parts);
    const compatible = (other) => parts.every((part, i) => !part || !other[i] || part === other[i]);
    const strong = !!institution && statement.institutionKind !== 'ORG' &&
      (statement.institutionKind !== 'FID' || !!statement.organization) && !/[*xX\u2022]/.test(source);
    const matches = this.all('SELECT * FROM accounts WHERE source_identity=?', identity);
    let created = false;
    if (!accountId) {
      const candidates = this.all('SELECT * FROM accounts WHERE source_account=? AND type=?', source, statement.kind)
        .filter((a) => a.source_identity ? compatible(JSON.parse(a.source_identity))
          : !a.institution || a.institution === institution);
      if (!strong || matches.length > 1)
        throw new Error('Select an account, or choose Create a new account: the statement identity is incomplete or ambiguous.');
      if (candidates.some((a) => a.id !== matches[0]?.id))
        throw new Error('Select an account to confirm the existing statement mapping, or choose Create a new account.');
      if (matches.length === 1) accountId = matches[0].id;
      else accountId = 'new';
    }
    if (strong && matches.length && !matches.some((a) => a.id === accountId))
      throw new Error('This statement account is already mapped to another tracked account. Select that account or use automatic matching.');
    if (accountId === 'new') {
      accountId = id();
      this.run('INSERT INTO accounts(id,name,type,included,currency) VALUES(?,?,?,?,?)',
        accountId, `${statement.kind === 'card' ? 'Card' : statement.accountType || 'Bank'} ${statement.organization ? `${statement.organization} ` : ''}${institution || 'account'} ending ${source.slice(-4)}${statement.branch ? ` branch ${statement.branch}` : ''}`,
        statement.kind, statement.kind === 'bank' ? 1 : 0, statement.currency);
      created = true;
    }
    const account = this.account(accountId);
    if (statement.kind !== account.type) throw new Error('Statement account type does not match');
    if (statement.currency !== account.currency) throw new Error('Statement currency does not match');
    if ((account.source_identity && !compatible(JSON.parse(account.source_identity))) ||
      (account.source_account && (account.source_account !== source ||
        (account.institution && institution && account.institution !== institution))))
      throw new Error('This account is already mapped to a different statement account');
    const previous = account.source_identity && JSON.parse(account.source_identity);
    const confirmed = previous ? JSON.stringify(parts.map((part, i) => part || previous[i])) : identity;
    this.run('UPDATE accounts SET institution=?,source_account=?,source_identity=? WHERE id=?',
      institution || account.institution || '', source, confirmed, accountId);
    return { account: this.account(accountId), created };
  }
  initializeImportBalance(accountId, statement) {
    if (this.account(accountId).opening !== null || !statement.balance || !statement.balanceCoverage) return;
    const rows = statement.transactions;
    if (rows.some((tx) => tx.correctId || tx.correctAction || tx.date < statement.start || tx.date >= statement.end) ||
      this.get('SELECT 1 FROM corrections WHERE account=?', accountId) ||
      this.get('SELECT 1 FROM suppressed_imports WHERE account=?', accountId)) return;
    const sourceIds = new Set(rows.map((tx) => String(tx.id)));
    const lines = this.all(`SELECT l.id,l.entry FROM lines l WHERE l.account=? AND l.posted>=? AND l.posted<?
      AND l.entry NOT IN (SELECT id FROM entries WHERE category='Opening balance')`, accountId, statement.start, statement.end);
    if (lines.some((line) => !this.all('SELECT source_id FROM imports WHERE account=? AND entry=?', accountId, line.entry)
      .some((i) => sourceIds.has(i.source_id)))) return;
    // Sum unique bank IDs, not only newly added rows: overlap must not change
    // the opening implied by a complete statement. BigInt avoids rounding.
    const unique = new Map(rows.map((tx) => [String(tx.id), tx]));
    const movement = [...unique.values()].reduce((sum, tx) => sum + BigInt(integer(tx.amount)), 0n);
    const opening = Number(BigInt(integer(statement.balance.amount)) - movement);
    if (!Number.isSafeInteger(opening)) return;
    const before = new Date(`${date(statement.start)}T00:00:00Z`);
    before.setUTCDate(before.getUTCDate() - 1);
    const openingDate = before.toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(openingDate)) return;
    this.applyBalance(accountId, opening, openingDate);
  }
  importStatement(accountId, statement, options = {}) {
    return this.atomic(() => {
      const request = { key: options.key, account: accountId || '',
        statement: createHash('sha256').update(JSON.stringify(statement)).digest('hex') };
      const prior = this.retry('import', request);
      if (prior) return JSON.parse(prior);
      const { account, created } = this.resolveImportAccount(accountId, statement);
      accountId = account.id;
      let added = 0,
        duplicate = 0,
        flagged = 0;
      const seen = new Set(
        [
          ...this.all(
            "SELECT source_id FROM imports WHERE account=?",
            accountId,
          ),
          ...this.all(
            "SELECT source_id FROM suppressed_imports WHERE account=?",
            accountId,
          ),
        ].map((row) => row.source_id),
      );
      const eligible = new Map();
      for (const tx of statement.transactions) {
        const key = String(tx.id);
        if (!tx.id || tx.correctId || tx.correctAction || seen.has(key))
          continue;
        seen.add(key);
        if (!eligible.has(tx.amount)) eligible.set(tx.amount, []);
        eligible.get(tx.amount).push(tx);
      }
      for (const tx of statement.transactions) {
        if (!tx.id) throw new Error("Transaction ID is required");
        if (tx.correctId || tx.correctAction) {
          const prior = this.get(
            "SELECT resolved FROM corrections WHERE account=? AND source_id=?",
            accountId,
            String(tx.id),
          );
          if (!prior)
            this.run(
              "INSERT INTO corrections VALUES(?,?,?,?,?,?,0)",
              id(),
              accountId,
              String(tx.id),
              tx.correctId || "",
              tx.correctAction || "",
              JSON.stringify(tx),
            );
          if (!prior || !prior.resolved) flagged++;
          else duplicate++;
          continue;
        }
        date(tx.date);
        integer(tx.amount);
        const existing = this.get(`SELECT l.amount,l.posted FROM imports i JOIN lines l
          ON l.entry=i.entry AND l.account=i.account WHERE i.account=? AND i.source_id=?`, accountId, String(tx.id));
        if (existing && (existing.amount !== tx.amount || existing.posted !== tx.date) &&
          !this.get('SELECT 1 FROM corrections WHERE account=? AND resolved=1 AND (original_id=? OR source_id=?)',
            accountId, String(tx.id), String(tx.id)))
          throw new Error('Transaction ID conflicts with previously imported details. Review the bank statement before importing.');
        if (
          this.get(
            "SELECT 1 FROM imports WHERE account=? AND source_id=?",
            accountId,
            String(tx.id),
          ) ||
          this.get(
            "SELECT 1 FROM suppressed_imports WHERE account=? AND source_id=?",
            accountId,
            String(tx.id),
          )
        ) {
          duplicate++;
          continue;
        }
        let entry;
        const manual = this.all(
          `SELECT e.id,e.date,e.name,e.category,l.amount FROM entries e JOIN lines l ON l.entry=e.id WHERE l.account=? AND l.amount=? AND (EXISTS(SELECT 1 FROM receipts r WHERE r.entry=e.id) OR e.key LIKE 'payment:%') AND NOT EXISTS (SELECT 1 FROM imports i WHERE i.entry=e.id AND i.account=l.account)`,
          accountId,
          tx.amount,
        ).filter(
          (e) =>
            near(e.date, tx.date) &&
            (merchantMatches(e.name, tx.name) ||
              memoMentions(e.name, tx.memo) ||
              (e.category === "Transfer" && transferText(tx, account.type))),
        );
        const manualCompetition = (eligible.get(tx.amount) || []).filter(
          (other) =>
            other.id !== tx.id &&
            other.amount === tx.amount &&
            other.date &&
            near(other.date, tx.date) &&
            ((manual[0] &&
              (merchantMatches(manual[0].name, other.name) ||
                memoMentions(manual[0].name, other.memo))) ||
              (manual[0]?.category === "Transfer" &&
                transferText(other, account.type))),
        ).length;
        if (manual.length === 1 && manualCompetition === 0) {
          entry = manual[0].id;
          this.run(
            "UPDATE lines SET posted=?,applied=? WHERE entry=? AND account=?",
            tx.date,
            !account.opening_date || tx.date > account.opening_date ? 1 : 0,
            entry,
            accountId,
          );
        } else {
          const potential = this.all(
            `SELECT e.id,e.date,e.name,l.amount,a.type FROM entries e JOIN lines l ON l.entry=e.id JOIN accounts a ON a.id=l.account WHERE l.account<>? AND l.amount=? AND e.category='Transfer' AND (SELECT COUNT(*) FROM lines ll WHERE ll.entry=e.id)=2 AND (SELECT COUNT(*) FROM lines ll WHERE ll.entry=e.id AND ll.account IS NOT NULL)=1 AND EXISTS(SELECT 1 FROM lines ll WHERE ll.entry=e.id AND ll.account IS NULL AND ll.dimension='clearing' AND ll.amount=-l.amount) AND NOT EXISTS(SELECT 1 FROM payments p WHERE p.entry=e.id) AND NOT EXISTS(SELECT 1 FROM receipts r WHERE r.entry=e.id) AND NOT EXISTS(SELECT 1 FROM obligations o WHERE o.source=e.id)`,
            accountId,
            -tx.amount,
          ).filter(
            (e) =>
              near(e.date, tx.date) &&
              (account.type === "card" ||
                e.type === "card" ||
                (transferText(tx, account.type) &&
                  /transfer|xfer/i.test(e.name))),
          );
          const competing = (eligible.get(tx.amount) || []).filter(
            (other) =>
              other.id !== tx.id &&
              other.amount === tx.amount &&
              other.date &&
              near(other.date, tx.date) &&
              transferText(other, account.type),
          ).length;
          if (
            manual.length === 0 &&
            potential.length === 1 &&
            competing === 0 &&
            transferText(tx, account.type)
          ) {
            entry = potential[0].id;
            this.run(
              "DELETE FROM lines WHERE entry=? AND account IS NULL",
              entry,
            );
            this.run(
              "INSERT INTO lines VALUES(?,?,?,?,?,?,?,?)",
              id(),
              entry,
              accountId,
              tx.amount,
              account.currency,
              !account.opening_date || tx.date > account.opening_date ? 1 : 0,
              tx.date,
              "asset",
            );
            this.run(
              "UPDATE accounts SET updated=CASE WHEN updated IS NULL OR updated<? THEN ? ELSE updated END WHERE id=?",
              tx.date,
              tx.date,
              accountId,
            );
          } else {
            if (
              potential.length > 1 ||
              manual.length > 1 ||
              competing ||
              manualCompetition
            )
              flagged++;
            entry = this.createEntry({
              date: tx.date,
              name: tx.name || "Transaction",
              category: transferText(tx, account.type)
                ? "Transfer"
                : this.suggestCategory(tx.name),
              amount: tx.amount,
              account: accountId,
              memo: tx.memo,
            });
          }
        }
        this.run(
          "INSERT INTO imports VALUES(?,?,?)",
          accountId,
          String(tx.id),
          entry,
        );
        if (manual.length && (manual.length > 1 || manualCompetition > 0)) {
          this.run(
            "INSERT INTO match_reviews VALUES(?,?,?,0)",
            id(),
            entry,
            JSON.stringify(manual.map((candidate) => candidate.id)),
          );
        }
        added++;
      }
      this.initializeImportBalance(accountId, statement);
      if (statement.end) this.expandRecurrences(date(statement.end));
      this.matchReceipts();
      this.matchBills();
      const result = {
        added,
        duplicate,
        flagged,
        account: accountId,
        created,
        needsBalance: this.account(accountId).opening === null,
        start: statement.start,
        end: statement.end,
      };
      this.remember('import', request, JSON.stringify(result));
      return result;
    });
  }
  addBill(v) {
    return this.addObligation("bill", v);
  }
  addOwed(v) {
    return this.addObligation("owed", v);
  }
  addObligation(kind, v) {
    const oid = id(),
      amount = minor(v.amount);
    if (amount <= 0) throw new Error("Amount must be positive");
    if (v.due) date(v.due);
    if (v.card && this.account(v.card).type !== "card")
      throw new Error("Select a credit card");
    if (v.recurrence && v.recurrence !== "monthly")
      throw new Error("Unsupported recurrence");
    if (v.source && !this.get("SELECT 1 FROM entries WHERE id=?", v.source))
      throw new Error("Transaction not found");
    return this.atomic(() => {
      const prior = this.retry(kind, v);
      if (prior) return prior;
      this.run(
        "INSERT INTO obligations VALUES(?,?,?,?,?,?,?,?)",
        oid,
        kind,
        name(v.name),
        amount,
        v.due || null,
        v.card || null,
        v.recurrence || null,
        v.source || null,
      );
      if (kind === "owed") {
        const d = today(),
          currency = this.currency();
        let entry;
        if (v.source) {
          entry = v.source;
          const expense = this.get(
            "SELECT * FROM lines WHERE entry=? AND dimension='expense' AND amount>=?",
            entry,
            amount,
          );
          if (!expense)
            throw new Error(
              "The linked outlay has insufficient expense to allocate",
            );
          this.run(
            "UPDATE lines SET amount=amount-? WHERE id=?",
            amount,
            expense.id,
          );
          this.run(
            "INSERT INTO lines VALUES(?,?,?,?,?,?,?,?)",
            id(),
            entry,
            null,
            amount,
            currency,
            1,
            d,
            "receivable",
          );
        } else {
          entry = id();
          this.run(
            "INSERT INTO entries(id,date,name,category) VALUES(?,?,?,?)",
            entry,
            d,
            v.name,
            "Receivable opening",
          );
          this.run(
            "INSERT INTO lines VALUES(?,?,?,?,?,?,?,?)",
            id(),
            entry,
            null,
            amount,
            currency,
            1,
            d,
            "receivable",
          );
          this.run(
            "INSERT INTO lines VALUES(?,?,?,?,?,?,?,?)",
            id(),
            entry,
            null,
            -amount,
            currency,
            1,
            d,
            "equity",
          );
        }
      }
      this.remember(kind, v, oid);
      if (kind === "bill") this.matchBills();
      return oid;
    });
  }
  pay(v) {
    return this.atomic(() => {
      const obligation = this.get(
        "SELECT * FROM obligations WHERE id=? AND kind=?",
        v.target,
        v.kind,
      );
      if (!obligation) throw new Error("Obligation not found");
      if (v.key) {
        const retried = this.retry("payment", v);
        if (retried) return retried;
        const prior = this.get("SELECT * FROM payments WHERE key=?", v.key);
        if (prior) {
          if (prior.obligation !== v.target)
            throw new Error("Payment key already used");
          return prior.id;
        }
      }
      let entry = v.transaction,
        amount;
      if (entry) {
        const lines = this.all(
          "SELECT l.* FROM lines l WHERE l.entry=? AND l.account IS NOT NULL",
          entry,
        );
        const line = obligation.card
          ? lines.find((l) => l.account === obligation.card && l.amount > 0)
          : lines.length === 1 && lines[0];
        if (!line) throw new Error("Transaction not found");
        if (
          (v.kind === "bill" && !obligation.card && line.amount >= 0) ||
          (v.kind === "owed" && line.amount <= 0)
        )
          throw new Error("Transaction has the wrong direction");
        amount = Math.abs(line.amount);
        const existing = this.get(
          "SELECT * FROM payments WHERE obligation=? AND entry=?",
          v.target,
          entry,
        );
        if (existing) return existing.id;
        if (this.get("SELECT 1 FROM payments WHERE entry=?", entry))
          throw new Error("Transaction already linked to a payment");
      } else {
        if (!v.key) throw new Error("A retry key is required");
        amount = minor(v.amount);
      }
      const remaining =
        obligation.amount -
        this.get(
          "SELECT COALESCE(SUM(amount),0) AS n FROM payments WHERE obligation=?",
          v.target,
        ).n;
      if (amount <= 0 || amount > remaining)
        throw new Error("Payment exceeds amount remaining");
      if (!entry) {
        if (date(v.date) > today())
          throw new Error("A payment date cannot be in the future");
        if (obligation.card && v.account === obligation.card)
          throw new Error("Pay a card bill from a different account");
        entry = this.createEntry({
          date: date(v.date),
          name: obligation.name,
          category:
            v.kind === "bill"
              ? obligation.card
                ? "Transfer"
                : "Bills"
              : "Repayment",
          amount: v.kind === "bill" ? -amount : amount,
          account: v.account,
          key: `payment:${v.key}`,
        });
        if (obligation.card) {
          const card = this.account(obligation.card);
          this.run(
            "DELETE FROM lines WHERE entry=? AND account IS NULL",
            entry,
          );
          this.run(
            "INSERT INTO lines VALUES(?,?,?,?,?,?,?,?)",
            id(),
            entry,
            card.id,
            amount,
            card.currency,
            !card.opening_date || v.date > card.opening_date ? 1 : 0,
            v.date,
            "asset",
          );
          this.run(
            "UPDATE accounts SET updated=CASE WHEN updated IS NULL OR updated<? THEN ? ELSE updated END WHERE id=?",
            v.date,
            v.date,
            card.id,
          );
        }
      } else if (
        !this.get("SELECT explicit FROM entries WHERE id=?", entry).explicit
      )
        this.run(
          "UPDATE entries SET category=? WHERE id=?",
          v.kind === "bill"
            ? obligation.card
              ? "Transfer"
              : "Bills"
            : "Repayment",
          entry,
        );
      if (v.kind === "owed")
        this.run(
          "UPDATE lines SET dimension='receivable' WHERE entry=? AND account IS NULL",
          entry,
        );
      const payment = id();
      this.run(
        "INSERT INTO payments VALUES(?,?,?,?,?)",
        payment,
        v.target,
        entry,
        amount,
        v.key || null,
      );
      this.remember("payment", v, payment);
      return payment;
    });
  }
  addReceipt(v) {
    return this.atomic(() => {
      if (!v.hash || !Buffer.isBuffer(v.image) || !v.mime)
        throw new Error("Receipt image and hash are required");
      const existing = this.get("SELECT id FROM receipts WHERE hash=?", v.hash);
      if (existing) return existing.id;
      if (v.date) date(v.date);
      if (v.amount != null && integer(v.amount) <= 0)
        throw new Error("Receipt amount must be positive");
      const rid = id();
      this.run(
        "INSERT INTO receipts VALUES(?,?,?,?,?,?,?,?,NULL)",
        rid,
        v.hash,
        v.image,
        v.mime,
        v.merchant || "",
        v.date || null,
        v.amount ?? null,
        v.category || this.suggestCategory(v.merchant),
      );
      this.matchReceipts();
      return rid;
    });
  }
  updateReceipt(v) {
    return this.atomic(() => {
      const r = this.get("SELECT * FROM receipts WHERE id=?", v.receipt);
      if (!r) throw new Error("Receipt not found");
      if (v.date) date(v.date);
      if (v.amount != null && integer(v.amount) <= 0)
        throw new Error("Receipt amount must be positive");
      this.run(
        "UPDATE receipts SET merchant=?,date=?,amount=?,category=? WHERE id=?",
        v.merchant ?? r.merchant,
        v.date || null,
        v.amount ?? null,
        v.category || null,
        v.receipt,
      );
      this.matchReceipts();
    });
  }
  receiptImage(receipt) {
    const r = this.get("SELECT image,mime FROM receipts WHERE id=?", receipt);
    if (!r) throw new Error("Receipt not found");
    return r;
  }
  candidates(r) {
    if (!r.date || !r.amount || !r.merchant) return [];
    return this.all(
      `SELECT DISTINCT e.id,e.date,e.name FROM entries e JOIN lines l ON l.entry=e.id WHERE l.account IS NOT NULL AND l.amount=? AND e.category NOT IN ('Transfer','Opening balance') AND NOT EXISTS (SELECT 1 FROM receipts rr WHERE rr.entry=e.id AND rr.id<>?)`,
      -r.amount,
      r.id,
    ).filter(
      (e) => near(e.date, r.date) && merchantMatches(e.name, r.merchant),
    );
  }
  matchReceipts() {
    for (const r of this.all("SELECT * FROM receipts WHERE entry IS NULL")) {
      const candidates = this.candidates(r);
      if (candidates.length === 1) {
        const competing = this.all(
          "SELECT * FROM receipts WHERE entry IS NULL AND id<>?",
          r.id,
        ).some((other) =>
          this.candidates(other).some((e) => e.id === candidates[0].id),
        );
        if (!competing) {
          this.run(
            "UPDATE receipts SET entry=? WHERE id=?",
            candidates[0].id,
            r.id,
          );
          if (r.category)
            this.run(
              "UPDATE entries SET category=? WHERE id=? AND explicit=0 AND category='Uncategorized'",
              r.category,
              candidates[0].id,
            );
        }
      }
    }
  }
  linkReceipt(v) {
    return this.atomic(() => {
      const r = this.get("SELECT * FROM receipts WHERE id=?", v.receipt);
      if (!r) throw new Error("Receipt not found");
      if (r.entry === v.transaction) return;
      if (this.get("SELECT 1 FROM receipts WHERE entry=?", v.transaction))
        throw new Error("Receipt or transaction already linked");
      if (!this.get("SELECT 1 FROM entries WHERE id=?", v.transaction))
        throw new Error("Transaction not found");
      if (r.entry) {
        const old = this.get("SELECT * FROM entries WHERE id=?", r.entry);
        const oldLine = this.get(
          "SELECT * FROM lines WHERE entry=? AND account IS NOT NULL",
          r.entry,
        );
        const candidate = this.get(
          "SELECT * FROM lines WHERE entry=? AND account=? AND amount=?",
          v.transaction,
          oldLine?.account,
          oldLine?.amount,
        );
        if (
          !old?.key?.startsWith("receipt:") ||
          !candidate ||
          this.get("SELECT 1 FROM imports WHERE entry=?", r.entry) ||
          !this.get("SELECT 1 FROM imports WHERE entry=?", v.transaction) ||
          this.get("SELECT COUNT(*) AS n FROM lines WHERE entry=?", r.entry)
            .n !== 2 ||
          this.get("SELECT 1 FROM obligations WHERE source=?", r.entry) ||
          this.get("SELECT 1 FROM payments WHERE entry=?", r.entry)
        )
          throw new Error(
            "Only a simple manual receipt purchase can be reconciled with a matching imported transaction",
          );
        if (old.explicit)
          this.run(
            "UPDATE entries SET category=?,explicit=1 WHERE id=?",
            old.category,
            v.transaction,
          );
        this.run(
          "UPDATE receipts SET entry=? WHERE id=?",
          v.transaction,
          v.receipt,
        );
        this.run("DELETE FROM entries WHERE id=?", r.entry);
        return;
      }
      this.run(
        "UPDATE receipts SET entry=? WHERE id=?",
        v.transaction,
        v.receipt,
      );
    });
  }
  recordReceipt(v) {
    return this.atomic(() => {
      const r = this.get("SELECT * FROM receipts WHERE id=?", v.receipt);
      if (!r) throw new Error("Receipt not found");
      if (r.entry) return r.entry;
      if (!r.amount || !r.date)
        throw new Error("Receipt needs an amount and date");
      if (r.date > today())
        throw new Error("A purchase date cannot be in the future");
      const entry = this.createEntry({
        date: r.date,
        name: r.merchant || "Purchase",
        category: r.category || "Uncategorized",
        amount: -r.amount,
        account: v.account,
        key: v.key ? `receipt:${v.key}` : `receipt:${r.id}`,
      });
      this.run("UPDATE receipts SET entry=? WHERE id=?", entry, r.id);
      return entry;
    });
  }
  addTransaction(v) {
    return this.atomic(() => {
      if (!v.key) throw new Error("A retry key is required");
      if (date(v.date) > today())
        throw new Error("A transaction date cannot be in the future");
      const key = `manual:${v.key}`;
      const prior = this.get("SELECT id FROM entries WHERE key=?", key);
      if (prior) return prior.id;
      return this.createEntry({
        date: v.date,
        name: v.name,
        category: v.category || "Uncategorized",
        amount: minor(v.amount),
        account: v.account,
        key,
        explicit: v.category ? 1 : 0,
        memo: v.memo,
      });
    });
  }
  categorize(v) {
    return this.atomic(() => {
      const entry = this.get("SELECT * FROM entries WHERE id=?", v.transaction);
      if (!entry) throw new Error("Transaction not found");
      const category = name(v.category);
      this.run(
        "UPDATE entries SET category=?,explicit=1 WHERE id=?",
        category,
        v.transaction,
      );
      const merchant = normalize(entry.name);
      if (merchant)
        this.run(
          "INSERT INTO merchant_rules VALUES(?,?) ON CONFLICT(merchant) DO UPDATE SET category=excluded.category",
          merchant,
          category,
        );
    });
  }
  linkManual(v) {
    return this.atomic(() => {
      const review = this.get(
        "SELECT * FROM match_reviews WHERE id=?",
        v.review,
      );
      if (!review) throw new Error("Review not found");
      if (review.resolved) return review.entry;
      if (!JSON.parse(review.candidates).includes(v.manual))
        throw new Error("That transaction is not a candidate for this review");
      const imported = this.all(
        "SELECT * FROM lines WHERE entry=? AND account IS NOT NULL",
        review.entry,
      );
      const manual =
        imported.length === 1 &&
        this.get(
          "SELECT * FROM lines WHERE entry=? AND account=? AND amount=?",
          v.manual,
          imported[0].account,
          imported[0].amount,
        );
      if (
        !manual ||
        this.get("SELECT COUNT(*) AS n FROM lines WHERE entry=?", review.entry)
          .n !== 2 ||
        this.get(
          "SELECT 1 FROM imports WHERE entry=? AND account=?",
          v.manual,
          manual.account,
        ) ||
        this.get("SELECT 1 FROM receipts WHERE entry=?", review.entry) ||
        this.get("SELECT 1 FROM payments WHERE entry=?", review.entry) ||
        this.get("SELECT 1 FROM obligations WHERE source=?", review.entry)
      )
        throw new Error(
          "These transactions have other links or no longer match; review them manually",
        );
      const account = this.account(manual.account);
      this.run(
        "UPDATE lines SET posted=?,applied=? WHERE id=?",
        imported[0].posted,
        !account.opening_date || imported[0].posted > account.opening_date
          ? 1
          : 0,
        manual.id,
      );
      this.run(
        "UPDATE imports SET entry=? WHERE entry=?",
        v.manual,
        review.entry,
      );
      this.run(
        "UPDATE match_reviews SET entry=?,resolved=1 WHERE id=?",
        v.manual,
        v.review,
      );
      this.run("DELETE FROM entries WHERE id=?", review.entry);
      return v.manual;
    });
  }
  dismissManualReview(v) {
    const review = this.get("SELECT * FROM match_reviews WHERE id=?", v.review);
    if (!review) throw new Error("Review not found");
    this.run("UPDATE match_reviews SET resolved=1 WHERE id=?", v.review);
  }
  linkTransfer(v) {
    return this.atomic(() => {
      const resolve = (value) =>
        this.get("SELECT entry FROM merged_entries WHERE old_id=?", value)
          ?.entry || value;
      const first = resolve(v.first),
        second = resolve(v.second);
      if (first === second) return first;
      const a = this.all(
          "SELECT * FROM lines WHERE entry=? AND account IS NOT NULL",
          first,
        ),
        b = this.all(
          "SELECT * FROM lines WHERE entry=? AND account IS NOT NULL",
          second,
        );
      if (
        a.length !== 1 ||
        b.length !== 1 ||
        a[0].account === b[0].account ||
        a[0].amount + b[0].amount !== 0 ||
        a[0].currency !== b[0].currency
      )
        throw new Error(
          "Transfers need two opposite amounts in different accounts",
        );
      for (const entry of [first, second]) {
        if (
          this.get("SELECT COUNT(*) AS n FROM lines WHERE entry=?", entry).n !==
            2 ||
          this.get("SELECT 1 FROM obligations WHERE source=?", entry) ||
          this.get("SELECT 1 FROM payments WHERE entry=?", entry) ||
          this.get("SELECT 1 FROM receipts WHERE entry=?", entry)
        )
          throw new Error(
            "Unlink related payments, receipts, or amounts owed before combining",
          );
      }
      if (
        this.get("SELECT 1 FROM payments WHERE entry=?", second) ||
        this.get("SELECT 1 FROM receipts WHERE entry=?", second)
      )
        throw new Error("Remove the second transaction link before combining");
      this.run("DELETE FROM lines WHERE entry=? AND account IS NULL", first);
      this.run("DELETE FROM lines WHERE entry=? AND account IS NULL", second);
      this.run("UPDATE lines SET entry=? WHERE entry=?", first, second);
      this.run("UPDATE imports SET entry=? WHERE entry=?", first, second);
      this.run(
        "UPDATE merged_entries SET entry=? WHERE entry=?",
        first,
        second,
      );
      this.run("INSERT INTO merged_entries VALUES(?,?)", second, first);
      this.run("DELETE FROM entries WHERE id=?", second);
      this.run(
        "UPDATE entries SET category='Transfer',explicit=1 WHERE id=?",
        first,
      );
      this.matchBills();
      return first;
    });
  }
  matchBills() {
    const bills = this.all(
      `SELECT o.*,o.amount-COALESCE((SELECT SUM(amount) FROM payments WHERE obligation=o.id),0) AS remaining FROM obligations o WHERE kind='bill' AND card IS NOT NULL`,
    );
    const entries = this.all(
      `SELECT e.id,e.date,l.account,l.amount FROM entries e JOIN lines l ON l.entry=e.id WHERE e.category='Transfer' AND l.amount>0 AND EXISTS(SELECT 1 FROM lines cash JOIN accounts a ON a.id=cash.account WHERE cash.entry=e.id AND cash.amount=-l.amount AND a.type IN ('bank','cash')) AND NOT EXISTS(SELECT 1 FROM payments p WHERE p.entry=e.id)`,
    );
    const matches = bills.flatMap((b) =>
      entries
        .filter(
          (e) =>
            b.card === e.account &&
            b.remaining === e.amount &&
            b.due &&
            near(e.date, b.due, 7),
        )
        .map((e) => ({ b, e })),
    );
    for (const { b, e } of matches)
      if (
        matches.filter((m) => m.b.id === b.id).length === 1 &&
        matches.filter((m) => m.e.id === e.id).length === 1
      )
        this.run(
          "INSERT INTO payments VALUES(?,?,?,?,NULL)",
          id(),
          b.id,
          e.id,
          e.amount,
        );
    const ordinaryBills = this.all(
      `SELECT o.*,o.amount-COALESCE((SELECT SUM(amount) FROM payments WHERE obligation=o.id),0) AS remaining FROM obligations o WHERE kind='bill' AND card IS NULL`,
    );
    const outlays = this.all(
      `SELECT e.id,e.date,e.name,e.explicit,l.amount FROM entries e JOIN lines l ON l.entry=e.id WHERE l.account IS NOT NULL AND l.amount<0 AND e.category<>'Transfer' AND (SELECT COUNT(*) FROM lines a WHERE a.entry=e.id AND a.account IS NOT NULL)=1 AND EXISTS(SELECT 1 FROM imports i WHERE i.entry=e.id) AND NOT EXISTS(SELECT 1 FROM payments p WHERE p.entry=e.id)`,
    );
    const ordinaryMatches = ordinaryBills.flatMap((b) =>
      outlays
        .filter(
          (e) =>
            b.remaining >= -e.amount &&
            b.due &&
            near(e.date, b.due, 7) &&
            normalize(b.name).length >= 3 &&
            normalize(b.name) === normalize(e.name),
        )
        .map((e) => ({ b, e })),
    );
    for (const { b, e } of ordinaryMatches) {
      if (
        ordinaryMatches.filter((m) => m.b.id === b.id).length === 1 &&
        ordinaryMatches.filter((m) => m.e.id === e.id).length === 1
      ) {
        this.run(
          "INSERT INTO payments VALUES(?,?,?,?,NULL)",
          id(),
          b.id,
          e.id,
          -e.amount,
        );
        if (!e.explicit)
          this.run("UPDATE entries SET category='Bills' WHERE id=?", e.id);
      }
    }
  }
  unbalanced() {
    return this.all(
      "SELECT entry,currency,SUM(amount) AS amount FROM lines GROUP BY entry,currency HAVING SUM(amount)<>0",
    );
  }
  expandRecurrences(until) {
    for (const original of this.all(
      "SELECT * FROM obligations WHERE recurrence='monthly'",
    )) {
      const start = original.due;
      if (!start) continue;
      const [year, month, day] = start.split("-").map(Number);
      for (let offset = 1; offset <= 600; offset++) {
        const first = new Date(Date.UTC(year, month - 1 + offset, 1));
        const last = new Date(
          Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
        ).getUTCDate();
        const due = `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
        if (due > until) break;
        const occurrence = `${original.id}:${due}`;
        this.run(
          "INSERT OR IGNORE INTO obligations VALUES(?,?,?,?,?,?,?,?)",
          occurrence,
          "bill",
          original.name,
          original.amount,
          due,
          original.card,
          null,
          original.source,
        );
      }
    }
  }
  snapshot(asOf = today()) {
    date(asOf);
    const settings = this.settings();
    this.atomic(() =>
      this.expandRecurrences(
        settings.payday && settings.payday > asOf ? settings.payday : asOf,
      ),
    );
    const accounts = this.all(
      `SELECT a.*, CASE WHEN opening IS NULL OR opening_date>? THEN NULL ELSE opening + COALESCE((SELECT SUM(amount) FROM lines WHERE account=a.id AND applied=1 AND posted<=?),0) END AS balance FROM accounts a ORDER BY rowid`,
      asOf,
      asOf,
    ).map((a) => ({ ...a, included: !!a.included }));
    const transactions = this.all(
      `SELECT e.*, (SELECT amount FROM lines WHERE entry=e.id AND account IS NOT NULL ORDER BY rowid LIMIT 1) AS amount, (SELECT account FROM lines WHERE entry=e.id AND account IS NOT NULL ORDER BY rowid LIMIT 1) AS account FROM entries e WHERE e.category<>'Opening balance' AND EXISTS(SELECT 1 FROM lines l WHERE l.entry=e.id AND l.account IS NOT NULL) ORDER BY e.date DESC,e.rowid DESC`,
    );
    for (const transaction of transactions) {
      transaction.legs = this.all(
        "SELECT account,amount,posted FROM lines WHERE entry=? AND account IS NOT NULL ORDER BY rowid",
        transaction.id,
      );
      transaction.spending = this.get(
        "SELECT COALESCE(SUM(amount),0) AS amount FROM lines WHERE entry=? AND dimension='expense' AND EXISTS(SELECT 1 FROM lines l WHERE l.entry=? AND l.account IS NOT NULL AND l.posted<=?)",
        transaction.id,
        transaction.id,
        asOf,
      ).amount;
    }
    const obligations = this.all(
      `SELECT o.*,o.amount-COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.obligation=o.id AND (SELECT MAX(posted) FROM lines WHERE entry=p.entry AND account IS NOT NULL)<=?),0) AS remaining FROM obligations o ORDER BY COALESCE(due,'9999'),o.rowid`,
      asOf,
    );
    const receipts = this.all(
      "SELECT id,hash,mime,merchant,date,amount,category,entry FROM receipts ORDER BY rowid DESC",
    ).map((r) => {
      const manual =
        r.entry &&
        this.get(
          "SELECT 1 FROM entries WHERE id=? AND key LIKE 'receipt:%'",
          r.entry,
        ) &&
        !this.get("SELECT 1 FROM imports WHERE entry=?", r.entry);
      const matches =
        !r.entry || manual
          ? this.candidates(r).filter(
              (candidate) =>
                candidate.id !== r.entry &&
                (!manual ||
                  this.get(
                    "SELECT 1 FROM imports WHERE entry=?",
                    candidate.id,
                  )),
            )
          : [];
      return { ...r, matches };
    });
    const included = accounts.filter((a) => a.included && a.type !== "card");
    const due = obligations.filter(
      (o) =>
        o.kind === "bill" &&
        o.due &&
        settings.payday &&
        o.due < settings.payday &&
        o.remaining > 0,
    );
    const validPayday = !!settings.payday && settings.payday > asOf;
    const needsBalance = included.some((a) => a.balance === null);
    const corrections = this.all(
      "SELECT id,account,source_id,original_id,action,payload FROM corrections WHERE resolved=0 ORDER BY rowid",
    ).map((c) => ({ ...c, transaction: JSON.parse(c.payload) }));
    const matchReviews = this.all(
      "SELECT * FROM match_reviews WHERE resolved=0",
    )
      .map((review) => {
        const imported = this.get(
          "SELECT account,amount FROM lines WHERE entry=? AND account IS NOT NULL",
          review.entry,
        );
        const candidates = JSON.parse(review.candidates)
          .map((candidate) =>
            this.get("SELECT id,date,name FROM entries WHERE id=?", candidate),
          )
          .filter(
            (candidate) =>
              candidate &&
              imported &&
              !this.get(
                "SELECT 1 FROM imports WHERE entry=? AND account=?",
                candidate.id,
                imported.account,
              ),
          );
        return {
          ...review,
          transaction: transactions.find((t) => t.id === review.entry),
          candidates,
        };
      })
      .filter((review) => review.candidates.length);
    const projection = {
      needsReview:
        corrections.length > 0 ||
        matchReviews.length > 0 ||
        receipts.some((receipt) => receipt.entry && receipt.matches.length > 0),
      payday: settings.payday || null,
      needsPayday: !validPayday,
      needsBalance,
      needsAccounts: included.length === 0,
      accounts: included,
      bills: due,
      cash: included.reduce((n, a) => n + (a.balance || 0), 0),
      due: due.reduce((n, b) => n + b.remaining, 0),
      available: null,
    };
    if (validPayday && !needsBalance && included.length > 0)
      projection.available = projection.cash - projection.due;
    return {
      settings,
      accounts,
      transactions,
      bills: obligations.filter((o) => o.kind === "bill"),
      owed: obligations.filter((o) => o.kind === "owed"),
      receipts,
      corrections,
      matchReviews,
      projection,
    };
  }
}
function transferText(tx, accountType) {
  return (
    /^(XFER|TRANSFER)$/i.test(tx.type || "") ||
    (accountType === "card" && /^PAYMENT$/i.test(tx.type || "")) ||
    /\b(transfer|xfer|credit card payment|card payment|payment thank you)\b/i.test(
      `${tx.name || ""} ${tx.memo || ""}`,
    )
  );
}
function memoMentions(name, memo) {
  const words =
    String(name || "")
      .toLowerCase()
      .match(/[a-z0-9]+/g) || [];
  const text =
    String(memo || "")
      .toLowerCase()
      .match(/[a-z0-9]+/g) || [];
  if (words.join("").length < 3) return false;
  return text.some((_, i) => words.every((word, j) => text[i + j] === word));
}
