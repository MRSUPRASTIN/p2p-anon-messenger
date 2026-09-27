/** Conversation view: stream, bubbles, composer, attachments. */
import {
  el,
  clear,
  icon,
  avatar,
  renderText,
  clockTime,
  dayLabel,
  listTime,
  sameDay,
  bytes,
  duration,
  fileKind,
  autoGrow,
  scrollToBottom,
  isAtBottom,
  throttle,
  initials,
} from '../util.js';
import * as S from '../state.js';
import { net } from '../app.js';
import { toast, contextMenu, popover, closePopover, openModal } from './overlay.js';
import { EMOJI, EMOJI_GROUPS } from './emoji.js';

const REACTIONS = ['👍', '❤️', '😂', '🔥', '🎉', '😮', '😢', '🙏'];

export const transfers = new Map(); // messageId -> {sent, received, total, dir, name}

let host = null;
let streamNode = null;
let innerNode = null;
let composerInput = null;
let nodes = new Map();
let currentId = null;
let typingTimer = null;
let lastTypingSent = 0;
let replyTo = null;
let editing = null;
let stickToBottom = true;
let unseen = 0;

export function mount(container) {
  host = container;
  host.className = 'view conv';
  host.hidden = true;
  clear(host);
}

export function getHost() {
  return host;
}

export function isOpen(peerId) {
  return currentId === peerId;
}

export function currentPeer() {
  return currentId;
}

/* ---------------------------------------------------------------- render --- */
export async function open(peerId) {
  if (currentId === peerId && host.hidden === false) {
    markRead(peerId);
    return;
  }
  currentId = peerId;
  host.hidden = false;
  clear(host);
  nodes = new Map();
  unseen = 0;
  replyTo = null;
  editing = null;

  const me = S.state.profile;
  const contact = S.contact(peerId) || { id: peerId, name: 'Unknown' };

  /* header ------------------------------------------------------------- */
  const status = el('span', { class: 'conv__status' });
  const tools = el('div', { class: 'conv__tools' });
  const infoBtn = el('button', { class: 'btn btn--ghost btn--icon', title: 'Информация' }, icon('info'));
  const searchBtn = el('button', { class: 'btn btn--ghost btn--icon', title: 'Поиск в чате' }, icon('search'));
  const moreBtn = el('button', { class: 'btn btn--ghost btn--icon', title: 'Ещё' }, icon('more'));
  tools.append(searchBtn, infoBtn, moreBtn);

  const head = el(
    'div',
    { class: 'conv__head' },
    el('button', {
      class: 'btn btn--ghost btn--icon',
      title: 'Назад к чатам',
      onclick: () => S.emit('back-to-list'),
    }, icon('chevron-right', 'icon', )),
    el('div', { class: 'conv__id' },
      el('div', {
        class: 'conv__name truncate',
        onclick: () => infoBtn.click(),
      }, el('span', { class: 'truncate', text: contact.name })),
      status),
    tools
  );

  streamNode = el('div', { class: 'stream' });
  innerNode = el('div', { class: 'stream__inner' });
  streamNode.append(innerNode);
  const jump = el('button', { class: 'jump', dataset: { show: 'false' } }, icon('arrow-down', 'icon icon--sm'), el('span', { text: 'Вниз' }));
  streamNode.append(jump);

  /* composer ----------------------------------------------------------- */
  composerInput = el('textarea', {
    class: 'composer__input',
    rows: 1,
    placeholder: 'Написать сообщение…',
    oninput: onInput,
    onkeydown: onKeyDown,
    onpaste: onPaste,
  });
  const replyBar = el('div', { class: 'composer__reply hidden' });
  const attachBtn = el('button', { class: 'btn btn--ghost btn--icon', title: 'Прикрепить файл' }, icon('paperclip'));
  const emojiBtn = el('button', { class: 'btn btn--ghost btn--icon', title: 'Эмодзи' }, icon('smile'));
  const sendBtn = el('button', { class: 'composer__send', title: 'Отправить (Enter)' }, icon('send', 'icon icon--lg'));
  sendBtn.disabled = true;

  const composer = el(
    'div',
    { class: 'composer' },
    replyBar,
    el('div', { class: 'composer__box' }, attachBtn, composerInput, el('div', { class: 'row', style: { gap: '4px' } }, emojiBtn, sendBtn)),
    el('div', { class: 'composer__foot' },
      el('span', { class: 'composer__hint' },
        el('kbd', { text: 'Enter' }), ' — отправить, ',
        el('kbd', { text: 'Shift+Enter' }), ' — новая строка'),
      el('span', { class: 'spacer' }),
      el('span', { text: 'DTLS + ECDH → AES-256-GCM' }))
  );

  host.append(head, el('div', { class: 'stream-wrap', style: { position: 'relative', minHeight: '0', display: 'grid' } }, streamNode, jump), composer);

  /* events ------------------------------------------------------------- */
  streamNode.addEventListener('scroll', () => {
    stickToBottom = isAtBottom(streamNode);
    jump.dataset.show = stickToBottom || unseen === 0 ? 'false' : 'true';
    jump.querySelector('span').textContent = unseen ? `Вниз · ${unseen}` : 'Вниз';
  });
  jump.addEventListener('click', () => {
    scrollToBottom(streamNode, true);
    stickToBottom = true;
    unseen = 0;
    jump.dataset.show = 'false';
  });
  sendBtn.addEventListener('click', () => submit());
  attachBtn.addEventListener('click', () => pickFiles());
  emojiBtn.addEventListener('click', () => openEmoji(emojiBtn));
  infoBtn.addEventListener('click', () => S.emit('open-info', peerId));
  searchBtn.addEventListener('click', () => openChatSearch(peerId));
  moreBtn.addEventListener('click', (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    contextMenu(rect.left - 180, rect.bottom + 6, [
      { type: 'label', label: contact.name },
      { label: 'Информация и отпечаток', icon: 'shield', onClick: () => S.emit('open-info', peerId) },
      { label: 'Поиск в чате', icon: 'search', onClick: () => openChatSearch(peerId) },
      { label: 'Прикрепить файл', icon: 'paperclip', onClick: () => pickFiles() },
      { type: 'sep' },
      net.isConnected(peerId)
        ? { label: 'Отключиться', icon: 'ban', onClick: () => net.hangup(peerId) }
        : { label: 'Подключиться', icon: 'refresh-cw', onClick: () => S.emit('connect', peerId) },
      { label: 'Удалить чат', icon: 'trash', danger: true, onClick: () => S.emit('delete-chat', peerId) },
    ]);
  });

  setupDrop(host, peerId);
  updateHeaderStatus(peerId, status);

  const list = await S.ensureChat(peerId);
  for (const message of list) appendNode(message, true);
  scrollToBottom(streamNode);
  stickToBottom = true;
  markRead(peerId);
  if (me) setTimeout(() => composerInput.focus(), 80);
}

