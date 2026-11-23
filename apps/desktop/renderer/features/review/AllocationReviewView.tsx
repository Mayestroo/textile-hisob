import React from 'react';
import { ClipboardCheck } from 'lucide-react';
import { AllocationReviewPanel } from '../patta/AllocationReviewPanel';
import { useWorkbookStore } from '../../store/workbookStore';
import { useAuthStore } from '../../store/authStore';
import { isAllocationReviewer } from './useAllocationReviewCount';

/** Dedicated page for patta submissions the server held for review. */
export const AllocationReviewView: React.FC = () => {
  const companyId = useWorkbookStore((s) => s.licenseStatus?.companyId || 'company_main');
  const role = useAuthStore((s) => s.role || '');
  const reviewer = isAllocationReviewer(role);

  return (
    <div className="phase-b-view" style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto' }}>
      <header style={{ padding: '18px 20px 4px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <ClipboardCheck size={22} aria-hidden="true" />
        <div>
          <h1 style={{ margin: 0, fontSize: 20 }}>Ko‘rib chiqish</h1>
          <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 2 }}>
            {reviewer
              ? 'Barcha kompyuterlardan server qabul qilmagan pattalar. Tekshiring va bekor qiling — keyin patta to‘g‘ri ma’lumot bilan qayta kiritiladi.'
              : 'Shu kompyuterda kiritilgan, server qabul qilmagan pattalar. Pattani «Patta» oynasida to‘g‘ri miqdor bilan qayta jo‘nating yoki admin/hisobchi bekor qilishini kuting.'}
          </div>
        </div>
      </header>
      <AllocationReviewPanel companyId={companyId} canCancel={reviewer} variant="page" />
    </div>
  );
};
