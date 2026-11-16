export const MAX_STATEMENT_BYTES = 12 * 1024 * 1024;

const currencies = new Set(Intl.supportedValuesOf('currency'));
const aggregates = new Set([
  'OFX', 'STMTRS', 'CCSTMTRS', 'BANKTRANLIST', 'STMTTRN', 'BANKACCTFROM',
  'CCACCTFROM', 'LEDGERBAL', 'AVAILBAL', 'FI', 'PAYEE', 'STATUS'
]);
const emptySgmlFields = new Set([
  'ACCTID', 'BANKID', 'BRANCHID', 'ACCTTYPE', 'FID', 'ORG', 'INTU.BID', 'CURDEF',
  'DTSTART', 'DTEND', 'DTPOSTED', 'DTASOF', 'BALAMT', 'TRNAMT', 'FITID', 'NAME',
  'MEMO', 'TRNTYPE', 'CORRECTFITID', 'CORRECTACTION'
]);

function statementText(input) {
  if (typeof input !== 'string' && !Buffer.isBuffer(input)) {
    throw new Error('Choose an OFX or QFX statement.');
  }
  if ((Buffer.isBuffer(input) ? input.length : Buffer.byteLength(input)) > MAX_STATEMENT_BYTES) {
    throw new Error('Choose a statement under 12 MB.');
  }
  if (typeof input === 'string') return input;
  if (input[0] === 0xff && input[1] === 0xfe) return new TextDecoder('utf-16le').decode(input);
  if (input[0] === 0xfe && input[1] === 0xff) return new TextDecoder('utf-16be').decode(input);
  const header = input.toString('latin1', 0, 1024);
  const charset = header.match(/^CHARSET\s*:\s*([\w-]+)/im)?.[1] ??
    header.match(/<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i)?.[1];
  if (/^(1252|windows-1252|iso-8859-1)$/i.test(charset)) {
    return new TextDecoder('windows-1252').decode(input);
  }
  try {
    return new TextDecoder(charset?.toUpperCase() === '65001' ? 'utf-8' : charset ?? 'utf-8', {
      fatal: true
    }).decode(input);
  } catch {
    return new TextDecoder('windows-1252').decode(input);
  }
}

function entities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (original, entity) => {
    const lower = entity.toLowerCase();
    if (!lower.startsWith('#')) return named[lower];
    const point = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number(lower.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point) : original;
  });
}

function invalidStructure() {
  return new Error('The OFX/QFX statement structure is incomplete or invalid.');
}

function parseTree(input) {
  const rootIndex = input.search(/<OFX\s*>/i);
  if (rootIndex < 0) throw new Error('Choose an OFX or QFX bank or credit card statement.');
  const preamble = input.slice(0, rootIndex);
  const xml = /<\?xml\b|OFXHEADER\s*=\s*["']200["']/i.test(preamble);
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(preamble)) throw new Error('Unsupported OFX declaration.');
  if (preamble
    .replace(/<\?(?:xml|OFX)\b[\s\S]*?\?>|<!--[\s\S]*?-->/gi, '')
    .replace(/^[A-Z][A-Z0-9.]*[ \t]*:[^\r\n<]*$/gim, '').trim()) throw invalidStructure();

  const stack = [];
  let root;
  let offset = rootIndex;
  let count = 0;
  const body = input.slice(rootIndex);
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Z][A-Z0-9_.-]*\s*\/?>|[^<]+/gi;
  for (const match of body.matchAll(tokens)) {
    const [token] = match;
    if (match.index + rootIndex !== offset) throw invalidStructure();
    offset += token.length;
    let current = stack.at(-1);
    if (token.startsWith('<!--')) continue;
    if (token.startsWith('<![CDATA[')) {
      if (!current || current.children.length || aggregates.has(current.tag)) throw invalidStructure();
      current.text += token.slice(9, -3);
      continue;
    }
    if (!token.startsWith('<')) {
      if (current && !current.children.length && !aggregates.has(current.tag)) {
        current.text += entities(token);
      } else if (token.trim()) {
        throw invalidStructure();
      }
      continue;
    }
    const tag = token.match(/[A-Z][A-Z0-9_.-]*/i)[0].toUpperCase();
    const closing = token.startsWith('</');

    // OFX 1.x allows omitted end tags for values, but aggregate boundaries are mandatory.
    const implicitClose = !xml && current && !current.children.length && !aggregates.has(current.tag)
      && (current.text.trim() || emptySgmlFields.has(current.tag));
    if (implicitClose && (!closing || current.tag !== tag)) {
      stack.pop();
      current = stack.at(-1);
    }
    if (closing) {
      if (current?.tag !== tag || token.endsWith('/>')) throw invalidStructure();
      stack.pop();
      continue;
    }
    if (current?.text.trim()) throw invalidStructure();
    if (++count > 300000 || stack.length > 64) throw invalidStructure();
    const node = { tag, text: '', children: [] };
    if (current) current.children.push(node);
    else if (root || tag !== 'OFX') throw invalidStructure();
    else root = node;
    if (!token.endsWith('/>')) stack.push(node);
  }
  if (!root || stack.length || offset !== input.length) throw invalidStructure();
  return root;
}

