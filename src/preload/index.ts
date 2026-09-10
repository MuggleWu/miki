import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type MikiApi } from '../shared/ipc'

const api: MikiApi = {
  loadWorkspace: () => ipcRenderer.invoke(IPC.loadWorkspace),
  addDeck: (name: string) => ipcRenderer.invoke(IPC.addDeck, name),
  renameDeck: (id: string, name: string) => ipcRenderer.invoke(IPC.renameDeck, id, name),
  deleteDeck: (id: string) => ipcRenderer.invoke(IPC.deleteDeck, id),
  getStudy: (deckId: string) => ipcRenderer.invoke(IPC.getStudy, deckId),
  answer: (cardId: string, rating: 1 | 2 | 3 | 4, durationMs?: number) =>
    ipcRenderer.invoke(IPC.answer, cardId, rating, durationMs),
  undo: () => ipcRenderer.invoke(IPC.undo),
  addCard: (deckId: string, front: string, back: string) => ipcRenderer.invoke(IPC.addCard, deckId, front, back),
  updateCard: (cardId: string, patch: { front?: string; back?: string }) =>
    ipcRenderer.invoke(IPC.updateCard, cardId, patch),
  // sendSync：窗口关闭路径上唯一能保证「写完再返回」的方式（见 MikiApi 注释）
  flushPendingEdit: (cardId: string, patch: { front: string; back: string }) =>
    ipcRenderer.sendSync(IPC.flushPendingEdit, cardId, patch) as boolean,
  getCard: (cardId: string) => ipcRenderer.invoke(IPC.getCard, cardId),
  deleteCard: (cardId: string) => ipcRenderer.invoke(IPC.deleteCard, cardId),
  queryCards: (params: unknown) => ipcRenderer.invoke(IPC.queryCards, params),
  getStats: (params: unknown) => ipcRenderer.invoke(IPC.getStats, params),
  saveBrowserConfig: (columns: string[], sort: unknown[]) => ipcRenderer.invoke(IPC.saveBrowserConfig, columns, sort),
  saveTheme: (theme: 'light' | 'dark') => ipcRenderer.invoke(IPC.saveTheme, theme),
  saveConfig: (patch: unknown) => ipcRenderer.invoke(IPC.saveConfig, patch),
  setCardSuspended: (cardId: string, suspended: boolean) => ipcRenderer.invoke(IPC.setCardSuspended, cardId, suspended),
  moveCards: (cardIds: string[], deckId: string) => ipcRenderer.invoke(IPC.moveCards, cardIds, deckId),
  resetProgress: (cardIds: string[]) => ipcRenderer.invoke(IPC.resetProgress, cardIds),
  addCards: (deckId: string, items: { front: string; back: string }[]) =>
    ipcRenderer.invoke(IPC.addCards, deckId, items),
  updateCards: (items: { cardId: string; front?: string; back?: string }[]) =>
    ipcRenderer.invoke(IPC.updateCards, items),
  deleteCards: (cardIds: string[]) => ipcRenderer.invoke(IPC.deleteCards, cardIds),
  getCards: (cardIds: string[]) => ipcRenderer.invoke(IPC.getCards, cardIds),
  previewIntervals: (cardId: string) => ipcRenderer.invoke(IPC.previewIntervals, cardId),
  onWorkspaceChanged: (cb) => {
    const h = () => cb()
    ipcRenderer.on(IPC.workspaceChanged, h)
    return () => ipcRenderer.removeListener(IPC.workspaceChanged, h)
  },
  onUndoDiscarded: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, dropped: number) => cb(dropped)
    ipcRenderer.on(IPC.undoDiscarded, h)
    return () => ipcRenderer.removeListener(IPC.undoDiscarded, h)
  },
  openCardDialog: (payload: unknown) => ipcRenderer.invoke(IPC.openCardDialog, payload),
  closeCardDialog: () => ipcRenderer.invoke(IPC.closeCardDialog),
  notifyCardsChanged: (kind: 'add' | 'edit') => ipcRenderer.invoke(IPC.notifyCardsChanged, kind),
  onCardDialogPayload: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, p: unknown) => cb(p)
    ipcRenderer.on(IPC.cardDialogPayload, h)
    return () => ipcRenderer.removeListener(IPC.cardDialogPayload, h)
  },
  onCardsChanged: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, p: { kind: 'add' | 'edit' }) => cb(p)
    ipcRenderer.on(IPC.cardsChanged, h)
    return () => ipcRenderer.removeListener(IPC.cardsChanged, h)
  },
  onCardDialogVisibility: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, visible: boolean) => cb(visible)
    ipcRenderer.on(IPC.cardDialogVisibility, h)
    return () => ipcRenderer.removeListener(IPC.cardDialogVisibility, h)
  },
  dataDamageReport: () => ipcRenderer.invoke(IPC.dataDamageReport),
  workspaceStatus: () => ipcRenderer.invoke(IPC.workspaceStatus),
  workspaceChooseFolder: () => ipcRenderer.invoke(IPC.workspaceChooseFolder),
  workspaceConfirm: (p) => ipcRenderer.invoke(IPC.workspaceConfirm, p),
  workspaceAdd: (p) => ipcRenderer.invoke(IPC.workspaceAdd, p),
  workspaceSwitch: (p) => ipcRenderer.invoke(IPC.workspaceSwitch, p),
  workspaceRemove: (p) => ipcRenderer.invoke(IPC.workspaceRemove, p),
  workspaceReveal: (p) => ipcRenderer.invoke(IPC.workspaceReveal, p)
}

contextBridge.exposeInMainWorld('miki', api)
