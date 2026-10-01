/**
 * Atomic UI Store — Phase 1
 * Faqat UI bilan bog'liq holat: activeSheet, modals, notifications, activeCell.
 */

import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { ACTIVE_SHEET_STORAGE_KEY } from '../constants/sheetConstants';

export interface Notification {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  title: string;
  message: string;
  createdAt: number;
}

export type ModalType =
  | 'new_operation'
  | 'delete_operation'
  | 'worker_manager'
  | 'backup_manager'
  | 'new_model'
  | 'period_manager'
  | 'license_activation'
  | 'developer_info'
  | 'patta_print'
  | 'worker_detail'
  | 'sync_settings'
  | 'pending_approval'
  | null;

export interface ModalState {
  type: ModalType;
  modelId?: string;
  opName?: string;
  workerId?: number;
  data?: any;
}

export interface ActiveCellInfo {
  cellId: string;
  sheetName: string;
  value: string;
  formula?: string;
  isReadOnly?: boolean;
}

export interface UIStore {
  activeSheet: string;
  activeCell: ActiveCellInfo;
  notifications: Notification[];
  modalState: ModalState;
  loadingMessage: string | null;

  setActiveSheet: (sheetName: string) => void;
  setActiveCell: (info: ActiveCellInfo) => void;
  openModal: (modal: ModalState) => void;
  closeModal: () => void;
  addNotification: (type: Notification['type'], title: string, message: string) => void;
  removeNotification: (id: string) => void;
  setLoadingMessage: (msg: string | null) => void;
  clearAllNotifications: () => void;
}

function genId(): string {
  return `n_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

const NOTIF_TTL_MS = 5000;
const MAX_NOTIFS = 10;

const getInitialActiveSheet = (): string => {
  if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    try {
      const saved = localStorage.getItem(ACTIVE_SHEET_STORAGE_KEY);
      if (saved && saved.trim()) {
        return saved.trim();
      }
    } catch {}
  }
  return 'Umumiy';
};

export const useUIStore = create<UIStore>((set, get) => {
  const initialSheet = getInitialActiveSheet();
  return {
    activeSheet: initialSheet,
    activeCell: { cellId: 'A1', sheetName: initialSheet, value: '' },
    notifications: [],
    modalState: { type: null },
    loadingMessage: null,

    setActiveSheet: (sheetName) => {
      if (typeof localStorage !== 'undefined' && sheetName) {
        try {
          localStorage.setItem(ACTIVE_SHEET_STORAGE_KEY, sheetName);
        } catch {}
      }
      set({ activeSheet: sheetName });
    },

  setActiveCell: (info) => set({ activeCell: info }),

  openModal: (modal) => set({ modalState: modal }),

  closeModal: () => set({ modalState: { type: null } }),

  addNotification: (type, title, message) => {
    const notif: Notification = {
      id: genId(),
      type,
      title,
      message,
      createdAt: Date.now()
    };
    const current = get().notifications;
    const updated = [...current, notif].slice(-MAX_NOTIFS);
    set({ notifications: updated });
    // Auto-remove after TTL
    setTimeout(() => {
      get().removeNotification(notif.id);
    }, NOTIF_TTL_MS);
  },

  removeNotification: (id) => {
    set({ notifications: get().notifications.filter((n) => n.id !== id) });
  },

  setLoadingMessage: (msg) => set({ loadingMessage: msg }),

  clearAllNotifications: () => set({ notifications: [] })
  };
});

export const useNotifications = () =>
  useUIStore(useShallow((s) => s.notifications));

export const useUIActions = () =>
  useUIStore(
    useShallow((s) => ({
      setActiveSheet: s.setActiveSheet,
      setActiveCell: s.setActiveCell,
      openModal: s.openModal,
      closeModal: s.closeModal,
      addNotification: s.addNotification,
      removeNotification: s.removeNotification,
      setLoadingMessage: s.setLoadingMessage
    }))
  );
