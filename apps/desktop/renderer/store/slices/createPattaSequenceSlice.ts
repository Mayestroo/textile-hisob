import type { StateCreator } from 'zustand';
import type { PattaSequenceSlice, WorkbookStore } from '../types';

export const createPattaSequenceSlice: StateCreator<WorkbookStore, [], [], PattaSequenceSlice> = () => ({
  nextPattaNumber: 1
});
