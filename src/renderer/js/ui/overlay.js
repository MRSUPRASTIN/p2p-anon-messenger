/** Overlays: toasts, modals, confirms, context menus, popovers. */
import { el, clear, icon, append, initials, $ } from '../util.js';

const layer = () => document.getElementById('layer');
const toastRoot = () => document.getElementById('toasts');

/* --------------------------------------------------------------- toasts --- */
export function toast({ title, text, glyph, seed, color, onClick, timeout = 4600, action } = {}) {
  const node = el('div', { class: 'toast', role: 'status' });
  const body = el('div', { class: 'stack', style: { gap: '1px', minWidth: '0' } });
  body.append(el('div', { class: 'toast__title truncate', text: title || '' }));
  if (text) body.append(el('div', { class: 'toast__text truncate', text }));
  node.append(
    el('div', {
      class: 'avatar avatar--sm',
      style: color
        ? { background: color }
        : { background: 'linear-gradient(135deg,var(--accent),var(--accent-2))' },
      text: glyph || (title || '?').slice(0, 2).toUpperCase(),
    }),
    body
  );
  if (action) {
    node.append(
      el('button', {
        class: 'btn btn--soft btn--sm',
        text: action.label,
        onclick: (event) => {
          event.stopPropagation();
          action.onClick?.();
          dismiss();
        },
      })
    );
  }
  node.append(
    el('button', {
      class: 'toast__x',
      title: 'Закрыть',
      onclick: (event) => {
        event.stopPropagation();
        dismiss();
      },
    }, icon('x', 'icon icon--sm'))
  );
  node.addEventListener('click', () => {
    onClick?.();
    dismiss();
  });
  const dismiss = () => {
    if (!node.isConnected) return;
    node.dataset.leaving = 'true';
    setTimeout(() => node.remove(), 200);
  };
  toastRoot().append(node);
  if (timeout) setTimeout(dismiss, timeout);
  return dismiss;
}

/* --------------------------------------------------------------- modals --- */
const modals = [];

export function openModal({
  title,
  subtitle,
  body,
  footer,
  size = '',
  onClose,
  closeOnScrim = true,
  headExtra,
} = {}) {
  const scrim = el('div', { class: 'scrim' });
  const modal = el('div', { class: 'modal' + (size ? ' modal--' + size : ''), role: 'dialog', 'aria-modal': 'true' });

  const head = el('div', { class: 'modal__head' });
  const titles = el('div', { class: 'stack', style: { gap: '1px', minWidth: '0' } });
  titles.append(el('h2', { text: title || '' }));
  if (subtitle) titles.append(el('p', { text: subtitle }));
  head.append(titles);
  if (headExtra) head.append(headExtra);
  head.append(
    el('button', { class: 'modal__x', title: 'Закрыть', onclick: () => close() }, icon('x'))
  );

  const bodyNode = el('div', { class: 'modal__body' });
  append(bodyNode, [typeof body === 'function' ? body() : body]);

  modal.append(head, bodyNode);
  if (footer) {
    const foot = el('div', { class: 'modal__foot' });
    append(foot, [typeof footer === 'function' ? footer() : footer]);
    modal.append(foot);
  }
  scrim.append(modal);

  if (closeOnScrim) {
    scrim.addEventListener('mousedown', (event) => {
      if (event.target === scrim) close();
    });
  }

  const entry = { scrim, modal, close };
  modals.push(entry);
  layer().append(scrim);

  const focusable = modal.querySelector('input, textarea, button.btn--primary, button');
  setTimeout(() => focusable?.focus(), 60);

  function close(result) {
    const at = modals.indexOf(entry);
    if (at === -1) return;
    modals.splice(at, 1);
    scrim.style.animation = 'none';
    scrim.style.opacity = '0';
    scrim.style.transition = 'opacity 140ms ease';
    setTimeout(() => scrim.remove(), 150);
    onClose?.(result);
  }

  return { close, modal, body: bodyNode, setFooter: (nodes) => {
    const old = modal.querySelector('.modal__foot');
    const foot = el('div', { class: 'modal__foot' });
    append(foot, [typeof nodes === 'function' ? nodes() : nodes]);
    if (old) old.replaceWith(foot);
    else modal.append(foot);
  } };
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const top = modals[modals.length - 1];
  if (top) {
    event.stopPropagation();
    top.close();
    return;
  }
  const open = document.querySelector('.menu, .popover');
  if (open) open.remove();
});

