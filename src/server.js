import http from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Books } from "./books.js";
import { parseStatement } from "./ofx.js";
import { validateReceiptImage, extractReceipt } from "./receipts.js";
import { renderPage } from "./views.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const css = readFileSync(join(root, "public/style.css"));
const maxBody = 13 * 1024 * 1024;
function reply(
  res,
  status,
  body,
  type = "text/plain; charset=utf-8",
  headers = {},
) {
  res.writeHead(status, {
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...headers,
  });
  res.end(body);
}
function originAllowed(req) {
  const origin = req.headers.origin;
  if (
    !origin ||
    origin === "null" ||
    req.headers["sec-fetch-site"] === "cross-site"
  )
    return false;
  try {
    const u = new URL(origin);
    return (
      ["http:", "https:"].includes(u.protocol) &&
      u.host === req.headers.host &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}
async function readForm(req) {
  const length = Number(req.headers["content-length"] || 0);
  if (length > maxBody) throw new Error("Upload is too large");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) throw new Error("Upload is too large");
    chunks.push(chunk);
  }
  const type = req.headers["content-type"] || "";
  if (
    !/^application\/x-www-form-urlencoded(?:;|$)/i.test(type) &&
    !/^multipart\/form-data\s*;/i.test(type)
  )
    throw new Error("Unsupported form encoding");
  const request = new Request("http://localhost/", {
    method: "POST",
    headers: { "content-type": type },
    body: Buffer.concat(chunks),
  });
  return request.formData();
}
function decimalCents(v) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(v))
    throw new Error("Enter a valid receipt total");
  const [whole, fraction = ""] = v.split(".");
  const n = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new Error("Enter a valid receipt total");
  return n;
}
export function createApp({
  dataDir = process.env.DATA_DIR || join(root, "data"),
} = {}) {
  mkdirSync(dataDir, { recursive: true });
  const books = new Books(join(dataDir, "simplebooks.sqlite"));
  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
      if (!req.url.startsWith("/") || req.url.startsWith("//"))
        throw new Error("Invalid target");
    } catch {
      return reply(res, 400, "Invalid request target");
    }
    const path = url.pathname;
    let data;
    try {
      if (req.method === "GET" && path === "/style.css")
        return reply(res, 200, css, "text/css; charset=utf-8");
      const image = path.match(/^\/receipts\/([a-f0-9-]+)\/image$/i);
      if (req.method === "GET" && image) {
        const receipt = books.receiptImage(image[1]);
        if (!["image/jpeg", "image/png", "image/webp"].includes(receipt.mime))
          return reply(res, 404, "Not found");
        return reply(res, 200, receipt.image, receipt.mime, {
          "Cache-Control": "private, no-store",
          "Content-Disposition": "inline",
        });
      }
      if (req.method === "GET") {
        const html = renderPage(path, books.snapshot(), {
          message: url.searchParams.get("message"),
          error: url.searchParams.get("error"),
        });
        return html
          ? reply(res, 200, html, "text/html; charset=utf-8", {
              "Cache-Control": "no-store",
            })
          : reply(res, 404, "Not found");
      }
      if (req.method !== "POST") return reply(res, 405, "Method not allowed");
      if (!originAllowed(req)) return reply(res, 403, "Invalid request origin");
      data = await readForm(req);
      const get = (k) => {
        const v = data.get(k);
        return typeof v === "string" ? v.trim() : "";
      };
      let target = path,
        message = "Saved.";
      switch (path) {
        case "/settings":
          books.settings({ payday: get("payday") });
          message = "Payday updated.";
          break;
        case "/accounts":
          books.addAccount({
            name: get("name"),
            key: get("key"),
            type: get("type"),
            included: get("included") === "on",
            amount: get("amount"),
            date: get("date"),
          });
          message = "Account added.";
          break;
        case "/accounts/update":
          books.updateAccount({
            account: get("account"),
            included: get("included") === "on",
          });
          target = "/accounts";
          message = "Account updated.";
          break;
        case "/accounts/balance":
          books.setBalance({
            account: get("account"),
            amount: get("amount"),
            date: get("date"),
          });
          target = "/accounts";
          message = "Starting balance updated.";
          break;
        case "/transactions":
          books.addTransaction({
            account: get("account"),
            name: get("name"),
            date: get("date"),
            amount: get("amount"),
            category: get("category"),
            key: get("key"),
          });
          message = "Transaction added.";
          break;
        case "/transactions/manual-match":
          books.linkManual({ review: get("review"), manual: get("manual") });
          target = "/transactions";
          message = "Transactions linked.";
          break;
        case "/transactions/manual-dismiss":
          books.dismissManualReview({ review: get("review") });
          target = "/transactions";
          message = "Review dismissed.";
          break;
        case "/transactions/correction":
          books.resolveCorrection({ correction: get("correction") });
          target = "/transactions";
          message = "Correction applied.";
          break;
        case "/transactions/transfer":
          books.linkTransfer({ first: get("first"), second: get("second") });
          target = "/transactions";
          message = "Transfer linked.";
          break;
        case "/transactions/category":
          books.categorize({
            transaction: get("transaction"),
            category: get("category"),
          });
          target = "/transactions";
          message = "Category updated.";
          break;
        case "/bills":
          books.addBill({
            key: get("key"),
            name: get("name"),
            amount: get("amount"),
            due: get("due"),
            card: get("card"),
            recurrence: get("recurring") === "on" ? "monthly" : null,
          });
          message = "Bill added.";
          break;
        case "/owed":
          books.addOwed({
            key: get("key"),
            name: get("name"),
            amount: get("amount"),
            due: get("due"),
            source: get("transaction"),
          });
          message = "Amount owed added.";
          break;
        case "/payments": {
          const kind = get("kind");
          books.pay({
            kind,
            target: get("target"),
            transaction: get("transaction") || undefined,
            account: get("account"),
            amount: get("amount"),
            date: get("date"),
            key: get("key"),
          });
          target = kind === "bill" ? "/bills" : "/owed";
          message = "Payment recorded.";
          break;
        }
        case "/import": {
          const file = data.get("statement");
          if (!file || typeof file === "string" || !file.size)
            throw new Error("Choose a statement file");
          const parsed = parseStatement(Buffer.from(await file.arrayBuffer()));
          const result = books.importStatement(get("account"), parsed, {
            applyBalance: get("applyBalance") === "on",
          });
          message = `Imported ${result.added} new, ${
            result.duplicate
          } previously imported, and ${result.flagged} flagged transactions (${
            result.start || "unknown date"
          } to ${result.end || "unknown date"}).`;
          break;
        }
        case "/receipts": {
          const file = data.get("receipt");
          if (!file || typeof file === "string" || !file.size)
            throw new Error("Choose a receipt image");
          const image = Buffer.from(await file.arrayBuffer());
          const info = validateReceiptImage(image);
          const result = await extractReceipt(image);
          books.addReceipt({
            hash: createHash("sha256").update(image).digest("hex"),
            image,
            mime: info.contentType,
            merchant: result.merchant,
            date: result.date,
            amount: result.total,
          });
          message = result.warning
            ? `Receipt saved. ${result.warning}`
            : "Receipt saved. Review its details below.";
          break;
        }
        case "/receipts/update":
          books.updateReceipt({
            receipt: get("receipt"),
            merchant: get("merchant"),
            date: get("date"),
            amount: get("amount") ? decimalCents(get("amount")) : null,
            category: get("category"),
          });
          target = "/receipts";
          message = "Receipt details updated.";
          break;
        case "/receipts/link":
          books.linkReceipt({
            receipt: get("receipt"),
            transaction: get("transaction"),
          });
          target = "/receipts";
          message = "Receipt attached.";
          break;
        case "/receipts/record":
          books.recordReceipt({
            receipt: get("receipt"),
            account: get("account"),
            key: get("key"),
          });
          target = "/receipts";
          message = "Purchase recorded.";
          break;
        default:
          return reply(res, 404, "Not found");
      }
      res.writeHead(303, {
        Location: `${target}?message=${encodeURIComponent(message)}`,
        "Cache-Control": "no-store",
      });
      res.end();
    } catch (error) {
      if (req.method === "POST") {
        const fallback = path.startsWith("/receipts")
          ? "/receipts"
          : path === "/payments"
          ? data?.get("kind") === "owed"
            ? "/owed"
            : "/bills"
          : path.startsWith("/transactions/")
          ? "/transactions"
          : path.startsWith("/accounts/")
          ? "/accounts"
          : path;
        const html = renderPage(fallback, books.snapshot(), {
          error: error.message || "Something went wrong.",
        });
        return reply(
          res,
          400,
          html || "Invalid request",
          html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
        );
      }
      return reply(res, 404, "Not found");
    }
  });
  server.on("close", () => books.close());
  return server;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = createApp();
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 3000);
  server.listen(port, host, () =>
    console.log(`SimpleBooks listening on http://${host}:${port}`),
  );
}
