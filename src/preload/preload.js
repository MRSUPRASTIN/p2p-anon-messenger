'use strict';
/** The only bridge between the sandboxed renderer and Node. */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (handler) => {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('mouth', {
  info: () => ipcRenderer.invoke('app:info'),

  store: {
    get: (name, fallback) => ipcRenderer.invoke('store:get', name, fallback),
    set: (name, value) => ipcRenderer.invoke('store:set', name, value),
  },

  win: {
    action: (name) => ipcRenderer.invoke('win:action', name),
    state: () => ipcRenderer.invoke('win:state'),
    onState: (fn) => {
      const handler = (_e, state) => fn(state);
      ipcRenderer.on('win:changed', handler);
      return () => ipcRenderer.removeListener('win:changed', handler);
    },
  },

  chat: {
    load: (peerId) => ipcRenderer.invoke('chat:load', peerId),
    save: (peerId, messages) => ipcRenderer.invoke('chat:save', peerId, messages),
    forget: (peerId) => ipcRenderer.invoke('chat:forget', peerId),
  },

  files: {
    pick: (opts) => ipcRenderer.invoke('file:pick', opts),
    pathFor: (file) => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return '';
      }
    },
    read: (filePath, offset, length) => ipcRenderer.invoke('file:read', filePath, offset, length),
    chunk: (transferId, index, data) => ipcRenderer.invoke('file:chunk', transferId, index, data),
    finish: (transferId, name, size) => ipcRenderer.invoke('file:finish', transferId, name, size),
    cancel: (transferId) => ipcRenderer.invoke('file:cancel', transferId),
    store: (payload) => ipcRenderer.invoke('file:store', payload),
    stat: (id, name) => ipcRenderer.invoke('file:stat', id, name),
    open: (id, name) => ipcRenderer.invoke('file:open', id, name),
    reveal: (id, name) => ipcRenderer.invoke('file:reveal', id, name),
    url: (id, name) => 'app://mouth/file/' + encodeURIComponent(id) + '/' + encodeURIComponent(name),
  },

  net: {
    start: (profile) => ipcRenderer.invoke('net:start', profile),
    stop: () => ipcRenderer.invoke('net:stop'),
    broadcast: (payload) => ipcRenderer.invoke('net:broadcast', payload),
    send: (peerId, payload) => ipcRenderer.invoke('net:send', peerId, payload),
    peers: () => ipcRenderer.invoke('net:peers'),
    remember: (peerId, addr) => ipcRenderer.invoke('net:remember', peerId, addr),
    onPeer: on('net:peer'),
    onBye: on('net:bye'),
    onSignal: on('net:signal'),
    onWarn: on('net:warn'),
    onReady: on('net:ready'),
  },

  notify: {
    show: (payload) => ipcRenderer.invoke('notify', payload),
    clear: () => ipcRenderer.invoke('notify:clear'),
  },

  app: {
    reset: () => ipcRenderer.invoke('app:reset'),
    openUserData: () => ipcRenderer.invoke('app:openUserData'),
    autostart: (enabled) => ipcRenderer.invoke('app:autostart', enabled),
    autostartState: () => ipcRenderer.invoke('app:autostartState'),
    openExternal: (url) => ipcRenderer.invoke('shell:open', url),
    onAction: on('ui:action'),
  },
});
