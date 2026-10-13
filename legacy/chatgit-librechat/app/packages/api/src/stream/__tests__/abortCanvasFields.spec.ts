/**
 * A Stop rebuilds the user turn from job metadata. A turn with ChatGit branch references
 * must keep the server-resolved fields the created event carried, and only those.
 */
import type { CanvasContext } from 'librechat-data-provider';

/** Suppress winston Console transport output (survives jest.resetModules) */
jest.spyOn(console, 'log').mockImplementation();

async function configureManager() {
  const { GenerationJobManager } = await import('../GenerationJobManager');
  const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
  const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

  GenerationJobManager.configure({
    jobStore: new InMemoryJobStore(),
    eventTransport: new InMemoryEventTransport(),
    isRedis: false,
    cleanupOnComplete: false,
  });
  GenerationJobManager.initialize();
  return GenerationJobManager;
}

const canvasContext: CanvasContext = {
  version: 1,
  sources: ['branch-answer'],
  nodes: [
    {
      messageId: 'branch-answer',
      parentMessageId: null,
      role: 'assistant',
      text: 'FROZEN_BRANCH_TEXT',
    },
  ],
};

describe('abortJob branch references', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it.each([
    { name: 'keeps the resolved fields of a referencing turn', fields: true },
    { name: 'adds none to an ordinary turn', fields: false },
  ])('$name', async ({ fields }) => {
    const manager = await configureManager();
    const streamId = `abort-canvas-${fields}`;
    const job = await manager.createJob(streamId, 'user-1', streamId);
    await manager.emitChunk(
      streamId,
      {
        created: true,
        message: {
          messageId: 'user-msg',
          parentMessageId: 'parent-msg',
          conversationId: streamId,
          text: 'Merge the branches.',
          isCreatedByUser: true,
          ...(fields && { canvasSources: ['branch-answer'], canvasContext }),
        },
        streamId,
      },
      { expectedCreatedAt: job.createdAt },
    );

    const result = await manager.abortJob(streamId);
    const { requestMessage } = result.finalEvent as { requestMessage: Record<string, unknown> };

    expect(result.success).toBe(true);
    for (const message of [result.jobData?.userMessage, requestMessage]) {
      if (fields) {
        expect(message).toMatchObject({ canvasSources: ['branch-answer'], canvasContext });
      } else {
        expect(message).not.toHaveProperty('canvasSources');
        expect(message).not.toHaveProperty('canvasContext');
      }
    }

    await manager.destroy();
  });
});
