import type { PrintedPartyRecord } from '../../types/workbook';

type PartyReference = Pick<PrintedPartyRecord, 'id' | 'partyNumber'>;
type ConfirmOptions = {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  isDanger?: boolean;
};

export async function confirmAndArchivePartyHistoryRecord(
  party: PartyReference,
  confirmAction: (options: ConfirmOptions) => Promise<boolean>,
  archiveParty: (id: string) => Promise<void> | void
): Promise<boolean> {
  const confirmed = await confirmAction({
    title: "Partiyani o'chirish",
    message: `Partiya ${party.partyNumber} ni o'chirishni xohlaysizmi?`,
    confirmText: "Ha, o'chirilsin",
    isDanger: true
  });
  if (!confirmed) return false;
  await archiveParty(party.id);
  return true;
}
