import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.js";

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "simplebooks-web-"));
  const app = createApp({ dataDir: dir });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  t.after(async () => {
    if (app.listening) await new Promise((resolve) => app.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  return { base, app, dir };
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
  const { base, app, dir } = await setup(t);
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
  t.after(() => new Promise((resolve) => reopened.close(resolve)));
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
