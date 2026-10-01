/**
 * Auth Store — Phase 4 (RBAC)
 * Hozircha UI uchun tayyor, Firebase Auth Phase 4 da ulanadi.
 */

import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { Role, Permission, UserProfile } from '../types/sync';
import { DEFAULT_PERMISSIONS } from '../types/sync';

export type AuthStatus =
  | 'unauthenticated'
  | 'pending_approval'
  | 'trial'
  | 'active'
  | 'suspended'
  | 'expired'
  | 'offline';

export interface AuthState {
  status: AuthStatus;
  user: UserProfile | null;
  permissions: Permission[];
  role: Role | null;
  companyId: string | null;
  deviceId: string | null;

  setAuth: (auth: Partial<AuthState>) => void;
  clearAuth: () => void;
  hasPermission: (perm: Permission) => boolean;
  hasAnyPermission: (...perms: Permission[]) => boolean;
}

const DEVICE_ID_KEY = 'novda_device_id';

function getOrCreateDeviceId(): string {
  if (typeof window === 'undefined') return 'server';
  // If running in Electron, wait for the actual hardware Machine ID from Electron
  if ((window as any).electronAPI) {
    return '';
  }
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = `dev-${crypto.randomUUID()}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'unauthenticated',
  user: null,
  permissions: [],
  role: null,
  companyId: null,
  deviceId: typeof window !== 'undefined' ? getOrCreateDeviceId() : null,

  setAuth: (auth) => set((prev) => ({ ...prev, ...auth })),

  clearAuth: () =>
    set({
      status: 'unauthenticated',
      user: null,
      permissions: [],
      role: null,
      companyId: null
    }),

  hasPermission: (perm) => get().permissions.includes(perm),
  hasAnyPermission: (...perms) => perms.some((p) => get().permissions.includes(p))
}));

// Hook: permission check
export const useCan = (permission: Permission): boolean =>
  useAuthStore((s) => s.permissions.includes(permission));

export const useCanAny = (...permissions: Permission[]): boolean =>
  useAuthStore(
    useShallow((s) => permissions.some((p) => s.permissions.includes(p)))
  );

export const useUser = () => useAuthStore((s) => s.user);
export const useRole = () => useAuthStore((s) => s.role);
export const useAuthStatus = () => useAuthStore((s) => s.status);
export const useCompanyId = () => useAuthStore((s) => s.companyId);
export const useDeviceId = () => useAuthStore((s) => s.deviceId);

// Apply role to permissions helper
export function applyRolePermissions(role: Role): Permission[] {
  return DEFAULT_PERMISSIONS[role] || [];
}