export function close() {
  currentId = null;
  if (host) host.hidden = true;
  nodes = new Map();
  transfers.clear();
}

/* ---------------------------------------------------------------- header --- */
const headerStatusNodes = new Map();

export function updateHeaderStatus(peerId, node) {
  headerStatusNodes.set(peerId, node);
  paintStatus(peerId);
}

function paintStatus(peerId) {
  const node = headerStatusNodes.get(peerId);
  if (!node) return;
  const contact = S.contact(peerId);
  const state = net.state(peerId);
  const online = net.isConnected(peerId);
  clear(node);
  node.className = 'conv__status';
  if (S.isTyping(peerId)) {
    node.classList.add('conv__status--busy');
    node.append(el('span', { text: 'печатает…' }));
    return;
  }
  if (online) {
    node.classList.add('conv__status--on');
    node.append(el('i', { class: 'dot dot--on' }));
    node.append(
      el('span', {
        text: (net.peers.get(peerId)?.lan ? 'в сети · локальная сеть' : 'в сети') +
          (contact?.verified ? ' · отпечаток сверен' : ''),
      })
    );
    return;
  }
  if (state === 'connecting') {
    node.classList.add('conv__status--busy');
    node.append(el('i', { class: 'dot dot--busy' }), el('span', { text: 'соединение…' }));
    return;
  }
  const seen = contact?.lastSeen;
  node.append(el('i', { class: 'dot dot--off' }));
  node.append(el('span', { text: seen ? `был(а) ${listTime(seen)}` : 'не в сети' }));
}

export function refreshStatus() {
  for (const peerId of headerStatusNodes.keys()) paintStatus(peerId);
}

/* --------------------------------------------------------------- stream --- */
export function renderMessages() {
  if (!innerNode || !currentId) return;
  const atBottom = isAtBottom(streamNode);
  clear(innerNode);
  nodes = new Map();
  let lastDay = 0;
  let previous = null;
  for (const message of S.messages(currentId)) {
    if (!sameDay(lastDay, message.ts)) {
      innerNode.append(el('div', { class: 'daysep', text: dayLabel(message.ts) }));
      lastDay = message.ts;
      previous = null;
    }
    appendNode(message, true, previous);
    previous = message;
  }
  if (atBottom) scrollToBottom(streamNode);
}

function grouping(previous, message) {
  if (!previous) return { tail: true, hidden: false };
  const sameAuthor = previous.dir === message.dir && (previous.authorId || previous.authorName) === (message.authorId || message.authorName);
  const close = message.ts - previous.ts < 5 * 60 * 1000;
  return { tail: !(sameAuthor && close), hidden: sameAuthor && close };
}