function findAll(node, tags, found = []) {
  if (tags.includes(node.tag)) found.push(node);
  for (const child of node.children) findAll(child, tags, found);
  return found;
}

function child(node, tag) {
  return node?.children.find((element) => element.tag === tag);
}

function value(node, tag) {
  return child(node, tag)?.text.trim() ?? '';
}

function date(value, label) {
  const parts = value.match(/^(\d{4})(\d{2})(\d{2})(?:(?:[01]\d|2[0-3])(?:[0-5]\d)(?:[0-5]\d|60)(?:\.\d+)?)?(?:\s*\[[+-]?\d{1,2}(?:\.\d+)?(?::[^\[\]]+)?\])?$/);
  const iso = parts && `${parts[1]}-${parts[2]}-${parts[3]}`;
  const parsed = iso && new Date(`${iso}T00:00:00Z`);
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    throw new Error(`The statement contains an invalid or missing ${label} date.`);
  }
  return iso;
}

function amount(value) {
  const parts = value.match(/^([+-]?)(?=\d|[.,]\d)(\d*)(?:[.,](\d*))?$/);
  const fraction = parts?.[3] ?? '';
  if (!parts || /[1-9]/.test(fraction.slice(2)) || value.length > 32) {
    throw new Error('The statement contains an invalid amount.');
  }
  const minor = Number(parts[2]) * 100 + Number(fraction.slice(0, 2).padEnd(2, '0'));
  if (!Number.isSafeInteger(minor)) throw new Error('The statement contains an invalid amount.');
  return parts[1] === '-' && minor !== 0 ? -minor : minor;
}

function parseTransaction(node) {
  const id = value(node, 'FITID');
  if (!id) throw new Error('The statement contains a transaction without a transaction ID.');
  const correctId = value(node, 'CORRECTFITID');
  const correctAction = value(node, 'CORRECTACTION').toUpperCase();
  if ((correctId || correctAction) && (!correctId || !['REPLACE', 'DELETE'].includes(correctAction))) {
    throw new Error('The statement contains an incomplete transaction correction.');
  }
  const posted = value(node, 'DTPOSTED');
  const transactionAmount = value(node, 'TRNAMT');
  const deletion = correctAction === 'DELETE';
  return {
    id,
    date: deletion && !posted ? '' : date(posted, 'transaction'),
    amount: deletion && !transactionAmount ? 0 : amount(transactionAmount),
    name: value(node, 'NAME') || value(child(node, 'PAYEE'), 'NAME'),
    memo: value(node, 'MEMO'),
    type: value(node, 'TRNTYPE').toUpperCase(),
    ...(correctId ? { correctId, correctAction } : {})
  };
}

