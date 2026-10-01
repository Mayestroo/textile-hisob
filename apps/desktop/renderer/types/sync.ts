/**
 * Sync & RBAC Type Definitions
 * Phase 0 — Foundation
 */

// ============================================
// ROLES & PERMISSIONS
// ============================================

export type Role = 'admin' | 'type' | 'print';

export type Permission =
  | 'view:models'
  | 'edit:models'
  | 'edit:hisob'
  | 'view:umumiy'
  | 'view:patta'
  | 'edit:patta'
  | 'print:patta'
  | 'view:patta-hisob'
  | 'view:workers'
  | 'edit:workers'
  | 'edit:avans'
  | 'view:backup'
  | 'restore:backup'
  | 'export:excel'
  | 'view:periods'
  | 'edit:periods'
  | 'manage:license'
  | 'view:audit-log';

export const DEFAULT_PERMISSIONS: Record<Role, Permission[]> = {
  admin: [
    'view:models', 'edit:models',
    'edit:hisob', 'view:umumiy',
    'view:patta', 'edit:patta', 'print:patta', 'view:patta-hisob',
    'view:workers', 'edit:workers', 'edit:avans',
    'view:backup', 'restore:backup', 'export:excel',
    'view:periods', 'edit:periods',
    'manage:license', 'view:audit-log'
  ],
  type: [
    'view:models', 'edit:models',
    'view:patta', 'edit:patta', 'print:patta', 'view:patta-hisob',
    'edit:hisob', 'view:umumiy',
    'view:workers', 'edit:workers', 'edit:avans',
    'view:backup', 'export:excel',
    'view:periods'
  ],
  print: [
    'view:models',
    'view:patta', 'print:patta', 'view:patta-hisob'
  ]
};

export const ROLE_LABELS_UZ: Record<Role, string> = {
  admin: 'Administrator',
  type: 'Maʼlumot kirituvchi',
  print: 'Printer operator'
};

export const ROLE_LABELS_SHORT: Record<Role, string> = {
  admin: 'ADMIN',
  type: 'TYPE',
  print: 'PRINT'
};

// ============================================
// USER PROFILE
// ============================================

export interface UserProfile {
  uid: string;
  email: string;
  companyId: string;
  displayName: string;
  role: Role;
  permissions: Permission[];
  deviceId: string;
  status: 'active' | 'suspended';
  lastSeen: string;
  createdAt: string;
}

// ============================================
// COMPANY
// ============================================

export interface CompanyData {
  companyId: string;
  name: string;
  ownerId: string;
  seats: number;
  typeSeats: number;
  printSeats: number;
  adminSeats: number;
  usedSeats: string[];
  plan: 'trial' | 'pro' | 'enterprise';
  status: 'active' | 'suspended' | 'expired';
  createdAt: string;
  expiresAt: string | 'lifetime';
}

// ============================================
// PENDING DEVICE (yangi qurilma so'rovi)
// ============================================

export interface PendingDevice {
  deviceId: string;
  hostname: string;
  osUser: string;
  platform: string;
  hwid: string;
  appVersion: string;
  requestedAt: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  retryCount: number;
  approvedBy?: string;
  approvedAt?: string;
  accessCode?: string;
  role?: Role;
  companyId?: string;
}

// ============================================
// SYNC STATE (normalized)
// ============================================

export interface SyncState {
  workers: Record<number, SyncWorker>;
  models: Record<string, SyncModel>;
  quantities: Record<string, Record<number, Record<string, number>>>; // modelId -> workerId -> opName -> qty
  ticketForms: Record<string, SyncTicketForm>;
  submittedTickets: Record<string, SyncSubmittedTicket>;
  printedParties: Record<string, SyncPrintedParty>;
  pattaBatches: Record<string, SyncPattaBatch>;
  periods: Record<string, SyncPeriod>;
  currentPeriodId: string;
  availableSizes: string[];
  nextPartyNumber: number;
  version: number;
  lastSyncedAt: string;
}

export interface SyncWorker {
  id: number;
  name: string;
  avans: number;
  jarima: number;
  staj: number;
  [k: string]: any;
}

export interface SyncModel {
  id: string;
  name: string;
  hisobSheetName: string;
  title: string;
  party: string;
  color: string;
  size: string;
  operations: Array<{ id: string; name: string; rate: number }>;
  pattaOpsOrder: string[];
  [k: string]: any;
}

export interface SyncTicketForm {
  modelId: string;
  date: string;
  party: string;
  color: string;
  size: string;
  qty: string;
  patta: string;
  entries: Record<string, any>;
}

export interface SyncSubmittedTicket {
  id: string;
  modelId: string;
  modelName: string;
  party: string;
  color: string;
  size: string;
  qty: number;
  patta: number;
  date: string;
  submittedAt: string;
  [k: string]: any;
}

export interface SyncPrintedParty {
  id: string;
  partyNumber: string;
  modelId: string;
  modelName: string;
  color: string;
  pattaCount: number;
  ishSoni: number;
  printedAt: string;
  [k: string]: any;
}

export interface SyncPattaBatch {
  modelId: string;
  partyNumber: string;
  isCustomParty: boolean;
  totalIshSoni: string;
  color: string;
  sizes: Record<string, string>;
}

export interface SyncPeriod {
  id: string;
  name: string;
  startDate: string;
  endDate?: string;
  isClosed: boolean;
  createdAt: string;
}

// ============================================
// PENDING CHANGE (offline queue)
// ============================================

export interface PendingChange {
  id: string;
  path: string;
  value: any;
  timestamp: string;
  synced: boolean;
  retryCount: number;
  deviceId: string;
}

// ============================================
// SYNC STATUS
// ============================================

export type SyncStatus = 'idle' | 'connecting' | 'syncing' | 'synced' | 'offline' | 'error';

export interface SyncInfo {
  status: SyncStatus;
  lastSyncedAt: string | null;
  pendingChanges: number;
  online: boolean;
  isServerConnected: boolean;
  errorMessage?: string;
}

// ============================================
// EMPTY STATE
// ============================================

export const EMPTY_SYNC_STATE: SyncState = {
  workers: {},
  models: {},
  quantities: {},
  ticketForms: {},
  submittedTickets: {},
  printedParties: {},
  pattaBatches: {},
  periods: {},
  currentPeriodId: '',
  availableSizes: [],
  nextPartyNumber: 1,
  version: 0,
  lastSyncedAt: ''
};
