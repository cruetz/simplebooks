import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

export const MAX_RECEIPT_BYTES = 12 * 1024 * 1024;
const MAX_PIXELS = 50_000_000;
const MAX_ACTIVE_OCR = 2;
const run = promisify(execFile);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const jpegFrames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
let activeOcr = 0;

function imageError() {
  return new Error('The receipt image is incomplete or invalid.');
}

function pngDimensions(buffer) {
  if (buffer.length < 45 || buffer.readUInt32BE(8) !== 13 ||
      buffer.toString('ascii', 12, 16) !== 'IHDR') throw imageError();
  let imageData = false;
  for (let pos = 8; pos + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(pos);
    const chunk = buffer.toString('ascii', pos + 4, pos + 8);
    pos += length + 12;
    if (pos > buffer.length) break;
    if (chunk === 'IDAT' && length) imageData = true;
    if (chunk === 'IEND' && length === 0 && imageData && pos === buffer.length) {
      return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
    }
  }
  throw imageError();
}

function jpegDimensions(buffer) {
  const endsAt = buffer.length - 2;
  if (buffer[endsAt] !== 0xff || buffer[endsAt + 1] !== 0xd9) throw imageError();
  let dimensions;
  for (let pos = 2; pos < endsAt;) {
    if (buffer[pos++] !== 0xff) break;
    while (buffer[pos] === 0xff) pos++;
    const marker = buffer[pos++];
    if (pos + 2 > endsAt) break;
    const length = buffer.readUInt16BE(pos);
    if (length < 2 || pos + length > endsAt) break;
    if (jpegFrames.has(marker) && length >= 8) {
      dimensions = [buffer.readUInt16BE(pos + 5), buffer.readUInt16BE(pos + 3)];
    }
    if (marker === 0xda && dimensions && pos + length < endsAt) return dimensions;
    pos += length;
  }
  throw imageError();
}

function webpDimensions(buffer) {
  if (buffer.length < 20 || buffer.readUInt32LE(4) + 8 !== buffer.length) throw imageError();
  let canvas;
  let dimensions;
  let pos = 12;
  while (pos + 8 <= buffer.length) {
    const chunk = buffer.toString('ascii', pos, pos + 4);
    const length = buffer.readUInt32LE(pos + 4);
    const data = pos + 8;
    pos = data + length + length % 2;
    if (pos > buffer.length) throw imageError();
    if (chunk === 'ANIM' || chunk === 'ANMF') throw new Error('Choose a still receipt photo.');
    if (chunk === 'VP8X' && length === 10) {
      if (buffer[data] & 0x02) throw new Error('Choose a still receipt photo.');
      canvas = [buffer.readUIntLE(data + 4, 3) + 1, buffer.readUIntLE(data + 7, 3) + 1];
    }
    if (chunk === 'VP8L' && length >= 5 && buffer[data] === 0x2f) {
      const bits = buffer.readUInt32LE(data + 1);
      dimensions = [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
    }
    if (chunk === 'VP8 ' && length >= 10 && buffer.readUIntBE(data + 3, 3) === 0x9d012a) {
      dimensions = [buffer.readUInt16LE(data + 6) & 0x3fff, buffer.readUInt16LE(data + 8) & 0x3fff];
    }
  }
  if (pos !== buffer.length || !dimensions ||
      (canvas && (canvas[0] !== dimensions[0] || canvas[1] !== dimensions[1]))) throw imageError();
  return dimensions;
}

export function validateReceiptImage(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Choose a receipt photo.');
  if (buffer.length > MAX_RECEIPT_BYTES) throw new Error('Choose a receipt photo under 12 MB.');
  let extension;
  let contentType;
  let dimensions;
  if (buffer.subarray(0, 8).equals(pngSignature)) {
    extension = 'png';
    contentType = 'image/png';
    dimensions = pngDimensions(buffer);
  } else if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    extension = 'jpg';
    contentType = 'image/jpeg';
    dimensions = jpegDimensions(buffer);
  } else if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    extension = 'webp';
    contentType = 'image/webp';
    dimensions = webpDimensions(buffer);
  } else {
    throw new Error('Choose a JPEG, PNG, or WebP receipt photo.');
  }
  const [width, height] = dimensions;
  if (!width || !height || width > 16384 || height > 16384 || width * height > MAX_PIXELS) {
    throw new Error('The receipt image dimensions are unsupported. Try a smaller photo.');
  }
  return { extension, contentType, width, height };
}

function calendarDate(year, month, day) {
  if (year.length === 2) year = '20' + year;
  const iso = [year, month.padStart(2, '0'), day.padStart(2, '0')].join('-');
  const parsed = new Date(iso + 'T00:00:00Z');
  if (year.length !== 4 || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) return '';
  return iso;
}

