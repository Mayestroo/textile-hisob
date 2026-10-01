import { describe, expect, it, vi } from 'vitest';
import { confirmAndArchivePartyHistoryRecord } from './pattaHistoryActions';

describe('confirmAndArchivePartyHistoryRecord', () => {
  it('archives the selected party after confirmation', async () => {
    const confirmAction = vi.fn().mockResolvedValue(true);
    const archiveParty = vi.fn().mockResolvedValue(undefined);

    await expect(confirmAndArchivePartyHistoryRecord(
      { id: 'party-50', partyNumber: '50' }, confirmAction, archiveParty
    )).resolves.toBe(true);

    expect(confirmAction).toHaveBeenCalledWith(expect.objectContaining({
      title: "Partiyani o'chirish",
      message: expect.stringContaining('50'),
      isDanger: true
    }));
    expect(archiveParty).toHaveBeenCalledTimes(1);
    expect(archiveParty).toHaveBeenCalledWith('party-50');
  });

  it('does not archive when confirmation is cancelled', async () => {
    const confirmAction = vi.fn().mockResolvedValue(false);
    const archiveParty = vi.fn();

    await expect(confirmAndArchivePartyHistoryRecord(
      { id: 'party-50', partyNumber: '50' }, confirmAction, archiveParty
    )).resolves.toBe(false);
    expect(archiveParty).not.toHaveBeenCalled();
  });
});
