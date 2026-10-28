// График цены в PNG без внешних библиотек: свой растеризатор, пиксельный шрифт и PNG-кодер (node:zlib).
import { deflateSync } from 'node:zlib';
import { ruNumber } from './stats.js';

// Шрифт 5×7: цифры, точка, двоеточие, минус, пробел, знак рубля и строчные буквы для легенды
// («цена», «с промокодом»). У строчных 8-я строка — выносной элемент (р, д, ц).
const GLYPHS = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ',': ['00000', '00000', '00000', '00000', '01100', '00100', '01000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '₽': ['01110', '01001', '01001', '01110', '01000', '11100', '01000'],
  а: ['00000', '00000', '01110', '00001', '01111', '10001', '01111', '00000'],
  д: ['00000', '00000', '00110', '01010', '01010', '01010', '11111', '10001'],
  е: ['00000', '00000', '01110', '10001', '11111', '10000', '01110', '00000'],
  к: ['00000', '00000', '10010', '10100', '11000', '10100', '10010', '00000'],
  м: ['00000', '00000', '10001', '11011', '10101', '10001', '10001', '00000'],
  н: ['00000', '00000', '10001', '10001', '11111', '10001', '10001', '00000'],
  о: ['00000', '00000', '01110', '10001', '10001', '10001', '01110', '00000'],
  п: ['00000', '00000', '11111', '10001', '10001', '10001', '10001', '00000'],
  р: ['00000', '00000', '11110', '10001', '10001', '11110', '10000', '10000'],
  с: ['00000', '00000', '01110', '10000', '10000', '10001', '01110', '00000'],
  ц: ['00000', '00000', '10010', '10010', '10010', '10010', '11111', '00001'],
};
const NARROW = new Set([' ', ' ', ' ']);

// Цвета: поверхность, текст, сетка; серии — цена (синяя) и цена с промокодом (оранжевая), цель — серая линия.
const C = {
  surface: [0xfc, 0xfc, 0xfb],
  text: [0x0b, 0x0b, 0x0b],
  muted: [0x52, 0x51, 0x4e],
  grid: [0xe6, 0xe5, 0xe1],
  axis: [0xc3, 0xc2, 0xb7],
  series: [0x2a, 0x78, 0xd6],
  promo: [0xeb, 0x68, 0x34],
};

const SS = 2; // сглаживание: рисуем в 2 раза крупнее и уменьшаем

class Canvas {
  constructor(w, h, bg) {
    Object.assign(this, { w: w * SS, h: h * SS, outW: w, outH: h });
    this.px = Buffer.alloc(this.w * this.h * 3);
    for (let i = 0; i < this.w * this.h; i++) this.px.set(bg, i * 3);
  }

