/** Section views: contacts, discover, settings, plus profile/invite modals. */
import {
  el,
  clear,
  icon,
  avatar,
  relTime,
  copyText,
} from '../util.js';
import { shortFingerprint } from '../crypto.js';
import * as S from '../state.js';
import { net } from '../app.js';
import { toast, openModal, confirmDialog, contextMenu } from './overlay.js';
import { AVATAR_EMOJI } from './emoji.js';
import { openInfo } from './info.js';
import { openInvite } from './invite.js';

const ACCENTS = [
  { name: 'Фиолетовый', h: 253 },
  { name: 'Индиго', h: 232 },
  { name: 'Голубой', h: 199 },
  { name: 'Бирюзовый', h: 172 },
  { name: 'Зелёный', h: 142 },
  { name: 'Лаймовый', h: 84 },
  { name: 'Жёлтый', h: 44 },
  { name: 'Оранжевый', h: 24 },
  { name: 'Розовый', h: 330 },
  { name: 'Красный', h: 0 },
];

export function accentHue(hexColor) {
  if (!hexColor) return 253;
  const value = hexColor.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return 253;
  const d = max - min;
  const sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return Math.round(h * 360);
}

export function applyTheme() {
  const { theme, accent } = S.state.settings;
  document.documentElement.dataset.theme = theme === 'auto'
    ? window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
    : theme;
  const hue = accentHue(accent);
  document.documentElement.style.setProperty('--accent-h', String(hue));
  document.documentElement.style.setProperty('--accent-s', '88%');
  document.documentElement.style.setProperty('--accent', `hsl(${hue} 88% 63%)`);
  document.documentElement.style.setProperty('--accent-2', `hsl(${(hue + 60) % 360} 82% 62%)`);
}

/* ================================================================ contacts === */
export function renderContacts(view) {
  clear(view);
  view.className = 'view view--pad';
  const contacts = S.contactList().sort((a, b) => (b.pinned - a.pinned) || a.name.localeCompare(b.name, 'ru'));

  view.append(
    el('div', { class: 'page-head' },
      el('h2', { text: 'Контакты' }),
      el('p', { text: 'Все, кто когда-либо присутствовал в вашей локальной сети или был добавлен по коду приглашения. Отпечатки хранятся локально и никогда не отправляются в открытом виде.' }))
  );

  if (!contacts.length) {
    view.append(
      el('div', { class: 'card' },
        el('div', { class: 'empty' },
          el('div', { class: 'empty__art' }, icon('users', 'icon')),
          el('h3', { text: 'Контактов пока нет' }),
          el('p', { text: 'Запустите p2pAnon на втором компьютере в той же сети — собеседник появится здесь сам. Либо пригласите удалённо кодом: он работает между любыми сетями и без сервера.' }),
          el('div', { class: 'row', style: { gap: '8px' } },
            el('button', { class: 'btn btn--primary', text: 'Найти в сети', onclick: () => S.emit('go-section', 'discover') }),
            el('button', { class: 'btn', text: 'Пригласить кодом', onclick: () => openInvite() }))))
    );
    return;
  }

  const grid = el('div', { class: 'peer-grid' });
  for (const contact of contacts) {
    const online = net.isConnected(contact.id);
    grid.append(
      el('div', { class: 'peer' },
        el('div', { class: 'peer__top' },
          avatar(contact.name, { size: 'lg', seed: contact.id, color: contact.color, status: online ? 'on' : net.state(contact.id) === 'connecting' ? 'busy' : '' }),
          el('div', { class: 'stack', style: { gap: '2px', minWidth: '0' } },
            el('div', { class: 'peer__name truncate', text: contact.name + (contact.pinned ? ' ★' : '') }),
            el('div', { class: 'peer__meta', text: online ? 'в сети' : contact.lastSeen ? 'был(а) ' + relTime(contact.lastSeen) : 'ещё не в сети' }))),
        el('div', { class: 'peer__meta truncate mono', text: shortFingerprint(contact.fingerprint) }),
        el('div', { class: 'peer__foot' },
          el('button', { class: 'btn btn--sm btn--soft', text: 'Открыть чат', onclick: () => S.emit('open-chat', contact.id) }),
          el('button', { class: 'btn btn--sm', text: 'Инфо', onclick: () => openInfo(contact.id) }),
          el('div', { class: 'spacer' }),
          contact.verified ? el('span', { class: 'chip chip--ok', text: 'сверен' }) : null))
    );
  }
  view.append(el('div', { class: 'card' }, el('div', { class: 'card__body' }, grid)));
}

