import type { MessageId, AnchorId, BranchId } from '../types';

let counter = 0;

function uid(prefix: string): string {
  counter++;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export const createMessageId = () => uid('msg') as MessageId;
export const createAnchorId = () => uid('anc') as AnchorId;
export const createBranchId = () => uid('br') as BranchId;
