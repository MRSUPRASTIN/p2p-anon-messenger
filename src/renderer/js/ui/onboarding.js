/** First run: pick a name, an emoji and an accent, then mint the identity. */
import { el, clear, icon, avatar } from '../util.js';
import { AVATAR_EMOJI } from './emoji.js';
import * as C from '../crypto.js';
import { toast } from './overlay.js';

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

const root = () => document.getElementById('onboardRoot');

/**
 * Three steps: name, look, done. Resolves with the freshly created identity so
 * the caller can persist it and boot the network layer.
 */
export function runOnboarding() {
  return new Promise((resolve) => {
    const step = { index: 0, name: '', emoji: AVATAR_EMOJI[0], hue: 253, busy: false };
    const host = el('div', { class: 'onboard' });
    root().append(host);
    paint();

    function paint() {
      clear(host);
      host.dataset.step = String(step.index);

      const dots = el('div', { class: 'onboard__dots' });
      for (let i = 0; i < 3; i++) {
        dots.append(el('i', { dataset: { on: String(i <= step.index) } }));
      }

      if (step.index === 0) {
        const input = el('input', {
          class: 'input input--lg',
          placeholder: 'Как вас зовут?',
          maxlength: 40,
          value: step.name,
          oninput: (event) => {
            step.name = event.target.value;
            next.disabled = !step.name.trim();
          },
          onkeydown: (event) => {
            if (event.key === 'Enter' && step.name.trim()) next.click();
          },
        });
        const next = el('button', {
          class: 'btn btn--primary btn--lg',
          text: 'Далее',
          onclick: () => {
            step.name = input.value.trim();
            if (!step.name) return;
            step.index = 1;
            paint();
            setTimeout(() => host.querySelector('.emoji-pick')?.focus(), 60);
          },
        });
        next.disabled = !step.name.trim();

        host.append(
          logo(),
          el('div', { class: 'onboard__card' },
            dots,
            el('h1', { class: 'onboard__title', text: 'Как вас зовут?' }),
            el('p', { class: 'onboard__lead', text: 'Имя увидят люди из вашей сети. Оно нигде не публикуется — только вашим собеседникам.' }),
            el('div', { class: 'onboard__row' }, input, next)),
          features()
        );
        setTimeout(() => {
          input.focus();
          input.setSelectionRange(999, 999);
        }, 70);
        return;
      }

      if (step.index === 1) {
        const emojiRow = el('div', { class: 'emoji-picker emoji-picker--lg' });
        const accentRow = el('div', { class: 'accent-picker accent-picker--lg' });

        const paintPreview = () => {
          preview.replaceChildren(avatar(step.name || '?', { size: 'xl', emoji: step.emoji }));
          document.documentElement.style.setProperty('--accent', `hsl(${step.hue} 88% 63%)`);
          document.documentElement.style.setProperty('--accent-2', `hsl(${(step.hue + 60) % 360} 82% 62%)`);
        };
        const preview = el('div', { class: 'onboard__preview' });

        for (const emoji of AVATAR_EMOJI) {
          emojiRow.append(
            el('button', {
              class: 'emoji-pick',
              text: emoji,
              'aria-pressed': String(step.emoji === emoji),
              onclick: (event) => {
                step.emoji = emoji;
                for (const node of emojiRow.children) node.setAttribute('aria-pressed', String(node.textContent === emoji));
                paintPreview();
                event.currentTarget.blur?.();
              },
            })
          );
        }
        for (const accent of ACCENTS) {
          accentRow.append(
            el('button', {
              class: 'accent-dot',
              style: { background: `hsl(${accent.h} 88% 63%)`, color: `hsl(${accent.h} 88% 63%)` },
              title: accent.name,
              'aria-pressed': String(step.hue === accent.h),
              onclick: () => {
                step.hue = accent.h;
                for (const node of accentRow.children) {
                  node.setAttribute('aria-pressed', String(node.style.background === node.style.color));
                }
                paintPreview();
              },
            })
          );
        }
        accentRow.addEventListener('click', (event) => {
          if (event.target.classList.contains('accent-dot')) {
            for (const node of accentRow.children) {
              const match = node.style.background === event.target.style.background;
              node.setAttribute('aria-pressed', String(match));
            }
          }
        });

        host.append(
          logo(),
          el('div', { class: 'onboard__card' },
            dots,
            el('h1', { class: 'onboard__title', text: 'Ваш образ' }),
            preview,
            el('div', { class: 'field' }, el('span', { class: 'field__label', text: 'Эмодзи' }), emojiRow),
            el('div', { class: 'field' }, el('span', { class: 'field__label', text: 'Цвет акцента' }), accentRow),
            el('div', { class: 'onboard__row' },
              el('button', { class: 'btn btn--lg', text: 'Назад', onclick: () => { step.index = 0; paint(); } }),
              el('button', { class: 'btn btn--primary btn--lg', text: 'Создать личность', onclick: finish })))
        );
        paintPreview();
        return;
      }

      /* step 2 - done */
      host.append(
        logo(),
        el('div', { class: 'onboard__card' },
          el('div', { class: 'onboard__done' },
            avatar(step.name, { size: 'xl', emoji: step.emoji }),
            el('h1', { class: 'onboard__title', text: step.name }),
            el('p', { class: 'onboard__lead', text: 'Ключи созданы локально на этом устройстве. Они никуда не отправлены и не могут быть восстановлены — сверьте отпечаток с собеседником, когда соединитесь.' }),
            el('div', { class: 'onboard__row' }, el('button', { class: 'btn btn--primary btn--lg', text: 'Начать общение', onclick: close }))))
      );
    }

    async function finish() {
      if (step.busy) return;
      step.busy = true;
      clear(host);
      host.append(
        logo(),
        el('div', { class: 'onboard__card' },
          el('div', { class: 'onboard__busy' },
            el('div', { class: 'spinner' }),
            el('p', { class: 'onboard__lead', text: 'Генерируем пару ключей P-256…' })))
      );
      try {
        const identity = await C.createIdentity();
        step.index = 2;
        paint();
        resolve({
          identity,
          name: step.name,
          emoji: step.emoji,
          accent: `hsl(${step.hue} 88% 63%)`,
        });
      } catch (err) {
        step.busy = false;
        toast({ title: 'Не удалось создать ключи', text: err.message });
        paint();
      }
    }

    function close() {
      clear(root());
      resolve(null);
    }
  });
}

function features() {
  return el('div', { class: 'onboard__feat' },
    el('div', {}, icon('lock', 'icon'), 'Шифрование DTLS + AES-256-GCM, ключи только на этом устройстве'),
    el('div', {}, icon('radar', 'icon'), 'Поиск собеседников в локальной сети без интернета'),
    el('div', {}, icon('key', 'icon'), 'Связь через интернет по коду приглашения, без сервера'));
}

function logo() {
  return el('div', { class: 'onboard__logo' },
    el('div', { class: 'onboard__mark' },
      el('span', { class: 'onboard__mark-top' }),
      el('span', { class: 'onboard__mark-mouth' })),
    el('span', { text: 'p2pAnon Messenger' })
  );
}