/* =============================================================== discover === */
export function renderDiscover(view) {
  clear(view);
  view.className = 'view view--pad';

  const found = [...S.state.discovered.values()].sort((a, b) => b.at - a.at);
  const online = S.contactList().filter((c) => net.isConnected(c.id));

  view.append(
    el('div', { class: 'page-head' },
      el('h2', { text: 'В сети' }),
      el('p', { text: 'p2pAnon рассылает UDP-подсветку каждые 4 секунды. Никаких серверов: найденные устройства — это ваша локальная сеть, соединение поднимается напрямую по WebRTC. Для других сетей есть приглашение кодом.' }))
  );

  const actions = el('div', { class: 'row', style: { gap: '8px', marginBottom: '16px', flexWrap: 'wrap' } },
    el('button', { class: 'btn btn--primary', onclick: () => openInvite() }, icon('qr'), 'Пригласить кодом'),
    el('button', { class: 'btn', onclick: () => S.emit('open-paste') }, icon('copy'), 'Вставить код'),
    el('div', { class: 'spacer' }),
    el('span', { class: 'chip' }, icon('radar', 'icon icon--sm'),
      el('span', { text: `UDP 45311 · найдено ${found.length}` }))
  );
  view.append(actions);

  if (online.length) {
    view.append(
      el('div', { class: 'card', style: { marginBottom: '16px' } },
        el('div', { class: 'card__head' }, icon('check-double', 'icon'), el('h3', { text: 'Подключены сейчас' })),
        el('div', { class: 'card__body' },
          el('div', { class: 'peer-grid' }, ...online.map((c) => peerCard(c, true)))))
    );
  }

  const unknown = found.filter((p) => !S.contact(p.id));
  view.append(
    el('div', { class: 'card' },
      el('div', { class: 'card__head' },
        icon('radar', 'icon'),
        el('h3', { text: 'Обнаружены в локальной сети' }),
        el('div', { class: 'spacer' }),
        el('span', { class: 'chip', text: String(unknown.length) })),
      el('div', { class: 'card__body' },
        unknown.length
          ? el('div', { class: 'peer-grid' }, ...unknown.map((p) => peerCard(p, false)))
          : el('div', { class: 'empty' },
              el('div', { class: 'empty__art' }, icon('radar', 'icon')),
              el('h3', { text: 'Пока никого не видно' }),
              el('p', { text: 'Откройте p2pAnon на другом устройстве в той же сети Wi-Fi или Ethernet. Если сеть блокирует broadcast-пакеты, воспользуйтесь приглашением кодом — оно работает между любыми сетями.' }))))
  );
}

