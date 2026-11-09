
if (typeof window !== 'undefined') {
  const disableWheelNumberChange = (e: WheelEvent) => {
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && active.type === 'number') {
      active.blur();
    }
    const target = e.target;
    if (target instanceof HTMLInputElement && target.type === 'number') {
      target.blur();
    }
  };

  window.addEventListener('wheel', disableWheelNumberChange, { capture: true, passive: true });
}
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { reloadWorkbookProjection } from '../../../apps/desktop/renderer/store/businessMutations';
import { useWorkbookStore } from '../../../apps/desktop/renderer/store/workbookStore';
import { startStoreBridge } from '../../../apps/desktop/renderer/store/bridge';
import { HisobView } from '../../../apps/desktop/renderer/features/models/HisobView';
import { UmumiyView } from '../../../apps/desktop/renderer/features/payroll/UmumiyView';
import { createPayrollWorkbook } from '../../../apps/desktop/renderer/engine/excelSync';
import { KonveyerView } from '../../../apps/desktop/renderer/features/models/KonveyerView';
import { TitleBar } from '../../../apps/desktop/renderer/components/layout/TitleBar';
import { SheetTabs } from '../../../apps/desktop/renderer/components/layout/SheetTabs';
import { PattaBatchView } from '../../../apps/desktop/renderer/features/patta/PattaBatchView';
import { PattaView } from '../../../apps/desktop/renderer/features/patta/PattaView';
import { PattaHisobView } from '../../../apps/desktop/renderer/features/patta/PattaHisobView';
import { ModellarJamiView } from '../../../apps/desktop/renderer/features/models/ModellarJamiView';
import { WorkerManagerModal } from '../../../apps/desktop/renderer/features/workers/modals/WorkerManagerModal';
import { WorkerDetailModal } from '../../../apps/desktop/renderer/features/workers/modals/WorkerDetailModal';
import { PeriodManagerModal } from '../../../apps/desktop/renderer/features/periods/modals/PeriodManagerModal';
import { NewModelModal } from '../../../apps/desktop/renderer/features/models/modals/NewModelModal';
import { NewOperationModal } from '../../../apps/desktop/renderer/features/models/modals/NewOperationModal';
import { DeleteOperationModal } from '../../../apps/desktop/renderer/features/models/modals/DeleteOperationModal';
import { EditSubmittedTicketModal } from '../../../apps/desktop/renderer/features/patta/modals/EditSubmittedTicketModal';
import { PattaPrintModal } from '../../../apps/desktop/renderer/features/patta/modals/PattaPrintModal';
import { BackupManagerModal } from '../../../apps/desktop/renderer/features/system/modals/BackupManagerModal';
import { LicenseActivationModal } from '../../../apps/desktop/renderer/features/system/modals/LicenseActivationModal';
import { AppUpdateModal } from '../../../apps/desktop/renderer/features/system/modals/AppUpdateModal';
import { DeveloperModal } from '../../../apps/desktop/renderer/features/system/modals/DeveloperModal';
import { ConfirmModal } from '../../../apps/desktop/renderer/features/system/modals/ConfirmModal';
import { NotificationToast } from '../../../apps/desktop/renderer/components/ui/NotificationToast';
import { LoadingOverlay } from '../../../apps/desktop/renderer/components/ui/LoadingOverlay';
import { OperationRatesView } from '../../../apps/desktop/renderer/features/models/OperationRatesView';
import { OperationRatesModal } from '../../../apps/desktop/renderer/features/models/modals/OperationRatesModal';
import { App } from '../../../apps/desktop/renderer/App';
import { useAuthStore, applyRolePermissions } from '../../../apps/desktop/renderer/store/authStore';
import XLSX from 'xlsx-js-style';
import '../../../apps/desktop/renderer/index.css';