const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthNames = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const monthFirst = new RegExp('\\b' + monthNames + '\\.?[ -]+(\\d{1,2})(?:st|nd|rd|th)?[, -]+(\\d{4}|\\d{2})\\b', 'i');
const dayFirst = new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?[ -]+' + monthNames + '\\.?[, -]+(\\d{4}|\\d{2})\\b', 'i');

function receiptDate(line) {
  const yearFirst = line.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (yearFirst) return calendarDate(yearFirst[1], yearFirst[2], yearFirst[3]);
  const numeric = line.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/);
  if (numeric) {
    const [, first, second, year] = numeric;
    if (Number(first) <= 12 && Number(second) <= 12 && Number(first) !== Number(second)) return '';
    return Number(first) > 12 ? calendarDate(year, second, first) : calendarDate(year, first, second);
  }
  const byMonth = line.match(monthFirst);
  const byDay = line.match(dayFirst);
  if (!byMonth && !byDay) return '';
  const [month, day, year] = byMonth ? byMonth.slice(1) : [byDay[2], byDay[1], byDay[3]];
  return calendarDate(year, String(months.indexOf(month.toLowerCase().slice(0, 3)) + 1), day);
}

const totalLabels = [
  /\b(?:grand\s+total|amount\s+(?:due|paid)|balance\s+due|total\s+(?:due|paid|sale|purchase)|purchase\s+total)\b/i,
  /^\W*total\b(?![\s-]+(?:tax|savings|discount|items?|points|tender|before)\b)/i
];

function receiptTotal(lines) {
  for (const label of totalLabels) {
    const amounts = new Set();
    for (const [index, line] of lines.entries()) {
      const match = line.match(label);
      if (!match) continue;
      const afterLabel = line.slice(match.index + match[0].length);
      const following = lines[index + 1] ?? '';
      const value = afterLabel.match(/^[\s:=$]*([0-9]+(?:,\d{3})*[.,]\d{2})(?![\d.,])/)
        ?? (/^[\s:=$]*$/.test(afterLabel) && following.match(/^\s*\$?\s*([0-9]+(?:,\d{3})*[.,]\d{2})(?:\s*[A-Z]{3})?\s*$/));
      if (value) {
        const cents = Number(value[1].replace(/[.,]/g, ''));
        if (Number.isSafeInteger(cents) && cents > 0) amounts.add(cents);
      }
    }
    if (amounts.size) return amounts.size === 1 ? [...amounts][0] : null;
  }
  return null;
}

export function parseReceiptText(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const dates = new Set(lines.map(receiptDate).filter(Boolean));
  const merchant = lines.slice(0, 8).find((line) =>
    /\p{L}{2}/u.test(line) &&
    !/^(?:receipt|tax invoice|invoice|merchant copy|customer copy|copy|sale|date|welcome|thank you|subtotal|total|change)\b|^no[.:\s]|\d+[.,]\d{2}\b|^\d+\s/i.test(line) &&
    !receiptDate(line)
  ) ?? '';
  return {
    merchant: merchant.slice(0, 150),
    date: dates.size === 1 ? [...dates][0] : '',
    total: receiptTotal(lines)
  };
}

export async function extractReceipt(buffer) {
  const { extension } = validateReceiptImage(buffer);
  if (activeOcr >= MAX_ACTIVE_OCR) {
    return {
      merchant: '', date: '', total: null, text: '',
      warning: 'Automatic recognition is busy. Enter the receipt details below.'
    };
  }
  activeOcr++;
  let directory;
  let text = '';
  let warning = null;
  try {
    directory = await mkdtemp(join(tmpdir(), 'simplebooks-ocr-'));
    const path = join(directory, `receipt.${extension}`);
    await writeFile(path, buffer, { mode: 0o600, flag: 'wx' });
    const { stdout } = await run('tesseract', [path, 'stdout', '-l', 'eng', '--psm', '1'], {
      timeout: 20000,
      maxBuffer: 256 * 1024,
      killSignal: 'SIGKILL',
      env: { ...process.env, OMP_THREAD_LIMIT: '1' }
    });
    text = stdout.trim().slice(0, 12000);
  } catch {
    warning = 'The receipt photo could not be read automatically. Enter the details below.';
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    activeOcr--;
  }
  const details = parseReceiptText(text);
  if (!warning && (!details.merchant || !details.date || details.total === null)) {
    warning = 'Some receipt details could not be read. Review and complete the fields below.';
  }
  return { ...details, text, warning };
}
