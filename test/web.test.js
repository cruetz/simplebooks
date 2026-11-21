import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.js";
import { Books } from "../src/books.js";

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "simplebooks-web-"));
  const app = createApp({ dataDir: dir });
  const servers = [app], databases = [];
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  t.after(async () => {
    for (const server of servers)
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    for (const db of databases) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { base, app, dir, servers, databases };
}

test("dashboard renders and rejects cross-origin form submissions", async (t) => {
  const { base } = await setup(t);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /before payday/i);
  const denied = await fetch(`${base}/settings`, {
    method: "POST",
    headers: {
      origin: "https://evil.example",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "payday=2026-12-01",
  });
  assert.equal(denied.status, 403);
});

test("account form persists across a server restart", async (t) => {
  const { base, app, dir, servers } = await setup(t);
  const formPage = await fetch(`${base}/accounts`);
  // Browsers send Origin: null on a form POST from a no-referrer page.
  assert.equal(formPage.headers.get("referrer-policy"), "same-origin");
  const response = await fetch(`${base}/accounts`, {
    method: "POST",
    redirect: "manual",
    headers: {
      origin: base,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "name=Everyday&type=bank&included=on&amount=800&date=2026-11-10&key=test-account",
  });
  assert.equal(response.status, 303);
  await new Promise((resolve) => app.close(resolve));
  const reopened = createApp({ dataDir: dir });
  await new Promise((resolve) => reopened.listen(0, "127.0.0.1", resolve));
  servers.push(reopened);
  const page = await fetch(
    `http://127.0.0.1:${reopened.address().port}/accounts`,
  );
  assert.match(await page.text(), /Everyday/);
});

test("receipt upload is stored once and served as a validated image", async (t) => {
  const { base } = await setup(t);
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ff7sAAAAASUVORK5CYII=",
    "base64",
  );
  for (let i = 0; i < 2; i++) {
    const data = new FormData();
    data.set(
      "receipt",
      new Blob([image], { type: "image/png" }),
      "receipt.png",
    );
    const response = await fetch(`${base}/receipts`, {
      method: "POST",
      headers: { origin: base },
      body: data,
      redirect: "manual",
    });
    assert.equal(response.status, 303);
  }
  const page = await (await fetch(`${base}/receipts`)).text();
  assert.match(page, /1 saved/);
  const path = page.match(/href="(\/receipts\/[a-f0-9-]+\/image)"/)[1];
  const response = await fetch(base + path);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
});

test("imported statement updates the payday dashboard once across retries", async (t) => {
  const { base } = await setup(t);
  const post = (path, body) =>
    fetch(base + path, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: base,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
  assert.equal(
    (
      await post(
        "/accounts",
        "name=Chequing&type=bank&included=on&amount=800&date=2026-11-10&key=import-account",
      )
    ).status,
    303,
  );
  assert.equal((await post("/settings", "payday=2099-11-20")).status, 303);
  const accounts = await (await fetch(base + "/import")).text();
  const account = accounts.match(
    /<option value="([a-f0-9-]+)">Chequing<\/option>/,
  )[1];
  const statement =
    "<OFX><STMTRS><CURDEF>CAD<BANKID>002<ACCTID>123<BANKTRANLIST><DTSTART>20261101<DTEND>20261130<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261112<TRNAMT>-10<FITID>one<NAME>Cafe</STMTTRN></BANKTRANLIST></STMTRS></OFX>";
  for (let i = 0; i < 2; i++) {
    const data = new FormData();
    data.set("account", account);
    data.set("statement", new Blob([statement]), "statement.ofx");
    assert.equal(
      (
        await fetch(base + "/import", {
          method: "POST",
          redirect: "manual",
          headers: { origin: base },
          body: data,
        })
      ).status,
      303,
    );
  }
  const dashboard = await (await fetch(base)).text();
  assert.match(dashboard, /\$790\.00/);
  assert.match(dashboard, /Dining/);
});

const autoStatement = '<OFX><STMTRS><CURDEF>CAD<BANKACCTFROM><BANKID>002<ACCTID>000123<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST><DTSTART>20261101<DTEND>20261115<STMTTRN><DTPOSTED>20261101<TRNAMT>-10<FITID>one<NAME>Shop</STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>90<DTASOF>20261115</LEDGERBAL></STMTRS></OFX>';
async function upload(base, statement = autoStatement, account = '') {
  const data = new FormData();
  data.set('statement', new Blob([statement]), 'statement.ofx');
  if (account) data.set('account', account);
  return fetch(base + '/import', { method: 'POST', redirect: 'manual', headers: { origin: base }, body: data });
}

test('empty installation can import through the form, repeat, and reopen with a derived balance', async (t) => {
  const { base, app, dir, databases } = await setup(t);
  const form = await (await fetch(base + '/import')).text();
  assert.match(form, /Automatically match or create/);
  assert.doesNotMatch(form, /<select name="account" required/);
  assert.equal((await upload(base)).status, 303);
  const repeat = await upload(base);
  assert.equal(repeat.status, 303);
  assert.match(decodeURIComponent(repeat.headers.get('location')), /0 new, 1 previously imported/);
  assert.match(await (await fetch(base + '/accounts')).text(), /\$90\.00/);
  await new Promise((resolve) => app.close(resolve));
  const b = new Books(join(dir, 'simplebooks.sqlite'));
  databases.push(b);
  const s = b.snapshot('2026-11-15');
  assert.equal(s.accounts.length, 1);
  assert.equal(s.transactions.length, 1);
  assert.equal(s.accounts[0].opening, 10000);
  assert.equal(b.importStatement('', (await import('../src/ofx.js')).parseStatement(autoStatement)).duplicate, 1);
});

test('unanchored upload succeeds and offers account-specific balance correction', async (t) => {
  const { base } = await setup(t);
  const response = await upload(base, autoStatement.replace(/<LEDGERBAL>.*?<\/LEDGERBAL>/, ''));
  assert.equal(response.status, 303);
  assert.match(decodeURIComponent(response.headers.get('location')), /needs a balance/i);
  const accounts = await (await fetch(base + '/accounts')).text();
  assert.match(accounts, /Needs balance/);
  assert.match(accounts, /action="\/accounts\/balance"/);
  assert.match(await (await fetch(base + '/transactions')).text(), /Shop/);
});

test('weak identity can create an account explicitly without pre-creating a balance', async (t) => {
  const { base } = await setup(t);
  const weak = autoStatement.replace('<BANKID>002', '');
  const response = await upload(base, weak);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Select an account/i);
  assert.equal((await upload(base, weak, 'new')).status, 303);
});