const root = createRoot(document.getElementById('root')!);
const LocalPreviewSurface: React.FC = () => {
  const activeSheet = useWorkbookStore((s) => s.activeSheet);
  const models = useWorkbookStore((s) => s.models);
  const modalType = useWorkbookStore((s) => s.modalState.type);
  const model = models.find((item) => item.name === activeSheet || item.hisobSheetName === activeSheet) || models[0];
  const isModellarJami = activeSheet === 'Modellar-jami' || activeSheet === 'Modellar' || activeSheet === 'Modellar kesimida jami' || activeSheet === 'Modellar kesimi jami';
  const isOperatsiyaNarxlari = activeSheet === 'Operatsiya-narxlari' || activeSheet === 'Operatsiya narxlari';

  React.useEffect(() => {
    if (!modalType) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        useWorkbookStore.getState().closeModal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [modalType]);

  const view = activeSheet === 'Umumiy' ? <UmumiyView />
    : isModellarJami ? <ModellarJamiView />
    : isOperatsiyaNarxlari ? <OperationRatesView />
    : activeSheet === 'Patta' ? <PattaBatchView />
    : activeSheet === 'Patta-hisob' ? <PattaHisobView />
    : activeSheet === 'Konveyer' ? <KonveyerView />
    : model && activeSheet === model.hisobSheetName ? <HisobView key={model.id} model={model} />
    : model ? <PattaView key={model.id} model={model} /> : <div className="phase-b-view">Sintetik fixture model yuklanmadi.</div>;
  return <div className="excel-app">
    <TitleBar />
    <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden', position: 'relative' }}>
      <SheetTabs />
      <main style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ minHeight: 24, padding: '4px 12px', background: '#fff7d6', color: '#714f00', borderBottom: '1px solid #eadca7', fontSize: 11, fontWeight: 700 }}>
          LOCAL TEST FIXTURE · Sintetik ma’lumotlar · Tashqi serverga ulanmagan
        </div>
        {view}
      </main>
    </div>
    {/* Fixture preview modals */}
    {modalType === 'worker_detail' && <WorkerDetailModal />}
    {modalType === 'worker_manager' && <WorkerManagerModal />}
    {modalType === 'period_manager' && <PeriodManagerModal />}
    {modalType === 'new_model' && <NewModelModal />}
    {modalType === 'new_operation' && <NewOperationModal />}
    {modalType === 'delete_operation' && <DeleteOperationModal />}
    {modalType === 'edit_ticket' && <EditSubmittedTicketModal />}
    {modalType === 'backup_manager' && <BackupManagerModal />}
    {modalType === 'app_update' && <AppUpdateModal />}
    {modalType === 'developer_info' && <DeveloperModal />}
    {modalType === 'operation_rates' && <OperationRatesModal />}
    <NotificationToast />
    <LoadingOverlay />
    <ConfirmModal />
  </div>;
};
Object.assign(window, { renderPayrollFixture: async (data: any) => {
  void data;
  const hydrated = await reloadWorkbookProjection((window as any).electronAPI, 'hisob_test_browser');
  const activationId = useWorkbookStore.getState().licenseStatus?.activationId || 'new-synthetic-license';
  flushSync(() => {
    useWorkbookStore.setState({ ...hydrated, licenseStatus: {
      isActivated: true, machineId: 'local-test', companyId: 'hisob_test_browser', activationId
    } });
     root.render(<><TitleBar /><div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}><SheetTabs /><main style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}><HisobView model={hydrated.models[0]} /><UmumiyView /></main></div></>);
  });
  startStoreBridge();
  return { company: useWorkbookStore.getState().payrollValuation.companyId, period: hydrated.currentPeriod.id };
 }, renderE5App: async () => {
  const hydrated = await reloadWorkbookProjection((window as any).electronAPI, 'hisob_test_browser');
  document.documentElement.setAttribute('data-theme', 'light');
  localStorage.setItem('novda_theme', 'light');
  (window as any).__store = useWorkbookStore;
  startStoreBridge();
  const licenseStatus = { isActivated: true, isTrial: true, isBlocked: false,
    machineId: 'e5a-local-only', activationId: 'e5a-local-only',
    companyId: 'hisob_test_browser', remainingText: 'LOCAL TEST', role: 'admin' };
  flushSync(() => {
    useWorkbookStore.setState({ licenseStatus });
    const wide = { ...hydrated.models[0], operations: [...hydrated.models[0].operations,
      ...Array.from({ length: 14 }, (_, i) => ({ id: `e5a-op-${i}`, name: `Synthetic operation ${i + 2}`, rate: 7 }))] };
    const workers = [...hydrated.workers, ...Array.from({ length: 221 }, (_, i) => ({ id: 1000 + i, name: `Synthetic worker ${i + 1}` }))];
    useWorkbookStore.setState({ ...hydrated, models: [wide], workers, activeSheet: 'Umumiy', theme: 'light',
      // Data was already read through the real preload/SQLite projection; no bootstrap or remote sync.
      initStore: async () => {}, isServerConnected: false });
    root.render(<App />);
  });
  return { workers: hydrated.workers.length, models: hydrated.models.length,
     gross: hydrated.payrollValuation.workers[0]?.gross, net: hydrated.payrollValuation.workers[0]?.net };
     }, renderFilters2aApp: async (actorId = 'filters-actor-a') => {
   const hydrated = await reloadWorkbookProjection((window as any).electronAPI, 'hisob_test_browser');
   const licenseStatus = { isActivated: true, isTrial: true, isBlocked: false, deviceCredentialReady: true,
     machineId: 'filters-2a-local-only', activationId: 'filters-2a-local-only', companyId: 'hisob_test_browser', role: 'admin' };
   const permissions = applyRolePermissions('admin');
   useAuthStore.getState().setAuth({ status: 'active', role: 'admin', companyId: 'hisob_test_browser', deviceId: 'filters-device-a',
     user: { uid: actorId, email: `${actorId}@fixture.invalid`, companyId: 'hisob_test_browser', displayName: actorId,
       role: 'admin', permissions, deviceId: 'filters-device-a', status: 'active', lastSeen: 'fixture', createdAt: 'fixture' },
     permissions });
   (window as any).__store = useWorkbookStore;
   (window as any).__filters2aAuth = useAuthStore;
   startStoreBridge();
   flushSync(() => {
     useWorkbookStore.setState({ ...hydrated, licenseStatus, activeSheet: 'Umumiy', isServerConnected: false,
       initStore: async () => {}, checkLicense: async () => {}, modalState: { type: null } } as any);
     root.render(<App />);
   });
     return { companyId: licenseStatus.companyId, models: hydrated.models.map(model => ({ id: model.id, name: model.name,
        hisobSheetName: model.hisobSheetName })), workers: hydrated.workers.map(worker => worker.id), periodId: hydrated.currentPeriod.id };
      }, renderFilters2gApp: async () => {
       const hydrated = await reloadWorkbookProjection((window as any).electronAPI, 'hisob_test_browser');
       const baseModel = hydrated.models[0];
       const secondModel = { ...baseModel, id: 'filters-2g-model-b', name: 'Filter Model B', title: 'Filter Model B',
         hisobSheetName: 'Filter Model B-hisob', operations: [...baseModel.operations] };
       const workers = [
         { id: 731, name: 'Filter Worker Alpha', staj: 0, avans: 0, jarima: 0 },
         { id: 732, name: 'Filter Worker Beta', staj: 0, avans: 0, jarima: 0 },
         { id: 733, name: 'Filter Worker Gamma', staj: 0, avans: 0, jarima: 0 }
       ];
       const ticket = (id: string, workerId: number, modelId: string, modelName: string, partyNumber: string,
         opName: string, konveyer: string, pattaNumber: number) => ({ id, workerId, modelId, modelName, partyNumber,
           partyRecordId: `fixture-${partyNumber}`, pattaNumber, qty: 10, size: 'M', color: 'Blue', konveyer,
           periodId: hydrated.currentPeriod.id, submittedAt: '2026-11-06T10:00:00Z', isSubmitted: true,
           entries: [{ workerId, opName, rateSnapshot: 5 }] });
       const syntheticTickets = [
         ticket('FILTER2G-TICKET-101', 731, baseModel.id, baseModel.name, 'FILTER-PARTY-101', 'Stitch', 'Line-A', 1),
         ticket('FILTER2G-TICKET-202', 731, secondModel.id, secondModel.name, 'FILTER-PARTY-202', 'Hem', 'Line-B', 2),
         ticket('FILTER2G-TICKET-303', 731, baseModel.id, baseModel.name, 'FILTER-PARTY-303', 'Cut', 'Line-C', 3),
         ticket('FILTER2G-TICKET-404', 732, baseModel.id, baseModel.name, 'FILTER-PARTY-404', 'Stitch', 'Line-A', 4)
       ];
       const licenseStatus = { isActivated: true, isTrial: true, isBlocked: false, deviceCredentialReady: true,
         machineId: 'filters-2g-machine-a', activationId: 'filters-2g-activation-a', companyId: 'hisob_test_browser', role: 'admin' as const };
       useAuthStore.getState().setAuth({ status: 'active', role: 'admin', companyId: licenseStatus.companyId,
         deviceId: licenseStatus.machineId, permissions: applyRolePermissions('admin') });
        (window as any).__filters2gStore = useWorkbookStore;
        (window as any).__filters2gAuth = useAuthStore;
       startStoreBridge();
       flushSync(() => {
         useWorkbookStore.setState({ ...hydrated, licenseStatus, workers, models: [...hydrated.models, secondModel],
           submittedTickets: [...hydrated.submittedTickets, ...syntheticTickets], activeSheet: 'Umumiy',
           isServerConnected: false, initStore: async () => {}, checkLicense: async () => {}, modalState: { type: null } } as any);
         root.render(<App />);
       });
      return { workers: workers.map(worker => worker.id), models: [baseModel.name, secondModel.name],
          tickets: syntheticTickets.map(item => ({ id: item.id, workerId: item.workerId, party: item.partyNumber,
            model: item.modelName, operation: item.entries[0].opName, conveyor: item.konveyer })) };
      }, renderPattaJumpApp: async () => {
        const companyId = 'hisob_test_browser';
        const hydrated = await reloadWorkbookProjection((window as any).electronAPI, companyId);
        const licenseStatus = { isActivated: true, isTrial: true, isBlocked: false, deviceCredentialReady: true,
          machineId: 'patta-jump-machine-a', activationId: 'patta-jump-actor-a', companyId, role: 'admin' as const };
        useAuthStore.getState().setAuth({ status: 'active', role: 'admin', companyId,
          deviceId: licenseStatus.machineId, permissions: applyRolePermissions('admin') });
        (window as any).__pattaJumpStore = useWorkbookStore;
        (window as any).__pattaJumpAuth = useAuthStore;
        startStoreBridge();
        flushSync(() => {
          useWorkbookStore.setState({ ...hydrated, licenseStatus, activeSheet: 'Umumiy', isServerConnected: false,
            initStore: async () => {}, checkLicense: async () => {}, modalState: { type: 'worker_detail', workerId: 7 } } as any);
          root.render(<App />);
        });
        return { companyId, periodId: hydrated.currentPeriod.id, workerIds: hydrated.workers.map(w => w.id),
          tickets: hydrated.submittedTickets.map(t => ({ id: t.id, party: t.partyNumber, patta: t.pattaNumber,
            modelId: t.modelId, periodId: t.periodId, qty: t.qty, size: t.size, color: t.color,
            konveyer: t.konveyer, entries: t.entries?.map(e => ({ opName: e.opName, workerId: e.workerId })) })) };
      }, pattaJumpRole: (role: 'admin' | 'print' | 'type') => {
        const permissions = applyRolePermissions(role);
        const state = useWorkbookStore.getState();
        useAuthStore.getState().setAuth({ status: 'active', role, companyId: state.licenseStatus?.companyId || null,
          permissions });
        useWorkbookStore.setState({ licenseStatus: { ...state.licenseStatus!, role } } as any);
        return { role, permissions };
      },
      filters2gContext: (patch: any) => {
      const state = useWorkbookStore.getState();
      useWorkbookStore.setState({ licenseStatus: { ...state.licenseStatus!, ...patch.licenseStatus },
        currentPeriod: patch.periodId ? { ...state.currentPeriod, id: patch.periodId } : state.currentPeriod,
        modalState: patch.modalState || state.modalState } as any);
      if (patch.role) useAuthStore.getState().setAuth({ status: 'active', role: patch.role,
        companyId: useWorkbookStore.getState().licenseStatus?.companyId || null, permissions: applyRolePermissions(patch.role) });
       return { company: useWorkbookStore.getState().licenseStatus?.companyId, period: useWorkbookStore.getState().currentPeriod.id,
         activationId: useWorkbookStore.getState().licenseStatus?.activationId, workerId: useWorkbookStore.getState().modalState.workerId };
      }, filters2cActor: (actorId: string, role = 'admin') => {
      const state = useWorkbookStore.getState();
      const licenseStatus = { ...state.licenseStatus!, activationId: actorId, machineId: actorId, role };
      useWorkbookStore.setState({ licenseStatus } as any);
      useAuthStore.getState().setAuth({ status: 'active', role: role as any, companyId: state.licenseStatus?.companyId || null,
        permissions: applyRolePermissions(role as any) });
       return licenseStatus;
     }, renderFilters2dApp: async () => {
      const hydrated = await reloadWorkbookProjection((window as any).electronAPI, 'hisob_test_browser');
      const licenseStatus = { isActivated: true, isTrial: true, isBlocked: false, deviceCredentialReady: true,
        machineId: 'filters-2d-local-only', activationId: 'filters-2d-local-only', companyId: 'hisob_test_browser', role: 'admin' as const };
      useAuthStore.getState().setAuth({ status: 'active', role: 'admin', companyId: 'hisob_test_browser', permissions: applyRolePermissions('admin') });
      (window as any).__filters2dStore = useWorkbookStore;
      (window as any).__filters2dAuth = useAuthStore;
      startStoreBridge();
      flushSync(() => {
        useWorkbookStore.setState({ ...hydrated, licenseStatus, activeSheet: 'Konveyer', isServerConnected: false,
          initStore: async () => {}, checkLicense: async () => {}, modalState: { type: null } } as any);
        root.render(<App />);
      });
      return { models: hydrated.models.map(model => ({ id: model.id, name: model.name })),
        tickets: hydrated.submittedTickets.map(ticket => ({ id: ticket.id, party: ticket.partyNumber, patta: ticket.pattaNumber,
          modelId: ticket.modelId, modelName: ticket.modelName, conveyor: ticket.konveyer })) };
    }, filters2dContext: (kind: string, value: string) => {
      const state = useWorkbookStore.getState();
      if (kind === 'company') useWorkbookStore.setState({ licenseStatus: { ...state.licenseStatus!, companyId: value } } as any);
      if (kind === 'period') useWorkbookStore.setState({ currentPeriod: { ...state.currentPeriod, id: value } } as any);
      if (kind === 'archive') useWorkbookStore.setState({ selectedArchiveFilename: value || null } as any);
      if (kind === 'actor') {
        useWorkbookStore.setState({ licenseStatus: { ...state.licenseStatus!, activationId: value, machineId: value } } as any);
        useAuthStore.getState().setAuth({ status: 'active', role: 'admin', companyId: state.licenseStatus?.companyId || null, permissions: applyRolePermissions('admin') });
      }
      if (kind === 'role') {
        useWorkbookStore.setState({ licenseStatus: { ...state.licenseStatus!, role: value as any } } as any);
        useAuthStore.getState().setAuth({ status: 'active', role: value as any, companyId: state.licenseStatus?.companyId || null, permissions: applyRolePermissions(value as any) });
      }
      return { company: useWorkbookStore.getState().licenseStatus?.companyId, period: useWorkbookStore.getState().currentPeriod.id,
        archive: useWorkbookStore.getState().selectedArchiveFilename };
    }, mountFilters2dPatta: () => {
      useWorkbookStore.setState({ activeSheet: 'Patta', pattaBatchConfigs: {
        m: { partyNumber: '70', isCustomParty: true, totalIshSoni: '4', color: 'Blue', sizes: { M: '1' } },
        'filters-2d-model-b': { partyNumber: '71', isCustomParty: true, totalIshSoni: '5', color: 'Red', sizes: { L: '2' } }
      } } as any);
      return true;
    }, mountFilters2bJournal: async () => {
    const state = useWorkbookStore.getState();
    const now = '2026-09-15T12:00:00Z';
    const modelTwo = { ...state.models[0], id: 'journal-model-two', name: 'Journal Two', title: 'Journal Two', hisobSheetName: 'Journal Two-hisob' };
    const parties = [
      { id: 'journal-active-a', partyNumber: '41', modelId: 'm', modelName: 'Demo', color: 'Blue', pattaCount: 1, cumulativePattaCount: 1, pattaStartNumber: 1, pattaEndNumber: 1, ishSoniPerPatta: 10, ishSoni: 10, cumulativeIshSoni: 10, sizes: { M: '1' }, printedAt: now },
      { id: 'journal-active-b', partyNumber: '42', modelId: modelTwo.id, modelName: modelTwo.name, color: 'Red', pattaCount: 1, cumulativePattaCount: 1, pattaStartNumber: 2, pattaEndNumber: 2, ishSoniPerPatta: 10, ishSoni: 10, cumulativeIshSoni: 10, sizes: { M: '1' }, printedAt: now },
      { id: 'journal-closed-c', partyNumber: '43', modelId: modelTwo.id, modelName: modelTwo.name, color: 'Green', pattaCount: 1, cumulativePattaCount: 1, pattaStartNumber: 3, pattaEndNumber: 3, ishSoniPerPatta: 10, ishSoni: 10, cumulativeIshSoni: 10, sizes: { M: '1' }, printedAt: now, isClosed: true }
    ];
    const tickets = [
      { id: 'JOURNAL-TICKET-4101', modelId: 'm', partyNumber: '41', partyRecordId: 'journal-active-a', periodId: state.currentPeriod.id, isClosed: false, pattaNumber: 1, qty: 10, size: 'M', color: 'Blue', konveyer: 'Line-41', submittedAt: now, entries: [] },
      { id: 'JOURNAL-CLOSED-TICKET-4303', modelId: modelTwo.id, partyNumber: '43', partyRecordId: 'journal-closed-c', periodId: state.currentPeriod.id, isClosed: true, pattaNumber: 3, qty: 10, size: 'M', color: 'Green', konveyer: 'Line-43', submittedAt: now, entries: [] }
    ];
    useWorkbookStore.setState({ models: [...state.models, modelTwo], printedPartyHistory: parties, submittedTickets: tickets, activeSheet: 'Patta-hisob', initStore: async () => {}, isServerConnected: false } as any);
    (window as any).__filters2bStore = useWorkbookStore;
    root.render(<App />);
    return { partyIds: parties.map(p => p.id), ticketIds: tickets.map(t => t.id) };
  }, renderMoney1cApp: async (companyId: string) => {
  const hydrated = await reloadWorkbookProjection((window as any).electronAPI, companyId);
  const licenseStatus = { isActivated: true, isTrial: true, isBlocked: false, deviceCredentialReady: true,
    machineId: 'money-1c-local-only', activationId: 'money-1c-local-only', companyId, role: 'admin' as const };
  const initFixtureStore = async (forcedCompanyId = companyId) => {
    if (forcedCompanyId !== companyId) {
      useWorkbookStore.setState({ payrollValuation: { companyId: forcedCompanyId, period: null, workers: [],
        accountingStatus: 'UNAVAILABLE', accountingReasons: ['PAYROLL_VALUATION_UNAVAILABLE'], syncStatus: 'UNKNOWN' } } as any);
      return;
    }
    try {
      const refreshed = await reloadWorkbookProjection((window as any).electronAPI, forcedCompanyId);
      useWorkbookStore.setState({ ...refreshed, activeSheet: 'Umumiy', modalState: { type: null } } as any);
    } catch {
      useWorkbookStore.setState({ payrollValuation: { companyId, period: null, workers: [],
        accountingStatus: 'UNAVAILABLE', accountingReasons: ['PAYROLL_VALUATION_UNAVAILABLE'], syncStatus: 'UNKNOWN' } } as any);
    }
  };
  startStoreBridge();
  flushSync(() => {
    useWorkbookStore.setState({ licenseStatus, initStore: initFixtureStore, isServerConnected: false } as any);
    useAuthStore.getState().setAuth({ status: 'active', role: 'admin', companyId,
      permissions: applyRolePermissions('admin') });
    useWorkbookStore.setState({ ...hydrated, activeSheet: 'Umumiy', licenseStatus,
      initStore: initFixtureStore, isServerConnected: false, modalState: { type: null } } as any);
    (window as any).__money1cStore = useWorkbookStore;
    (window as any).__money1cAuth = useAuthStore.getState();
    (window as any).__money1cAdminPermissions = applyRolePermissions('admin');
    (window as any).__money1cPermissions = () => useAuthStore.getState().permissions;
    root.render(<App />);
  });
  (window as any).__money1cCsvBlob = null;
  URL.createObjectURL = ((blob: Blob) => { (window as any).__money1cCsvBlob = blob; return 'blob:money-1c-test'; }) as any;
  HTMLAnchorElement.prototype.click = function () { (window as any).__money1cCsvFilename = this.download; };
  (window as any).readMoney1cCsv = async () => (window as any).__money1cCsvBlob?.text();
  (window as any).exportMoney1cXlsx = () => XLSX.write(
    createPayrollWorkbook(hydrated.models, hydrated.workers, hydrated.payrollValuation),
    { type: 'base64', bookType: 'xlsx' });
  (window as any).exportMoney1cUnavailableXlsx = () => {
    const state = useWorkbookStore.getState();
    return XLSX.write(createPayrollWorkbook(state.models, state.workers, {
      companyId, period: null, workers: [], accountingStatus: 'UNAVAILABLE',
      accountingReasons: ['PAYROLL_VALUATION_UNAVAILABLE'], syncStatus: 'UNKNOWN'
    }), { type: 'base64', bookType: 'xlsx' });
  };
  return { companyId, periodId: hydrated.currentPeriod.id, workers: hydrated.workers.length,
    accountingStatus: hydrated.payrollValuation.accountingStatus, syncStatus: hydrated.payrollValuation.syncStatus,
    valuationCompany: hydrated.payrollValuation.companyId, valuationPeriod: hydrated.payrollValuation.period?.periodId,
    valuedWorkers: hydrated.payrollValuation.workers.map(worker => worker.workerId) };
}, e5Role: (role: 'admin' | 'type' | 'print') => {
  const state = useWorkbookStore.getState();
  useAuthStore.getState().setAuth({ status: 'active', role, companyId: 'hisob_test_browser',
    permissions: applyRolePermissions(role) });
  return { sheet: state.activeSheet, role, permissions: useAuthStore.getState().permissions };
}, e5InvalidLicense: () => {
  const previous = useWorkbookStore.getState().licenseStatus!;
  useWorkbookStore.setState({ licenseStatus: { ...previous, isActivated: false, isBlocked: true } });
  return useAuthStore.getState().permissions;
}, e5Context: (companyId: string, periodId?: string) => {
  const current = useWorkbookStore.getState();
  flushSync(() => useWorkbookStore.setState({
    licenseStatus: { ...current.licenseStatus!, companyId },
    ...(periodId ? { currentPeriod: { ...current.currentPeriod, id: periodId } } : {})
  }));
  return useWorkbookStore.getState().payrollValuation;
}, renderLocalPreview: async () => {
  const hydrated = await reloadWorkbookProjection((window as any).electronAPI, 'hisob_test_browser');
  flushSync(() => {
    useWorkbookStore.setState({ ...hydrated, activeSheet: 'Umumiy', licenseStatus: {
      isActivated: true, isTrial: true, machineId: 'local-test-fixture', companyId: 'hisob_test_browser',
      activationId: 'local-test-fixture', remainingText: 'LOCAL TEST'
    }, isServerConnected: false });
    root.render(<LocalPreviewSurface />);
  });
  return { companyId: 'hisob_test_browser', activeSheet: useWorkbookStore.getState().activeSheet,
    models: hydrated.models.length, workers: hydrated.workers.length, synthetic: true };
}, renderE1Report: async () => {
  const hydrated = await reloadWorkbookProjection((window as any).electronAPI, 'hisob_test_browser');
  flushSync(() => {
    useWorkbookStore.setState({ ...hydrated, activeSheet: 'Umumiy' });
    root.render(<LocalPreviewSurface />);
  });
}, renderE2AJournal: () => {
  const state = useWorkbookStore.getState();
  const model = state.models[0];
  const printedAt = '2026-11-05T09:00:00.000Z';
  const parties = [
    { id: 'e2a-active', partyNumber: '41', modelId: model.id, modelName: model.name, color: 'Sinov qora', pattaCount: 3,
      cumulativePattaCount: 3, ishSoniPerPatta: 4, ishSoni: 12, cumulativeIshSoni: 12, sizes: { M: '3' }, printedAt },
    { id: 'e2a-closed', partyNumber: '42', modelId: model.id, modelName: model.name, color: 'Sinov oq', pattaCount: 1,
      cumulativePattaCount: 4, ishSoniPerPatta: 4, ishSoni: 4, cumulativeIshSoni: 16, sizes: { M: '1' }, printedAt, isClosed: true }
  ];
  flushSync(() => {
    useWorkbookStore.setState({ activeSheet: 'Patta-hisob', printedPartyHistory: parties,
      submittedTickets: [{ id: 'e2a-entered', partyRecordId: 'e2a-active', modelId: model.id, periodId: state.currentPeriod.id,
        partyNumber: '41', pattaNumber: 1, size: 'M', color: 'Sinov qora', qty: 4, submittedAt: printedAt }] });
    root.render(<LocalPreviewSurface />);
  });
 }, renderE2B: (surface: string) => {
  const state = useWorkbookStore.getState();
  const base = state.models[0];
  (window as any).__store = useWorkbookStore;
  const models = [base, ...[2, 3].map(n => ({ ...base, id: `e2b-model-${n}`, name: `Sinov model ${n}` }))];
  const printedAt = '2026-11-05T09:00:00.000Z';
  flushSync(() => {
    useWorkbookStore.setState({ models, activeSheet: surface === 'batch' ? 'Patta' : base.name,
      pattaBatchConfigs: { [base.id]: { partyNumber: '42', isCustomParty: true, totalIshSoni: '4', color: 'Sinov qora', sizes: { M: '3' } } },
      printedPartyHistory: [{ id: 'e2b-party', partyNumber: '41', modelId: base.id, modelName: base.name,
        color: 'Sinov qora', pattaCount: 3, cumulativePattaCount: 3, ishSoniPerPatta: 4,
        sizes: { M: '3' }, printedAt }],
      ticketForms: { [base.id]: { date: '2026-09-15', party: '41', patta: '1', color: 'Sinov qora', size: 'M', qty: '4',
        konveyer: 'A', entries: { Sew: '7' }, strictParty: true, strictPatta: true } } } as any);
    root.render(<LocalPreviewSurface />);
  });
 }, renderE2C: (surface: string) => {
   const state = useWorkbookStore.getState();
   const previous = state.models[0];
   const base = { ...previous, operations: previous.operations.filter((operation) => !String(operation.id).startsWith('e2c-op-')) };
  const extraWorkers = Array.from({ length: 45 }, (_, index) => ({ ...state.workers[0], id: index + 100,
    name: `Synthetic worker ${index + 100}`, avans: 0, jarima: 0 }));
  const tickets = [
    { id: 'e2c-a', modelId: base.id, periodId: state.currentPeriod.id, partyNumber: '41', pattaNumber: 1,
      qty: 10, konveyer: 'A', size: 'M', color: 'Sinov', entries: [{ opName: 'Sew', workerId: 7, rateSnapshot: 5 }] },
    { id: 'e2c-b', modelId: base.id, periodId: state.currentPeriod.id, partyNumber: '42', pattaNumber: 2,
      qty: 2, konveyer: 'B', size: 'M', color: 'Sinov', entries: [{ opName: 'Sew', workerId: 7, rateSnapshot: 5 }] }
  ];
   const wideModel = { ...base, operations: [...base.operations,
    ...Array.from({ length: 14 }, (_, index) => ({ id: `e2c-op-${index}`, name: `Sinov operatsiya ${index + 2}`, rate: 7 }))] };
  flushSync(() => {
    useWorkbookStore.setState({ workers: [state.workers[0], ...extraWorkers],
      models: surface === 'conveyor' ? [base, { ...base, id: 'e2c-empty', name: 'Sinov bo‘sh model', operations: [], hisobQuantities: {} }] : [wideModel],
      submittedTickets: surface === 'conveyor' ? tickets : state.submittedTickets,
      activeSheet: surface === 'conveyor' ? 'Konveyer' : base.hisobSheetName } as any);
    root.render(<LocalPreviewSurface />);
  });
}, readFixtureConfirmState: () => useWorkbookStore.getState().confirmState,
switchPayrollContext: (companyId: string, periodId?: string) => {
  flushSync(() => useWorkbookStore.setState((state) => ({
    licenseStatus: { ...state.licenseStatus!, companyId },
    ...(periodId ? { currentPeriod: { ...state.currentPeriod, id: periodId } } : {})
  })));
}, changeLicenseContext: () => {
  const current = useWorkbookStore.getState().licenseStatus!;
  flushSync(() => useWorkbookStore.setState({ licenseStatus: { ...current, activationId: 'changed-synthetic-license' } }));
  return useWorkbookStore.getState().payrollValuation;
 }, renderPhaseBSurface: (surface: string) => {
  const state = useWorkbookStore.getState();
  const model = state.models[0];
  const sheetBySurface: Record<string, string> = {
    batch: 'Patta', entry: model?.name || 'Patta', journal: 'Patta-hisob', hisob: model?.hisobSheetName || 'Umumiy', conveyor: 'Konveyer'
  };
  useWorkbookStore.setState({ activeSheet: sheetBySurface[surface] || 'Umumiy' });
  const view = surface === 'batch' ? <PattaBatchView />
    : surface === 'entry' && model ? <PattaView model={model} />
    : surface === 'journal' ? <PattaHisobView />
    : surface === 'hisob' && model ? <HisobView model={model} />
    : surface === 'conveyor' ? <KonveyerView /> : <div>Unknown fixture surface</div>;
  flushSync(() => root.render(<><TitleBar /><div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}><SheetTabs key={`fixture-${surface}`} /><main style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>{view}</main></div></>));
  return { surface, activeSheet: useWorkbookStore.getState().activeSheet, modelId: model?.id };
 }, renderModelSizesCApp: async () => {
   const hydrated = await reloadWorkbookProjection((window as any).electronAPI, 'hisob_test_browser');
   const licenseStatus = { isActivated: true, isTrial: true, isBlocked: false, deviceCredentialReady: true,
     machineId: 'model-sizes-c-machine', activationId: 'model-sizes-c-activation', companyId: 'hisob_test_browser', role: 'admin' as const };
   useAuthStore.getState().setAuth({ status: 'active', role: 'admin', companyId: licenseStatus.companyId,
     permissions: applyRolePermissions('admin') });
   (window as any).__modelSizesCStore = useWorkbookStore;
   (window as any).__modelSizesCAuth = useAuthStore;
   startStoreBridge();
   flushSync(() => {
     useWorkbookStore.setState({ ...hydrated, licenseStatus, activeSheet: 'Patta', isServerConnected: false,
       initStore: async () => {}, checkLicense: async () => {}, modalState: { type: null },
       pattaBatchConfigs: Object.fromEntries(hydrated.models.map((model) => [model.id, {
         partyNumber: '', isCustomParty: false, totalIshSoni: '', color: model.id === 'model-sizes-c-b' ? 'Red' : 'Blue', sizes: {}
       }])) } as any);
     root.render(<App />);
   });
   return { companyId: licenseStatus.companyId, periodId: hydrated.currentPeriod.id,
     modelIds: hydrated.models.map(model => model.id), modelNames: hydrated.models.map(model => model.name),
     periodClosed: hydrated.currentPeriod.isClosed, archive: hydrated.selectedArchiveFilename };
 }, modelSizesCPrintHtml: () => (window as any).__modelSizesCPrintHtml || null,
 reloadModelSizesC: async () => {
   const hydrated = await reloadWorkbookProjection((window as any).electronAPI, 'hisob_test_browser');
   flushSync(() => {
     useWorkbookStore.setState({ ...hydrated, licenseStatus: { isActivated: true, isTrial: true, isBlocked: false,
       machineId: 'model-sizes-c-machine', activationId: 'model-sizes-c-activation', companyId: 'hisob_test_browser', role: 'admin' },
       activeSheet: 'Patta', isServerConnected: false, initStore: async () => {}, checkLicense: async () => {}, modalState: { type: null } } as any);
     root.render(<App />);
   });
   return { configs: useWorkbookStore.getState().pattaBatchConfigs };
  }, renderPhaseCModal: (modalName: string) => {
  const state = useWorkbookStore.getState();
  const model = state.models[0];
  const ticket = (state.submittedTickets || [])[0];
  const modalByName: Record<string, any> = {
    'worker-manager': { type: 'worker_manager' },
    'worker-detail': { type: 'worker_detail', workerId: state.workers[0]?.id },
    'period-manager': { type: 'period_manager' },
    'new-model': { type: 'new_model' },
    'new-operation': { type: 'new_operation', modelId: model?.id },
    'delete-operation': { type: 'delete_operation', modelId: model?.id, opName: model?.operations[0]?.name },
    'edit-ticket': { type: 'edit_ticket', data: ticket },
    backup: { type: 'backup_manager' }, license: { type: 'license_activation' },
    update: { type: 'app_update' }, developer: { type: 'developer_info' }
  };
  useWorkbookStore.setState({ modalState: modalByName[modalName] || { type: null },
    loadingMessage: modalName === 'loading' ? 'Lokal test yuklanmoqda' : null } as any);
  if (modalName === 'confirm') {
    (window as any).__fixtureConfirmResult = undefined;
    void useWorkbookStore.getState().confirmAction({ title: 'Fixture tasdig‘i',
      message: 'Bekor qilish oqimi sinovi. Hech qanday amal bajarilmaydi.',
      confirmText: 'Tasdiqlash', cancelText: 'Bekor qilish', isDanger: false
    }).then((result) => { (window as any).__fixtureConfirmResult = result; });
  }
  if (modalName === 'notification') useWorkbookStore.getState().addNotification('info', 'Lokal xabar', 'Sintetik fixture bildirishnomasi.');
  const overlay = modalName === 'worker-manager' ? <WorkerManagerModal />
    : modalName === 'worker-detail' ? <WorkerDetailModal />
    : modalName === 'period-manager' ? <PeriodManagerModal />
    : modalName === 'new-model' ? <NewModelModal />
    : modalName === 'new-operation' ? <NewOperationModal />
    : modalName === 'delete-operation' ? <DeleteOperationModal />
    : modalName === 'edit-ticket' ? <EditSubmittedTicketModal />
    : modalName === 'print' && model ? <PattaPrintModal items={[{ model, partyNumber: ticket?.partyNumber || '1', sizes: { [ticket?.size || 'M']: '1' }, ishSoniPerPatta: '1', color: ticket?.color || 'Kora' }]} onClose={() => useWorkbookStore.getState().closeModal()} />
    : modalName === 'backup' ? <BackupManagerModal />
    : modalName === 'license' ? <LicenseActivationModal />
    : modalName === 'update' ? <AppUpdateModal />
    : modalName === 'developer' ? <DeveloperModal />
    : modalName === 'confirm' ? <ConfirmModal />
    : modalName === 'notification' ? <NotificationToast />
    : modalName === 'loading' ? <LoadingOverlay /> : null;
  flushSync(() => root.render(<div className="excel-app"><TitleBar /><div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden', position: 'relative' }}>
    <SheetTabs key={`phase-c-${modalName}`} /><main style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '4px 12px', background: '#fff7d6', color: '#714f00', fontSize: 11, fontWeight: 700 }}>LOCAL TEST FIXTURE · Sintetik ma’lumotlar</div>
      <UmumiyView />
    </main></div>{overlay}</div>));
  return { modalName, ticketId: ticket?.id, workerId: state.workers[0]?.id, modelId: model?.id };
}, renderPeriodManagerFixture: (current: any, archiveResponse: any, readResponse?: any) => {
  flushSync(() => root.render(null));
  (window as any).electronAPI = {
    getRuntimeMode: async () => ({ mode: 'sync', success: true }),
    dbRead: async () => readResponse || ({ success: true, data: current }),
    PeriodArchiveRead: async () => archiveResponse
  };
  flushSync(() => {
    useWorkbookStore.setState({
      models: current.models, workers: current.workers, currentPeriod: current.currentPeriod,
      periods: current.periods, payrollValuation: current.payrollValuation,
      licenseStatus: { isActivated: true, machineId: 'local-test', companyId: current.companyId },
      modalState: { type: 'period_manager' }
    } as any);
    root.render(<PeriodManagerModal />);
  });
}, renderArchiveXlsx: (data: any) => {
  const workbook = createPayrollWorkbook(data.models, data.workers, data.payrollValuation);
  return XLSX.write(workbook, { type: 'base64', bookType: 'xlsx' });
}, periodManagerContext: () => ({ companyId: useWorkbookStore.getState().licenseStatus?.companyId,
  periodId: useWorkbookStore.getState().currentPeriod.id }), renderWorkerDetailFixture: (data: any, valuation: any, period: any, workerId = 7) => {
  (window as any).__workerCsvBlob = null;
  URL.createObjectURL = ((blob: Blob) => { (window as any).__workerCsvBlob = blob; return 'blob:worker-detail-test'; }) as any;
  HTMLAnchorElement.prototype.click = function () { (window as any).__workerCsvFilename = this.download; };
  flushSync(() => {
    useWorkbookStore.setState({
      models: data.models, workers: data.workers, submittedTickets: data.submittedTickets,
      currentPeriod: period, payrollValuation: valuation,
      licenseStatus: { isActivated: true, machineId: 'local-test', companyId: data.companyId },
      modalState: { type: 'worker_detail', workerId }
    } as any);
    root.render(<WorkerDetailModal />);
  });
}, readWorkerCsv: async () => (window as any).__workerCsvBlob?.text(),
  workerDetailContext: () => ({ companyId: useWorkbookStore.getState().licenseStatus?.companyId,
    periodId: useWorkbookStore.getState().currentPeriod.id, workerId: useWorkbookStore.getState().modalState.workerId,
    filename: (window as any).__workerCsvFilename }), renderKonveyerFixture: (data: any) => {
  flushSync(() => {
    useWorkbookStore.setState({ models: data.models, workers: data.workers, submittedTickets: data.submittedTickets,
    currentPeriod: data.currentPeriod, payrollValuation: data.payrollValuation,
    licenseStatus: { isActivated: true, machineId: 'local-test', companyId: data.companyId } } as any);
    root.render(<KonveyerView />);
  });
} });


