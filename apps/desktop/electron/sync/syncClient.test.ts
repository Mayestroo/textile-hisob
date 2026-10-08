import { afterEach, describe, expect, it, vi } from 'vitest';

const { SyncClient, SyncError } = require('./syncClient.cjs');

describe(' SyncClient bootstrap request', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requests bootstrap through authenticated device headers without a caller-selected company', async () => {
    const responseBody = { success: true, snapshot: { company: { companyId: 'comp_novda' } }, cursor: '8', counts: {} };
    const fetch = vi.fn(async () => new Response(JSON.stringify(responseBody), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const client = new SyncClient({ baseUrl: 'https://sync.example.test', token: 'device-secret', deviceId: 'machine-1' });

    await expect(client.getBootstrap()).resolves.toEqual(responseBody);

    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0] as any;
    expect(url).toBe('https://sync.example.test/api/sync/bootstrap');
    expect(options.method).toBe('GET');
    expect(options.headers.Authorization).toBe('Bearer device-secret');
    expect(options.headers['x-device-id']).toBe('machine-1');
  });

  it('preserves authentication failures as structured SyncErrors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: false,
      error: { code: 'DEVICE_REVOKED', message: 'Device revoked' }
    }), { status: 403 })));
    const client = new SyncClient({ baseUrl: 'https://sync.example.test', token: 'revoked' });

    await expect(client.getBootstrap()).rejects.toBeInstanceOf(SyncError);
    await expect(client.getBootstrap()).rejects.toMatchObject({ code: 'DEVICE_REVOKED', statusCode: 403 });
  });

  it('queries accepted outbox operation identities with the authenticated company device', async () => {
    const responseBody = { success: true, results: [{ operationId: 'op-1', status: 'APPLIED', payloadHash: 'a'.repeat(64) }] };
    const fetch = vi.fn(async () => new Response(JSON.stringify(responseBody), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const client = new SyncClient({ baseUrl: 'https://sync.example.test', token: 'device-secret', deviceId: 'machine-1' });
    const operations = [{ operationId: 'op-1', payloadHash: 'a'.repeat(64) }];

    await expect(client.getOperationStatuses(operations)).resolves.toEqual(responseBody);

    const [url, options] = fetch.mock.calls[0] as any;
    expect(url).toBe('https://sync.example.test/api/sync/operations/status');
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe('Bearer device-secret');
    expect(JSON.parse(options.body)).toEqual({ operations });
  });

  it('splits large operation lists into bounded requests and preserves result order', async () => {
    const operations = Array.from({ length: 25 }, (_, index) => ({
      operationId: `op-batch-${index}`,
      commandType: 'UpdateBatchSettings',
      payload: { snapshot: 'x'.repeat(2_500) }
    }));
    const fetch = vi.fn(async (_url: string, options: any) => {
      const batch = JSON.parse(options.body).operations;
      return new Response(JSON.stringify({
        success: true,
        results: batch.map((operation: any) => ({ operationId: operation.operationId, status: 'APPLIED' }))
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const client = new SyncClient({ baseUrl: 'https://sync.example.test', maxOperationBatchBytes: 8_000 });

    const response = await client.pushOperations(operations);

    expect(fetch.mock.calls.length).toBeGreaterThan(1);
    for (const [, options] of fetch.mock.calls as any) {
      expect(Buffer.byteLength(options.body, 'utf8')).toBeLessThanOrEqual(8_000);
    }
    expect(response.results.map((result: any) => result.operationId))
      .toEqual(operations.map((operation) => operation.operationId));
  });

  it('splits again when the server enforces a smaller body limit and rejects missing result lists', async () => {
    const operations = Array.from({ length: 4 }, (_, index) => ({
      operationId: `op-413-${index}`,
      commandType: 'UpdateBatchSettings',
      payload: { snapshot: 'x'.repeat(450) }
    }));
    const fetch = vi.fn(async (_url: string, options: any) => {
      const batch = JSON.parse(options.body).operations;
      if (Buffer.byteLength(options.body, 'utf8') > 800) return new Response('{}', { status: 413 });
      return new Response(JSON.stringify({
        success: true,
        results: batch.map((operation: any) => ({ operationId: operation.operationId, status: 'APPLIED' }))
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const client = new SyncClient({ baseUrl: 'https://sync.example.test', maxOperationBatchBytes: 8_000 });

    const response = await client.pushOperations(operations);
    expect(response.results.map((result: any) => result.operationId))
      .toEqual(operations.map((operation) => operation.operationId));
    expect(fetch.mock.calls.some(([, options]: any) => Buffer.byteLength(options.body, 'utf8') > 800)).toBe(true);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })));
    await expect(client.pushOperations([operations[0]])).rejects.toMatchObject({ code: 'INVALID_OPERATION_BATCH_RESPONSE' });
  });
});