function appendNode(message, quiet = false, previous = null) {
  if (!innerNode) return null;
  if (nodes.has(message.id)) return nodes.get(message.id);

  if (message.kind === 'system') {
    const node = el('div', { class: 'sysline', text: message.text });
    nodes.set(message.id, node);
    innerNode.append(node);
    scrollIfPinned();
    return node;
  }

  const prev = previous || lastMessageBefore(message.id);
  const shape = grouping(prev, message);
  const own = message.dir === 'out';
  const author = own ? S.state.profile?.name : message.authorName || S.contactName(message.peerId);
  const authorId = own ? S.state.profile?.id : message.peerId;

  const row = el('div', {
    class: `msg msg--${own ? 'out' : 'in'}${shape.tail ? ' msg--tail' : ''}${shape.hidden ? ' msg--hidden' : ''}`,
    dataset: { id: message.id },
  });

  if (!own && shape.tail) row.append(avatar(author, { size: 'sm', seed: authorId, color: message.authorColor }));

  const col = el('div', { class: 'msg__col' });
  if (!own && shape.tail) {
    col.append(el('div', { class: 'bubble__author', text: author, style: { paddingLeft: '2px' } }));
  }

  const bubble = el('div', { class: 'bubble' + (message.deleted ? ' bubble--deleted' : '') });
  bubble.dataset.bubble = '1';

  if (message.deleted) {
    bubble.append(el('div', { class: 'bubble__text', text: 'Сообщение удалено' }));
  } else {
    if (message.replyTo) {
      bubble.append(
        el('div', {
          class: 'reply-quote',
          onclick: () => highlight(message.replyTo.id),
        },
          el('b', { text: message.replyTo.name || '—' }),
          el('span', { class: 'truncate', text: message.replyTo.text || '' }))
      );
    }
    if (message.kind === 'image' || message.kind === 'audio' || message.kind === 'file') {
      bubble.classList.add('bubble--media');
      bubble.append(mediaBlock(message));
    }
    if (message.text) {
      bubble.append(el('div', { class: 'bubble__text', html: renderText(message.text) }));
    }
  }

  if (message.reactions && message.reactions.length) {
    bubble.append(reactionRow(message));
  }

  col.append(bubble, metaRow(message));
  row.append(col);

  const tools = el('div', { class: 'msg__tools' });
  if (!own && !message.deleted) {
    tools.append(
      toolButton('smile', 'Реакция', (event) => openReactions(event.currentTarget, message)),
      toolButton('reply', 'Ответить', () => startReply(message))
    );
  }
  if (own && !message.deleted) {
    tools.append(
      toolButton('edit', 'Изменить', () => startEdit(message)),
      toolButton('trash', 'Удалить', () => deleteMessage(message), 'danger')
    );
  }
  if (tools.childElementCount) row.append(tools);

  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    messageMenu(message, event.clientX, event.clientY);
  });

  nodes.set(message.id, row);
  innerNode.append(row);
  if (!quiet) scrollIfPinned();
  return row;
}

function toolButton(name, title, onClick, extra = '') {
  return el('button', {
    class: 'msg__tool' + (extra ? ' msg__tool--' + extra : ''),
    title,
    onclick: (event) => {
      event.stopPropagation();
      onClick(event);
    },
  }, icon(name, 'icon icon--sm'));
}

function lastMessageBefore(id) {
  if (!currentId) return null;
  const list = S.messages(currentId);
  const at = list.findIndex((m) => m.id === id);
  return at > 0 ? list[at - 1] : null;
}

function scrollIfPinned() {
  if (stickToBottom && streamNode) scrollToBottom(streamNode);
}

function highlight(id) {
  const node = nodes.get(id);
  if (!node) return;
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  node.animate(
    [
      { boxShadow: '0 0 0 0 rgba(124,92,255,0)' },
      { boxShadow: '0 0 0 3px rgba(124,92,255,.55)' },
      { boxShadow: '0 0 0 0 rgba(124,92,255,0)' },
    ],
    { duration: 1100, easing: 'ease-out' }
  );
}

