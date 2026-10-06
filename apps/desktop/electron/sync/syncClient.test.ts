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
});
