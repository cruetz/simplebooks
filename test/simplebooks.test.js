import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Books } from '../src/books.js';
import { parseStatement } from '../src/ofx.js';

const statement = (rows, account = '1234', kind = 'bank') => `OFXHEADER:100
DATA:OFXSGML
<OFX><${kind === 'bank' ? 'STMTRS' : 'CCSTMTRS'}><CURDEF>CAD
<BANKID>002
<ACCTID>${account}
<BANKTRANLIST><DTSTART>20261101<DTEND>20261130
${rows.map(([id, date, amount, name, type = 'DEBIT']) => `<STMTTRN><TRNTYPE>${type}<DTPOSTED>${date}<TRNAMT>${amount}<FITID>${id}<NAME>${name}</STMTTRN>`).join('\n')}
</BANKTRANLIST></${kind === 'bank' ? 'STMTRS' : 'CCSTMTRS'}></OFX>`;

function setup(t) {
  const books = new Books(':memory:');
  t.after(() => books.close());
  books.settings({ currency: 'CAD', payday: '2026-11-20' });
  const cash = books.addAccount({ name: 'Chequing', type: 'bank', included: true, date: '2026-11-10', amount: '800' });
  const card = books.addAccount({ name: 'Credit card', type: 'card', date: '2026-11-10', amount: '0' });
  return { books, cash, card };
}

test('overlap retains separate bank IDs and respects the opening balance date', (t) => {
  const { books, cash } = setup(t);
  const a = ['one', '20261109', '-10', 'Cafe'];
  const b = ['two', '20261111', '-10', 'Cafe'];
  const c = ['three', '20261111', '-10', 'Cafe'];
  assert.equal(books.importStatement(cash, parseStatement(statement([a, b]))).added, 2);
  assert.equal(books.importStatement(cash, parseStatement(statement([b, c]))).duplicate, 1);
  assert.equal(books.importStatement(cash, parseStatement(statement([a, b, c]))).duplicate, 3);
  assert.equal(books.snapshot('2026-11-12').accounts[0].balance, 78000);
  assert.equal(books.snapshot('2026-11-12').transactions.length, 3);
  assert.deepEqual(books.unbalanced(), []);
});

test('payday projection, partial bills and repayment linked to an imported deposit', (t) => {
  const { books, cash, card } = setup(t);
  const rent = books.addBill({ name: 'Rent', amount: '200', due: '2026-11-19' });
  books.addBill({ name: 'Payday bill', amount: '90', due: '2026-11-20' });
  books.addBill({ name: 'Card statement', amount: '150', due: '2026-12-01', card });
  const loan = books.addOwed({ name: 'Alex', amount: '100' });
  assert.equal(books.snapshot('2026-11-12').projection.available, 60000);
  books.pay({ target: rent, kind: 'bill', account: cash, amount: '50', date: '2026-11-12', key: 'bill-50' });
  assert.equal(books.snapshot('2026-11-12').projection.available, 60000);
  books.importStatement(cash, parseStatement(statement([['repay', '20261112', '25', 'Alex', 'CREDIT']])));
  const [repayment] = books.snapshot('2026-11-12').transactions;
  books.pay({ target: loan, kind: 'owed', transaction: repayment.id });
  assert.equal(books.snapshot('2026-11-12').projection.available, 62500);
  assert.equal(books.snapshot('2026-11-12').owed[0].remaining, 7500);
  assert.deepEqual(books.unbalanced(), []);
});

test('card payment pairs both imported legs without a second expense', (t) => {
  const { books, cash, card } = setup(t);
  books.importStatement(cash, parseStatement(statement([['out', '20261113', '-100', 'CREDIT CARD PAYMENT', 'XFER']])));
  books.importStatement(card, parseStatement(statement([['in', '20261114', '100', 'PAYMENT THANK YOU', 'PAYMENT']], '4321', 'card')));
  const state = books.snapshot('2026-11-15');
  assert.deepEqual(state.accounts.map(({ balance }) => balance), [70000, 10000]);
  assert.equal(state.transactions.length, 1);
  assert.equal(state.transactions[0].category, 'Transfer');
  assert.deepEqual(books.unbalanced(), []);
});

test('receipt matching works in both arrival orders and skips ambiguous pairs', (t) => {
  const { books, cash } = setup(t);
  books.addReceipt({ hash: 'first', image: Buffer.from('1'), mime: 'image/png', merchant: 'Cafe', date: '2026-11-11', amount: 1000 });
  books.importStatement(cash, parseStatement(statement([
    ['one', '20261111', '-10', 'Cafe'], ['two', '20261112', '-20', 'Grocery'],
    ['three', '20261113', '-30', 'Shop'], ['four', '20261113', '-30', 'Shop']
  ])));
  books.addReceipt({ hash: 'second', image: Buffer.from('2'), mime: 'image/png', merchant: 'Grocery', date: '2026-11-12', amount: 2000 });
  books.addReceipt({ hash: 'third', image: Buffer.from('3'), mime: 'image/png', merchant: 'Shop', date: '2026-11-13', amount: 3000 });
  const state = books.snapshot('2026-11-14');
  assert.equal(state.receipts.filter((receipt) => receipt.entry).length, 2);
  assert.equal(state.receipts.find((receipt) => receipt.hash === 'third').matches.length, 2);
  assert.equal(state.transactions.length, 4);
});

test('manual purchase matched to an import keeps one movement and receipt uploads are idempotent', (t) => {
  const { books, cash } = setup(t);
  const receipt = books.addReceipt({ hash: 'receipt', image: Buffer.from('x'), mime: 'image/png', merchant: 'Cafe', date: '2026-11-12', amount: 1000 });
  assert.equal(books.addReceipt({ hash: 'receipt', image: Buffer.from('x'), mime: 'image/png', merchant: 'Cafe', date: '2026-11-12', amount: 1000 }), receipt);
  books.recordReceipt({ receipt, account: cash, key: 'purchase' });
  books.importStatement(cash, parseStatement(statement([['bank-id', '20261112', '-10', 'Cafe']])));
  const state = books.snapshot('2026-11-13');
  assert.equal(state.accounts[0].balance, 79000);
  assert.equal(state.transactions.length, 1);
  assert.equal(state.receipts[0].entry, state.transactions[0].id);
  assert.deepEqual(books.unbalanced(), []);
});

test('payments are idempotent and cannot overpay', (t) => {
  const { books, cash } = setup(t);
  const bill = books.addBill({ name: 'Internet', amount: '50', due: '2026-11-19' });
  const payment = { target: bill, kind: 'bill', account: cash, amount: '20', date: '2026-11-12', key: 'payment' };
  books.pay(payment);
  books.pay(payment);
  assert.equal(books.snapshot('2026-11-13').bills[0].remaining, 3000);
  assert.equal(books.snapshot('2026-11-13').accounts[0].balance, 78000);
  assert.throws(() => books.pay({ ...payment, key: 'other', amount: '40' }));
  assert.equal(books.snapshot('2026-11-13').accounts[0].balance, 78000);
});
