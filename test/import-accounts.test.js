import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Books } from '../src/books.js';
import { parseStatement } from '../src/ofx.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function statement({ kind = 'bank', institution = '002', organization = 'Example Bank', account = '000123', branch = '001', subtype = 'CHECKING', start = '20261101', end = '20261130', balanceDate = end, balance = '90', rows = [['one', '20261101', '-10']], ledger = true } = {}) {
  const tag = kind === 'card' ? 'CCSTMTRS' : 'STMTRS';
  return parseStatement(`<OFX><SIGNONMSGSRSV1><SONRS><FI><ORG>${organization}<FID>${institution}</FI></SONRS></SIGNONMSGSRSV1><${tag}><CURDEF>CAD<${kind === 'card' ? 'CCACCTFROM' : 'BANKACCTFROM'}><BANKID>${institution}<BRANCHID>${branch}<ACCTTYPE>${subtype}<ACCTID>${account}</${kind === 'card' ? 'CCACCTFROM' : 'BANKACCTFROM'}><BANKTRANLIST>${start ? `<DTSTART>${start}` : ''}${end ? `<DTEND>${end}` : ''}${rows.map(([id, day, amount]) => `<STMTTRN><FITID>${id}<DTPOSTED>${day}<TRNAMT>${amount}<NAME>Shop</STMTTRN>`).join('')}</BANKTRANLIST>${ledger ? `<LEDGERBAL><BALAMT>${balance}<DTASOF>${balanceDate}</LEDGERBAL>` : ''}</${tag}></OFX>`);
}
function setup(t) {
  const b = new Books(':memory:');
  t.after(() => b.close());
  return b;
}

test('first upload creates a bank account and derives a balance before the first transaction day', (t) => {
  const b = setup(t);
  const result = b.importStatement('', statement());
  const a = b.snapshot('2026-11-30').accounts[0];
  assert.equal(result.created, true);
  assert.equal(a.id, result.account);
  assert.equal(a.included, true);
  assert.equal(a.opening, 10000);
  assert.equal(a.opening_date, '2026-10-31');
  assert.equal(a.balance, 9000);
  assert.equal(b.snapshot('2026-11-01').accounts[0].balance, 9000);
  assert.deepEqual(b.unbalanced(), []);
});

test('card debit signs and repeated rows produce one opening and one purchase', (t) => {
  const b = setup(t);
  const s = statement({ kind: 'card', balance: '-30', rows: [['one', '20261101', '-10'], ['one', '20261101', '-10']] });
  const r = b.importStatement('', s);
  assert.equal(r.duplicate, 1);
  const a = b.snapshot('2026-11-30').accounts[0];
  assert.equal(a.opening, -2000);
  assert.equal(a.balance, -3000);
  assert.equal(a.included, false);
});

test('automatic repeat, overlap, and older history preserve the established baseline', (t) => {
  const b = setup(t);
  const first = b.importStatement('', statement());
  assert.equal(b.importStatement('', statement()).duplicate, 1);
  const later = b.importStatement('', statement({ end: '20261202', balance: '85', rows: [['one', '20261101', '-10'], ['two', '20261202', '-5']] }));
  assert.equal(later.account, first.account);
  assert.equal(later.added, 1);
  b.importStatement('', statement({ start: '20261001', end: '20261031', balance: '100', rows: [['old', '20261002', '-50']] }));
  const s = b.snapshot('2026-12-02');
  assert.equal(s.accounts.length, 1);
  assert.equal(s.transactions.length, 3);
  assert.equal(s.accounts[0].opening, 10000);
  assert.equal(s.accounts[0].opening_date, '2026-10-31');
  assert.equal(s.accounts[0].balance, 8500);
  assert.deepEqual(b.unbalanced(), []);
});

test('identity includes institution, full account ID, kind, branch, and bank subtype', (t) => {
  const b = setup(t);
  for (const options of [{}, { institution: '003' }, { account: '123' }, { kind: 'card' }, { branch: '002' }, { subtype: 'SAVINGS' }]) {
    b.importStatement('', statement(options));
  }
  assert.equal(b.snapshot('2026-11-30').accounts.length, 6);
});

test('weak identity requires a deliberate destination and never silently matches', (t) => {
  const b = setup(t);
  for (const options of [{ institution: '' }, { account: 'XXXX1234' }]) {
    const s = statement(options);
    assert.throws(() => b.importStatement('', s), /select.*account/i);
    const result = b.importStatement('new', s);
    assert.throws(() => b.importStatement('', s), /select.*account/i);
    assert.equal(b.importStatement(result.account, s).duplicate, 1);
  }
  assert.equal(b.snapshot('2026-11-30').accounts.length, 2);
});

