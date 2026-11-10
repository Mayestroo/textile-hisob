import { useEffect } from 'react';
import { useWorkbookStore } from './workbookStore';
import { useUIStore } from './uiStore';
import { useAuthStore, applyRolePermissions } from './authStore';
import { ACTIVE_SHEET_STORAGE_KEY } from '../constants/sheetConstants';
import { invalidateSessionIdentity } from './sessionGuard';
import { cancelDebouncedSave } from './helpers/debounceSave';

export const syncLicenseAuth = (lic: any) => {
  if (!lic) {
    useAuthStore.getState().setAuth({
      status: 'pending_approval',
      role: null,
      permissions: [],
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
      permissions: [],
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

function licenseSessionKey(license: any): string {
  if (!license) return '';
  return [license.companyId || '', license.activationId || '', license.machineId || '',
    Boolean(license.isActivated), Boolean(license.isBlocked), license.role || ''].join('|');
}

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
    if (licenseSessionKey(state.licenseStatus) !== licenseSessionKey(previous.licenseStatus)) {
      cancelDebouncedSave();
      invalidateSessionIdentity(state.licenseStatus?.companyId);
      const companyId = state.licenseStatus?.companyId || '';
      useWorkbookStore.setState({
        payrollValuation: {
          companyId, period: null, workers: [], accountingStatus: 'UNAVAILABLE',
          accountingReasons: ['PAYROLL_VALUATION_UNAVAILABLE'], syncStatus: 'UNKNOWN'
        }
      });
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
