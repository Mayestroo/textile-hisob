import React, { useEffect, useRef } from 'react';
import { TitleBar } from './components/layout/TitleBar';
import { SheetTabs } from './components/layout/SheetTabs';
import { PattaView } from './features/patta/PattaView';
import { PattaBatchView } from './features/patta/PattaBatchView';
import { HisobView } from './features/models/HisobView';
import { UmumiyView } from './features/payroll/UmumiyView';

// Phase 6: Code Splitting for heavy views & modals
const PattaHisobView = React.lazy(() => import('./features/patta/PattaHisobView').then(m => ({ default: m.PattaHisobView })));
const KonveyerView = React.lazy(() => import('./features/models/KonveyerView').then(m => ({ default: m.KonveyerView })));

import { NewOperationModal } from './features/models/modals/NewOperationModal';
import { DeleteOperationModal } from './features/models/modals/DeleteOperationModal';
import { NewModelModal } from './features/models/modals/NewModelModal';
import { LicenseActivationModal } from './features/system/modals/LicenseActivationModal';

const WorkerManagerModal = React.lazy(() => import('./features/workers/modals/WorkerManagerModal').then(m => ({ default: m.WorkerManagerModal })));
const WorkerDetailModal = React.lazy(() => import('./features/workers/modals/WorkerDetailModal').then(m => ({ default: m.WorkerDetailModal })));
const BackupManagerModal = React.lazy(() => import('./features/system/modals/BackupManagerModal').then(m => ({ default: m.BackupManagerModal })));
const PeriodManagerModal = React.lazy(() => import('./features/periods/modals/PeriodManagerModal').then(m => ({ default: m.PeriodManagerModal })));
const DeveloperModal = React.lazy(() => import('./features/system/modals/DeveloperModal').then(m => ({ default: m.DeveloperModal })));
const AppUpdateModal = React.lazy(() => import('./features/system/modals/AppUpdateModal').then(m => ({ default: m.AppUpdateModal })));
const EditSubmittedTicketModal = React.lazy(() => import('./features/patta/modals/EditSubmittedTicketModal').then(m => ({ default: m.EditSubmittedTicketModal })));

import { NotificationToast } from './components/ui/NotificationToast';
import { LoadingOverlay } from './components/ui/LoadingOverlay';
import { ConfirmModal } from './features/system/modals/ConfirmModal';
import { useWorkbookStore } from './store/workbookStore';
import { PermissionGuard } from './components/auth/PermissionGuard';
import { AccessDenied } from './components/auth/AccessDenied';
import { SYSTEM_SHEET_NAMES, DEFAULT_ACTIVE_SHEET } from './constants/sheetConstants';

let initialLicenseCheckStarted = false;

