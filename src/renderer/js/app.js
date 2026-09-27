/**
 * p2pAnon Messenger - renderer bootstrap.
 *
 * Wires the state store, the WebRTC transport, the sidebar, the section views
 * and the conversation view together, then keeps them in sync with the events
 * coming from the main process.
 */
import { $, el, clear, icon, avatar, debounce, throttle, relTime, bytes } from './util.js';
import { mountSprite } from './icons.js';
import * as C from './crypto.js';
import * as S from './state.js';
import { Net } from './net.js';
import * as chat from './ui/chat.js';
import * as sidebar from './ui/sidebar.js';
import * as views from './ui/views.js';
import { openInvite, pasteFlow } from './ui/invite.js';
import { openInfo, rememberSafety } from './ui/info.js';
import { runOnboarding } from './ui/onboarding.js';
import { toast, confirmDialog, closeAllOverlays, closeMenu, closePopover } from './ui/overlay.js';
import { AVATAR_EMOJI } from './ui/emoji.js';

export const net = new Net();

const SECTIONS = [
  { id: 'chats', label: 'Чаты', icon: 'chats' },
  { id: 'discover', label: 'В сети', icon: 'radar' },
  { id: 'contacts', label: 'Контакты', icon: 'users' },
  { id: 'settings', label: 'Настройки', icon: 'settings' },
];

const rail = $('#rail');
const shell = $('#shell');
const stage = $('#stage');
const view = $('#view');
const netPill = $('#netPill');
const netPillText = $('#netPillText');

let booted = false;
const inboundFiles = new Map();

/* ------------------------------------------------------------------ boot --- */
async function boot() {
  mountSprite($('#sprite'));
  await S.init();
  views.applyTheme();

  let identity = null;
  if (S.state.profile) {
    identity = await C.restoreIdentity(S.state.profile.identity);
    if (identity.fingerprint !== S.state.profile.identity?.fingerprint) {
      S.setProfile({ identity });
    }
  } else {
    const created = await runOnboarding();
    if (!created) {
      location.reload();
      return;
    }
    identity = created.identity;
    S.state.profile = {
      id: identity.id,
      name: created.name,
      emoji: created.emoji,
      color: created.accent,
      bio: '',
      createdAt: Date.now(),
      identity,
    };
    await window.mouth.store.set('profile.json', S.state.profile);
    S.setSettings({ accent: created.accent });
    views.applyTheme();
  }
  S.state.identity = identity;

  document.getElementById('app').hidden = false;
  buildRail();
  wireChrome();
  sidebar.init();
  chat.mount(view);
  wireState();
  wireNet();
  wireMain();

  await net.start(identity, S.state.profile, S.state.settings);
  paintNet('P2P · без сервера');

  booted = true;
  await showSection('chats');
  if (S.state.contacts.size) greetReturning();
}

/** A short hello when the app comes back with a few known contacts. */
function greetReturning() {
  const known = S.contactList().length;
  if (!known) return;
  setTimeout(() => {
    toast({
      title: 'С возвращением, ' + S.state.profile.name,
      text: known === 1 ? '1 контакт сохранён' : known + ' контактов сохранено',
      glyph: S.state.profile.emoji,
      color: S.state.profile.color,
      timeout: 4200,
    });
  }, 700);
}

/* ------------------------------------------------------------------ rail --- */
function buildRail() {
  clear(rail);
  for (const section of SECTIONS) {
    const node = el('button', {
      class: 'rail__btn',
      title: section.label,
      'aria-label': section.label,
      dataset: { id: section.id },
      onclick: () => showSection(section.id),
    }, icon(section.icon, 'icon icon--lg'));
    if (section.id === 'chats') {
      node.append(el('span', { class: 'rail__badge', id: 'railBadge', hidden: true }));
    }
    rail.append(node);
  }
  rail.append(el('div', { class: 'spacer' }));
  rail.append(
    el('button', {
      class: 'rail__btn rail__btn--me',
      title: 'Мой профиль',
      onclick: () => views.openProfile(),
    }, avatar(S.state.profile.name, { size: 'sm', seed: S.state.profile.id, color: S.state.profile.color, emoji: S.state.profile.emoji }))
  );
  paintRail();
}