test('explicit mapping preserves a manual balance and refuses conflicting destinations', (t) => {
  const b = setup(t);
  const a = b.addAccount({ name: 'My bank', type: 'bank', amount: '200', date: '2026-10-31' });
  b.importStatement(a, statement());
  assert.equal(b.importStatement('', statement()).account, a);
  assert.equal(b.snapshot('2026-11-30').accounts[0].balance, 19000);
  assert.throws(() => b.importStatement(a, statement({ branch: '002' })), /different statement account/i);
  const other = b.addAccount({ name: 'Other', type: 'bank' });
  assert.throws(() => b.importStatement(other, statement()), /already.*mapped/i);
});

test('legacy mappings require one explicit confirmation before automatic matching', (t) => {
  const b = setup(t);
  const a = b.addAccount({ name: 'Legacy', type: 'bank', amount: '100', date: '2026-10-31' });
  b.run('UPDATE accounts SET institution=?,source_account=? WHERE id=?', '002', '000123', a);
  assert.throws(() => b.importStatement('', statement()), /select.*account/i);
  b.importStatement(a, statement());
  assert.equal(b.importStatement('', statement()).account, a);
  assert.equal(b.account(a).opening, 10000);
});

test('missing or insufficient ledger coverage imports activity with an unresolved balance', (t) => {
  const b = setup(t);
  const cases = [
    { ledger: false }, { start: '' }, { end: '', balanceDate: '20261130' },
    { balanceDate: '20261201' }, { balanceDate: '20261115' },
    { balanceDate: '20261130120000' }, { start: '20261101120000' },
    { rows: [['one', '20261031', '-10']] },
  ];
  for (const [i, options] of cases.entries()) {
    const r = b.importStatement('', statement({ ...options, account: String(i) }));
    assert.equal(r.needsBalance, true);
    assert.equal(b.account(r.account).opening, null);
    assert.equal(r.added, 1);
  }
  assert.equal(b.snapshot('2026-12-01').transactions.length, cases.length);
  assert.equal(b.snapshot('2026-12-01').projection.needsBalance, true);
});

test('an unresolved account can receive a later supported anchor or a manual correction', (t) => {
  const b = setup(t);
  const r = b.importStatement('', statement({ ledger: false }));
  assert.equal(b.importStatement('', statement()).needsBalance, false);
  assert.equal(b.account(r.account).opening, 10000);
  const other = b.importStatement('', statement({ account: 'other', ledger: false }));
  b.setBalance({ account: other.account, amount: '90', date: '2026-11-30' });
  assert.equal(b.snapshot('2026-11-30').accounts[1].balance, 9000);
});

test('extra existing activity in the covered range prevents an unsupported automatic balance', (t) => {
  const b = setup(t);
  const a = b.addAccount({ name: 'Existing', type: 'bank' });
  b.addTransaction({ account: a, name: 'Cash purchase', date: '2026-11-02', amount: '-7', key: 'cash' });
  b.importStatement(a, statement());
  assert.equal(b.account(a).opening, null);
  assert.equal(b.snapshot('2026-11-30').transactions.length, 2);
});

test('invalid imports roll back auto-created accounts and conflicting FITIDs cannot alter balances', (t) => {
  const b = setup(t);
  const bad = statement();
  bad.transactions[0].amount = 0.1;
  assert.throws(() => b.importStatement('', bad), /integer/);
  assert.equal(b.snapshot('2026-11-30').accounts.length, 0);
  const r = b.importStatement('', statement());
  assert.throws(() => b.importStatement('', statement({ rows: [['one', '20261101', '-20']] })), /transaction ID.*conflict/i);
  assert.equal(b.snapshot('2026-11-30').accounts[0].balance, 9000);
  assert.equal(b.account(r.account).opening, 10000);
});

test('a retried explicit new-account submission cannot duplicate a weakly identified account', (t) => {
  const b = setup(t);
  const s = statement({ institution: '' });
  const first = b.importStatement('new', s, { key: 'upload-1' });
  assert.equal(b.importStatement('new', s, { key: 'upload-1' }).account, first.account);
  assert.equal(b.snapshot('2026-11-30').accounts.length, 1);
  assert.equal(b.snapshot('2026-11-30').transactions.length, 1);
  assert.throws(() => b.importStatement('new', statement(), { key: 'upload-1' }), /different details/);
});