/* ----------------------------------------------------------------- media --- */
function mediaBlock(message) {
  const file = message.file || {};
  const kind = file.kind || fileKind(file.name, file.mime);
  const url = file.id ? window.mouth.files.url(file.id, file.name) : '';

  if (kind === 'image' && url) {
    const img = el('img', {
      src: url,
      alt: file.name || 'изображение',
      loading: 'lazy',
      onclick: () => openLightbox(url, file),
    });
    const wrap = el('div', { class: 'media' }, img);
    const box = el('div', { style: { display: 'grid', gap: '4px' } }, wrap);
    if (message.text) box.append(el('div', { class: 'media__cap', text: message.text }));
    return box;
  }

  if (kind === 'audio' && url) {
    return audioBlock(message, url);
  }

  const card = el('div', { class: 'filecard' },
    el('div', { class: 'filecard__ico' }, icon(kindIcon(kind), 'icon')),
    el('div', { class: 'stack', style: { gap: '1px', minWidth: '0' } },
      el('div', { class: 'filecard__name truncate', text: file.name || 'файл' }),
      el('div', { class: 'filecard__sub', text: bytes(file.size) + (message.text ? ' · ' + message.text : '') }))
  );
  card.style.cursor = 'pointer';
  card.addEventListener('click', () => {
    if (file.id) window.mouth.files.open(file.id, file.name);
  });
  const wrap = el('div', { style: { display: 'grid', gap: '4px' } }, card);
  const live = transfers.get(message.id);
  if (live) wrap.append(progressBar(live, message));
  return wrap;
}

function kindIcon(kind) {
  return (
    {
      image: 'image',
      audio: 'music',
      video: 'film',
      archive: 'archive',
      pdf: 'file',
      doc: 'file',
      sheet: 'file',
      file: 'file',
    }[kind] || 'file'
  );
}

function progressBar(live, message) {
  const total = live.total || message.file?.size || 1;
  const done = live.dir === 'out' ? live.sent : live.received;
  const pct = Math.min(100, Math.round((done / total) * 100));
  const wrap = el('div', { class: 'progress' }, el('div', { class: 'progress__bar', style: { width: pct + '%' } }));
  wrap.title = `${bytes(done)} / ${bytes(total)}`;
  wrap.dataset.pct = String(pct);
  return wrap;
}

function audioBlock(message, url) {
  const audio = new Audio(url);
  audio.preload = 'metadata';
  const time = el('span', { class: 'audio__time', text: '0:00' });
  const playIcon = icon('send', 'icon');
  const play = el('button', { class: 'audio__play', title: 'Слушать' });
  play.append(playIcon);
  const wave = el('div', { class: 'audio__wave' });
  for (let i = 0; i < 22; i++) {
    const h = 6 + Math.round(Math.abs(Math.sin(i * 1.7)) * 18);
    wave.append(el('i', { style: { height: h + 'px' } }));
  }
  play.addEventListener('click', () => {
    if (audio.paused) {
      audio.play().catch(() => toast({ title: 'Не удалось воспроизвести' }));
    } else audio.pause();
  });
  audio.addEventListener('play', () => clear(play).append(icon('x', 'icon')));
  audio.addEventListener('pause', () => clear(play).append(icon('send', 'icon')));
  audio.addEventListener('timeupdate', () => {
    time.textContent = duration(audio.currentTime);
    const ratio = audio.duration ? audio.currentTime / audio.duration : 0;
    [...wave.children].forEach((bar, i) => {
      bar.style.opacity = i / wave.childElementCount <= ratio ? '1' : '0.4';
    });
  });
  audio.addEventListener('ended', () => {
    time.textContent = '0:00';
  });
  return el('div', { class: 'audio' }, play, wave, time);
}

/* ------------------------------------------------------------------ meta --- */
function metaRow(message) {
  const row = el('div', { class: 'meta' });
  if (message.editedAt) row.append(el('span', { class: 'meta__edited', text: 'изменено' }));
  row.append(el('span', { text: clockTime(message.ts) }));
  if (message.dir === 'out') row.append(ticks(message));
  return row;
}

function ticks(message) {
  const wrap = el('span', { class: 'ticks' });
  const map = {
    sending: { name: 'clock', title: 'Отправляется' },
    failed: { name: 'alert', title: 'Не отправлено' },
    sent: { name: 'check', title: 'Отправлено' },
    delivered: { name: 'check-double', title: 'Доставлено' },
    read: { name: 'check-double', title: 'Прочитано' },
  };
  const spec = map[message.state] || map.sent;
  const node = icon(spec.name, 'icon icon--sm');
  node.setAttribute('style', spec.name === 'alert' ? 'color:var(--danger)' : '');
  wrap.append(node);
  if (message.state === 'read') wrap.classList.add('ticks--read');
  wrap.title = spec.title;
  if (message.state === 'failed') {
    wrap.style.cursor = 'pointer';
    wrap.addEventListener('click', () => retry(message));
  }
  return wrap;
}

function reactionRow(message) {
  const row = el('div', { class: 'reactions', style: { marginTop: '4px' } });
  for (const reaction of message.reactions) {
    row.append(
      el('button', {
        class: 'reaction' + (reaction.mine ? ' reaction--mine' : ''),
        title: reaction.mine ? 'Убрать реакцию' : 'Поставить реакцию',
        onclick: () => toggleReaction(message, reaction.emoji),
      }, el('span', { text: reaction.emoji }), el('b', { text: String(reaction.count) }))
    );
  }
  return row;
}