// Auto-mount for standard browser viewing (e.g. Chrome / dev preview)
if (typeof window !== 'undefined') {
  setTimeout(() => {
    if (!document.querySelector('.excel-app')) {
      if (typeof (window as any).electronAPI === 'undefined') {
        const syntheticModels = [
          {
            id: 'm3', name: 'DZ-008-1', hisobSheetName: 'DZ-008-1-hisob', title: 'DZ-008-1',
            party: '2', color: 'Ko\'k', size: 'M',
            operations: [
              { id: 'op-orka', name: 'Орка бостирув', rate: 150 },
              { id: 'op-bichish', name: 'Бичиш', rate: 500 },
              { id: 'op-tikish', name: 'Тикиш', rate: 1970 }
            ],
            pattaOpsOrder: ["Орка бостирув","Бичиш","Тикиш"], hisobQuantities: { 1: { 'Орка бостирув': 4684 } }
          },
          {
            id: 'm7', name: 'Бухоро ЛОНГ-1', hisobSheetName: 'Бухоро ЛОНГ-1-hisob', title: 'Бухоро ЛОНГ-1',
            party: '5', color: 'Qizil', size: 'XXL',
            operations: [{ id: 'op8', name: 'Тикиш', rate: 2370 }],
            pattaOpsOrder: ["Тикиш"], hisobQuantities: { 2: { 'Тикиш': 3573 } }
          },
          {
            id: 'm-kapalak', name: 'Buxoro-Kapalak', hisobSheetName: 'Buxoro-Kapalak-hisob', title: 'Buxoro-Kapalak',
            party: '3', color: 'Oq', size: 'L',
            operations: [{ id: 'op-kap', name: 'Тикиш', rate: 2150 }],
            pattaOpsOrder: ["Тикиш"], hisobQuantities: { 3: { 'Тикиш': 3418 } }
          },
          {
            id: 'm-body-long', name: 'BODY-LONG', hisobSheetName: 'BODY-LONG-hisob', title: 'BODY-LONG',
            party: '4', color: 'Kulrang', size: 'M',
            operations: [{ id: 'op-bl', name: 'Тикиш', rate: 3550 }],
            pattaOpsOrder: ["Тикиш"], hisobQuantities: { 4: { 'Тикиш': 594 } }
          },
          {
            id: 'm6', name: 'BODY-T-SHRIT', hisobSheetName: 'BODY-T-SHRIT-hisob', title: 'BODY-T-SHRIT',
            party: '4', color: 'Qora', size: 'XL',
            operations: [{ id: 'op7', name: 'Тикиш', rate: 3440 }],
            pattaOpsOrder: ["Тикиш"], hisobQuantities: { 1: { 'Тикиш': 205 } }
          },
          {
            id: 'm-lasina', name: 'КИК-ФИРМА-ЛАСИНА', hisobSheetName: 'КИК-ФИРМА-ЛАСИНА-hisob', title: 'КИК-ФИРМА-ЛАСИНА',
            party: '6', color: 'Qora', size: 'S',
            operations: [
              { id: 'op-las-1', name: 'Поис 22 да 1', rate: 0 },
              { id: 'op-las-2', name: 'Рашма', rate: 0 },
              { id: 'op-las-3', name: 'Этикетка 22', rate: 0 },
              { id: 'op-las-4', name: 'Чистка', rate: 0 },
              { id: 'op-las-5', name: 'Дазмол', rate: 0 },
              { id: 'op-las-6', name: 'Кантирон', rate: 0 },
              { id: 'op-las-7', name: 'Каробка кадоклаш', rate: 0 },
              { id: 'op-las-8', name: 'Поис 22 да 2', rate: 0 },
              { id: 'op-las-9', name: 'Поис резинка', rate: 0 },
              { id: 'op-las-10', name: 'Поис тсла гулчок', rate: 0 },
              { id: 'op-las-11', name: 'Поис 22 да 3', rate: 0 },
              { id: 'op-las-12', name: 'Опди орка селон', rate: 0 },
              { id: 'op-las-13', name: 'Поис улаш аверпло', rate: 0 },
              { id: 'op-las-14', name: 'Поис паст гулчок', rate: 0 },
              { id: 'op-las-15', name: 'Шаговой', rate: 0 }
            ],
            pattaOpsOrder: ["Поис 22 да 1","Рашма","Этикетка 22","Чистка","Дазмол","Кантирон","Каробка кадоклаш","Поис 22 да 2","Поис резинка","Поис тсла гулчок","Поис 22 да 3","Опди орка селон","Поис улаш аверпло","Поис паст гулчок","Шаговой"], hisobQuantities: { 5: { 'Чистка': 1533 } }
          },
          {
            id: 'm1', name: 'Barisha-tursik-100', hisobSheetName: 'Barisha-tursik-100-hisob', title: 'Barisha-tursik-100',
            party: '1', color: 'Qora', size: 'XL',
            operations: [{ id: 'op1', name: 'Бичиш', rate: 1000 }, { id: 'op2', name: 'Тикиш', rate: 1180 }],
            pattaOpsOrder: ["Бичиш","Тикиш"], hisobQuantities: {}
          },
          {
            id: 'm2', name: 'Basiman', hisobSheetName: 'Basiman-hisob', title: 'Basiman',
            party: '48', color: 'Қора', size: 'L',
            operations: [
          {
                    "id": "b-op-1",
                    "name": "Бичиш",
                    "rate": 180
          },
          {
                    "id": "b-op-2",
                    "name": "Елка қўшиш",
                    "rate": 180
          },
          {
                    "id": "b-op-3",
                    "name": "Рибана ўрнатиш",
                    "rate": 180
          },
          {
                    "id": "b-op-4",
                    "name": "Орка бостирув",
                    "rate": 180
          },
          {
                    "id": "b-op-5",
                    "name": "Енг ўрнатиш",
                    "rate": 180
          },
          {
                    "id": "b-op-6",
                    "name": "Ён тикиш",
                    "rate": 180
          },
          {
                    "id": "b-op-7",
                    "name": "Этак рашма",
                    "rate": 180
          },
          {
                    "id": "b-op-8",
                    "name": "Енг рашма",
                    "rate": 180
          },
          {
                    "id": "b-op-9",
                    "name": "Чистка",
                    "rate": 180
          },
          {
                    "id": "b-op-10",
                    "name": "Дазмол",
                    "rate": 180
          },
          {
                    "id": "b-op-11",
                    "name": "Контроль",
                    "rate": 180
          },
          {
                    "id": "b-op-12",
                    "name": "Тахлов",
                    "rate": 180
          },
          {
                    "id": "b-op-13",
                    "name": "Каробка кадоклаш",
                    "rate": 180
          },
          {
                    "id": "b-op-14",
                    "name": "Упаковка",
                    "rate": 180
          }
],
            pattaOpsOrder: ["Бичиш","Елка қўшиш","Рибана ўрнатиш","Орка бостирув","Енг ўрнатиш","Ён тикиш","Этак рашма","Енг рашма","Чистка","Дазмол","Контроль","Тахлов","Каробка кадоклаш","Упаковка"],
            hisobQuantities: {}
          },
          {
            id: 'm4', name: 'Dana-Polo-long', hisobSheetName: 'Dana-Polo-long-hisob', title: 'Dana-Polo-long',
            party: '', color: 'Sariq', size: 'S',
            operations: [{ id: 'op5', name: 'Тикиш', rate: 4770 }],
            pattaOpsOrder: ["Тикиш"], hisobQuantities: {}
          },
          {
            id: 'm5', name: 'Детиски-3-еш-(-иштон)', hisobSheetName: 'Детиски-3-еш-(-иштон)-hisob', title: 'Детиски-3-еш-(-иштон)',
            party: '3', color: 'Yashil', size: '3-yosh',
            operations: [
              { id: 'op-det-1', name: 'Бичиш', rate: 0 },
              { id: 'op-det-2', name: 'Олди чўнтак', rate: 0 },
              { id: 'op-det-3', name: 'Орқа чўнтак', rate: 0 },
              { id: 'op-det-4', name: 'Ён чок', rate: 0 },
              { id: 'op-det-5', name: 'Оралиқ чок', rate: 0 },
              { id: 'op-det-6', name: 'Поис улаш', rate: 0 },
              { id: 'op-det-7', name: 'Резинка тортиш', rate: 0 },
              { id: 'op-det-8', name: 'Поча қайтариш', rate: 0 },
              { id: 'op-det-9', name: 'Чистка', rate: 0 },
              { id: 'op-det-10', name: 'Дазмол', rate: 0 },
              { id: 'op-det-11', name: 'Қадоқлаш', rate: 0 }
            ],
            pattaOpsOrder: ["Бичиш","Олди чўнтак","Орқа чўнтак","Ён чок","Оралиқ чок","Поис улаш","Резинка тортиш","Поча қайтариш","Чистка","Дазмол","Қадоқлаш"], hisobQuantities: {}
          },
          {
            id: 'm8', name: 'Брайс-Турси', hisobSheetName: 'Брайс-Турси-hisob', title: 'Брайс-Турси',
            party: '', color: 'Kulrang', size: 'M',
            operations: [{ id: 'op9', name: 'Тикиш', rate: 2000 }],
            pattaOpsOrder: ["Тикиш"], hisobQuantities: {}
          },
          {
            id: 'm9', name: 'Александир-лонгслиф2', hisobSheetName: 'Александир-лонгслиф2-hisob', title: 'Александир-лонгслиф2',
            party: '', color: 'Oq', size: 'L',
            operations: [{ id: 'op10', name: 'Тикиш', rate: 2980 }],
            pattaOpsOrder: ["Тикиш"], hisobQuantities: {}
          },
          {
            id: 'm10', name: 'Dana-Polo', hisobSheetName: 'Dana-Polo-hisob', title: 'Dana-Polo',
            party: '', color: 'Qora', size: 'M',
            operations: [{ id: 'op11', name: 'Тикиш', rate: 4740 }],
            pattaOpsOrder: ["Тикиш"], hisobQuantities: {}
          },
          {
            id: 'm11', name: 'Александир-лонгслиф', hisobSheetName: 'Александир-лонгслиф-hisob', title: 'Александир-лонгслиф',
            party: '', color: 'Oq', size: 'L',
            operations: [{ id: 'op12', name: 'Тикиш', rate: 2970 }],
            pattaOpsOrder: ["Тикиш"], hisobQuantities: {}
          },
          {
            id: 'm12', name: 'Buxoro-Kapalak-long', hisobSheetName: 'Buxoro-Kapalak-long-hisob', title: 'Buxoro-Kapalak-long',
            party: '', color: 'Oq', size: 'L',
            operations: [{ id: 'op13', name: 'Тикиш', rate: 2400 }],
            pattaOpsOrder: ["Тикиш"], hisobQuantities: {}
          },
          {
            id: 'm13', name: 'Barisha-tursik-101', hisobSheetName: 'Barisha-tursik-101-hisob', title: 'Barisha-tursik-101',
            party: '', color: 'Qora', size: 'XL',
            operations: [{ id: 'op14', name: 'Тикиш', rate: 3460 }],
            pattaOpsOrder: ["Тикиш"], hisobQuantities: {}
          },
          {
            id: 'm14', name: 'Александр-Оверсайз', hisobSheetName: 'Александр-Оверсайз-hisob', title: 'Александр-Оверсайз',
            party: '', color: 'Oq', size: 'L',
            operations: [{ id: 'op15', name: 'Тикиш', rate: 2630 }],
            pattaOpsOrder: ["Тикиш"], hisobQuantities: {}
          },
          {
            id: 'm15', name: 'Aleksandr-Pritalinniy', hisobSheetName: 'Aleksandr-Pritalinniy-hisob', title: 'Aleksandr-Pritalinniy',
            party: '', color: 'Oq', size: 'L',
            operations: [{ id: 'op16', name: 'Тикиш', rate: 2890 }],
            pattaOpsOrder: ["Тикиш"], hisobQuantities: {}
          },
          {
            id: 'm16', name: 'Barisha', hisobSheetName: 'Barisha-hisob', title: 'Barisha',
            party: '', color: 'Qora', size: 'XL',
            operations: [{ id: 'op17', name: 'Тикиш', rate: 3460 }],
            pattaOpsOrder: ["Тикиш"], hisobQuantities: {}
          },
          {
            id: 'm17', name: 'Дана-пикабук-лонг', hisobSheetName: 'Дана-пикабук-лонг-hisob', title: 'Дана-пикабук-лонг',
            party: '', color: 'Oq', size: 'L',
            operations: [{ id: 'op18', name: 'Тикиш', rate: 0 }],
            pattaOpsOrder: ["Тикиш"], hisobQuantities: {}
          }
        ];

        const initialDates = [
          '10.10.2026 13:35', '10.10.2026 11:01', '10.10.2026 11:13',
          '14.10.2026 16:30', '14.10.2026 15:13', '14.10.2026 14:44', '10.10.2026 13:25'
        ];
        const initialQtys = [82, 82, 82, 99, 120, 139, 103];
        const syntheticTickets: any[] = [];

        // 7 exact tickets matching reference image 6
        for (let i = 0; i < 7; i++) {
          syntheticTickets.push({
            id: `ticket-ref-${i + 1}`,
            companyId: 'hisob_browser',
            periodId: 'p1',
            modelId: 'm3',
            partyNumber: '',
            pattaNumber: 0,
            qty: initialQtys[i],
            status: 'CONFIRMED',
            submittedAt: initialDates[i],
            entries: [{ opName: 'Орка бостирув', workerId: 1, qty: initialQtys[i], rateSnapshot: 150 }]
          });
        }

        // Remaining 42 tickets to reach 49 operations and 4 684 dona (totaling 702 600 so'm)
        for (let i = 7; i < 49; i++) {
          const qty = i === 48 ? 82 : 95;
          const day = 10 + (i % 5);
          const hour = 10 + (i % 8);
          const min = (i * 7) % 60;
          syntheticTickets.push({
            id: `ticket-ref-${i + 1}`,
            companyId: 'hisob_browser',
            periodId: 'p1',
            modelId: 'm3',
            partyNumber: '',
            pattaNumber: 0,
            qty,
            status: 'CONFIRMED',
            submittedAt: `${day}.10.2026 ${hour < 10 ? '0' : ''}${hour}:${min < 10 ? '0' : ''}${min}`,
            entries: [{ opName: 'Орка бостирув', workerId: 1, qty, rateSnapshot: 150 }]
          });
        }

        // Synthetic Parties matching reference image
        const syntheticParties: any[] = [];
        for (let i = 1; i <= 34; i++) {
          const rate = i <= 27 ? 55 : 54;
          const ish = 12 * rate;
          syntheticParties.push({
            id: `p-dz-${i}`,
            partyNumber: String(100 + i),
            modelId: 'm3',
            modelName: 'DZ-008-1',
            color: 'Кора',
            pattaCount: 12,
            ishSoniPerPatta: rate,
            ishSoni: ish,
            sizes: { XXL: '12' },
            pattaStartNumber: 1000 + i * 12,
            pattaEndNumber: 1000 + i * 12 + 11,
            printedAt: '2026-10-10T05:00:00.000Z'
          });
        }
        const btCounts = [21, 21, 20, 20, 20, 20];
        const btRates = [58, 58, 59, 62, 62, 62];
        for (let i = 0; i < 6; i++) {
          const count = btCounts[i];
          const rate = btRates[i];
          const ish = count * rate;
          syntheticParties.push({
            id: `p-bt-${i + 1}`,
            partyNumber: String(200 + i + 1),
            modelId: 'm8',
            modelName: 'Брайс-Турси',
            color: 'Кора',
            pattaCount: count,
            ishSoniPerPatta: rate,
            ishSoni: ish,
            sizes: { XXL: String(count) },
            pattaStartNumber: 2000 + (i + 1) * 25,
            pattaEndNumber: 2000 + (i + 1) * 25 + count - 1,
            printedAt: '2026-10-10T05:30:00.000Z'
          });
        }
        const lasinaParties = [
          { num: '9', reja: 500, time: '2026-10-10T06:32:00.000Z', start: 117 },
          { num: '10', reja: 550, time: '2026-10-10T06:33:00.000Z', start: 127 },
          { num: '22', reja: 600, time: '2026-10-13T03:47:00.000Z', start: 137 },
          { num: '27', reja: 510, time: '2026-10-14T03:21:00.000Z', start: 147 },
          { num: '36', reja: 500, time: '2026-10-14T08:53:00.000Z', start: 157 },
          { num: '42', reja: 520, time: '2026-10-15T04:35:00.000Z', start: 167 }
        ];
        for (const lp of lasinaParties) {
          syntheticParties.push({
            id: `p-las-${lp.num}`,
            partyNumber: lp.num,
            modelId: 'm-lasina',
            modelName: 'КИК-ФИРМА-ЛАСИНА',
            color: 'Кора',
            pattaCount: 10,
            ishSoniPerPatta: lp.reja / 10,
            ishSoni: lp.reja,
            sizes: { XXL: '10' },
            pattaStartNumber: lp.start,
            pattaEndNumber: lp.start + 9,
            printedAt: lp.time
          });
        }
        // 54 closed parties
        for (let i = 1; i <= 54; i++) {
          syntheticParties.push({
            id: `closed-p-${i}`,
            partyNumber: `c${i}`,
            modelId: 'm3',
            modelName: 'DZ-008-1',
            color: 'Кора',
            isClosed: true,
            pattaCount: 1,
            ishSoniPerPatta: 10,
            ishSoni: 10,
            sizes: { XXL: '1' },
            printedAt: '2026-09-10T10:00:00.000Z'
          });
        }

        useAuthStore.getState().setAuth({
          status: 'active',
          role: 'admin',
          permissions: applyRolePermissions('admin'),
          companyId: 'hisob_browser'
        });

        useWorkbookStore.setState({
          models: syntheticModels,
          printedPartyHistory: syntheticParties,
          workers: [
            { id: 1, name: 'Абдуллаева Мавлуда', staj: 0, avans: 0, jarima: 0 },
            { id: 2, name: 'Абдуллаева Нодира', staj: 0, avans: 0, jarima: 0 },
            { id: 3, name: 'Абдуллаева Нурхон', staj: 140000, avans: 0, jarima: 0 },
            { id: 4, name: 'Абдуллаева Зарнигор', staj: 0, avans: 0, jarima: 0 },
            { id: 5, name: 'Абдумуталипов Абдуллох', staj: 140000, avans: 0, jarima: 0 },
            { id: 6, name: 'Абдумуталипова Гуллола', staj: 140000, avans: 0, jarima: 0 },
            { id: 7, name: 'Абдрахмонова Рисолатой', staj: 0, avans: 0, jarima: 0 },
            { id: 8, name: 'Абдумуталипова Санобар', staj: 140000, avans: 0, jarima: 0 },
            { id: 9, name: 'Акбарова Дилдора', staj: 0, avans: 0, jarima: 0 }
          ],
          submittedTickets: syntheticTickets,
          activeSheet: 'Patta-hisob',
          currentPeriod: { id: 'p1', name: '2026-Oktabr', startDate: '2026-10-01', isClosed: false },
          periods: [{ id: 'p1', name: '2026-Oktabr', startDate: '2026-10-01', isClosed: false }],
          licenseStatus: {
            isActivated: true, isTrial: true, machineId: 'local-browser', companyId: 'hisob_browser',
            activationId: 'local-browser', remainingText: 'LOCAL BROWSER', role: 'admin'
          },
          payrollValuation: {
            companyId: 'hisob_browser',
            accountingStatus: 'COMPLETE',
            syncStatus: 'CURRENT',
            period: { periodId: 'p1', name: 'Joriy Oylik', isClosed: false },
            workers: [
              { workerId: 1, name: 'Абдуллаева Мавлуда', pieceworkGross: 702600, umumiy: 702600, staj: 0, avans: 0, jarima: 0, oklad: 0, magazin: 0, sofFoyda: 702600, models_breakdown: { 'm3': { name: 'DZ-008-1', operations: [{ name: 'Орка бостирув', qty: 4684 }] } } },
              { workerId: 2, name: 'Абдуллаева Нодира', pieceworkGross: 479850, umumiy: 479850, staj: 0, avans: 0, jarima: 0, oklad: 0, magazin: 0, sofFoyda: 479850 },
              { workerId: 3, name: 'Абдуллаева Нурхон', pieceworkGross: 910010, umumiy: 910010, staj: 140000, avans: 0, jarima: 0, oklad: 0, magazin: 0, sofFoyda: 770010 },
              { workerId: 4, name: 'Абдуллаева Зарнигор', pieceworkGross: 1066060, umumiy: 1066060, staj: 0, avans: 0, jarima: 0, oklad: 0, magazin: 0, sofFoyda: 1066060 },
              { workerId: 5, name: 'Абдумуталипов Абдуллох', pieceworkGross: 0, umumiy: 0, staj: 140000, avans: 0, jarima: 0, oklad: 0, magazin: 0, sofFoyda: -140000 },
              { workerId: 6, name: 'Абдумуталипова Гуллола', pieceworkGross: 0, umumiy: 0, staj: 140000, avans: 0, jarima: 0, oklad: 0, magazin: 0, sofFoyda: -140000 },
              { workerId: 7, name: 'Абдрахмонова Рисолатой', pieceworkGross: 329610, umumiy: 329610, staj: 0, avans: 0, jarima: 0, oklad: 0, magazin: 0, sofFoyda: 329610 },
              { workerId: 8, name: 'Абдумуталипова Санобар', pieceworkGross: 540300, umumiy: 540300, staj: 140000, avans: 0, jarima: 0, oklad: 0, magazin: 0, sofFoyda: 400300 },
              { workerId: 9, name: 'Акбарова Дилдора', pieceworkGross: 771000, umumiy: 771000, staj: 0, avans: 0, jarima: 0, oklad: 0, magazin: 0, sofFoyda: 771000 }
            ],
            tariffs: [
              { id: 'm3', name: 'DZ-008-1', operations: [{ id: 'op-orka', name: 'Орка бостирув', rate: 150 }] }
            ]
          },
          pattaBatchConfigs: {},
          isServerConnected: false,
          modalState: { type: null }
        } as any);
        flushSync(() => {
          root.render(<LocalPreviewSurface />);
        });
      }
    }
  }, 100);
}
