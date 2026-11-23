import { useEffect, useState } from 'react';
import { getElectronApi } from '../../store/runtimeMode';
import { useAuthStore } from '../../store/authStore';
import { useWorkbookStore } from '../../store/workbookStore';

export const REVIEWER_ROLES = ['admin', 'accountant'];

export function isAllocationReviewer(role: string | null | undefined): boolean {
  return REVIEWER_ROLES.includes(String(role || '').toLowerCase());
}

/**
 * Number of open allocation-review items: this PC's held submissions and, for
 * an admin/accountant, every PC's items recorded on the server.
 */
export function useAllocationReviewCount(pollMs = 60_000): number {
  const companyId = useWorkbookStore((s) => s.licenseStatus?.companyId || '');
  const submittedTickets = useWorkbookStore((s) => s.submittedTickets);
  const role = useAuthStore((s) => s.role || '');
  const reviewer = isAllocationReviewer(role);
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const api = getElectronApi() as any;
      if (!companyId || typeof api?.AllocationReviewList !== 'function') return;
      try {
        const ids = new Set<string>();
        const local = await api.AllocationReviewList({ companyId });
        for (const row of local?.conflicts || []) if (row.status === 'CONFLICT') ids.add(row.operation_id);
        if (reviewer && typeof api.AllocationReviewServerList === 'function') {
          const server = await api.AllocationReviewServerList({ companyId });
          for (const row of server?.reviews || []) ids.add(row.operationId);
        }
        if (!cancelled) setCount(ids.size);
      } catch { /* keep the last known count */ }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, pollMs);
    return () => { cancelled = true; window.clearInterval(timer); };
    // submittedTickets: refresh when a sync/projection reload changes tickets.
  }, [companyId, reviewer, pollMs, submittedTickets]);

  return count;
}
