/** Tiny DOM + formatting toolbox. No framework, no deps. */

/* ------------------------------------------------------------- elements --- */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node && key !== 'list' && typeof value !== 'object') {
      node[key] = value;
    } else node.setAttribute(key, value === true ? '' : value);
  }
  append(node, children);
  return node;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Inline SVG icon from the sprite. */
export function icon(name, cls = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

/* ------------------------------------------------------------ formatting --- */
export function initials(name) {
  const parts = String(name || '?')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return [...parts[0]].slice(0, 2).join('').toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const AVATAR_RAMPS = [
  ['#6366f1', '#a855f7'],
  ['#ec4899', '#f43f5e'],
  ['#f59e0b', '#ef4444'],
  ['#10b981', '#14b8a6'],
  ['#0ea5e9', '#6366f1'],
  ['#8b5cf6', '#d946ef'],
  ['#f43f5e', '#f59e0b'],
  ['#22d3ee', '#3b82f6'],
  ['#84cc16', '#10b981'],
  ['#eab308', '#84cc16'],
];

export function hashCode(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
}

export function avatarStyle(seed, color) {
  if (color && color.startsWith('hsl')) return { background: color };
  const ramp = AVATAR_RAMPS[hashCode(seed || 'x') % AVATAR_RAMPS.length];
  const angle = 30 + (hashCode(seed || 'x') % 120);
  return { background: `linear-gradient(${angle}deg, ${ramp[0]}, ${ramp[1]})` };
}

export function avatar(name, { size = '', status = '', seed = '', color = '', emoji = '', img = '' } = {}) {
  const node = el('div', { class: 'avatar' + (size ? ' avatar--' + size : ''), style: avatarStyle(seed || name, color) });
  if (img) node.append(el('img', { class: 'avatar__img', src: img, alt: '', draggable: false }));
  else node.append(el('span', { text: emoji || initials(name) }));
  if (emoji && !img) node.style.fontSize = size === 'xl' ? '40px' : size === 'lg' ? '26px' : '16px';
  if (status) {
    node.append(
      el('i', {
        class: 'avatar__status avatar__status--' + status,
        title: status === 'on' ? 'в сети' : status === 'busy' ? 'соединение…' : 'не в сети',
      })
    );
  }
  return node;
}

/**
 * Turn a picked image file into a small square data URL. It all happens in the
 * renderer: the picture is cropped square, scaled down and re-encoded, so what
 * lands in profile.json is a few kilobytes instead of a multi-megabyte photo and
 * what travels to a contact still fits in a chat channel.
 */
export async function makeAvatarImage(bytes, mime, size = 256) {
  const blob = new Blob([bytes], { type: mime || 'image/png' });
  const bitmap = await createImageBitmap(blob);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.82);
  } finally {
    bitmap.close();
  }
}

const pad = (n) => String(n).padStart(2, '0');

export function clockTime(ts) {
  const d = new Date(ts);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

export function dayLabel(ts) {
  const d = new Date(ts);
  const today = startOfDay(Date.now());
  const day = startOfDay(ts);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Вчера';
  if (diff < 7) return ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][d.getDay()].toUpperCase();
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function listTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = startOfDay(Date.now());
  const day = startOfDay(ts);
  if (day === today) return clockTime(ts);
  if (today - day === 86400000) return 'вчера';
  if (today - day < 6 * 86400000) return ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][d.getDay()];
  return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + String(d.getFullYear()).slice(2);
}

export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function sameDay(a, b) {
  return startOfDay(a) === startOfDay(b);
}

export function relTime(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'только что';
  if (s < 90) return 'минуту назад';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' мин назад';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' ч назад';
  const d = Math.round(h / 24);
  return d === 1 ? 'вчера' : d + ' дн назад';
}

export function bytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' Б';
  if (v < 1024 * 1024) return (v / 1024).toFixed(v < 10240 ? 1 : 0) + ' КБ';
  if (v < 1024 * 1024 * 1024) return (v / 1048576).toFixed(v < 10485760 ? 1 : 0) + ' МБ';
  return (v / 1073741824).toFixed(2) + ' ГБ';
}

export function duration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return m + ':' + pad(s % 60);
}

/* ----------------------------------------------------------------- misc --- */
let idCounter = 0;
export function uid(prefix = '') {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  idCounter = (idCounter + 1) % 0xffff;
  return (
    prefix +
    Date.now().toString(36) +
    idCounter.toString(36).padStart(3, '0') +
    '-' +
    rand[0].toString(36) +
    rand[1].toString(36)
  );
}

export function debounce(fn, ms = 200) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  wrapped.flush = (...args) => {
    clearTimeout(t);
    fn(...args);
  };
  return wrapped;
}

export function throttle(fn, ms = 100) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const now = Date.now();
    const wait = ms - (now - last);
    if (wait <= 0) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn(...args);
      }, wait);
    }
  };
}

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export function groupBy(list, fn) {
  const map = new Map();
  for (const item of list) {
    const key = fn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  const ta = el('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
  document.body.append(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } finally {
    ta.remove();
  }
  return Promise.resolve();
}

/** Very small markdown subset: code fences, inline code, bold, italic, links. */
export function renderText(text) {
  const blocks = [];
  const source = String(text ?? '');
  const fence = /```([\w+-]*)\n([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = fence.exec(source))) {
    if (m.index > last) blocks.push({ type: 'text', value: source.slice(last, m.index) });
    blocks.push({ type: 'code', lang: m[1], value: m[2].replace(/\n$/, '') });
    last = fence.lastIndex;
  }
  if (last < source.length) blocks.push({ type: 'text', value: source.slice(last) });

  return blocks
    .map((block) => {
      if (block.type === 'code') {
        return `<pre><code>${escapeHtml(block.value)}</code></pre>`;
      }
      let html = escapeHtml(block.value);
      html = html.replace(/`([^`\n]+)`/g, (_x, code) => `<code>${code}</code>`);
      html = html.replace(/(^|[\s(])\*\*([^*\n]+)\*\*/g, '$1<strong>$2</strong>');
      html = html.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
      html = html.replace(
        /(https?:\/\/[^\s<]+[^\s<.,:;"')\]])/g,
        '<a href="$1" rel="noreferrer noopener">$1</a>'
      );
      return html;
    })
    .join('');
}

export function fileKind(name, mime) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (mime && mime.startsWith('image/')) return 'image';
  if (mime && mime.startsWith('audio/')) return 'audio';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'opus'].includes(ext)) return 'audio';
  if (['mp4', 'mkv', 'webm', 'mov', 'avi'].includes(ext)) return 'video';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive';
  if (['pdf'].includes(ext)) return 'pdf';
  if (['doc', 'docx', 'odt', 'rtf'].includes(ext)) return 'doc';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'sheet';
  return 'file';
}

export function shortId(id, len = 8) {
  return String(id).slice(0, len);
}

export function autoGrow(textarea, max = 168) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, max) + 'px';
  return textarea.scrollHeight > max + 8;
}

export function scrollToBottom(node, smooth = false) {
  node.scrollTo({ top: node.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

export function isAtBottom(node, slack = 90) {
  return node.scrollHeight - node.scrollTop - node.clientHeight < slack;
}