  set(x, y, c) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.px.set(c, (y * this.w + x) * 3);
  }

  rect(x, y, w, h, c) {
    const [x0, y0] = [Math.round(x * SS), Math.round(y * SS)];
    const [x1, y1] = [Math.round((x + w) * SS), Math.round((y + h) * SS)];
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.set(xx, yy, c);
  }

  /** Отрезок толщиной width (в пикселях итоговой картинки) с круглыми концами. */
  line(ax, ay, bx, by, width, c) {
    const r = (width * SS) / 2;
    [ax, ay, bx, by] = [ax * SS, ay * SS, bx * SS, by * SS];
    const [dx, dy] = [bx - ax, by - ay];
    const len2 = dx * dx + dy * dy || 1;
    for (let y = Math.floor(Math.min(ay, by) - r); y <= Math.ceil(Math.max(ay, by) + r); y++) {
      for (let x = Math.floor(Math.min(ax, bx) - r); x <= Math.ceil(Math.max(ax, bx) + r); x++) {
        const t = Math.max(0, Math.min(1, ((x + 0.5 - ax) * dx + (y + 0.5 - ay) * dy) / len2));
        const [px, py] = [ax + t * dx - x - 0.5, ay + t * dy - y - 0.5];
        if (px * px + py * py <= r * r) this.set(x, y, c);
      }
    }
  }

  dot(x, y, radius, c) {
    this.line(x, y, x, y, radius * 2, c);
  }

  textWidth(s, scale) {
    let w = 0;
    for (const ch of s) w += (NARROW.has(ch) ? 3 : 6) * scale;
    return w - scale;
  }

  text(s, x, y, scale, c, align = 'left') {
    if (align === 'right') x -= this.textWidth(s, scale);
    if (align === 'center') x -= this.textWidth(s, scale) / 2;
    for (const ch of s) {
      const g = GLYPHS[ch];
      if (g) for (let row = 0; row < g.length; row++) for (let col = 0; col < 5; col++) if (g[row][col] === '1') this.rect(x + col * scale, y + row * scale, scale, scale, c);
      x += (NARROW.has(ch) ? 3 : 6) * scale;
    }
  }

  /** Уменьшение в SS раз с усреднением — получается сглаженная картинка. */
  toPng() {
    const { outW: w, outH: h } = this;
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) {
      raw[y * (w * 3 + 1)] = 0;
      for (let x = 0; x < w; x++) {
        for (let ch = 0; ch < 3; ch++) {
          let sum = 0;
          for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) sum += this.px[((y * SS + sy) * this.w + x * SS + sx) * 3 + ch];
          raw[y * (w * 3 + 1) + 1 + x * 3 + ch] = Math.round(sum / (SS * SS));
        }
      }
    }
    return encodePng(w, h, raw);
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
export function encodePng(w, h, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8 бит, RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function niceTicks(lo, hi, count = 4) {
  if (hi === lo) {
    const pad = Math.max(1, Math.abs(hi) * 0.05);
    [lo, hi] = [lo - pad, hi + pad];
  }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  let start = Math.floor(lo / step) * step;
  let end = Math.ceil(hi / step) * step;
  // Точки не должны лежать прямо на краю графика
  if (start === lo) start -= step;
  if (end === hi) end += step;
  const ticks = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

const label = (v) => `${ruNumber(Math.round(v), 0, { sep: ' ' })} ₽`;

/**
 * points — [{ ts, price, promoPrice? }] по времени; promoPrice — цена с промокодом, если он был.
 * dateLabel(ts) → '26.10'. target — цель пользователя (линия) или null. Возвращает PNG (Buffer).
 */
export function renderChart(points, { dateLabel, target = null, width = 1000, height = 500 } = {}) {
  const cv = new Canvas(width, height, C.surface);
  const hasPromo = points.some((p) => p.promoPrice != null);
  const box = { l: 112, r: width - 120, t: hasPromo ? 48 : 28, b: height - 52 };
  const values = [...points.map((p) => p.price), ...points.filter((p) => p.promoPrice != null).map((p) => p.promoPrice)];
  const ticks = niceTicks(Math.min(...values, target ?? Infinity), Math.max(...values, target ?? -Infinity));
  const [yLo, yHi] = [ticks[0], ticks.at(-1)];
  const y = (v) => box.b - ((v - yLo) / (yHi - yLo)) * (box.b - box.t);
  const t0 = points[0].ts;
  const span = points.at(-1).ts - t0;
  const x = (ts) => (span ? box.l + ((ts - t0) / span) * (box.r - box.l) : (box.l + box.r) / 2);

  // Сетка и подписи цен
  for (const v of ticks) {
    cv.rect(box.l, Math.round(y(v)), box.r - box.l, 1, v === yLo ? C.axis : C.grid);
    cv.text(label(v), box.l - 14, Math.round(y(v)) - 7, 2, C.muted, 'right');
  }

  // Подписи дат: не больше 7, без наложений
  const n = Math.min(7, points.length);
  let lastRight = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = points[n === 1 ? 0 : Math.round((i * (points.length - 1)) / (n - 1))];
    const s = dateLabel(p.ts);
    const cx = x(p.ts);
    const half = cv.textWidth(s, 2) / 2;
    if (cx - half < lastRight + 16) continue;
    cv.rect(Math.round(cx), box.b, 1, 6, C.axis);
    cv.text(s, cx, box.b + 16, 2, C.muted, 'center');
    lastRight = cx + half;
  }

  // Легенда — когда линий две
  if (hasPromo) {
    let lx = box.l;
    for (const [name, color] of [['цена', C.series], ['с промокодом', C.promo]]) {
      cv.line(lx, 17, lx + 22, 17, 2, color);
      cv.dot(lx + 11, 17, 4, color);
      cv.text(name, lx + 32, 8, 2, C.text);
      lx += 32 + cv.textWidth(name, 2) + 36;
    }
  }

  // Цель пользователя
  if (target !== null) {
    cv.rect(box.l, Math.round(y(target)), box.r - box.l, 2, C.muted);
    cv.text(label(target), box.r + 12, Math.round(y(target)) - 7, 2, C.muted);
  }

  const marker = (p, v, color) => {
    cv.dot(x(p.ts), y(v), 6, C.surface);
    cv.dot(x(p.ts), y(v), 4, color);
  };

  // Линия цены (ступенькой: цена держится до следующей проверки)
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    cv.line(x(a.ts), y(a.price), x(b.ts), y(a.price), 2, C.series);
    cv.line(x(b.ts), y(a.price), x(b.ts), y(b.price), 2, C.series);
  }
  if (points.length <= 40) points.forEach((p) => marker(p, p.price, C.series));

  // Цена с промокодом: линия там, где промокод был в соседних проверках, иначе точка
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    if (a.promoPrice == null || b.promoPrice == null) continue;
    cv.line(x(a.ts), y(a.promoPrice), x(b.ts), y(a.promoPrice), 2, C.promo);
    cv.line(x(b.ts), y(a.promoPrice), x(b.ts), y(b.promoPrice), 2, C.promo);
  }
  points.filter((p) => p.promoPrice != null).forEach((p) => marker(p, p.promoPrice, C.promo));

  // Подписи: минимум к оплате и текущая цена (и цена с промокодом, если он сейчас есть)
  const pay = (p) => p.promoPrice ?? p.price;
  const last = points.at(-1);
  const min = points.reduce((a, b) => (pay(b) < pay(a) ? b : a));
  marker(min, pay(min), min.promoPrice != null ? C.promo : C.series);
  marker(last, last.price, C.series);
  if (min !== last && Math.abs(x(min.ts) - x(last.ts)) > 90) {
    const below = y(pay(min)) + 14 + 14 <= box.b - 2;
    cv.text(label(pay(min)), x(min.ts), below ? y(pay(min)) + 14 : y(pay(min)) - 28, 2, C.text, 'center');
  }
  let lastY = y(last.price) - 7;
  if (last.promoPrice != null) {
    marker(last, last.promoPrice, C.promo);
    let promoY = y(last.promoPrice) - 7;
    if (promoY - lastY < 18) [lastY, promoY] = [Math.min(lastY, promoY - 18), Math.max(promoY, lastY + 18)];
    cv.text(label(last.promoPrice), x(last.ts) + 12, promoY, 2, C.text);
  }
  cv.text(label(last.price), x(last.ts) + 12, lastY, 2, C.text);
  return cv.toPng();
}
