/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const html = readFileSync(join(__dirname, '../index.html'), 'utf8');
const script = readFileSync(join(__dirname, '../scripts/worker.js'), 'utf8');
const profile = () => ({ worker_id: 27, company_id: 'tenant-a', worker_name: 'Server Worker',
  period_name: 'Current server period', period: { periodId: 'P', isClosed: false },
  gross: 900, pieceworkGross: 800, oklad: 100, magazin: 50, avans: 70, jarima: 20, staj: 10,
  net: 750, pieces: 8, accountingStatus: 'COMPLETE', models_breakdown: {
    m: { name: 'Server Model', operations: [{ name: 'Server operation', qty: 8, rate: 100, amount: 800 }] }
  } });

async function boot() {
  let currentProfile: any = profile();
  let statusCode = 200;
  const fetch = vi.fn(async (input: string, _init: any) => ({ ok: statusCode === 200, status: statusCode,
    json: async () => input.includes('/profile')
      ? { success: statusCode === 200, profile: currentProfile }
      : { success: true, workerId: 27, tickets: [{ model_id: 'm', model_name: 'Server Model',
        patta_number: 76, party_number: '45', qty: 100, my_qty: 8, my_operations: 'Server operation' }] }
  }));
  const context: any = { document, localStorage, URL, URLSearchParams, fetch, console: { warn: vi.fn() },
    setInterval: vi.fn(), clearInterval: vi.fn(), window: {
      location: { origin: 'https://worker.invalid', search: `?companyId=tenant-a&workerId=27&telegramId=123&expiresAt=9999999999&authToken=${'a'.repeat(64)}` },
      sessionStorage, addEventListener: vi.fn()
    } };
  vm.runInNewContext(`${script}\nthis.app = { loadWorkerData, state };`, context);
  await vi.waitFor(() => expect(context.app.state.isLoading).toBe(false));
  return { ...context.app, fetch, setProfile(value: any) { currentProfile = value; }, setStatus(value: number) { statusCode = value; } };
}

describe('worker server data rendering', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
    localStorage.clear();
    sessionStorage.clear();
  });

  it('renders server identity, payroll, operations, issued quantity and personal work without demo replacements', async () => {
    const app = await boot();
    expect(document.getElementById('workerNameHeader')!.textContent).toBe('Server Worker');
    expect(document.getElementById('netPayAmount')!.textContent).toContain('750');
    expect(document.getElementById('modelsBreakdownList')!.textContent).toContain('Server operation');
    expect(document.getElementById('ticketsList')!.textContent).toContain('Server Model');
    expect(document.getElementById('ticketsList')!.textContent).toContain('Bajargan ishim: 8 dona');
    expect(document.getElementById('workerDataStatus')!.textContent).toContain('Serverdan yangilandi');
    for (const [url, init] of app.fetch.mock.calls as any) {
      const request = new URL(url);
      expect(request.searchParams.get('companyId')).toBe('tenant-a');
      expect(request.searchParams.get('workerId')).toBe('27');
      expect(init.headers['x-worker-auth-token']).toBe('a'.repeat(64));
      expect(init.cache).toBe('no-store');
    }
    app.setProfile({ ...profile(), net: 321 });
    await app.loadWorkerData({ silent: true });
    expect(document.getElementById('netPayAmount')!.textContent).toContain('321');
  });

  it.each([401, 403, 503])('clears old finances on automatic refresh failure %s, then recovers', async (status) => {
    const app = await boot();
    app.setStatus(status);
    await app.loadWorkerData({ silent: true });
    expect(document.getElementById('netPayAmount')!.textContent).toBe('—');
    expect(document.getElementById('workerDataStatus')!.textContent).toContain('Bot orqali qayta kiring');
    expect(app.state.submittedTickets).toHaveLength(0);
    app.setStatus(200);
    await app.loadWorkerData();
    expect(document.getElementById('netPayAmount')!.textContent).toContain('750');
  });

  it('does not turn a missing server amount into zero or display another worker', async () => {
    const app = await boot();
    app.setProfile({ ...profile(), net: undefined });
    await app.loadWorkerData();
    expect(document.getElementById('netPayAmount')!.textContent).toBe('—');
    app.setProfile({ ...profile(), worker_id: 28 });
    await app.loadWorkerData();
    expect(document.getElementById('workerNameHeader')!.textContent).toBe('—');
  });

  it('distinguishes real zero pay from unavailable payroll', async () => {
    const app = await boot();
    app.setProfile({ ...profile(), net: 0 });
    await app.loadWorkerData();
    expect(document.getElementById('netPayAmount')!.textContent).toContain('0');
    app.setProfile({ ...profile(), accountingStatus: 'UNAVAILABLE', period: null, net: 0 });
    await app.loadWorkerData();
    expect(document.getElementById('netPayAmount')!.textContent).toBe('—');
    expect(document.getElementById('netPaySubtitle')!.textContent).toContain('oylik hisoblanmagan');
  });
});
