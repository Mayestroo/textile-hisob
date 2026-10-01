export interface Worker {
  id: number;
  name: string;
  staj?: number;      // Doimiy Staj (Ishchilar ro'yxatida belgilanadi va har oy saqlanadi)
  avans?: number;     // Avans (Oylik davr yopilganda 0 ga qaytadi)
  jarima?: number;    // Jarima (Oylik davr yopilganda 0 ga qaytadi)
  role?: string;
  status?: 'ACTIVE' | 'INACTIVE';
  updatedAt?: number;
  serverRevision?: number;
}

export interface Operation {
  id: string;
  name: string;
  rate: number;
  col?: number;
}

export interface ModelConfig {
  id: string;
  name: string;
  hisobSheetName: string;
  title: string;
  party: string;
  color: string;
  size: string;
  operations: Operation[];
  pattaOpsOrder: string[];
  serverRevision?: number;
  hisobQuantities: Record<number, Record<string, number>>; // workerId -> { opName: quantity }
}

export interface TicketEntry {
  opName: string;
  workerId: number | string;
  workerName: string;
  brak?: string;
}

export interface TicketFormState {
  date: string;
  konveyer?: string;
  party: string;
  color: string;
  size: string;
  qty: number | string;
  patta?: string;
  strictParty?: boolean;
  strictPatta?: boolean;
  entries: Record<string, number | string>; // opName -> workerId
}

export interface ModelPattaBatchConfig {
  partyNumber: string;
  isCustomParty?: boolean;
  totalIshSoni: string;
  color?: string;
  sizes: Record<string, string>; // size -> count
}

export interface PrintedPartyRecord {
  id: string;
  partyNumber: string;
  modelId: string;
  modelName: string;
  color: string;
  pattaCount: number;           // Ushbu partiyadagi patta soni (masalan: 15)
  cumulativePattaCount: number; // Jami to'plangan patta soni (oldingi + yangi)
  pattaStartNumber?: number;    // Korxona bo'yicha ajratilgan birinchi global patta raqami
  pattaEndNumber?: number;      // Korxona bo'yicha ajratilgan oxirgi global patta raqami
  ishSoniPerPatta?: number;     // 1 ta patta uchun ish soni (masalan: 50)
  totalIshSoni?: number;        // Jami ish soni = pattaCount * ishSoniPerPatta
  ishSoni: number;              // Ushbu partiyadagi jami ish soni (masalan: 750)
  cumulativeIshSoni: number;    // Jami to'plangan ish soni (oldingi + yangi)
  sizes?: Record<string, string>; // Razmerlar bo'yicha patta soni taqsimoti
  printedAt: string;            // Qachon pechat qilingan
  archivedPattaNumbers?: number[]; // Oldingi oylarda topshirilib arxivlangan patta raqamlari
  isClosed?: boolean;           // Partiya yakunlangan (yopilgan) holati
  isArchived?: boolean;         //  kanonik tarixdan yashirilgan holati
  closedAt?: string;            // Qachon yakunlangan
  serverRevision?: number;
}

export interface SubmittedTicketRecord {
  id: string;
  modelId: string;
  partyNumber: string;
  partyRecordId?: string | null; // NULL in  free mode: no fabricated printed party record.
  periodId?: string;
  serverRevision?: number;
  isClosed?: boolean;           // Partiya yakunlanganda yopilgan holati
  konveyer?: string;
  pattaNumber: number;
  size?: string;
  color?: string;
  qty: number;
  entries?: Array<{
    opName: string;
    workerId: number;
    workerNameSnapshot?: string;
    rateSnapshot?: number;
  }>;
  submittedAt: string;
}

export type SheetType = 'patta' | 'hisob' | 'umumiy' | 'patta_batch' | 'konveyer';

export interface SheetConfig {
  id: string;
  name: string;
  type: SheetType;
  modelId?: string;
}

export interface PayrollPeriod {
  id: string;
  name: string;
  startDate: string;
  endDate?: string;
  isClosed: boolean;
  closedAt?: string;
  notes?: string;
  archiveFilename?: string;
  serverRevision?: number;
}

export interface Notification {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  title: string;
  message: string;
  timestamp: number;
}

export interface LicenseStatus {
  isActivated: boolean;
  isTrial?: boolean;
  isTrialExpired?: boolean;
  isBlocked?: boolean;
  machineId: string;
  expiry?: string;
  isLifetime?: boolean;
  licenseKey?: string;
  activatedAt?: string;
  activationId?: string;
  deviceCredentialReady?: boolean;
  remainingHours?: number;
  remainingMinutes?: number;
  remainingText?: string;
  trialEndsAt?: number;
  message?: string;
  role?: 'admin' | 'type' | 'print';
  companyId?: string;
  companyName?: string;
  requireTicketValidation?: boolean;
  activationRequestStatus?: 'PENDING' | 'REJECTED';
  activationRequestId?: string;
}
