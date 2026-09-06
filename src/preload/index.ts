import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'

const api = {
  loadWorkspace: () => ipcRenderer.invoke(IPC.loadWorkspace),
  addDeck: (name: string) => ipcRenderer.invoke(IPC.addDeck, name),
  renameDeck: (id: string, name: string) => ipcRenderer.invoke(IPC.renameDeck, id, name),
  deleteDeck: (id: string) => ipcRenderer.invoke(IPC.deleteDeck, id),
  getStudy: (deckId: string) => ipcRenderer.invoke(IPC.getStudy, deckId),
  answer: (cardId: string, rating: 1 | 2 | 3 | 4, durationMs?: number) =>
    ipcRenderer.invoke(IPC.answer, cardId, rating, durationMs),
  undo: () => ipcRenderer.invoke(IPC.undo),
  addCard: (deckId: string, front: string, back: string) => ipcRenderer.invoke(IPC.addCard, deckId, front, back),
  updateCard: (cardId: string, front: string, back: string) => ipcRenderer.invoke(IPC.updateCard, cardId, front, back),
  getCard: (cardId: string) => ipcRenderer.invoke(IPC.getCard, cardId),
  deleteCard: (cardId: string) => ipcRenderer.invoke(IPC.deleteCard, cardId),
  queryCards: (params: unknown) => ipcRenderer.invoke(IPC.queryCards, params),
  getStats: (params: unknown) => ipcRenderer.invoke(IPC.getStats, params),
  saveBrowserConfig: (columns: string[], sort: unknown[]) =>
    ipcRenderer.invoke(IPC.saveBrowserConfig, columns, sort),
  saveTheme: (theme: 'light' | 'dark') => ipcRenderer.invoke(IPC.saveTheme, theme),
  saveConfig: (patch: unknown) => ipcRenderer.invoke(IPC.saveConfig, patch),
  setCardSuspended: (cardId: string, suspended: boolean) =>
    ipcRenderer.invoke(IPC.setCardSuspended, cardId, suspended),
  previewIntervals: (cardId: string) => ipcRenderer.invoke(IPC.previewIntervals, cardId)
}

contextBridge.exposeInMainWorld('miki', api)
