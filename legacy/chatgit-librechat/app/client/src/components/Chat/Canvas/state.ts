import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import { createStorageAtom } from '~/store/jotai-utils';

export const readerMode = createStorageAtom<'side' | 'dialog'>('chatgit.reader', 'side');

export const canvasDraft = atomFamily((_conversationId: string) =>
  atom({
    text: '',
    selected: [] as string[],
    parentId: null as string | null,
    mode: 'merge' as 'merge' | 'continue' | 'rewrite',
  }),
);