function peerCard(peer, isContact) {
  const name = isContact ? peer.name : peer.name;
  const sub = isContact
    ? net.state(peer.id) === 'connecting' ? 'соединение…' : 'в сети'
    : peer.addr || 'локальная сеть';
  return el('div', { class: 'peer' },
    el('div', { class: 'peer__top' },
      avatar(name, { size: 'lg', seed: peer.id, color: peer.color, status: 'on' }),
      el('div', { class: 'stack', style: { gap: '2px', minWidth: '0' } },
        el('div', { class: 'peer__name truncate', text: name }),
        el('div', { class: 'peer__meta', text: sub }))),
    el('div', { class: 'peer__foot' },
      isContact
        ? el('button', { class: 'btn btn--sm btn--soft', text: 'Открыть', onclick: () => S.emit('open-chat', peer.id) })
        : el('button', {
            class: 'btn btn--sm btn--primary',
            text: 'Подключить',
            onclick: async () => {
              S.upsertContact({
                id: peer.id,
                name: peer.name,
                color: peer.color,
                emoji: peer.emoji,
                pubRaw: '',
                fingerprint: '',
                lan: true,
              });
              await S.emit('connect', peer.id);
            },
          }),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn btn--sm btn--ghost', title: 'Инфо', onclick: () => openInfo(peer.id) }, icon('info', 'icon icon--sm'))));
}

/* ================================================================ settings === */
export function renderSettings(view) {
  clear(view);
  view.className = 'view view--pad';
  const s = S.state.settings;
  const me = S.state.profile;

  view.append(
    el('div', { class: 'page-head' },
      el('h2', { text: 'Настройки' }),
      el('p', { text: 'Всё хранится локально в userData. Никакой телеметрии, аккаунтов и облачных копий.' }))
  );

  /* profile */
  const nameInput = el('input', { class: 'input', value: me?.name || '', maxlength: 40, placeholder: 'Как вас зовут' });
  nameInput.addEventListener('change', () => {
    const value = nameInput.value.trim() || 'Anonymous';
    S.setProfile({ name: value });
    net.updateProfile({ name: value });
    S.emit('profile-changed');
  });
  const bioInput = el('input', { class: 'input', value: me?.bio || '', maxlength: 80, placeholder: 'Пара слов о себе' });
  bioInput.addEventListener('change', () => {
    S.setProfile({ bio: bioInput.value.trim() });
    net.updateProfile({ bio: bioInput.value.trim() });
  });

  const emojiRow = el('div', { class: 'emoji-picker' });
  const paintEmoji = () => {
    clear(emojiRow);
    for (const emoji of AVATAR_EMOJI) {
      emojiRow.append(
        el('button', {
          class: 'emoji-pick',
          text: emoji,
          'aria-pressed': String((me?.emoji || '') === emoji),
          onclick: () => {
            S.setProfile({ emoji });
            net.updateProfile({ emoji });
            paintEmoji();
            S.emit('profile-changed');
          },
        })
      );
    }
  };
  paintEmoji();

  const accentRow = el('div', { class: 'accent-picker' });
  const paintAccents = () => {
    clear(accentRow);
    for (const accent of ACCENTS) {
      const button = el('button', {
        class: 'accent-dot',
        style: { background: `hsl(${accent.h} 88% 63%)`, color: `hsl(${accent.h} 88% 63%)` },
        title: accent.name,
        'aria-pressed': String(accentHue(s.accent) === accent.h),
        onclick: () => {
          S.setSettings({ accent: `hsl(${accent.h} 88% 63%)` });
          applyTheme();
          paintAccents();
        },
      });
      accentRow.append(button);
    }
  };
  paintAccents();

  view.append(
    el('div', { class: 'card', style: { marginBottom: '16px' } },
      el('div', { class: 'card__head' }, icon('at', 'icon'), el('h3', { text: 'Профиль' })),
      el('div', { class: 'card__body' },
        el('div', { class: 'row', style: { gap: '14px', alignItems: 'flex-start' } },
          el('div', { class: 'stack', style: { gap: '8px', alignItems: 'center' } },
            avatar(me?.name || '?', { size: 'xl', seed: me?.id, emoji: me?.emoji }),
            el('span', { class: 'field__hint', text: 'Аватар' })),
          el('div', { class: 'stack', style: { gap: '12px', flex: '1', minWidth: '0' } },
            el('label', { class: 'field' }, el('span', { class: 'field__label', text: 'Имя' }), nameInput),
            el('label', { class: 'field' }, el('span', { class: 'field__label', text: 'О себе' }), bioInput),
            el('div', { class: 'field' }, el('span', { class: 'field__label', text: 'Эмодзи-аватар' }), emojiRow),
            el('div', { class: 'field' }, el('span', { class: 'field__label', text: 'Акцент интерфейса' }), accentRow))))
    )
  );

  /* behaviour */
  const toggle = (key, title, hint) => {
    const sw = el('button', {
      class: 'switch',
      role: 'switch',
      'aria-checked': String(Boolean(s[key])),
      onclick: () => {
        const next = !S.state.settings[key];
        S.setSettings({ [key]: next });
        sw.setAttribute('aria-checked', String(next));
        net.setSettings(S.state.settings);
        if (key === 'autostart') window.mouth.app.autostart(next);
      },
    });
    return el('div', { class: 'settings-row' },
      el('div', { class: 'settings-row__text' }, el('strong', { text: title }), el('span', { text: hint })),
      sw);
  };

  view.append(
    el('div', { class: 'card', style: { marginBottom: '16px' } },
      el('div', { class: 'card__head' }, icon('settings', 'icon'), el('h3', { text: 'Поведение' })),
      el('div', { class: 'card__body', style: { gap: '0' } },
        toggle('notifications', 'Уведомления', 'Показывать системные уведомления о новых сообщениях'),
        toggle('readReceipts', 'Отметки о прочтении', 'Отправлять собеседнику, что вы прочитали сообщение'),
        toggle('typing', 'Индикатор набора', 'Показывать «печатает…» в обе стороны'),
        toggle('enterToSend', 'Enter отправляет', 'Shift+Enter — перенос строки'),
        toggle('lanDiscovery', 'Поиск в локальной сети', 'UDP-подсветка на порт 45311. Выключите, если не доверяете сети'),
        toggle('autoConnect', 'Автоподключение', 'Переподключаться к известным контактам самим'),
        toggle('minimiseToTray', 'Сворачивать в трей', 'Закрытие окна прячет приложение'),
        toggle('autostart', 'Запускать при старте Windows', 'В фоне, без окна')))
  );

  /* appearance */
  const themeRow = el('div', { class: 'row', style: { gap: '8px' } });
  for (const theme of ['dark', 'light', 'auto']) {
    themeRow.append(
      el('button', {
        class: 'btn btn--sm' + (s.theme === theme ? ' btn--soft' : ''),
        text: theme === 'dark' ? 'Тёмная' : theme === 'light' ? 'Светлая' : 'Системная',
        onclick: () => {
          S.setSettings({ theme });
          applyTheme();
          renderSettings(view);
        },
      })
    );
  }

  view.append(
    el('div', { class: 'card', style: { marginBottom: '16px' } },
      el('div', { class: 'card__head' }, icon('sun', 'icon'), el('h3', { text: 'Внешний вид' })),
      el('div', { class: 'card__body' },
        el('div', { class: 'field' }, el('span', { class: 'field__label', text: 'Тема' }), themeRow)))
  );

  /* identity + network info */
  const info = S.state.info || {};
  view.append(
    el('div', { class: 'card', style: { marginBottom: '16px' } },
      el('div', { class: 'card__head' }, icon('shield', 'icon'), el('h3', { text: 'Личность и безопасность' })),
      el('div', { class: 'card__body' },
        el('div', { class: 'kv' },
          row('ID', me?.id?.slice(0, 16) + '…'),
          row('Ключ', 'ECDHE P-256'),
          row('Шифрование канала', 'DTLS + AES-256-GCM'),
          row('Отпечаток', shortFingerprint(S.state.identity?.fingerprint)),
          row('Создан', me?.createdAt ? new Date(me.createdAt).toLocaleString('ru-RU') : '—')),
        el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
          el('button', { class: 'btn btn--sm', onclick: () => { copyText(S.state.identity?.fingerprint || ''); toast({ title: 'Отпечаток скопирован' }); } }, icon('copy', 'icon icon--sm'), 'Скопировать отпечаток'),
          el('button', { class: 'btn btn--sm', onclick: () => openInvite() }, icon('qr', 'icon icon--sm'), 'Приглашение кодом'))))
  );

  view.append(
    el('div', { class: 'card', style: { marginBottom: '16px' } },
      el('div', { class: 'card__head' }, icon('info', 'icon'), el('h3', { text: 'О программе' })),
      el('div', { class: 'card__body' },
        el('div', { class: 'kv' },
          row('Версия', info.version || '—'),
          row('Electron', info.electron || '—'),
          row('Chromium', info.chrome || '—'),
          row('UDP-порт', String(info.udpPort || 45311)),
          row('Данные', info.userData || '—')),
        el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
          el('button', { class: 'btn btn--sm', onclick: () => window.mouth.app.openUserData() }, icon('folder', 'icon icon--sm'), 'Открыть папку данных'),
          el('button', {
            class: 'btn btn--sm btn--danger',
            onclick: async () => {
              const ok = await confirmDialog({
                title: 'Сбросить личность?',
                text: 'Будут удалены профиль, контакты, история и файлы. Отменить это нельзя.',
                confirmLabel: 'Удалить всё',
                danger: true,
              });
              if (ok) await window.mouth.app.reset();
            },
          }, icon('trash', 'icon icon--sm'), 'Сбросить личность'))))
  );

  function row(label, value) {
    return el('div', { class: 'kv__row' }, el('span', { text: label }), el('span', { class: 'truncate selectable', text: value }));
  }
}

