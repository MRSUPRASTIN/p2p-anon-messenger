/** Sidebar: search, filters and the conversation list. */
import { el, clear, icon, avatar, listTime, bytes, clamp } from '../util.js';
import * as S from '../state.js';
import { net } from '../app.js';
import { contextMenu, toast } from './overlay.js';

let listNode = null;
let footNode = null;
let filterNode = null;
let searchInput = null;

const FILTERS = [
  { id: 'all', label: 'Все' },
  { id: 'unread', label: 'Непрочитанные' },
  { id: 'online', label: 'В сети' },
  { id: 'files', label: 'Файлы' },
];

export function init() {
  listNode = document.getElementById('chatList');
  footNode = document.getElementById('sidebarFoot');
  filterNode = document.getElementById('filters');
  searchInput = document.getElementById('search');
  const wrap = document.getElementById('searchWrap');
  const clearBtn = document.getElementById('searchClear');

  for (const filter of FILTERS) {
    filterNode.append(
      el('button', {
        class: 'filter',
        text: filter.label,
        'aria-pressed': String(S.state.filter === filter.id),
        dataset: { id: filter.id },
        onclick: () => {
          S.setFilter(filter.id);
          for (const node of filterNode.children) {
            node.setAttribute('aria-pressed', String(node.dataset.id === filter.id));
          }
          render();
        },
      })
    );
  }

  searchInput.addEventListener('input', () => {
    const value = searchInput.value;
    wrap.dataset.filled = value ? 'true' : 'false';
    S.setQuery(value);
    render();
  });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      searchInput.value = '';
      wrap.dataset.filled = 'false';
      S.setQuery('');
      render();
    }
  });
  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    wrap.dataset.filled = 'false';
    S.setQuery('');
    searchInput.focus();
    render();
  });

  render();
}

export function focusSearch() {
  searchInput?.focus();
  searchInput?.select();
}

/* ---------------------------------------------------------------- render --- */
function matches(contact, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  if (contact.name.toLowerCase().includes(q)) return true;
  if ((contact.note || '').toLowerCase().includes(q)) return true;
  return S.messages(contact.id).some((m) => m.text && m.text.toLowerCase().includes(q));
}

function passes(contact) {
  const filter = S.state.filter;
  if (filter === 'unread') return S.unreadCount(contact.id) > 0;
  if (filter === 'online') return net.isConnected(contact.id);
  if (filter === 'files') return S.messages(contact.id).some((m) => m.file);
  return true;
}

function preview(contact) {
  const list = S.messages(contact.id);
  const last = list[list.length - 1];
  if (!last) {
    const state = net.state(contact.id);
    if (state === 'connecting') return { text: 'соединение…', cls: 'crow__sub' };
    return { text: 'Нет сообщений', cls: 'crow__sub' };
  }
  if (last.deleted) return { text: 'Сообщение удалено', cls: 'crow__sub' };
  let text = last.text || '';
  if (last.file) {
    const kind = last.file.kind === 'image' ? '🖼' : last.file.kind === 'audio' ? '🎵' : '📎';
    text = (text ? text + ' · ' : '') + kind + ' ' + last.file.name;
  }
  if (last.state === 'sending') text = '… ' + text;
  if (last.state === 'failed') text = '⚠ не отправлено';
  return { text, cls: 'crow__sub', mine: last.dir === 'out' };
}