export function parseStatement(input) {
  const root = parseTree(statementText(input));
  const statements = findAll(root, ['STMTRS', 'CCSTMTRS']);
  if (!statements.length) throw new Error('The file does not contain an OFX/QFX bank or credit card statement.');
  if (statements.length !== 1) throw new Error('Export a statement for one account at a time.');

  const [statement] = statements;
  const kind = statement.tag === 'STMTRS' ? 'bank' : 'card';
  const currency = value(statement, 'CURDEF').toUpperCase();
  if (!currencies.has(currency) || new Intl.NumberFormat('en', { style: 'currency', currency })
    .resolvedOptions().maximumFractionDigits !== 2) {
    throw new Error('The statement must identify a supported currency with two decimal places.');
  }

  const accountInfo = child(statement, kind === 'bank' ? 'BANKACCTFROM' : 'CCACCTFROM') ?? statement;
  const account = value(accountInfo, 'ACCTID');
  if (!account) throw new Error('The statement does not identify the source account.');

  const signon = findAll(root, ['SONRS'])[0];
  const fi = child(signon, 'FI');
  const bank = value(accountInfo, 'BANKID');
  const issuer = value(fi, 'FID') || value(signon, 'INTU.BID') || value(fi, 'ORG');
  const institution = kind === 'bank' ? bank || issuer : issuer || bank;
  const institutionKind = kind === 'bank' && bank ? 'BANKID'
    : value(fi, 'FID') ? 'FID' : value(signon, 'INTU.BID') ? 'INTU.BID'
    : value(fi, 'ORG') ? 'ORG' : bank ? 'BANKID' : '';
  const organization = value(fi, 'ORG');
  const branch = kind === 'bank' ? value(accountInfo, 'BRANCHID') : '';
  const accountType = kind === 'bank' ? value(accountInfo, 'ACCTTYPE').toUpperCase() : '';
  const list = child(statement, 'BANKTRANLIST');
  const transactionNodes = list?.children.filter((node) => node.tag === 'STMTTRN') ?? [];
  if (transactionNodes.length !== findAll(statement, ['STMTTRN']).length) throw invalidStructure();
  const transactions = transactionNodes.map(parseTransaction);
  let earliest = '';
  let latest = '';
  for (const { date: posted } of transactions) {
    if (!posted) continue;
    if (!earliest || posted < earliest) earliest = posted;
    if (posted > latest) latest = posted;
  }

  const ledger = child(statement, 'LEDGERBAL');
  const balance = ledger ? {
    amount: amount(value(ledger, 'BALAMT')), date: date(value(ledger, 'DTASOF'), 'balance')
  } : null;
  const from = value(list, 'DTSTART');
  const to = value(list, 'DTEND');
  const start = from ? date(from, 'start') : earliest || balance?.date || '';
  const end = to ? date(to, 'end') : latest || balance?.date || '';
  if (start && end && start > end) throw new Error('The statement date range is invalid.');
  // OFX 2.3 §§3.2.7–3.2.8: DTEND is exclusive; omitted time/zone means
  // midnight GMT. The day-based journal can infer only matching midnight
  // end/ledger boundaries, with a consistent offset throughout the statement.
  const midnight = (v) => /^\d{8}(?:000000(?:\.0+)?)?(?:\s*\[[^\]]+\])?$/.test(v);
  const offset = (v) => Number(v.match(/\[([+-]?\d{1,2}(?:\.\d+)?)/)?.[1] || 0);
  const zone = offset(from);
  const balanceCoverage = !!(from && to && balance && balance.date === end &&
    start < end && midnight(from) && midnight(to) && midnight(value(ledger, 'DTASOF')) &&
    Math.abs(zone) <= 14 && offset(to) === zone && offset(value(ledger, 'DTASOF')) === zone &&
    transactionNodes.every((node) => offset(value(node, 'DTPOSTED')) === zone));
  return { kind, institution, institutionKind, organization, branch, accountType, account, currency,
    start, end, balance, balanceCoverage, transactions };
}