function paintRail() {
  const badge = $('#railBadge');
  if (badge) {
    const total = S.totalUnread();
    badge.hidden = total === 0;
    badge.textContent = total > 99 ? '99+' : String(total);
  }
  const me = rail.querySelector('.rail__btn--me span');
  if (me) {
    const p = S.state.profile;
    me.textContent = p.emoji || p.name.slice(0, 1).toUpperCase();
  }
}

async function showSection(section) {
  if (!SECTIONS.some((s) => s.id === section)) section = 'chats';
  S.setSection(section);
  shell.dataset.section = section;
  $('#sidebarTitle').textContent = SECTIONS.find((s) => s.id === section).label;
  paintRail();

  if (section === 'chats') {
    if (S.state.activeId) {
      await chat.open(S.state.activeId);
    } else {
      chat.close();
      renderHome();
    }
  } else {
    chat.close();
    ({ contacts: views.renderContacts, discover: views.renderDiscover, settings: views.renderSettings })[section](view);
  }
  sidebar.render();
}

function renderHome() {
  clear(view);
  view.className = 'view view--pad view--home';
  const near = [...S.state.discovered.values()];
  view.append(
    el('div', { class: 'card card--hero' },
      el('div', { class: 'card__body' },
        el('div', { class: 'hero' },
          avatar(S.state.profile.name, { size: 'xl', seed: S.state.profile.id, color: S.state.profile.color, emoji: S.state.profile.emoji }),
          el('div', { class: 'stack', style: { gap: '6px' } },
            el('h2', { text: 'Привет, ' + S.state.profile.name }),
            el('p', {
              class: 'field__hint',
              text: 'Здесь появляются переписки. Начните с кого-то в локальной сети или пригласите друга кодом — соединение пойдёт напрямую, без сервера.',
            }),
            el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
              el('button', { class: 'btn btn--primary', onclick: () => showSection('discover') }, icon('radar', 'icon icon--sm'), 'Найти в сети'),
              el('button', { class: 'btn', onclick: () => openInvite() }, icon('qr', 'icon icon--sm'), 'Пригласить кодом'))),
          near.length
            ? el('div', { class: 'hero__near' },
                el('div', { class: 'field__label', text: 'Рядом в сети' }),
                ...near.slice(0, 6).map((peer) =>
                  el('button', {
                    class: 'near',
                    onclick: () => connectTo(peer.id),
                    oncontextmenu: (event) => {
                      event.preventDefault();
                      openInfo(peer.id);
                    },
                  },
                    avatar(peer.name, { size: 'sm', seed: peer.id, color: peer.color, emoji: peer.emoji }),
                    el('span', { class: 'truncate', text: peer.name }))))
            : null)))
  );
}

/* --------------------------------------------------------------- chrome --- */
function wireChrome() {
  for (const button of document.querySelectorAll('[data-win]')) {
    button.addEventListener('click', () => window.mouth.win.action(button.dataset.win));
  }
  $('#btnInvite').addEventListener('click', () => openInvite());
  $('#btnNewChat').addEventListener('click', () => showSection('discover'));
  window.mouth.win.onState((state) => document.body.dataset.maximized = String(state.maximized));

  document.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      sidebar.focusSearch();
    }
    if (mod && event.key.toLowerCase() === 'i') {
      event.preventDefault();
      openInvite();
    }
    if (mod && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      showSection('discover');
    }
    if (event.key === 'Escape') {
      if (S.state.activeId && S.state.section === 'chats') closeChat();
    }
  });

  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (link) {
      event.preventDefault();
      const href = link.getAttribute('href');
      if (/^https?:|^mailto:/.test(href)) window.mouth.app.openExternal(href);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      chat.onVisible();
      if (S.totalUnread()) window.mouth.notify.clear();
    }
  });
  window.addEventListener('focus', () => chat.onVisible());
}

function closeChat() {
  S.setActive(null);
  chat.close();
  renderHome();
  sidebar.render();
}