/* ------------------------------------------------------------- reactions --- */
function openReactions(anchor, message) {
  const grid = el('div', { class: 'emoji-grid', style: { gridTemplateColumns: 'repeat(4, 34px)' } });
  for (const emoji of REACTIONS) {
    grid.append(
      el('button', {
        text: emoji,
        onclick: () => {
          toggleReaction(message, emoji);
          closePopover();
        },
      })
    );
  }
  popover(anchor, grid, { align: 'end' });
}

function toggleReaction(message, emoji) {
  const list = message.reactions ? [...message.reactions] : [];
  const at = list.findIndex((r) => r.emoji === emoji);
  if (at === -1) list.push({ emoji, mine: true, count: 1 });
  else if (list[at].mine) {
    list[at].count -= 1;
    if (list[at].count <= 0) list.splice(at, 1);
  } else {
    list[at].mine = true;
    list[at].count += 1;
  }
  const reactions = list.map((r) => ({ emoji: r.emoji, count: r.count, mine: r.mine }));
  S.patchMessage(message.peerId, message.id, { reactions });
  patchNode(message.peerId, message.id);
  if (message.dir === 'out' && net.isConnected(message.peerId)) {
    net.send(message.peerId, { t: 'msg', m: { ...message, reactions, patch: true } }).catch(() => {});
  }
}

export function applyReaction(peerId, incoming) {
  const list = incoming.reactions ? [...incoming.reactions] : [];
  const message = S.patchMessage(peerId, incoming.id, { reactions: list });
  if (message) patchNode(peerId, incoming.id);
}

/* ------------------------------------------------------------ live patch --- */
export function patchNode(peerId, id) {
  const message = S.findMessage(peerId, id);
  const node = nodes.get(id);
  if (!message || !node) return;
  const row = node;
  const bubble = row.querySelector('[data-bubble]');
  if (!bubble) return;

  bubble.classList.toggle('bubble--deleted', Boolean(message.deleted));
  const textNode = bubble.querySelector('.bubble__text');
  if (message.deleted) {
    if (textNode) textNode.textContent = 'Сообщение удалено';
  } else if (textNode && message.text) {
    textNode.innerHTML = renderText(message.text);
  }

  // reactions
  const existing = bubble.querySelector('.reactions');
  if (existing) existing.remove();
  if (message.reactions && message.reactions.length && !message.deleted) {
    bubble.append(reactionRow(message));
  }

  // progress
  const live = transfers.get(message.id);
  let bar = bubble.querySelector('.progress');
  if (live && !(message.dir === 'in' && live.done)) {
    const fresh = progressBar(live, message);
    if (bar) bar.replaceWith(fresh);
    else bubble.append(fresh);
  } else if (bar && !live) {
    bar.remove();
  }

  const meta = row.querySelector('.meta');
  if (meta) meta.replaceWith(metaRow(message));
}

/* ------------------------------------------------------------- composer --- */
function onInput() {
  autoGrow(composerInput);
  const hasText = composerInput.value.trim().length > 0;
  composerInput.closest('.composer__box').querySelector('.composer__send').disabled = !hasText && !replyTo;
  if (!S.state.settings.typing || !currentId) return;
  const now = Date.now();
  if (now - lastTypingSent > 1800) {
    lastTypingSent = now;
    net.sendTyping(currentId, true);
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    if (currentId) net.sendTyping(currentId, false);
  }, 2600);
}

function onKeyDown(event) {
  if (event.key === 'Enter' && !event.shiftKey && S.state.settings.enterToSend) {
    event.preventDefault();
    submit();
  }
  if (event.key === 'Escape' && replyTo) {
    event.preventDefault();
    cancelReply();
  }
  if (event.key === 'ArrowUp' && !composerInput.value.trim() && !event.shiftKey) {
    const list = S.messages(currentId).filter((m) => m.dir === 'out' && m.text && !m.deleted);
    const last = list[list.length - 1];
    if (last) {
      event.preventDefault();
      startEdit(last);
    }
  }
}

function onPaste(event) {
  const items = [...(event.clipboardData?.items || [])];
  const files = items
    .filter((i) => i.kind === 'file')
    .map((i) => i.getAsFile())
    .filter(Boolean);
  if (files.length) {
    event.preventDefault();
    sendFiles(files);
  }
}

async function submit() {
  const text = composerInput.value.trim();
  if (editing) {
    const { message, original } = editing;
    const next = text;
    cancelEdit();
    if (next && next !== original) {
      S.patchMessage(message.peerId, message.id, { text: next, editedAt: Date.now() });
      patchNode(message.peerId, message.id);
      if (message.dir === 'out') {
        net.send(message.peerId, { t: 'msg', m: { ...message, text: next, editedAt: Date.now(), patch: true } }).catch(() => {});
      }
    }
    return;
  }
  if (!text || !currentId) return;
  composerInput.value = '';
  autoGrow(composerInput);
  composerInput.closest('.composer__box').querySelector('.composer__send').disabled = true;
  const quote = replyTo;
  cancelReply();
  await sendText(text, quote);
}

