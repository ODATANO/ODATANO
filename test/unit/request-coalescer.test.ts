import { RequestCoalescer } from '../../srv/blockchain/request-coalescer';

describe('RequestCoalescer', () => {
    it('should deduplicate concurrent requests for the same key', async () => {
        const coalescer = new RequestCoalescer<number>();
        let calls = 0;

        const fetcher = async () => {
            calls += 1;
            await new Promise(resolve => setTimeout(resolve, 10));
            return 42;
        };

        const [a, b] = await Promise.all([
            coalescer.get('same-key', fetcher),
            coalescer.get('same-key', fetcher),
        ]);

        expect(a).toBe(42);
        expect(b).toBe(42);
        expect(calls).toBe(1);
    });

    it('should clear failed requests and allow retry', async () => {
        const coalescer = new RequestCoalescer<string>();
        let firstAttempt = true;

        const flakyFetcher = jest.fn(async () => {
            if (firstAttempt) {
                firstAttempt = false;
                throw new Error('temporary failure');
            }
            return 'ok';
        });

        await expect(coalescer.get('retry-key', flakyFetcher)).rejects.toThrow('temporary failure');
        await expect(coalescer.get('retry-key', flakyFetcher)).resolves.toBe('ok');
        expect(flakyFetcher).toHaveBeenCalledTimes(2);
    });

    it('should expose pending request count via size getter', async () => {
        const coalescer = new RequestCoalescer<number>();
        let resolvePending!: (value: number) => void;

        const pendingPromise = new Promise<number>(resolve => {
            resolvePending = resolve;
        });

        const inFlight = coalescer.get('size-key', () => pendingPromise);
        expect(coalescer.size).toBe(1);

        resolvePending(7);
        await inFlight;

        expect(coalescer.size).toBe(0);
    });
});
