import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const directory = path.join(__dirname, '..', '..', '..', '..', 'webapps', 'admin');
const html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
const javascript = fs.readFileSync(path.join(directory, 'scripts', 'admin.js'), 'utf8');
const css = `${fs.readFileSync(path.join(directory, 'styles', 'admin.css'), 'utf8')}\n${fs.readFileSync(path.join(directory, 'styles', 'company-admin.css'), 'utf8')}`;

describe('company admin WebApp security and usability', () => {
  it('contains company workflows and no retired superadmin console', () => {
    for (const id of ['companyAdminApp', 'companyPeriodSelect', 'companyWorkers', 'companyParties', 'companyOperations', 'companyWorkerTickets', 'companyPicker']) {
      expect(html).toContain(`id="${id}"`);
    }
    for (const tab of ['home', 'workers', 'parties', 'settings']) expect(html).toContain(`data-co-tab="${tab}"`);
    expect(html).not.toContain('id="adminApp"');
    expect(html).not.toContain('id="activationForm"');
    expect(javascript).not.toContain('submitActivationAction');
    expect(javascript).not.toContain('/admins/${encodeURIComponent(telegramId)}');
  });

  it('uses verified Telegram sessions, company selection and isolated financial intents', () => {
    expect(javascript).toContain('telegram.initData');
    expect(javascript).toContain("const API = '/api/admin/webapp'");
    expect(javascript).toContain("credentials: 'same-origin'");
    expect(javascript).not.toMatch(/initDataUnsafe/i);
    expect(javascript).toContain('openAdminCompany(state.access.companyIds[0])');
    expect(javascript).toContain('else await showCompanyPicker()');
    expect(javascript).toContain('companyPanel.companyId !== companyId');
    expect(javascript).toContain('NovdaFinancialIntent.create(window.localStorage, navigator.locks)');
    expect(javascript).toContain("financialScope(companyPanel.companyId, 'company-advance')");
    expect(javascript).toContain('hisob.company.worker-filter.v1:');
    expect(javascript).not.toMatch(/sessionStorage\.(?:setItem|getItem)\(['"](?:session|token|auth)/i);
    expect(html).toContain('<script src="/admin-app/financial-intent.js" defer></script>');
  });

  it('contains no secrets, direct database clients, unsafe HTML injection, or dynamic code', () => {
    expect(`${html}\n${javascript}\n${css}`).not.toMatch(/firebaseio|firebasedatabase|BOT_TOKEN|NOVDA_ADMIN_API_TOKEN|ED25519_PRIVATE_KEY/i);
    expect(javascript).not.toMatch(/\.innerHTML\s*=|\beval\s*\(|new Function\s*\(/i);
    expect(html).toContain('https://telegram.org/js/telegram-web-app.js');
  });

  it('supports mobile screens and accessible feedback', () => {
    expect(css).toContain('@media (max-width: 820px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain(':focus-visible');
    expect(html).toContain('aria-live="polite"');
    expect(css).toContain('.co-bottom-nav');
  });
});