export const App: React.FC = () => {
  const activeSheet = useWorkbookStore((s) => s.activeSheet);
  const models = useWorkbookStore((s) => s.models);
  const setActiveSheet = useWorkbookStore((s) => s.setActiveSheet);
  const jonatish = useWorkbookStore((s) => s.jonatish);
  const addNotification = useWorkbookStore((s) => s.addNotification);
  const initStore = useWorkbookStore((s) => s.initStore);
  const isServerConnected = useWorkbookStore((s) => s.isServerConnected);
  const licenseStatus = useWorkbookStore((s) => s.licenseStatus);
  const initializedActivation = useRef<string | null>(null);

  useEffect(() => {
    if (initialLicenseCheckStarted) return;
    initialLicenseCheckStarted = true;
    if (import.meta.env.DEV) {
      (window as any).__store = useWorkbookStore;
      (window as any).__workbookStoreRef = useWorkbookStore;
    }
    void useWorkbookStore.getState().checkLicense();
  }, []);

  useEffect(() => {
    const companyId = licenseStatus?.companyId;
    if (!licenseStatus?.isActivated || licenseStatus.isBlocked || !companyId
      || licenseStatus.deviceCredentialReady === false) return;
    const activationKey = `${companyId}:${licenseStatus.activationId || licenseStatus.machineId || ''}`;
    if (initializedActivation.current === activationKey) return;
    initializedActivation.current = activationKey;
    void initStore(companyId);
  }, [initStore, licenseStatus?.activationId, licenseStatus?.companyId,
    licenseStatus?.deviceCredentialReady, licenseStatus?.isActivated,
    licenseStatus?.isBlocked, licenseStatus?.machineId]);

  // Reconcile saved activeSheet with loaded models once database has loaded
  useEffect(() => {
    if (isServerConnected && models.length > 0) {
      const isSystemSheet =
        (SYSTEM_SHEET_NAMES as readonly string[]).includes(activeSheet) ||
        activeSheet === 'Konveyer' ||
        activeSheet === 'Конвейер';
      const isModelSheet = models.some(
        (m) => m.name === activeSheet || m.id === activeSheet || m.hisobSheetName === activeSheet
      );
      if (!isSystemSheet && !isModelSheet) {
        setActiveSheet(models[0]?.name || DEFAULT_ACTIVE_SHEET);
      }
    }
  }, [isServerConnected, models, activeSheet, setActiveSheet]);

  // Periodic license check (every 60 seconds)
  useEffect(() => {
    const interval = setInterval(() => {
      useWorkbookStore.getState().checkLicense();
    }, 60000);

    return () => {
      clearInterval(interval);
    };
  }, []);

  // Keyboard Shortcuts (Ctrl+S, F5, Ctrl+PageUp/Down)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+S to save
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void useWorkbookStore.getState().saveToDisk(undefined, { forceBackup: true }).then((saved) => {
          if (saved) addNotification('success', 'Saqlandi', 'Barcha ma\'lumotlar muvaffaqiyatli saqlandi!');
        });
      }

      // F5 to trigger Jonatish if on patta sheet
      if (e.key === 'F5') {
        e.preventDefault();
        if (!activeSheet.endsWith('-hisob') && activeSheet !== 'Umumiy' && activeSheet !== 'Patta' && activeSheet !== 'Patta-hisob' && activeSheet !== 'Konveyer') {
          const targetModel = models.find((m) => m.id === activeSheet || m.name === activeSheet);
          if (targetModel) {
            jonatish(targetModel.id);
          }
        }
      }

      // Ctrl + PageDown -> Next sheet
      const currentSheets = [...SYSTEM_SHEET_NAMES, ...models.flatMap((m) => [m.name, m.hisobSheetName])];
      if ((e.ctrlKey || e.metaKey) && e.key === 'PageDown') {
        e.preventDefault();
        const currentIdx = currentSheets.indexOf(activeSheet as any);
        if (currentIdx !== -1 && currentIdx < currentSheets.length - 1) {
          setActiveSheet(currentSheets[currentIdx + 1]);
        }
      }

      // Ctrl + PageUp -> Prev sheet
      if ((e.ctrlKey || e.metaKey) && e.key === 'PageUp') {
        e.preventDefault();
        const currentIdx = currentSheets.indexOf(activeSheet as any);
        if (currentIdx !== -1 && currentIdx > 0) {
          setActiveSheet(currentSheets[currentIdx - 1]);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeSheet, jonatish, setActiveSheet, addNotification, models]);

  // Determine current view with RBAC Permission Guarding
  const renderActiveSheetView = () => {
    if (activeSheet === 'Umumiy') {
      return (
        <PermissionGuard
          permission="view:umumiy"
          fallback={
            <AccessDenied
              requiredPermission="view:umumiy"
              message="Umumiy hisobot varag'ini ko'rish faqat Admin va Buxgalter uchun ruxsat etilgan."
            />
          }
        >
          <UmumiyView />
        </PermissionGuard>
      );
    }

    if (activeSheet === 'Patta') {
      return (
        <PermissionGuard
          permission="view:patta"
          fallback={
            <AccessDenied
              requiredPermission="view:patta"
              message="Patta kesish va chop etish faqat Admin va Chop etuvchi (Print) roli uchun ruxsat etilgan."
            />
          }
        >
          <PattaBatchView />
        </PermissionGuard>
      );
    }

    if (activeSheet === 'Patta-hisob') {
      return (
        <PermissionGuard
          permission="view:patta"
          fallback={
            <AccessDenied
              requiredPermission="view:patta"
              message="Topshirilgan pattalar hisobini ko'rish faqat ruxsatnomasi bor xodimlar uchun ochiq."
            />
          }
        >
          <PattaHisobView />
        </PermissionGuard>
      );
    }

    if (activeSheet === 'Konveyer' || activeSheet === 'Конвейер') {
      return (
        <PermissionGuard
          permission="edit:hisob"
          fallback={
            <AccessDenied
              requiredPermission="edit:hisob"
              message="Konveyer varag'ini ko'rish va tahrirlash faqat Admin va Ma'lumot kirituvchi (Type) roli uchun ruxsat etilgan."
            />
          }
        >
          <KonveyerView />
        </PermissionGuard>
      );
    }

    if (activeSheet.endsWith('-hisob')) {
      const hisobTarget = activeSheet;
      const modelIdOrName = activeSheet.replace(/-hisob$/i, '');
      const model = models.find(
        (m) => m.hisobSheetName === hisobTarget || m.id === modelIdOrName || m.name === modelIdOrName
      ) || models[0];
      if (!model) {
        return (
          <div className="flex flex-col items-center justify-center h-full p-8 text-center text-gray-500">
            <p className="text-lg font-medium mb-1">Hech qanday model mavjud emas</p>
            <p className="text-sm opacity-75">Iltimos, pastki menyudan yangi model qo'shing yoki "Patta-Hisob" varaqasiga o'ting.</p>
          </div>
        );
      }
      return (
        <PermissionGuard
          permission="edit:hisob"
          fallback={
            <AccessDenied
              requiredPermission="edit:hisob"
              message="Model hisob-kitobini ko'rish va kiritish faqat Admin va Ma'lumot kirituvchi (Type) roli uchun ruxsat etilgan."
            />
          }
        >
          <HisobView key={model.id} model={model} />
        </PermissionGuard>
      );
    }

    const model = models.find((m) => m.id === activeSheet || m.name === activeSheet) || models[0];
    if (!model) {
      return (
        <div className="flex flex-col items-center justify-center h-full p-8 text-center text-gray-500">
          <p className="text-lg font-medium mb-1">Hech qanday model mavjud emas</p>
          <p className="text-sm opacity-75">Iltimos, pastki menyudan yangi model qo'shing yoki "Patta-Hisob" varaqasiga o'ting.</p>
        </div>
      );
    }
    return (
      <PermissionGuard
        permission="view:patta"
        fallback={
          <AccessDenied
            requiredPermission="view:patta"
            message="Patta varaqasini ko'rish uchun sizning rolingizda ruxsat yo'q."
          />
        }
      >
        <PattaView key={model.id} model={model} />
      </PermissionGuard>
    );
  };

  const modalType = useWorkbookStore((s) => s.modalState.type);

  return (
    <div className="excel-app">
      {/* Title Bar */}
      <TitleBar />

      {/* Main Body Layout: Left Sidebar + Active Sheet Content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden', position: 'relative' }}>
        {/* Left Sidebar Sheet Navigation */}
        <SheetTabs />

        {/* Main Active Sheet Content */}
        <main style={{ flex: 1, position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <React.Suspense
            fallback={
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontSize: '14px', gap: '8px' }}>
                <span className="codicon codicon-loading codicon-modifier-spin" style={{ fontSize: '18px' }} />
                Yuklanmoqda...
              </div>
            }
          >
            {renderActiveSheetView()}
          </React.Suspense>
        </main>
      </div>

      {/* Modals & Toasts & Loading Overlay */}
      <LicenseActivationModal />
      <React.Suspense fallback={null}>
        {modalType === 'developer_info' && <DeveloperModal />}
        {modalType === 'period_manager' && <PeriodManagerModal />}
        {modalType === 'new_model' && <NewModelModal />}
        {modalType === 'new_operation' && <NewOperationModal />}
        {modalType === 'delete_operation' && <DeleteOperationModal />}
        {modalType === 'worker_manager' && <WorkerManagerModal />}
        {modalType === 'worker_detail' && <WorkerDetailModal />}
        {modalType === 'backup_manager' && <BackupManagerModal />}
        {modalType === 'app_update' && <AppUpdateModal />}
        {modalType === 'edit_ticket' && <EditSubmittedTicketModal />}
      </React.Suspense>
      <NotificationToast />
      <LoadingOverlay />
      <ConfirmModal />
    </div>
  );
};

export default App;
