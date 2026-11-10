import React from 'react';
import { OperationRatesView } from '../OperationRatesView';

interface OperationRatesModalProps {
  onClose: () => void;
  initialModelId?: string;
}

export const OperationRatesModal: React.FC<OperationRatesModalProps> = ({ onClose, initialModelId }) => {
  return (
    <div className="rates-modal-overlay" onClick={onClose}>
      <div className="rates-modal-dialog" onClick={(e) => e.stopPropagation()}>
        <OperationRatesView isModal={true} onClose={onClose} initialModelId={initialModelId} />
      </div>
    </div>
  );
};
