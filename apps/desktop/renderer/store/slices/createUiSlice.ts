import { StateCreator } from 'zustand';
import { WorkbookStore, UiSlice, ActiveCellInfo, ModalState } from '../types';
import { Notification } from '../../types/workbook';
import { DEFAULT_ACTIVE_SHEET, ACTIVE_SHEET_STORAGE_KEY } from '../../constants/sheetConstants';

const getInitialActiveSheet = (): string => {
  if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    try {
      const saved = localStorage.getItem(ACTIVE_SHEET_STORAGE_KEY);
      if (saved && saved.trim()) {
        return saved.trim();
      }
    } catch {}
  }
  return DEFAULT_ACTIVE_SHEET;
};

export const createUiSlice: StateCreator<WorkbookStore, [], [], UiSlice> = (set, get) => {
  const initialSheet = getInitialActiveSheet();
  return {
    activeSheet: initialSheet,
    activeCell: {
      cellId: 'A3',
      sheetName: initialSheet,
      value: '',
      formula: ''
    },
    notifications: [],
    modalState: { type: null },
    confirmState: null,
    loadingMessage: null,
    availableUpdate: null,

    setAvailableUpdate: (update) => set({ availableUpdate: update }),
    setLoadingMessage: (msg: string | null) => set({ loadingMessage: msg }),

    setActiveSheet: (sheetName: string) => {
      if (typeof localStorage !== 'undefined' && sheetName) {
        try {
          localStorage.setItem(ACTIVE_SHEET_STORAGE_KEY, sheetName);
        } catch {}
      }
      set({ activeSheet: sheetName });
    },

  setActiveCell: (info: ActiveCellInfo) => {
    const cur = get().activeCell;
    if (
      cur &&
      cur.cellId === info.cellId &&
      cur.sheetName === info.sheetName &&
      cur.value === info.value &&
      cur.formula === info.formula
    ) {
      return;
    }
    set({ activeCell: info });
  },

  openModal: (modal: ModalState) => {
    set({ modalState: modal });
  },

  closeModal: () => {
    set({ modalState: { type: null } });
  },

  confirmAction: (options) => {
    return new Promise<boolean>((resolve) => {
      set({
        confirmState: {
          ...options,
          resolve: (confirmed: boolean) => {
            set({ confirmState: null });
            resolve(confirmed);
            // Critical for Electron on Windows: refocus window so inputs are immediately selectable
            setTimeout(() => {
              try {
                window.focus();
              } catch {}
            }, 30);
          }
        }
      });
    });
  },

  closeConfirm: (result: boolean) => {
    const current = get().confirmState;
    if (current && current.resolve) {
      current.resolve(result);
    } else {
      set({ confirmState: null });
    }
    setTimeout(() => {
      try {
        window.focus();
      } catch {}
    }, 30);
  },

  addNotification: (type: Notification['type'], title: string, message: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    set((state) => {
      // Bir xil nom va xabarga ega bildirishnoma allaqachon ekranda tursa, uni takrorlamaymiz
      const isDuplicate = state.notifications.some(
        (n) => n.title === title && n.message === message
      );
      if (isDuplicate) return state;

      const updated = [...state.notifications, { id, type, title, message, timestamp: Date.now() }];
      return { notifications: updated.slice(-4) };
    });

    setTimeout(() => {
      set((state) => ({
        notifications: state.notifications.filter((n) => n.id !== id)
      }));
    }, 4500);
  },

  removeNotification: (id: string) => {
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id)
    }));
  }
  };
};
