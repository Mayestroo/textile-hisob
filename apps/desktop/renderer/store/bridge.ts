import { useEffect } from 'react';
import { useWorkbookStore } from './workbookStore';
import { useUIStore } from './uiStore';
import { useAuthStore, applyRolePermissions } from './authStore';
import { ACTIVE_SHEET_STORAGE_KEY } from '../constants/sheetConstants';
import { captureSessionIdentity } from './sessionGuard';
import { cancelDebouncedSave } from './helpers/debounceSave';

export const syncLicenseAuth = (lic: any) => {
  if (!lic) {
    useAuthStore.getState().setAuth({
      status: 'pending_approval',
      role: null,
      companyId: null,
      user: null
    });
    return;
  }

  const companyId = lic.companyId;
  const deviceId = lic.machineId || useAuthStore.getState().deviceId;
  if (!companyId || !lic.isActivated || lic.isBlocked) {
    useAuthStore.getState().setAuth({
      status: lic.isBlocked ? 'suspended' : 'pending_approval',
      role: null,
      companyId: companyId || null,
      user: lic.user || null,
      deviceId
    });
    return;
  }

  const role = (lic.role ? String(lic.role).toLowerCase() : 'admin') as 'admin' | 'type' | 'print';
  useAuthStore.getState().setAuth({
    status: 'active',
    role,
    permissions: applyRolePermissions(role),
    companyId,
    user: lic.user || null,
    deviceId
  });
};

let bridgeStarted = false;

export function startStoreBridge() {
  if (bridgeStarted) return;
  bridgeStarted = true;

  useWorkbookStore.subscribe((state, previous) => {
    if (state.activeSheet !== previous.activeSheet) {
      if (typeof localStorage !== 'undefined' && state.activeSheet) {
        try {
          localStorage.setItem(ACTIVE_SHEET_STORAGE_KEY, state.activeSheet);
        } catch {}
      }
      useUIStore.getState().setActiveSheet(state.activeSheet);
    }
  });

  useWorkbookStore.subscribe((state, previous) => {
    if (state.licenseStatus !== previous.licenseStatus) {
      cancelDebouncedSave();
      captureSessionIdentity(state.licenseStatus?.companyId);
      syncLicenseAuth(state.licenseStatus);
    }
  });

  syncLicenseAuth(useWorkbookStore.getState().licenseStatus);
}

export function useStoreBridge() {
  useEffect(() => {
    startStoreBridge();
    const workbook = useWorkbookStore.getState();
    useUIStore.getState().setActiveSheet(workbook.activeSheet);
    if (workbook.licenseStatus) syncLicenseAuth(workbook.licenseStatus);
  }, []);
}

export function syncAtomicFromLegacy() {
  const workbook = useWorkbookStore.getState();
  useUIStore.getState().setActiveSheet(workbook.activeSheet);
}
