/** Invite codes: serverless pairing across networks. */
import { el, clear, icon, avatar, copyText } from '../util.js';
import { shortFingerprint } from '../crypto.js';
import * as S from '../state.js';
import { net } from '../app.js';
import { toast, openModal } from './overlay.js';

let active = null;

export function openInvite() {
  if (!S.state.profile) return;
  const me = S.state.profile;

  const steps = el('div', { class: 'steps' }, el('i'), el('i'), el('i'));
  const hint = el('p', { class: 'field__hint' });
  const codeBox = el('div', { class: 'code code--accent' });
  const answerBox = el('div', { class: 'code' });
  const answerWrap = el('div', { class: 'stack', style: { gap: '8px' } });
  const status = el('div', { class: 'kv' });

  const markStep = (n) => {
    [...steps.children].forEach((node, i) => (node.dataset.on = String(i < n)));
  };

  const handle = openModal({
    title: 'Приглашение кодом',
    subtitle: 'Для связи через интернет и разные сети',
    size: 'wide',
    body: el('div', { class: 'invite' },
      el('p', { class: 'field__hint', style: { margin: '0' }, text:
        'Код содержит описание WebRTC-соединения. Передайте его собеседнику любым способом — мессенджером, почтой, голосом. Никакой сервер не участвует: после обмена кодами трафик идёт напрямую между вами.' }),
      steps,
      status,
      hint,
      el('div', { class: 'stack', style: { gap: '8px' } },
        el('div', { class: 'field__label', text: '1. Ваш код — отправьте его собеседнику' }),
        codeBox,
        el('div', { class: 'row', style: { gap: '8px' } },
          el('button', { class: 'btn btn--sm btn--soft', onclick: regenerate }, icon('refresh-cw', 'icon icon--sm'), 'Создать заново'),
          el('button', {
            class: 'btn btn--sm',
            onclick: async () => {
              await copyText(codeBox.textContent);
              toast({ title: 'Код скопирован' });
            },
          }, icon('copy', 'icon icon--sm'), 'Скопировать'),
          el('div', { class: 'spacer' }),
          el('span', { class: 'chip', text: 'Шаг 1 из 3' }))),
      answerWrap),
    footer: () => [
      el('button', { class: 'btn btn--ghost', onclick: () => handle.close() }, 'Закрыть'),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', onclick: () => pasteFlow(handle) }, icon('download'), 'У меня есть код'),
    ],
    onClose: () => {
      if (active) net.cancelInvite(active.token);
      active = null;
    },
  });

  /* my identity card */
  clear(status);
  status.append(
    el('div', { class: 'kv__row' },
      avatar(me.name, { size: 'sm', seed: me.id, color: me.color, emoji: me.emoji }),
      el('span', { text: me.name }),
      el('span', { class: 'spacer' }),
      el('span', { text: shortFingerprint(S.state.identity?.fingerprint) })),
    el('div', { class: 'kv__row' }, el('span', { text: 'Ваш ID' }), el('span', { class: 'truncate', text: me.id }))
  );

  regenerate();

  function regenerate() {
    markStep(1);
    codeBox.textContent = 'создаём код…';
    clear(answerWrap);
    /* a previous attempt still owns a peer connection; drop it instead of
       leaving it to time out fifteen minutes from now */
    if (active) net.cancelInvite(active.token);
    net
      .createInvite()
      .then(({ code, token }) => {
        active = { token };
        codeBox.textContent = code;
        hint.textContent = 'Собеседник вставит этот код у себя и пришлёт ответный.';
        markStep(2);
        const paste = el('textarea', { class: 'textarea', rows: 3, placeholder: 'Вставьте сюда ответный код собеседника…' });
        const go = el('button', { class: 'btn btn--primary btn--sm', text: 'Соединиться' });
        go.addEventListener('click', async () => {
          go.disabled = true;
          go.textContent = 'Соединение…';
          try {
            const id = await net.completeInvite(paste.value.trim());
            S.upsertContact({
              id,
              name: 'Новый контакт',
              pubRaw: '',
              fingerprint: '',
            });
            toast({
              title: 'Соединение устанавливается',
              text: 'Сверяем отпечатки и поднимаем прямой канал — обычно это несколько секунд. Если не вышло, создайте новый код и обменяйтесь им ещё раз.',
              timeout: 20000,
            });
            handle.close();
            S.emit('open-chat', id);
          } catch (err) {
            toast({ title: 'Не получилось', text: err.message });
            go.disabled = false;
            go.textContent = 'Соединиться';
          }
        });
        answerWrap.append(
          el('div', { class: 'field__label', text: '2. Вставьте ответный код' }),
          paste,
          el('div', { class: 'row', style: { gap: '8px' } }, go, el('div', { class: 'spacer' }), el('span', { class: 'chip', text: 'Шаг 2 из 3' }))
        );
        answerBox.remove();
      })
      .catch((err) => {
        codeBox.textContent = 'ошибка: ' + err.message;
      });
  }
}

/** Inbound direction: paste their invite, get an answer code back. */
export function pasteFlow(parentHandle) {
  const paste = el('textarea', { class: 'textarea', rows: 5, placeholder: 'M1.…' });
  const out = el('div', { class: 'code code--accent' });
  const peerBox = el('div', { class: 'kv' });

  const handle = openModal({
    title: 'Вставить код приглашения',
    subtitle: 'Шаг 1: получите ответный код и отправьте его обратно',
    body: el('div', { class: 'stack', style: { gap: '14px' } },
      peerBox,
      el('div', { class: 'field' }, el('span', { class: 'field__label', text: 'Код от собеседника' }), paste),
      el('div', { class: 'field__hint', text: 'Нажмите «Создать ответ» — вы получите код, который нужно отправить обратно. Соединение начнётся, как только он его вставит.' }),
      el('div', { class: 'stack', style: { gap: '8px' } },
        el('div', { class: 'field__label', text: 'Ваш ответный код' }),
        out)),
    footer: () => [
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', text: 'Отмена', onclick: () => handle.close() }),
      el('button', {
        class: 'btn btn--primary',
        onclick: async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          button.textContent = 'Обработка…';
          try {
            const { code, profile } = await net.answerInvite(paste.value.trim());
            out.textContent = code;
            clear(peerBox);
            peerBox.append(
              el('div', { class: 'kv__row' },
                avatar(profile.name, { size: 'sm', seed: profile.id, color: profile.color }),
                el('span', { text: profile.name }),
                el('span', { class: 'spacer' }),
                el('span', { text: shortFingerprint(profile.fingerprint) })));
            S.upsertContact({
              id: profile.id,
              name: profile.name,
              color: profile.color,
              emoji: profile.emoji,
              pubRaw: profile.pubRaw,
              fingerprint: profile.fingerprint,
            });
            button.textContent = 'Готово';
            toast({ title: 'Ответный код создан', text: 'Отправьте его собеседнику' });
            await copyText(code);
            toast({ title: 'Ответный код скопирован' });
          } catch (err) {
            toast({ title: 'Код не подошёл', text: err.message });
            button.disabled = false;
            button.textContent = 'Создать ответ';
          }
        },
        text: 'Создать ответ',
      }),
    ],
    onClose: () => {
      parentHandle?.close?.();
    },
  });
  setTimeout(() => paste.focus(), 80);
}
