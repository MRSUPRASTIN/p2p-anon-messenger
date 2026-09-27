/**
 * Application state: profile, settings, contacts, chat history.
 * Everything is persisted through the main process bridge.
 */
import { uid, debounce } from './util.js';

const bus = new Map();

export const on = (event, handler) => {
  if (!bus.has(event)) bus.set(event, new Set());
  bus.get(event).add(handler);
  return () => bus.get(event).delete(handler);
};

export const emit = (event, payload) => {
  const set = bus.get(event);
  if (!set) return;
  for (const handler of [...set]) {
    try {
      handler(payload);
    } catch (err) {
      console.error('[state] handler for ' + event, err);
    }
  }
};

export const DEFAULT_SETTINGS = {
  theme: 'dark',
  accent: '#7c5cff',
  notifications: true,
  sound: false,
  readReceipts: true,
  typing: true,
  enterToSend: true,
  showFingerprint: true,
  autoConnect: true,
  minimiseToTray: true,
  compact: false,
  lanDiscovery: true,
  autostart: false,
};

export const state = {
  ready: false,
  info: null,
  profile: null,
  settings: { ...DEFAULT_SETTINGS },
  contacts: new Map(),
  chats: new Map(),
  loadedChats: new Set(),
  discovered: new Map(),
  peers: new Map(),
  typing: new Map(),
  activeId: null,
  section: 'chats',
  filter: 'all',
  query: '',
  unread: new Map(),
};

export async function init() {
  state.info = await window.mouth.info();
  state.settings = { ...DEFAULT_SETTINGS, ...(await window.mouth.store.get('settings.json', {})) };

  const storedProfile = await window.mouth.store.get('profile.json', null);
  if (storedProfile) {
    state.profile = storedProfile;
  }
  const contacts = await window.mouth.store.get('contacts.json', []);
  for (const contact of contacts || []) state.contacts.set(contact.id, contact);
  state.ready = true;
  return state;
}

/* -------------------------------------------------------------- profile --- */
const saveProfileNow = async () => {
  await window.mouth.store.set('profile.json', state.profile);
  emit('profile', state.profile);
};
export const saveProfile = debounce(saveProfileNow, 120);

export function setProfile(patch) {
  state.profile = { ...state.profile, ...patch, updatedAt: Date.now() };
  saveProfile();
  return state.profile;
}

/* ------------------------------------------------------------- settings --- */
const saveSettingsNow = async () => {
  await window.mouth.store.set('settings.json', state.settings);
  emit('settings', state.settings);
};
export const saveSettings = debounce(saveSettingsNow, 120);

export function setSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  saveSettings();
  emit('settings', state.settings);
  return state.settings;
}

/* ------------------------------------------------------------- contacts --- */
const saveContacts = debounce(async () => {
  await window.mouth.store.set('contacts.json', [...state.contacts.values()]);
}, 200);

export function upsertContact(patch) {
  const existing = state.contacts.get(patch.id);
  const contact = {
    id: patch.id,
    name: patch.name ?? existing?.name ?? 'Unknown',
    color: patch.color ?? existing?.color ?? '',
    emoji: patch.emoji ?? existing?.emoji ?? '',
    avatar: patch.avatar ?? existing?.avatar ?? '',
    pubRaw: patch.pubRaw ?? existing?.pubRaw ?? '',
    dhRaw: patch.dhRaw ?? existing?.dhRaw ?? '',
    fingerprint: patch.fingerprint ?? existing?.fingerprint ?? '',
    note: patch.note ?? existing?.note ?? '',
    pinned: patch.pinned ?? existing?.pinned ?? false,
    verified: patch.verified ?? existing?.verified ?? false,
    lan: patch.lan ?? existing?.lan ?? false,
    createdAt: existing?.createdAt ?? Date.now(),
    lastSeen: patch.lastSeen ?? existing?.lastSeen ?? 0,
  };
  state.contacts.set(contact.id, contact);
  saveContacts();
  emit('contacts', contact);
  return contact;
}

export function patchContact(id, patch) {
  const existing = state.contacts.get(id);
  if (!existing) return null;
  const next = { ...existing, ...patch };
  state.contacts.set(id, next);
  saveContacts();
  emit('contacts', next);
  return next;
}

