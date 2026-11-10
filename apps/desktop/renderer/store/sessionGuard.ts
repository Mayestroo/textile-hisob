export interface SessionIdentity {
  companyId: string;
  generation: number;
}

let observedCompanyId: string | null = null;
let sessionGeneration = 0;

/** Invalidate async work when the license/operator session changes, even if the company does not. */
export function invalidateSessionIdentity(companyId?: string | null): SessionIdentity | null {
  if (!companyId || companyId === 'unassigned') {
    observedCompanyId = null;
    sessionGeneration += 1;
    return null;
  }
  observedCompanyId = companyId;
  sessionGeneration += 1;
  return { companyId, generation: sessionGeneration };
}

/** Observe the active company and advance identity whenever it changes. */
export function captureSessionIdentity(companyId: string | null | undefined): SessionIdentity | null {
  if (!companyId || companyId === 'unassigned') return null;
  if (companyId !== observedCompanyId) {
    observedCompanyId = companyId;
    sessionGeneration += 1;
  }
  return { companyId, generation: sessionGeneration };
}

export function isSessionCurrent(
  captured: SessionIdentity | null,
  currentCompanyId: string | null | undefined
): boolean {
  if (!captured || !currentCompanyId) return false;
  const current = captureSessionIdentity(currentCompanyId);
  return Boolean(
    current &&
    captured.companyId === current.companyId &&
    captured.generation === current.generation
  );
}

export function resetSessionGuardForTests(): void {
  observedCompanyId = null;
  sessionGeneration = 0;
}
