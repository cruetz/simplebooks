import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStatement } from '../src/ofx.js';
import { extractReceipt, parseReceiptText, validateReceiptImage } from '../src/receipts.js';

const sgml = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
ENCODING:USASCII
CHARSET:1252

<OFX><SIGNONMSGSRSV1><SONRS><FI><ORG>Banque du Nord<FID>0001</FI></SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>CAD
<BANKACCTFROM><BANKID>0002<ACCTID>00031234<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20261101000000[-7:MST]<DTEND>20261113235959.123 [-7:MST]
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261112<TRNAMT>-10.10<FITID>one<NAME>Café &amp; Marché<MEMO>Store 2</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261112<TRNAMT>-10,10<FITID>two<NAME>Café &amp; Marché</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>123.4000<DTASOF>20261113</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

const card = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="211"?>
<OFX><SIGNONMSGSRSV1><SONRS><FI><FID>123</FID></FI></SONRS></SIGNONMSGSRSV1>
<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>
<CURDEF>CAD</CURDEF><CCACCTFROM><ACCTID>0000000000001234</ACCTID></CCACCTFROM>
<BANKTRANLIST>
<STMTTRN><DTPOSTED>20261112</DTPOSTED><TRNAMT>-20</TRNAMT><FITID>purchase</FITID><NAME>Shop &#x26; Café</NAME></STMTTRN>
<STMTTRN><TRNTYPE>PAYMENT</TRNTYPE><DTPOSTED>20261113</DTPOSTED><TRNAMT>+15.50</TRNAMT><FITID>payment</FITID><NAME><![CDATA[PAYMENT <THANKS>]]></NAME></STMTTRN>
<STMTTRN><FITID>delete-1</FITID><CORRECTFITID>earlier</CORRECTFITID><CORRECTACTION>DELETE</CORRECTACTION></STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>-4.50</BALAMT><DTASOF>20261113</DTASOF></LEDGERBAL>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;

test('parses SGML bank statements with CP1252, stable identities, and exact cents', () => {
  const statement = parseStatement(Buffer.from(sgml, 'latin1'));
  assert.deepEqual(statement, {
    kind: 'bank', institution: '0002', account: '00031234', currency: 'CAD',
    institutionKind: 'BANKID', organization: 'Banque du Nord', branch: '', accountType: 'CHECKING', balanceCoverage: false,
    start: '2026-11-01', end: '2026-11-13', balance: { amount: 12340, date: '2026-11-13' },
    transactions: [
      { id: 'one', date: '2026-11-12', amount: -1010, name: 'Café & Marché', memo: 'Store 2', type: 'DEBIT' },
      { id: 'two', date: '2026-11-12', amount: -1010, name: 'Café & Marché', memo: '', type: 'DEBIT' }
    ]
  });
});

test('parses XML QFX credit card signs, text entities, corrections, and fallback date range', () => {
  const statement = parseStatement(Buffer.from(card));
  assert.deepEqual(statement, {
    kind: 'card', institution: '123', account: '0000000000001234', currency: 'CAD',
    institutionKind: 'FID', organization: '', branch: '', accountType: '', balanceCoverage: false,
    start: '2026-11-12', end: '2026-11-13', balance: { amount: -450, date: '2026-11-13' },
    transactions: [
      { id: 'purchase', date: '2026-11-12', amount: -2000, name: 'Shop & Café', memo: '', type: '' },
      { id: 'payment', date: '2026-11-13', amount: 1550, name: 'PAYMENT <THANKS>', memo: '', type: 'PAYMENT' },
      { id: 'delete-1', date: '', amount: 0, name: '', memo: '', type: '', correctId: 'earlier', correctAction: 'DELETE' }
    ]
  });
});

test('reads a balance-only statement without treating available credit as the ledger balance', () => {
  const statement = parseStatement('<OFX><CCSTMTRS><CURDEF>CAD<ACCTID>1234<AVAILBAL><BALAMT>9999<DTASOF>20261113</AVAILBAL></CCSTMTRS></OFX>');
  assert.equal(statement.balance, null);
  assert.deepEqual(statement.transactions, []);
});