export function removeContact(id) {
  state.contacts.delete(id);
  state.chats.delete(id);
  state.unread.delete(id);
  saveContacts();
  emit('contacts', null);
  return window.mouth.chat.forget(id);
}

export const contact = (id) => state.contacts.get(id) || null;
export const contactName = (id) => state.contacts.get(id)?.name || 'Unknown';

export function contactList() {
  return [...state.contacts.values()];
}

/* ---------------------------------------------------------------- chats --- */
export async function ensureChat(peerId) {
  if (state.loadedChats.has(peerId)) return state.chats.get(peerId) || [];
  const messages = await window.mouth.chat.load(peerId);
  state.chats.set(peerId, messages || []);
  state.loadedChats.add(peerId);
  return state.chats.get(peerId);
}

export const messages = (peerId) => state.chats.get(peerId) || [];

const persistChat = debounce(async (peerId) => {
  const list = state.chats.get(peerId);
  if (!list) return;
  await window.mouth.chat.save(peerId, list);
}, 400);

export function addMessage(peerId, message) {
  if (!state.chats.has(peerId)) {
    state.chats.set(peerId, []);
    state.loadedChats.add(peerId);
  }
  const list = state.chats.get(peerId);
  const existing = list.findIndex((m) => m.id === message.id);
  if (existing !== -1) list[existing] = { ...list[existing], ...message };
  else list.push(message);
  persistChat(peerId);
  bump(peerId);
  emit('message', { peerId, message });
  return message;
}

export function patchMessage(peerId, id, patch) {
  const list = state.chats.get(peerId);
  if (!list) return null;
  const message = list.find((m) => m.id === id);
  if (!message) return null;
  Object.assign(message, patch);
  persistChat(peerId);
  emit('message', { peerId, message });
  return message;
}

export function findMessage(peerId, id) {
  return messages(peerId).find((m) => m.id === id) || null;
}

export function removeMessage(peerId, id) {
  const list = state.chats.get(peerId);
  if (!list) return;
  const at = list.findIndex((m) => m.id === id);
  if (at === -1) return;
  list.splice(at, 1);
  persistChat(peerId);
  emit('message', { peerId, message: null, removed: id });
}

export function lastMessage(peerId) {
  const list = messages(peerId);
  return list.length ? list[list.length - 1] : null;
}

export function unreadCount(peerId) {
  return state.unread.get(peerId) || 0;
}

export function totalUnread() {
  let sum = 0;
  for (const n of state.unread.values()) sum += n;
  return sum;
}

function bump(peerId) {
  emit('unread', { peerId });
}

export function setUnread(peerId, value) {
  if (value <= 0) state.unread.delete(peerId);
  else state.unread.set(peerId, value);
  emit('unread', { peerId });
}

export function markUnread(peerId) {
  setUnread(peerId, unreadCount(peerId) + 1);
}

export function clearUnread(peerId) {
  if (state.unread.has(peerId)) setUnread(peerId, 0);
}

export function clearAllUnread() {
  state.unread.clear();
  emit('unread', {});
}

/* --------------------------------------------------------------- active --- */
export function setActive(peerId) {
  if (state.activeId === peerId) return;
  state.activeId = peerId;
  emit('active', peerId);
}

export function setSection(section) {
  if (state.section === section) return;
  state.section = section;
  emit('section', section);
}

export function setFilter(filter) {
  state.filter = filter;
  emit('filter', filter);
}

export function setQuery(query) {
  state.query = query;
  emit('query', query);
}

export function setTyping(peerId, value) {
  if (value) state.typing.set(peerId, Date.now());
  else state.typing.delete(peerId);
  emit('typing', { peerId, value });
}

export const isTyping = (peerId) => state.typing.has(peerId);

export function setDiscovered(peer, isNew) {
  state.discovered.set(peer.id, { ...peer, isNew });
  state.peers.set(peer.id, peer);
  emit('discovered', { peer, isNew });
}

export function dropDiscovered(id) {
  state.discovered.delete(id);
  state.peers.delete(id);
  emit('discovered', { peer: null, id });
}

export function setLan(id, value) {
  const known = state.discovered.get(id);
  if (known) known.lan = value;
  patchContact(id, { lan: value });
}

export function newMessageId() {
  return uid('m');
}