export function render() {
  if (!listNode) return;
  const scrollTop = listNode.scrollTop;
  clear(listNode);
  const query = S.state.query.trim();

  const contacts = S.contactList()
    .filter((c) => matches(c, query) && passes(c))
    .map((c) => {
      const last = S.messages(c.id)[S.messages(c.id).length - 1];
      return {
        contact: c,
        ts: last ? last.ts : c.lastSeen || c.createdAt,
        online: net.isConnected(c.id),
        unread: S.unreadCount(c.id),
        pinned: c.pinned,
      };
    })
    .sort((a, b) => (b.pinned - a.pinned) || (b.online - a.online) || b.ts - a.ts);

  if (!contacts.length) {
    listNode.append(
      el('div', { class: 'empty' },
        el('div', { class: 'empty__art' }, icon(query ? 'search' : 'chat', 'icon')),
        el('h3', { text: query ? 'Ничего не найдено' : 'Пока нет чатов' }),
        el('p', {
          text: query
            ? 'Попробуйте другое имя или текст сообщения'
            : 'Откройте «В сети», чтобы найти собеседников в локальной сети, или пригласите друга кодом',
        }),
        !query &&
          el('button', {
            class: 'btn btn--soft btn--sm',
            text: 'Найти в сети',
            onclick: () => S.emit('go-section', 'discover'),
          }))
    );
    renderFoot();
    return;
  }

  let group = null;
  for (const row of contacts) {
    const next = row.pinned ? 'pinned' : row.online ? 'online' : row.ts ? 'recent' : 'empty';
    if (next !== group) {
      group = next;
      const labels = {
        pinned: 'Закреплённые',
        online: 'В сети',
        recent: 'Недавние',
        empty: 'Контакты',
      };
      if (!(query && row.pinned)) listNode.append(el('div', { class: 'list__group', text: labels[next] }));
    }
    listNode.append(rowNode(row));
  }
  listNode.scrollTop = scrollTop;
  renderFoot();
}

function rowNode(row) {
  const { contact } = row;
  const pre = preview(contact);
  const sub = el('span', { class: 'truncate', text: (row.online ? '● ' : '') + pre.text });
  if (S.isTyping(contact.id)) {
    sub.className = 'truncate crow__typing';
    sub.textContent = 'печатает…';
  } else if (pre.mine) {
    sub.textContent = 'Вы: ' + sub.text;
  }
  if (row.unread) sub.classList.add('crow__unread');

  const body = el('div', { class: 'crow__body' },
    el('div', { class: 'crow__top' },
      el('span', { class: 'crow__name truncate', text: contact.name }),
      el('span', { class: 'crow__time', text: listTime(row.ts) })),
    el('div', { class: pre.cls }, sub));

  return el('button', {
    class: 'crow',
    role: 'option',
    'aria-selected': String(S.state.activeId === contact.id),
    onclick: () => S.emit('open-chat', contact.id),
    oncontextmenu: (event) => {
      event.preventDefault();
      rowMenu(contact, event.clientX, event.clientY);
    },
  },
    avatar(contact.name, {
      size: 'sm',
      seed: contact.id,
      color: contact.color,
      status: row.online ? 'on' : net.state(contact.id) === 'connecting' ? 'busy' : '',
    }),
    body,
    row.unread ? el('span', { class: 'crow__badge', text: String(row.unread) }) : null
  );
}

function rowMenu(contact, x, y) {
  const online = net.isConnected(contact.id);
  contextMenu(x, y, [
    { type: 'label', label: contact.name },
    {
      label: contact.pinned ? 'Открепить' : 'Закрепить',
      icon: 'star',
      onClick: () => S.patchContact(contact.id, { pinned: !contact.pinned }),
    },
    {
      label: 'Прочитать и снять счётчик',
      icon: 'check',
      onClick: () => S.setUnread(contact.id, 0),
    },
    { type: 'sep' },
    online
      ? { label: 'Отключиться', icon: 'ban', onClick: () => net.hangup(contact.id) }
      : { label: 'Подключиться', icon: 'refresh-cw', onClick: () => S.emit('connect', contact.id) },
    { label: 'Информация', icon: 'info', onClick: () => S.emit('open-info', contact.id) },
    { type: 'sep' },
    { label: 'Удалить контакт и чат', icon: 'trash', danger: true, onClick: () => S.emit('delete-contact', contact.id) },
  ]);
}

function renderFoot() {
  if (!footNode) return;
  clear(footNode);
  const connected = S.contactList().filter((c) => net.isConnected(c.id)).length;
  const nearby = S.state.discovered.size;
  footNode.append(
    el('i', { class: 'dot ' + (connected ? 'dot--on' : '') }),
    el('span', { text: connected ? `в сети: ${connected}` : 'никого нет в сети' }),
    el('div', { class: 'spacer' }),
    nearby ? el('span', { text: `рядом: ${nearby}` }) : null
  );
}

export function refresh() {
  render();
}