export async function sendText(text, quote) {
  const peerId = currentId;
  if (!peerId) return null;
  const message = {
    id: S.newMessageId(),
    peerId,
    dir: 'out',
    kind: 'text',
    text,
    ts: Date.now(),
    state: 'sending',
    reactions: [],
    replyTo: quote ? { id: quote.id, name: quote.dir === 'out' ? 'Вы' : quote.authorName || S.contactName(peerId), text: quote.text } : null,
  };
  S.addMessage(peerId, message);
  scrollToBottom(streamNode, true);
  await transmit(message);
  return message;
}

async function transmit(message) {
  try {
    await net.send(message.peerId, { t: 'msg', m: message });
    if (message.state === 'sending') {
      S.patchMessage(message.peerId, message.id, { state: 'sent' });
      patchNode(message.peerId, message.id);
    }
  } catch (err) {
    S.patchMessage(message.peerId, message.id, { state: 'failed', error: err.message });
    patchNode(message.peerId, message.id);
    toast({
      title: 'Не отправлено',
      text: err.message,
      action: { label: 'Повторить', onClick: () => retry(message) },
    });
  }
}

async function retry(message) {
  S.patchMessage(message.peerId, message.id, { state: 'sending' });
  patchNode(message.peerId, message.id);
  await transmit(message);
}

function startReply(message) {
  if (!composerInput) return;
  replyTo = message;
  const bar = host.querySelector('.composer__reply');
  clear(bar);
  bar.classList.remove('hidden');
  bar.append(
    el('span', { class: 'field__label', text: 'Ответ' }),
    el('span', { class: 'truncate', text: (message.authorName || S.contactName(message.peerId)) + ': ' + (message.text || 'вложение') }),
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn btn--ghost btn--icon btn--sm', title: 'Отменить', onclick: cancelReply }, icon('x', 'icon icon--sm'))
  );
  composerInput.focus();
}

function cancelReply() {
  replyTo = null;
  const bar = host?.querySelector('.composer__reply');
  if (bar) {
    bar.classList.add('hidden');
    clear(bar);
  }
}

function startEdit(message) {
  if (!composerInput) return;
  editing = { message, original: message.text };
  composerInput.value = message.text || '';
  composerInput.placeholder = 'Изменить сообщение…';
  autoGrow(composerInput);
  const box = host.querySelector('.composer__box');
  box.querySelector('.composer__send').disabled = false;
  const bar = host.querySelector('.composer__reply');
  clear(bar);
  bar.classList.remove('hidden');
  bar.append(
    el('span', { class: 'field__label', text: 'Правка' }),
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn btn--ghost btn--sm', text: 'Отмена', onclick: cancelEdit })
  );
  composerInput.focus();
  composerInput.setSelectionRange(9999, 9999);
}

function cancelEdit() {
  editing = null;
  if (!composerInput) return;
  composerInput.value = '';
  composerInput.placeholder = 'Написать сообщение…';
  autoGrow(composerInput);
  const bar = host?.querySelector('.composer__reply');
  if (bar) {
    bar.classList.add('hidden');
    clear(bar);
  }
}

function deleteMessage(message) {
  S.patchMessage(message.peerId, message.id, { deleted: true, text: '', file: message.file, reactions: [] });
  patchNode(message.peerId, message.id);
  if (message.dir === 'out') {
    net.send(message.peerId, { t: 'msg', m: { ...message, deleted: true, patch: true } }).catch(() => {});
  }
}

function messageMenu(message, x, y) {
  const items = [];
  if (!message.deleted) {
    if (message.dir === 'in') {
      items.push({ label: 'Реакция', icon: 'smile', onClick: () => toggleReaction(message, '👍') });
      items.push({ label: 'Ответить', icon: 'reply', onClick: () => startReply(message) });
      if (message.file?.id) {
        items.push({
          label: 'Сохранить файл',
          icon: 'download',
          onClick: () => window.mouth.files.open(message.file.id, message.file.name),
        });
        items.push({
          label: 'Показать в папке',
          icon: 'folder',
          onClick: () => window.mouth.files.reveal(message.file.id, message.file.name),
        });
      }
    } else {
      items.push({ label: 'Изменить', icon: 'edit', onClick: () => startEdit(message) });
      items.push({ label: 'Ответить', icon: 'reply', onClick: () => startReply(message) });
    }
  }
  items.push({ type: 'sep' });
  items.push({
    label: 'Копировать текст',
    icon: 'copy',
    disabled: !message.text,
    onClick: () => navigator.clipboard?.writeText(message.text || ''),
  });
  items.push({ label: 'Удалить', icon: 'trash', danger: true, onClick: () => deleteMessage(message) });
  contextMenu(x, y, items);
}

