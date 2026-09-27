/** Contact sheet: profile, connection state, safety number. */
import { el, icon, avatar, relTime, listTime, copyText } from '../util.js';
import { shortFingerprint } from '../crypto.js';
import * as S from '../state.js';
import { net } from '../app.js';
import { toast, openModal, confirmDialog, contextMenu, promptDialog } from './overlay.js';

const safetyCache = new Map();

export function openInfo(peerId) {
  const contact = S.contact(peerId) || { id: peerId, name: 'Неизвестный' };
  const online = net.isConnected(peerId);
  const state = net.state(peerId);
  const safety = safetyCache.get(peerId);

  const statusText = online
    ? 'в сети'
    : state === 'connecting'
      ? 'соединение…'
      : contact.lastSeen
        ? 'был(а) ' + relTime(contact.lastSeen)
        : 'не в сети';

  const body = el('div', { class: 'stack', style: { gap: '16px' } });

  body.append(
    el('div', { class: 'row', style: { gap: '14px', alignItems: 'center' } },
      avatar(contact.name, { size: 'xl', seed: contact.id, color: contact.color, emoji: contact.emoji }),
      el('div', { class: 'stack', style: { gap: '4px', minWidth: '0' } },
        el('div', { style: { fontSize: '19px', fontWeight: '660' }, text: contact.name }),
        el('div', { class: 'row', style: { gap: '6px' } },
          el('i', { class: 'dot ' + (online ? 'dot--on' : state === 'connecting' ? 'dot--busy' : '') }),
          el('span', { class: 'field__hint', text: statusText })),
        contact.note ? el('div', { class: 'field__hint', text: contact.note }) : null))
  );

  /* safety number */
  const safetyBox = el('div', { class: 'stack', style: { gap: '8px' } });
  if (safety && safety.length) {
    const grid = el('div', { class: 'fp-grid' });
    for (const group of safety) grid.append(el('div', { class: 'fp-cell', text: group }));
    safetyBox.append(
      el('div', { class: 'field__label', text: 'Код сверки — совпадение означает, что канал не перехвачен' }),
      grid,
      el('div', { class: 'row', style: { gap: '8px' } },
        el('button', {
          class: 'btn btn--sm',
          onclick: async () => {
            await copyText(safety.join(' '));
            toast({ title: 'Код сверки скопирован' });
          },
        }, icon('copy', 'icon icon--sm'), 'Скопировать'),
        contact.verified
          ? el('span', { class: 'chip chip--ok' }, icon('check', 'icon icon--sm'), 'сверен')
          : el('button', {
              class: 'btn btn--sm btn--soft',
              text: 'Отметить как сверенный',
              onclick: () => {
                S.patchContact(peerId, { verified: true });
                toast({ title: 'Отпечаток отмечен как сверенный' });
                handle.close();
              },
            }))
    );
  } else {
    safetyBox.append(
      el('div', { class: 'field__label', text: 'Код сверки появится после соединения' }),
      el('p', { class: 'field__hint', text: 'Он выводится из отпечатков обоих ключей и не может быть подменён посредником.' })
    );
  }
  body.append(el('div', { class: 'card' }, el('div', { class: 'card__body' }, safetyBox)));

  /* facts */
  const kv = el('div', { class: 'kv' });
  const row = (label, value) => el('div', { class: 'kv__row' }, el('span', { text: label }), el('span', { class: 'truncate selectable', text: value }));
  kv.append(
    row('ID', contact.id),
    row('Отпечаток ключа', shortFingerprint(contact.fingerprint || S.state.identity?.fingerprint || '—')),
    row('Добавлен', contact.createdAt ? new Date(contact.createdAt).toLocaleDateString('ru-RU') : '—'),
    row('Канал', online ? (net.peers.get(peerId)?.lan ? 'P2P · локальная сеть' : 'P2P · через STUN') : '—')
  );
  const messages = S.messages(peerId);
  if (messages.length) {
    const files = messages.filter((m) => m.file);
    kv.append(
      row('Сообщений', String(messages.length)),
      row('Файлов', String(files.length)),
      row('Последнее', listTime(messages[messages.length - 1].ts))
    );
  }
  body.append(el('div', { class: 'card' }, el('div', { class: 'card__body' }, kv)));

  const handle = openModal({
    title: contact.name,
    subtitle: 'Карточка контакта',
    body,
    footer: () => [
      el('button', {
        class: 'btn btn--ghost',
        onclick: async () => {
          const name = await promptDialog({ title: 'Переименовать', label: 'Имя', value: contact.name, okLabel: 'Сохранить' });
          if (name && name.trim()) {
            S.patchContact(peerId, { name: name.trim() });
            net.updateProfile({});
            toast({ title: 'Имя изменено', text: 'Собеседник увидит новое имя при следующем соединении' });
            handle.close();
          }
        },
      }, icon('edit', 'icon icon--sm'), 'Переименовать'),
      el('div', { class: 'spacer' }),
      online
        ? el('button', { class: 'btn', onclick: () => { net.hangup(peerId); handle.close(); } }, icon('ban', 'icon icon--sm'), 'Отключить')
        : el('button', { class: 'btn btn--primary', onclick: () => { S.emit('connect', peerId); handle.close(); } }, icon('refresh-cw', 'icon icon--sm'), 'Подключиться'),
      el('button', { class: 'btn', onclick: () => handle.close() }, 'Закрыть'),
    ],
  });
}

export function rememberSafety(peerId, safety) {
  safetyCache.set(peerId, safety);
}
