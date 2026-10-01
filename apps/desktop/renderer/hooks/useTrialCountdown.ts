import { useState, useEffect } from 'react';
import { LicenseStatus } from '../types/workbook';
import { useWorkbookStore } from '../store/workbookStore';

export interface TrialCountdownResult {
  hours: number;
  minutes: number;
  seconds: number;
  isExpired: boolean;
  formattedClock: string; // e.g. "23:14:05"
  formattedText: string;  // e.g. "23 soat 14 daqiqa 5 soniya"
  formattedShort: string; // e.g. "23 soat 14 daq"
}

export function useTrialCountdown(licenseStatus: LicenseStatus | null): TrialCountdownResult | null {
  const [countdown, setCountdown] = useState<TrialCountdownResult | null>(null);

  useEffect(() => {
    if (!licenseStatus?.isTrial || !licenseStatus.trialEndsAt) {
      setCountdown(null);
      return;
    }

    const calculate = () => {
      const now = Date.now();
      const endsAt = licenseStatus.trialEndsAt || 0;
      const diffMs = Math.max(0, endsAt - now);

      if (diffMs <= 0) {
        setCountdown({
          hours: 0,
          minutes: 0,
          seconds: 0,
          isExpired: true,
          formattedClock: '00:00:00',
          formattedText: 'Sinov muddati tugadi',
          formattedShort: 'Muddati tugadi'
        });
        // Re-check license from backend
        useWorkbookStore.getState().checkLicense();
        return;
      }

      const hours = Math.floor(diffMs / (1000 * 60 * 60));
      const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);

      const hStr = String(hours).padStart(2, '0');
      const mStr = String(minutes).padStart(2, '0');
      const sStr = String(seconds).padStart(2, '0');

      setCountdown({
        hours,
        minutes,
        seconds,
        isExpired: false,
        formattedClock: `${hStr}:${mStr}:${sStr}`,
        formattedText: `${hours} soat ${minutes} daqiqa ${seconds} soniya`,
        formattedShort: `${hours} soat ${minutes} daq`
      });
    };

    calculate();
    const interval = setInterval(calculate, 1000);
    return () => clearInterval(interval);
  }, [licenseStatus?.isTrial, licenseStatus?.trialEndsAt]);

  return countdown;
}