/* ---------------------------------------------------------------- emoji --- */
function openEmoji(anchor) {
  const wrap = el('div');
  const grid = el('div', { class: 'emoji-grid' });
  for (const emoji of EMOJI) {
    grid.append(
      el('button', {
        text: emoji,
        onclick: () => {
          insertAtCursor(emoji);
          closePopover();
        },
      })
    );
  }
  wrap.append(grid);
  popover(anchor, wrap, { align: 'end' });
}

function insertAtCursor(text) {
  if (!composerInput) return;
  const start = composerInput.selectionStart ?? composerInput.value.length;
  const end = composerInput.selectionEnd ?? start;
  composerInput.value = composerInput.value.slice(0, start) + text + composerInput.value.slice(end);
  composerInput.focus();
  composerInput.selectionStart = composerInput.selectionEnd = start + text.length;
  onInput();
}

/* -------------------------------------------------------------- files in --- */
let dropInstalled = false;

function setupDrop() {
  if (dropInstalled) return;
  dropInstalled = true;
  const stage = document.getElementById('stage');
  let depth = 0;
  const isFileDrag = (event) => [...(event.dataTransfer?.types || [])].includes('Files');

  window.addEventListener('dragenter', (event) => {
    if (!isFileDrag(event)) return;
    depth++;
    stage.dataset.drop = 'true';
  });
  window.addEventListener('dragover', (event) => {
    if (isFileDrag(event)) event.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) stage.dataset.drop = 'false';
  });
  window.addEventListener('drop', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    depth = 0;
    stage.dataset.drop = 'false';
    const files = [...event.dataTransfer.files];
    if (files.length) sendFiles(files);
  });
}

export async function pickFiles() {
  const picked = await window.mouth.files.pick({ multiple: true });
  if (!picked.length || !currentId) return;
  for (const file of picked) {
    await sendAttachment({
      name: file.name,
      size: file.size,
      path: file.path,
      mime: guessMime(file.name),
    });
  }
}

export function guessMime(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  const table = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    avif: 'image/avif',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    opus: 'audio/opus',
    flac: 'audio/flac',
    mp4: 'video/mp4',
    webm: 'video/webm',
    pdf: 'application/pdf',
    txt: 'text/plain',
    json: 'application/json',
    zip: 'application/zip',
  };
  return table[ext] || 'application/octet-stream';
}

export async function sendFiles(fileList) {
  for (const file of fileList) {
    const path = window.mouth.files.pathFor ? window.mouth.files.pathFor(file) : '';
    await sendAttachment({
      name: file.name,
      size: file.size,
      path: path || undefined,
      blob: path ? null : file,
      mime: file.type || guessMime(file.name),
      width: file.width,
      height: file.height,
    });
  }
}

export async function sendAttachment({ name, size, path, blob, mime, width, height }) {
  const peerId = currentId;
  if (!peerId) return null;
  const kind = fileKind(name, mime);
  const id = S.newMessageId();
  const message = {
    id,
    peerId,
    dir: 'out',
    kind: kind === 'image' ? 'image' : kind === 'audio' ? 'audio' : 'file',
    text: '',
    ts: Date.now(),
    state: 'sending',
    reactions: [],
    file: { id, name, size, mime, kind, w: width, h: height },
  };
  S.addMessage(peerId, message);
  scrollToBottom(streamNode, true);
  transfers.set(id, { dir: 'out', sent: 0, received: 0, total: size });
  patchNode(peerId, id);

  // keep a local copy so the sender sees the same bubble as the receiver
  try {
    const payload = { id, name, path: path || '' };
    if (!path && blob) payload.bytes = new Uint8Array(await blob.arrayBuffer());
    if (await window.mouth.files.store(payload)) {
      S.patchMessage(peerId, id, { file: { ...message.file, has: true } });
    }
  } catch {
    /* preview will fall back to a plain attachment card */
  }

  if (!net.isConnected(peerId)) {
    transfers.delete(id);
    S.patchMessage(peerId, id, { state: 'failed', error: 'Нет соединения' });
    patchNode(peerId, id);
    toast({ title: 'Файл не отправлен', text: 'Нет соединения с контактом' });
    return null;
  }

  const source = { path, blob, size };
  try {
    await net.sendFile(
      peerId,
      {
        name,
        size,
        mime,
        read: (offset, length) => readChunk(source, offset, length),
      },
      message
    );
  } catch (err) {
    transfers.delete(id);
    S.patchMessage(peerId, id, { state: 'failed', error: err.message });
    patchNode(peerId, id);
    return null;
  }
  return message;
}