/* ================================================================ profile === */
export function openProfile() {
  const me = S.state.profile || {};
  const handle = openModal({
    title: 'Мой профиль',
    size: 'slim',
    body: el('div', { class: 'stack', style: { gap: '14px' } },
      el('div', { class: 'row', style: { gap: '14px' } },
        avatar(me.name || '?', { size: 'xl', seed: me.id, color: me.color, emoji: me.emoji }),
        el('div', { class: 'stack', style: { gap: '2px' } },
          el('div', { style: { fontSize: '17px', fontWeight: '650' }, text: me.name || '—' }),
          el('div', { class: 'field__hint', text: me.bio || 'О себе ничего нет' }))),
      el('div', { class: 'kv' },
        el('div', { class: 'kv__row' }, el('span', { text: 'ID' }), el('span', { class: 'truncate', text: me.id || '—' })),
        el('div', { class: 'kv__row' }, el('span', { text: 'Отпечаток' }), el('span', { text: shortFingerprint(S.state.identity?.fingerprint) }))),
      el('div', { class: 'row', style: { gap: '8px' } },
        el('button', {
          class: 'btn btn--primary btn--block',
          onclick: async () => {
            await copyText(S.state.identity?.fingerprint || '');
            toast({ title: 'Отпечаток скопирован', text: 'Сверьте его с собеседником' });
          },
        }, icon('copy'), 'Скопировать отпечаток'),
        el('button', { class: 'btn btn--block', onclick: () => { handle.close(); S.emit('go-section', 'settings'); } }, icon('settings'), 'Настройки'))),
  });
}
