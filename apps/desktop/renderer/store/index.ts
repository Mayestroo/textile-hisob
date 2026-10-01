/**
 * Store Barrel Export — Phase 1
 * Atomic store'larga qulay kirish nuqtasi.
 */


export { useUIStore, useNotifications, useUIActions } from './uiStore';
export {
  useAuthStore,
  useCan,
  useCanAny,
  useUser,
  useRole,
  useAuthStatus,
  useCompanyId,
  useDeviceId,
  applyRolePermissions
} from './authStore';
export { useSyncStore, useSyncStatus, useSyncInfo } from './syncStore';

// Bridge
export { startStoreBridge, useStoreBridge, syncAtomicFromLegacy } from './bridge';

// Legacy store (backward compat)
export { useWorkbookStore } from './workbookStore';
export { DEFAULT_BATCH_SIZES } from '../constants/batchConstants';
export type { WorkbookStore, ActiveCellInfo, ModalState } from './types';
export type {
  Notification,
  ModalType,
  ModalState as UIModalState,
  ActiveCellInfo as UIActiveCellInfo
} from './uiStore';
export type { Role, Permission } from '../types/sync';