test('missing identity components cannot silently create another copy of a mapped account', (t) => {
  const b = setup(t);
  const a = b.importStatement('', statement({ branch: '' })).account;
  assert.throws(() => b.importStatement('', statement()), /select.*account/i);
  assert.equal(b.snapshot('2026-11-30').accounts.length, 1);
  // Explicit confirmation can add missing identity detail, but cannot change it.
  assert.equal(b.importStatement(a, statement()).duplicate, 1);
  assert.equal(b.importStatement('', statement()).account, a);
  assert.throws(() => b.importStatement(a, statement({ branch: '002' })), /different statement account/i);
  assert.throws(() => b.importStatement('', statement({ branch: '' })), /select.*account/i);
});

test('an exact match is still ambiguous when another account has compatible incomplete details', (t) => {
  const b = setup(t);
  const first = b.importStatement('', statement({ branch: '' })).account;
  b.importStatement('new', statement());
  assert.throws(() => b.importStatement('', statement({ branch: '' })), /select.*account/i);
  assert.equal(b.importStatement(first, statement({ branch: '' })).duplicate, 1);
});

test('the additive migration preserves legacy money, IDs, and deduplication across restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'simplebooks-migration-'));
  let b;
  try {
    const path = join(dir, 'test.sqlite');
    b = new Books(path);
    const a = b.addAccount({ name: 'Legacy', type: 'bank', amount: '100', date: '2026-10-31' });
    b.importStatement(a, statement());
    // Reproduce the deployed schema, with real balanced entries and imports.
    b.db.exec('DROP INDEX account_identity; ALTER TABLE accounts DROP COLUMN source_identity; CREATE UNIQUE INDEX account_source ON accounts(institution,source_account,type) WHERE source_account IS NOT NULL');
    b.close();
    b = new Books(path);
    assert.equal(b.snapshot('2026-11-30').accounts[0].balance, 9000);
    assert.throws(() => b.importStatement('', statement()), /select.*account/i);
    assert.equal(b.importStatement(a, statement()).duplicate, 1);
    b.close();
    b = new Books(path);
    assert.equal(b.importStatement('', statement()).duplicate, 1);
    assert.equal(b.snapshot('2026-11-30').accounts[0].balance, 9000);
    assert.deepEqual(b.unbalanced(), []);
  } finally {
    b?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('corrections, mismatched IDs within one file, and overflowing totals cannot invent an opening', (t) => {
  const b = setup(t);
  const corrected = statement();
  corrected.transactions.push({ id: 'fix', correctId: 'one', correctAction: 'DELETE' });
  const r = b.importStatement('', corrected);
  assert.equal(r.flagged, 1);
  assert.equal(b.account(r.account).opening, null);
  assert.throws(() => b.importStatement('', statement({ account: 'other', rows: [['same', '20261101', '-10'], ['same', '20261101', '-20']] })), /transaction ID.*conflict/i);
  const huge = statement({ account: 'huge', balance: '90071992547409.91' });
  const large = b.importStatement('', huge);
  assert.equal(b.account(large.account).opening, null);
});

test('FID account identity is scoped by organization and missing namespaces require confirmation', (t) => {
  const b = setup(t);
  const a = b.importStatement('', statement({ kind: 'card', organization: 'Issuer A' })).account;
  const c = b.importStatement('', statement({ kind: 'card', organization: 'Issuer B' })).account;
  assert.notEqual(a, c);
  assert.equal(b.snapshot('2026-11-30').accounts.length, 2);
  assert.throws(() => b.importStatement('', statement({ kind: 'card', organization: '' })), /select.*account/i);
});

test('exclusive end and midnight ledger boundaries must cover every imported date', (t) => {
  const b = setup(t);
  const cases = [
    { end: '20261130', balanceDate: '20261130235959' },
    { rows: [['end-day', '20261130', '-10']] },
    { start: '20261101000000[-7:MST]', end: '20261130000000[-7:MST]', balanceDate: '20261130000000[0:GMT]' },
    { rows: [['zone', '20261101000000[7:ZONE]', '-10']] },
  ];
  for (const [i, options] of cases.entries()) {
    const r = b.importStatement('', statement({ ...options, account: `boundary-${i}` }));
    assert.equal(r.needsBalance, true);
    assert.equal(r.added, 1);
  }
  const r = b.importStatement('', statement({ account: 'midnight', start: '20261101000000[-7:MST]',
    end: '20261130000000[-7:MST]', balanceDate: '20261130000000[-7:MST]', rows: [['one', '20261101120000[-7:MST]', '-10']] }));
  assert.equal(b.account(r.account).opening, 10000);
  assert.equal(b.account(r.account).opening_date, '2026-10-31');
});