/* --------------------------------------------------------- state events --- */
function wireState() {
  S.on('open-chat', async (peerId) => {
    await S.ensureChat(peerId);
    S.setActive(peerId);
    await showSection('chats');
    chat.markRead(peerId);
    sidebar.render();
  });

  S.on('back-to-list', () => closeChat());

  S.on('go-section', (section) => showSection(section));

  S.on('open-info', (peerId) => openInfo(peerId));
  S.on('open-paste', () => pasteFlow());
  S.on('profile-changed', () => {
    paintRail();
    if (S.state.section === 'chats') {
      if (S.state.activeId) chat.open(S.state.activeId);
      else renderHome();
    }
  });

  S.on('connect', (peerId) => connectTo(peerId));

  S.on('delete-contact', async (peerId) => {
    const contact = S.contact(peerId);
    const ok = await confirmDialog({
      title: 'Удалить контакт?',
      text: 'Контакт «' + (contact?.name || 'без имени') + '» и вся переписка с ним будут удалены с этого устройства. У собеседника чат останется.',
      confirmLabel: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    net.hangup(peerId, { silent: true });
    await S.removeContact(peerId);
    if (S.state.activeId === peerId) closeChat();
    sidebar.render();
    toast({ title: 'Контакт удалён' });
  });

  S.on('delete-chat', async (peerId) => {
    const ok = await confirmDialog({
      title: 'Очистить переписку?',
      text: 'История будет удалена у обоих собеседников.',
      confirmLabel: 'Очистить',
      danger: true,
    });
    if (!ok) return;
    S.state.chats.set(peerId, []);
    S.state.loadedChats.add(peerId);
    await window.mouth.chat.save(peerId, []);
    S.setUnread(peerId, 0);
    if (S.state.activeId === peerId) await chat.open(peerId);
  });

  S.on('unread', () => {
    paintRail();
    paintTitle();
    sidebar.render();
  });

  S.on('message', ({ peerId, message, removed }) => {
    if (removed) {
      if (chat.isOpen(peerId)) chat.renderMessages();
      return;
    }
    if (chat.isOpen(peerId)) chat.renderMessages();
  });

  S.on('discovered', () => {
    if (S.state.section === 'discover') views.renderDiscover(view);
    if (S.state.section === 'chats' && !S.state.activeId) renderHome();
    sidebar.render();
  });

  window.addEventListener('beforeunload', () => {
    net.hangupAll?.();
    void net.stop();
  });
}

/* ------------------------------------------------------------------ net --- */
function wireNet() {
  /* hooks used by the transport */
  net.hooks.isKnown = (id) => Boolean(S.contact(id));
  net.hooks.onIncoming = async ({ id, profile }) => {
    const known = S.contact(id);
    if (known) {
      S.patchContact(id, { lastSeen: Date.now() });
      return { accepted: true, contact: known };
    }
    if (S.state.info?.pair) {
      /* pair test: no one is there to press a button */
      const auto = S.upsertContact({
        id,
        name: profile?.name || 'Собеседник',
        color: profile?.color || '',
        emoji: profile?.emoji || '',
        pubRaw: profile?.pubRaw || '',
        dhRaw: profile?.dhRaw || '',
        fingerprint: profile?.fingerprint || '',
        lan: true,
        lastSeen: Date.now(),
      });
      return { accepted: true, contact: auto };
    }
    const ok = await confirmDialog({
      title: 'Входящее соединение',
      subtitle: profile?.name || 'Неизвестный собеседник',
      text: 'Устройство из вашей локальной сети хочет начать переписку. Трафик пойдёт напрямую между вами.',
      confirmLabel: 'Принять',
      avatar: profile,
    });
    if (!ok) return { accepted: false };
    const contact = S.upsertContact({
      id,
      name: profile?.name || 'Собеседник',
      color: profile?.color || '',
      emoji: profile?.emoji || '',
      pubRaw: profile?.pubRaw || '',
      fingerprint: profile?.fingerprint || '',
      lan: true,
      lastSeen: Date.now(),
    });
    return { accepted: true, contact };
  };

  net.on('verified', async ({ id, profile, lan, safety }) => {
    const wasVerified = Boolean(S.contact(id)?.verified);
    S.upsertContact({
      id,
      name: profile?.name || S.contact(id)?.name || 'Собеседник',
      color: profile?.color ?? S.contact(id)?.color ?? '',
      emoji: profile?.emoji || '',
      pubRaw: profile?.pubRaw || '',
      dhRaw: profile?.dhRaw || '',
      fingerprint: profile?.fingerprint || '',
      lan: Boolean(lan),
      verified: true,
      lastSeen: Date.now(),
    });
    rememberSafety(id, safety);
    S.setUnread(id, 0);
    sidebar.render();
    if (chat.isOpen(id)) chat.refreshStatus();
    if (!wasVerified) {
      toast({
        title: 'Канал защищён',
        text: 'С ' + (profile?.name || 'собеседником') + ' сверен отпечаток ' + C.shortFingerprint(profile?.fingerprint),
        timeout: 6000,
        action: { label: 'Отпечаток', onClick: () => openInfo(id) },
      });
    }
  });

  net.on('state', () => {
    sidebar.render();
    if (chat.currentPeer()) chat.refreshStatus();
  });

  net.on('message', async ({ id, message }) => {
    await S.ensureChat(id);
    const incoming = {
      ...message,
      dir: 'in',
      ts: message.ts || Date.now(),
      state: 'delivered',
      reactions: message.reactions || [],
    };
    delete incoming.patch;
    if (incoming.file) {
      incoming.file = { ...incoming.file };
      delete incoming.file.path;
    }
    if (incoming.deleted) {
      incoming.text = '';
    }
    if (message.patch) {
      const clean = { ...incoming };
      delete clean.patch;
      S.patchMessage(id, message.id, clean);
      if (chat.isOpen(id)) chat.patchNode(id, message.id);
      return;
    }
    S.addMessage(id, incoming);

    const isOpen = chat.isOpen(id) && S.state.section === 'chats' && !document.hidden;
    if (isOpen) {
      chat.markRead(id);
      if (chat.isOpen(id)) chat.renderMessages();
    } else {
      S.markUnread(id);
      notify(id, incoming);
    }
    sidebar.render();
  });

  net.on('typing', ({ id, on: typing }) => {
    S.setTyping(id, typing);
    if (chat.isOpen(id)) chat.renderTyping(id);
    sidebar.render();
  });

  net.on('receipt', ({ id, ids, kind }) => {
    for (const messageId of ids) {
      S.patchMessage(id, messageId, { state: kind === 'read' ? 'read' : 'delivered' });
    }
    if (chat.isOpen(id)) chat.renderMessages();
  });

  net.on('peer-profile', ({ id, profile }) => {
    S.patchContact(id, {
      name: profile.name,
      color: profile.color,
      emoji: profile.emoji,
    });
    if (chat.isOpen(id)) chat.open(id);
    sidebar.render();
  });

  net.on('left', ({ id }) => {
    S.patchContact(id, { lastSeen: Date.now() });
    if (chat.isOpen(id)) chat.refreshStatus();
    sidebar.render();
  });

  net.on('closed', ({ id }) => {
    S.setTyping(id, false);
    if (chat.isOpen(id)) chat.refreshStatus();
  });

  net.on('reconnecting', ({ id, attempt }) => {
    if (chat.isOpen(id)) chat.refreshStatus();
    if (attempt === 1) toast({ title: 'Переподключаемся…', text: S.contactName(id), timeout: 2600 });
  });

  net.on('rejected', ({ id }) => {
    S.patchMessage(id, S.lastMessage(id)?.id, { state: 'failed' });
    toast({ title: 'Соединение отклонено', text: S.contactName(id) });
  });

  /**
   * The peer was visible in the network, so the address was known, and still the
   * channel never came up. Whatever the reason, the user gets an answer now
   * instead of an endless spinner, plus the one thing that actually helps: a
   * working path over the invite code.
   */
  net.on('timeout', ({ id, report, initiator, invite }) => {
    if (invite) {
      S.patchMessage(id, S.lastMessage(id)?.id, { state: 'failed' });
      toast({
        title: 'Код не сработал',
        text: 'Прямое соединение не поднялось. Чаще всего мешает NAT или брандмауэр: попросите собеседника создать новый код — или попробуйте ещё раз, с другим кодом.',
        timeout: 14000,
        action: { label: 'Новый код', onClick: () => openInvite() },
      });
      return;
    }
    if (!initiator) return;
    S.patchMessage(id, S.lastMessage(id)?.id, { state: 'failed' });
    const why =
      report && report.iceConnection === 'checking'
        ? 'Пакеты не доходят: устройство видно, но соединение блокирует брандмауэр или сеть'
        : report && report.remote
          ? 'Кандидаты получены, но пара не подтверждена'
          : 'Устройство перестало отвечать';
    toast({
      title: 'Не удалось подключиться',
      text: S.contactName(id) + ': ' + why + '. Попробуйте код приглашения — он работает через интернет.',
      timeout: 12000,
      action: { label: 'Код', onClick: () => openInvite() },
    });
  });

  net.on('no-route', ({ id }) => {
    if (!chat.isOpen(id)) return;
    console.warn('[net] lost the route to ' + id);
  });

  net.on('tamper', ({ id, reason }) => {
    toast({ title: 'Соединение разорвано', text: reason + ' — ' + S.contactName(id), timeout: 9000 });
    net.hangup(id, { silent: true });
  });

  net.on('error', ({ error }) => {
    if (error) console.warn('[net]', error.message);
  });

  /* files ------------------------------------------------------------- */
  net.on('file-begin', ({ id, transferId, name, size, messageId }) => {
    const dismiss = toast({
      title: 'Файл: ' + name,
      text: bytes(size) + ' — принять?',
      timeout: 120000,
      action: { label: 'Принять', onClick: () => answerFile(transferId, true) },
    });
    inboundFiles.set(transferId, { id, name, size, messageId, dismiss });
  });

  net.on('file-progress', ({ id, transferId, messageId, sent, received, total }) => {
    const job = chat.transfers.get(messageId) || { dir: sent != null ? 'out' : 'in' };
    if (sent != null) job.sent = sent;
    if (received != null) job.received = received;
    job.total = total || job.total;
    chat.transfers.set(messageId, job);
    if (chat.isOpen(id)) chat.patchNode(id, messageId);
  });

  net.on('file-done', ({ id, messageId, transferId, name, size }) => {
    chat.transfers.delete(messageId);
    const job = inboundFiles.get(transferId);
    job?.dismiss?.();
    inboundFiles.delete(transferId);
    const message = S.findMessage(id, messageId);
    if (message?.file) {
      S.patchMessage(id, messageId, { file: { ...message.file, id: transferId, name, size, ready: true } });
    }
    if (chat.isOpen(id)) chat.renderMessages();
    toast({
      title: 'Файл получен',
      text: name + ' · ' + bytes(size),
      onClick: () => window.mouth.files.open(transferId, name),
      timeout: 7000,
    });
  });

  net.on('file-sent', ({ id, messageId }) => {
    chat.transfers.delete(messageId);
    S.patchMessage(id, messageId, { state: 'sent' });
    if (chat.isOpen(id)) chat.patchNode(id, messageId);
  });

  net.on('file-failed', ({ id, messageId, error }) => {
    chat.transfers.delete(messageId);
    S.patchMessage(id, messageId, { state: 'failed', error });
    if (chat.isOpen(id)) chat.patchNode(id, messageId);
    toast({ title: 'Файл не отправлен', text: error });
  });

  net.on('file-abort', ({ id, messageId, reason }) => {
    chat.transfers.delete(messageId);
    if (messageId) S.patchMessage(id, messageId, { file: { ...(S.findMessage(id, messageId)?.file || {}), aborted: true } });
    toast({ title: 'Передача файла прервана', text: reason || '' });
  });
}

function answerFile(transferId, ok) {
  const job = inboundFiles.get(transferId);
  if (!job) return;
  inboundFiles.delete(transferId);
  job.dismiss?.();
  net.answerFile(job.id, transferId, ok);
  if (ok) {
    chat.transfers.set(job.messageId, { dir: 'in', sent: 0, received: 0, total: job.size });
    if (chat.isOpen(job.id)) chat.patchNode(job.id, job.messageId);
  } else {
    toast({ title: 'Файл отклонён', text: job.name });
  }
}

async function connectTo(peerId) {
  const contact = S.contact(peerId);
  if (!contact) return;
  await S.ensureChat(peerId);
  const peer = await net.dial(peerId, { lan: true, profile: publicOf(peerId) });
  if (!peer) {
    toast({ title: 'Не удалось подключиться', text: 'Собеседник сейчас не в локальной сети — попробуйте код приглашения' });
    return;
  }
  S.setActive(peerId);
  await showSection('chats');
}

function publicOf(peerId) {
  const contact = S.contact(peerId);
  if (!contact) return null;
  return {
    id: contact.id,
    name: contact.name,
    color: contact.color,
    emoji: contact.emoji,
    pubRaw: contact.pubRaw,
    dhRaw: contact.dhRaw || '',
    fingerprint: contact.fingerprint,
  };
}

/* ------------------------------------------------------------ main events --- */
function wireMain() {
  window.mouth.net.onPeer(async ({ peer, isNew }) => {
    S.setDiscovered(peer, isNew);
    const known = S.contact(peer.id);
    if (known) {
      S.patchContact(peer.id, { lastSeen: Date.now(), lan: true });
      if (S.state.settings.autoConnect && !net.isConnected(peer.id)) {
        await window.mouth.net.remember(peer.id, peer.addr || '');
        net.dial(peer.id, { lan: true, profile: publicOf(peer.id) });
      }
    } else if (isNew && S.state.settings.autoConnect && S.state.profile) {
      notifyPeer(peer);
    }
    if (S.state.section === 'discover') views.renderDiscover(view);
    sidebar.render();
  });

  window.mouth.net.onBye((id) => {
    S.dropDiscovered(id);
    S.patchContact(id, { lastSeen: Date.now() });
    if (S.state.section === 'discover') views.renderDiscover(view);
  });

  window.mouth.net.onSignal((msg) => {
    net.onSignal(msg).catch((err) => {
      console.error('[net] signal failed', msg && msg.t, err);
      net.fire('error', { id: msg && msg.id, error: err instanceof Error ? err : new Error(String(err)) });
    });
  });

  window.mouth.net.onWarn((message) => {
    toast({ title: 'Сеть', text: message, timeout: 6000 });
  });

  window.mouth.net.onReady((info) => {
    paintNet('P2P · UDP ' + (info?.port || 45311));
  });

  window.mouth.app.onAction((action) => {
    if (action === 'new-chat') showSection('discover');
    else if (action === 'invite') openInvite();
    else if (action && action.openChat) S.emit('open-chat', action.openChat);
  });
}

/* ---------------------------------------------------------------- chrome --- */
function paintNet(text) {
  netPillText.textContent = text;
  const online = S.contactList().filter((c) => net.isConnected(c.id)).length;
  netPill.querySelector('.dot').classList.toggle('dot--on', online > 0);
  netPill.title = online ? online + ' контактов в сети' : 'Серверов нет: трафик идёт напрямую';
}

function paintTitle() {
  const total = S.totalUnread();
  document.title = total ? `(${total}) p2pAnon Messenger` : 'p2pAnon Messenger';
}

function notify(peerId, message) {
  paintTitle();
  if (!S.state.settings.notifications) return;
  const contact = S.contact(peerId);
  const text = message.text || (message.file ? message.file.name : 'вложение');
  window.mouth.notify.show({
    title: contact?.name || 'p2pAnon Messenger',
    body: text.length > 140 ? text.slice(0, 137) + '…' : text,
    silent: false,
    onClick: { peerId },
  });
}

function notifyPeer(peer) {
  if (!S.state.settings.notifications) return;
  window.mouth.notify.show({
    title: 'Кто-то рядом',
    body: peer.name + ' в локальной сети',
    silent: true,
    onClick: { discover: true },
  });
}

/* ------------------------------------------------------------------ go --- */
boot().catch((err) => {
  console.error('[boot]', err);
  const root = document.getElementById('onboardRoot');
  root.innerHTML = '';
  root.append(
    el('div', { class: 'onboard' },
      el('div', { class: 'onboard__card' },
        el('h1', { text: 'Не удалось запустить' }),
        el('p', { class: 'onboard__lead', text: err.message }),
        el('div', { class: 'onboard__row' },
          el('button', { class: 'btn btn--primary btn--lg', text: 'Перезапустить', onclick: () => location.reload() })))
    )
  );
});