test('rejects malformed or unsafe statement data before financial state can change', () => {
  const examples = [
    [sgml.replace('</STMTTRN>', ''), /structure/i],
    [sgml.replace('</BANKTRANLIST>', ''), /structure/i],
    [sgml.replace('</OFX>', ''), /structure/i],
    [sgml.replace('<FITID>one', ''), /transaction ID/i],
    [sgml.replace('<DTPOSTED>20261112', '<DTPOSTED>20260230'), /date/i],
    [sgml.replace('<DTSTART>20261101', '<DTSTART>20261120'), /range/i],
    [sgml.replace('<CURDEF>CAD', '<CURDEF>XX1'), /currency/i],
    [sgml.replace('<CURDEF>CAD', '<CURDEF>QQQ'), /currency/i],
    [sgml.replace('<TRNAMT>-10.10', '<TRNAMT>-10.101'), /amount/i],
    [sgml.replace('<TRNAMT>-10.10', '<TRNAMT>90071992547409.92'), /amount/i],
    [sgml.replace('<ACCTID>00031234', '<ACCTID>'), /account/i],
    [card.replace('<CORRECTFITID>earlier</CORRECTFITID>', ''), /correction/i],
    [card.replace('</CCSTMTRS>', '</CCSTMTRS><CCSTMTRS></CCSTMTRS>'), /one account/i],
    [card.replace('<OFX>', '<!DOCTYPE OFX [<!ENTITY x SYSTEM "file:///tmp/example">]><OFX>'), /declaration/i]
  ];
  for (const [input, error] of examples) assert.throws(() => parseStatement(input), error);
});

test('reads the merchant, purchase date, and final total without using subtotal, tender, or change', () => {
  assert.deepEqual(parseReceiptText(`CUSTOMER COPY
NO. 523654
Northside Market
123 Center Street
11/13/2026 04:35 PM
Subtotal $49.99
TOTAL SAVINGS 3.00
Tax $2.50
GRAND TOTAL
$52.49 CAD
Cash $60.00
CHANGE DUE $7.51`), {
    merchant: 'Northside Market', date: '2026-11-13', total: 5249
  });
});

test('leaves unreadable or conflicting receipt fields for manual entry', () => {
  assert.deepEqual(parseReceiptText(`RECEIPT
Subtotal 12.00
TOTAL TAX 0.60
Total 12.60
Total 14.00
02/30/2026
Thank you!`), {
    merchant: '', date: '', total: null
  });
});

test('leaves ambiguous month and day ordering for manual entry', () => {
  assert.equal(parseReceiptText('Northside Market\n11/05/26\nTotal 3.50').date, '');
});

const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ff7sAAAAASUVORK5CYII=',
  'base64'
);
const onePixelWebp = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAgA0JaQAA3AA/vuUAAA=', 'base64');
const onePixelJpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAA/AL8Af//Z',
  'base64'
);

test('identifies bounded PNG, JPEG, and WebP images by their bytes', () => {
  assert.deepEqual(validateReceiptImage(onePixelPng), { extension: 'png', contentType: 'image/png', width: 1, height: 1 });
  assert.deepEqual(validateReceiptImage(onePixelJpeg), { extension: 'jpg', contentType: 'image/jpeg', width: 1, height: 1 });
  assert.deepEqual(validateReceiptImage(onePixelWebp), { extension: 'webp', contentType: 'image/webp', width: 1, height: 1 });
});

test('rejects mislabeled, truncated, and oversized receipt images', () => {
  assert.throws(() => validateReceiptImage(Buffer.from('<svg></svg>')), /JPEG, PNG, or WebP/);
  assert.throws(() => validateReceiptImage(onePixelPng.subarray(0, 24)), /incomplete|invalid/i);
  const enormousPng = Buffer.from(onePixelPng);
  enormousPng.writeUInt32BE(1000000, 16);
  assert.throws(() => validateReceiptImage(enormousPng), /dimensions/i);
});

test('OCR with no readable text leaves fields editable and reports a warning', async () => {
  const result = await extractReceipt(onePixelPng);
  assert.deepEqual({ merchant: result.merchant, date: result.date, total: result.total },
    { merchant: '', date: '', total: null });
  assert.equal(typeof result.warning, 'string');
  assert.ok(result.warning.length);
});
