/**
 * DetachedRun: a run that throws before it returns a promise ends as failed, and a run counts as
 * cancelled only when it saw the stop request.
 */
import { DetachedRun } from '../../srv/utils/detached-run';

const settle = () => new Promise((r) => setImmediate(r));

describe('DetachedRun', () => {
  it('ends a run that throws synchronously as failed and frees it for the next start', async () => {
    const run = new DetachedRun<{ rows: number }>('Test run', { rows: 0 });
    await run.start(() => ({ run: () => { throw new Error('no app context'); }, answer: 'started' }));
    await settle();
    expect(run.snapshot()).toMatchObject({ status: 'failed', error: 'no app context' });
    expect(run.isBusy()).toBe(false);
    await expect(run.start(() => ({ run: async () => ({ rows: 2 }), answer: 'again' }))).resolves.toBe('again');
    await settle();
    expect(run.snapshot()).toMatchObject({ status: 'done', rows: 2 });
  });

  it('reports done when the cancel came after the run made its last check', async () => {
    const run = new DetachedRun<{ rows: number }>('Test run', { rows: 0 });
    let finish!: () => void;
    await run.start(() => ({ run: () => new Promise<{ rows: number }>((r) => { finish = () => r({ rows: 5 }); }), answer: null }));
    expect(run.cancel()).toBe(true);
    finish();
    await settle();
    expect(run.snapshot()).toMatchObject({ status: 'done', rows: 5 });
  });

  it('reports cancelled when the run stopped on the request', async () => {
    const run = new DetachedRun<{ rows: number }>('Test run', { rows: 0 });
    let check!: () => boolean;
    let finish!: () => void;
    await run.start(() => ({
      run: (ctl) => new Promise<{ rows: number }>((r) => { check = () => ctl.shouldStop(); finish = () => r({ rows: 1 }); }),
      answer: null,
    }));
    run.cancel();
    expect(check()).toBe(true);
    finish();
    await settle();
    expect(run.snapshot()).toMatchObject({ status: 'cancelled', rows: 1 });
  });
});