/** Chunk reader that works both for IPC paths and in-memory blobs. */
export async function readChunk(source, offset, length) {
  if (source.path) return window.mouth.files.read(source.path, offset, length);
  if (source.blob) {
    const slice = source.blob.slice(offset, offset + length);
    return new Uint8Array(await slice.arrayBuffer());
  }
  throw new Error('Источник файла недоступен');
}

/* -------------------------------------------------------------- receipts --- */
export function markRead(peerId) {
  const list = S.messages(peerId).filter((m) => m.dir === 'in' && m.state !== 'read');
  S.clearUnread(peerId);
  if (!list.length || !net.isConnected(peerId)) return;
  const ids = list.map((m) => m.id);
  net.sendReceipt(peerId, ids, 'read');
  for (const id of ids) S.patchMessage(peerId, id, { state: 'read' });
}

export function onVisible() {
  if (currentId && !document.hidden) markRead(currentId);
}

/* ------------------------------------------------------------- lightbox --- */
export function openLightbox(url, file) {
  const box = document.getElementById('lightbox');
  clear(box);
  const bar = el('div', { class: 'lightbox__bar' });
  if (file?.id) {
    bar.append(
      el('button', {
        class: 'btn btn--ghost btn--icon',
        title: 'Открыть в системном приложении',
        onclick: (event) => {
          event.stopPropagation();
          window.mouth.files.open(file.id, file.name);
        },
      }, icon('external'))
    );
  }
  bar.append(
    el('button', { class: 'btn btn--ghost btn--icon', title: 'Закрыть (Esc)' }, icon('x'))
  );
  box.append(bar, el('img', { src: url, alt: file?.name || '' }));
  if (file?.name) box.append(el('div', { class: 'lightbox__cap', text: file.name + ' · ' + bytes(file.size) }));
  box.dataset.open = 'true';
  const close = () => {
    box.dataset.open = 'false';
    setTimeout(() => clear(box), 180);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  box.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  box.querySelector('.lightbox__bar').addEventListener('click', (e) => e.stopPropagation());
}

/* ---------------------------------------------------------- chat search --- */
export function openChatSearch(peerId) {
  const results = el('div', { class: 'list', style: { maxHeight: '320px', padding: '0' } });
  const input = el('input', { class: 'input', placeholder: 'Найти в переписке…' });
  const counter = el('span', { class: 'field__hint' });

  const run = () => {
    const query = input.value.trim().toLowerCase();
    clear(results);
    const list = S.messages(peerId).filter((m) => m.text && !m.deleted);
    const found = query
      ? list.filter((m) => m.text.toLowerCase().includes(query))
      : list.slice(-40).reverse();
    counter.textContent = query ? `Найдено: ${found.length}` : 'Последние сообщения';
    for (const message of found) {
      results.append(
        el('button', {
          class: 'crow',
          onclick: () => {
            handle.close();
            if (currentId === peerId) highlight(message.id);
            else S.emit('open-chat', peerId);
          },
        },
          el('div', { class: 'crow__body' },
            el('div', { class: 'crow__top' },
              el('span', { class: 'crow__name truncate', text: message.authorName || (message.dir === 'out' ? 'Вы' : S.contactName(peerId)) }),
              el('span', { class: 'crow__time', text: listTime(message.ts) })),
            el('div', { class: 'crow__sub clamp-2', text: message.text })))
      );
    }
    if (!found.length) results.append(el('div', { class: 'empty', text: 'Ничего не найдено' }));
  };

  const handle = openModal({
    title: 'Поиск в чате',
    subtitle: S.contactName(peerId),
    size: 'wide',
    body: el('div', { class: 'stack', style: { gap: '10px' } }, input, counter, results),
    footer: () => [el('div', { class: 'spacer' }), el('button', { class: 'btn', text: 'Закрыть', onclick: () => handle.close() })],
  });
  input.addEventListener('input', throttle(run, 120));
  run();
}

/* --------------------------------------------------------------- typing --- */
export function setPeerTyping(peerId, on) {
  if (on) S.setTyping(peerId, true);
  else S.setTyping(peerId, false);
  if (peerId === currentId) paintStatus(peerId);
}

let typingRow = null;
export function renderTyping(peerId) {
  if (!innerNode) return;
  if (typingRow) {
    typingRow.remove();
    typingRow = null;
  }
  if (peerId !== currentId || !S.isTyping(peerId)) return;
  typingRow = el('div', { class: 'typing' },
    el('span', { class: 'typing__dots' }, el('i'), el('i'), el('i')),
    el('span', { text: S.contactName(peerId) + ' печатает' }));
  innerNode.append(typingRow);
  scrollIfPinned();
}