export function confirmDialog({
  title,
  subtitle,
  text,
  confirmLabel = 'Подтвердить',
  cancelLabel = 'Отмена',
  danger = false,
  avatar: who = null,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const body = el('div', { class: 'stack', style: { gap: '14px' } });
    if (who) {
      body.append(
        el('div', { class: 'row', style: { gap: '12px' } },
          avatarNode(who),
          el('div', { class: 'stack', style: { gap: '2px', minWidth: '0' } },
            el('strong', { class: 'truncate', text: who.name || 'Собеседник' }),
            el('span', { class: 'field__hint', text: who.id ? 'ID ' + who.id.slice(0, 10) + '…' : '' })))
      );
    }
    if (text) body.append(el('p', { class: 'selectable', text, style: { color: 'var(--text-dim)', margin: '0' } }));

    const handle = openModal({
      title,
      subtitle,
      size: 'slim',
      body,
      footer: () => [
        el('div', { class: 'spacer' }),
        el('button', {
          class: 'btn',
          text: cancelLabel,
          onclick: () => {
            done(false);
            handle.close();
          },
        }),
        el('button', {
          class: 'btn ' + (danger ? 'btn--danger' : 'btn--primary'),
          text: confirmLabel,
          onclick: () => {
            done(true);
            handle.close();
          },
        }),
      ],
      onClose: () => done(false),
    });
  });
}

function avatarNode(who) {
  const node = el('div', { class: 'avatar avatar--lg' }, el('span', { text: who.emoji || initials(who.name) }));
  node.style.background = who.color || 'linear-gradient(135deg,var(--accent),var(--accent-2))';
  return node;
}

export function promptDialog({ title, subtitle, label, value = '', placeholder = '', okLabel = 'Готово', multiline = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const field = multiline
      ? el('textarea', { class: 'textarea', rows: 4, placeholder })
      : el('input', { class: 'input', type: 'text', placeholder });
    field.value = value;
    const handle = openModal({
      title,
      subtitle,
      size: 'slim',
      body: el('div', { class: 'field' }, el('span', { class: 'field__label', text: label || '' }), field),
      footer: () => [
        el('div', { class: 'spacer' }),
        el('button', {
          class: 'btn',
          text: 'Отмена',
          onclick: () => {
            done(null);
            handle.close();
          },
        }),
        el('button', {
          class: 'btn btn--primary',
          text: okLabel,
          onclick: () => {
            done(field.value);
            handle.close();
          },
        }),
      ],
      onClose: () => done(null),
    });
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !multiline) {
        event.preventDefault();
        done(field.value);
        handle.close();
      }
    });
  });
}

/* ---------------------------------------------------------- context menu --- */
let openMenu = null;

export function contextMenu(x, y, items) {
  closeMenu();
  const menu = el('div', { class: 'menu', role: 'menu' });
  for (const item of items) {
    if (!item) continue;
    if (item.type === 'sep') {
      menu.append(el('div', { class: 'menu__sep' }));
      continue;
    }
    if (item.type === 'label') {
      menu.append(el('div', { class: 'menu__label', text: item.label }));
      continue;
    }
    const button = el(
      'button',
      {
        class: 'menu__item' + (item.danger ? ' menu__item--danger' : ''),
        disabled: item.disabled,
        onclick: () => {
          closeMenu();
          item.onClick?.();
        },
      },
      item.icon ? icon(item.icon, 'icon icon--sm') : null,
      el('span', { text: item.label }),
      item.kbd ? el('kbd', { text: item.kbd }) : null
    );
    menu.append(button);
  }
  document.body.append(menu);
  position(menu, x, y);
  openMenu = menu;
  setTimeout(() => {
    document.addEventListener('mousedown', onDocDown, { once: true });
    document.addEventListener('keydown', onEsc, { once: true });
  }, 0);
  return menu;
}

function onDocDown(event) {
  if (openMenu && !openMenu.contains(event.target)) closeMenu();
}
function onEsc(event) {
  if (event.key === 'Escape') closeMenu();
}

export function closeMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
  }
}

function position(node, x, y) {
  const rect = node.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  node.style.left = Math.max(8, left) + 'px';
  node.style.top = Math.max(8, top) + 'px';
}

/* -------------------------------------------------------------- popover --- */
let openPopover = null;

export function popover(anchor, content, { align = 'end' } = {}) {
  closePopover();
  const node = el('div', { class: 'popover' }, content);
  document.body.append(node);
  const rect = anchor.getBoundingClientRect();
  const size = node.getBoundingClientRect();
  let left = align === 'end' ? rect.right - size.width : rect.left;
  left = Math.max(8, Math.min(left, window.innerWidth - size.width - 8));
  let top = rect.top - size.height - 8;
  if (top < 8) top = rect.bottom + 8;
  node.style.left = left + 'px';
  node.style.top = top + 'px';
  openPopover = node;
  setTimeout(() => {
    document.addEventListener('mousedown', outside, { once: true });
  }, 0);
  function outside(event) {
    if (!node.contains(event.target) && !anchor.contains(event.target)) closePopover();
  }
  return node;
}

export function closePopover() {
  if (openPopover) {
    openPopover.remove();
    openPopover = null;
  }
}

export function closeAllOverlays() {
  closeMenu();
  closePopover();
}
