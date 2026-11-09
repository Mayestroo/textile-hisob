import { StateCreator } from 'zustand';
import { WorkbookStore, LicenseSlice } from '../types';

export const createLicenseSlice: StateCreator<WorkbookStore, [], [], LicenseSlice> = (set, get) => ({
  licenseStatus: null,
  theme: (typeof window !== 'undefined' && (localStorage.getItem('novda_theme') as 'light' | 'dark')) || 'light',

  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark';
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', next);
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('novda_theme', next);
    }
    set({ theme: next });
  },

  checkLicense: async () => {
    const eAPI = (window as any).electronAPI;
    if (!eAPI?.getLicenseStatus) throw new Error('Aktivatsiya holatini tekshirish faqat Desktop dasturida mavjud.');
    try {
      const status = await eAPI.getLicenseStatus();
      const previous = get();
      const companyId = (value: typeof status | null) => value?.companyId?.trim() || '';
      const sessionId = (value: typeof status | null) => value?.activationId || value?.machineId || '';
      const validContext = (value: typeof status | null) => Boolean(value?.isActivated && !value.isBlocked && companyId(value));
      const contextChanged = !validContext(status)
        || !validContext(previous.licenseStatus)
        || companyId(status) !== companyId(previous.licenseStatus)
        || sessionId(status) !== sessionId(previous.licenseStatus);
      set(contextChanged ? {
        licenseStatus: status,
        payrollValuation: {
          companyId: companyId(status), period: null, workers: [], accountingStatus: 'UNAVAILABLE',
          accountingReasons: ['PAYROLL_VALUATION_UNAVAILABLE'], syncStatus: 'UNKNOWN'
        }
      } : { licenseStatus: status });
      return status;
    } catch (err: any) {
      console.error('License check error:', err);
      throw new Error(err?.message || 'Server bilan bog\'lanib bo\'lmadi.');
    }
  },

  activateWithKey: async (key: string) => {
    const eAPI = (window as any).electronAPI;
    if (eAPI && eAPI.activateLicense) {
      try {
        const res = await eAPI.activateLicense(key);
        if (res.success) {
          await get().checkLicense();
          get().addNotification('success', 'Aktivatsiya qilindi', 'Dastur litsenziyasi muvaffaqiyatli faollashtirildi!');
          return { success: true };
        } else {
          return { success: false, error: res.error || 'Kalit yaroqsiz' };
        }
      } catch (err: any) {
        return { success: false, error: err.message || 'Aktivatsiyada xatolik yuz berdi' };
      }
    }
    return { success: false, error: 'Aktivatsiya faqat Desktop dasturida mavjud' };
  }
});
