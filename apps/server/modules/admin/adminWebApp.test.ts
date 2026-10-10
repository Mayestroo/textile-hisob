import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const webAppDirectory = path.join(__dirname, '..', '..', 'static', 'admin-webapp');
const html = fs.readFileSync(path.join(webAppDirectory, 'index.html'), 'utf8');
const javascript = fs.readFileSync(path.join(webAppDirectory, 'admin.js'), 'utf8');
const css = fs.readFileSync(path.join(webAppDirectory, 'admin.css'), 'utf8');

describe(' Admin WebApp static security and usability boundaries', () => {
  it('contains the full supported admin navigation and explicit retired legacy state', () => {
    for (const view of ['overview', 'devices', 'companies', 'workers', 'activations', 'admin']) {
      expect(html).toContain(`data-view="${view}"`);
      expect(html).toContain(`data-section="${view}"`);
    }
    expect(html).toContain('UNSUPPORTED CONTROLS RETIRED');
    expect(html).toContain('PostgreSQL authoritative');
    for (const view of ['bindings', 'models', 'parties', 'tickets', 'balances', 'system']) {
      expect(html).toContain(`data-view="${view}"`);
      expect(html).toContain(`data-section="${view}"`);
    }
  });

  it('authenticates from Telegram initData only and calls same-origin  routes', () => {
    expect(javascript).toContain('telegram.initData');
    expect(javascript).toContain("const API = '/api/admin/webapp'");
    expect(javascript).toContain("credentials: 'same-origin'");
    expect(javascript).not.toMatch(/initDataUnsafe/i);
    expect(javascript).not.toMatch(/localStorage|sessionStorage/i);
  });

  it('hides global-only views for company-scoped admins and carries server access scope', () => {
    expect(javascript).toContain("['overview', 'devices', 'activations', 'system'].includes(button.dataset.view)");
    expect(javascript).toContain('state.access = session.access || state.access');
    expect(javascript).toContain('if (state.access?.isGlobalAdmin === false');
  });

  it('labels activation policy separately and does not expose bot-managed ticket mode', () => {
    const policyForm = html.match(/<form id="companyForm"[\s\S]*?<\/form>/)?.[0] || '';
    expect(html).toContain('Activation policy');
    expect(html).toContain('activation-policy');
    expect(html).toContain('id="companyPolicySelect"');
    expect(policyForm).toMatch(/<select[^>]*name="companyId"[^>]*id="companyPolicySelect"/);
    expect(policyForm).not.toMatch(/<input[^>]*name="companyId"/);
    expect(javascript).not.toContain('elements.requireTicketValidation');
    expect(javascript).toContain('businessScopeExists');
    expect(policyForm).toContain('name="isActive"');
    expect(html).not.toContain('strictModeToggle');
    expect(html).not.toContain('strictModeReapply');
    expect(javascript).not.toContain('changeStrictMode');
    expect(javascript).not.toContain('reapplyStrictModeToDevices');
  });

  it('contains no direct legacy database clients, secrets, unsafe DOM injection, or dynamic code', () => {
    const source = `${html}\n${javascript}\n${css}`;
    expect(source).not.toMatch(/firebaseio|firebasedatabase/i);
    expect(source).not.toMatch(/BOT_TOKEN|NOVDA_ADMIN_API_TOKEN|ED25519_PRIVATE_KEY/i);
    expect(javascript).not.toMatch(/\.innerHTML\s*=|\beval\s*\(|new Function\s*\(/i);
    expect(html).toContain('https://telegram.org/js/telegram-web-app.js');
  });

  it('supports narrow Telegram screens, keyboard focus, and reduced-motion preferences', () => {
    expect(css).toContain('@media (max-width: 820px)');
    expect(css).toContain('@media (max-width: 560px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain(':focus-visible');
  });

  it('provides real server-paginated worker and binding lists and empty ticket state', () => {
    expect(javascript).toContain("limit: 50");
    expect(javascript).toContain('boundOnly: true');
    expect(html).toContain('Hali ticket qayd etilmagan');
    expect(html).toContain('PATTA JAMLANMASI');
    expect(html).toContain('tarixiy tranzaksiya sifatida ko‘rsatilmaydi');
    expect(html).toContain('activation policy');
  });

  it('shows loading/error feedback and guards sensitive actions against repeat submits', () => {
    expect(javascript).toContain("setNotice('Ma’lumot yuklanmoqda…', 'loading')");
    expect(javascript).toContain("setNotice(`Ma’lumot olinmadi:");
    expect(javascript).toContain('if (state.activationSubmitting) return');
    expect(javascript).toContain('window.confirm(confirmation)');
    expect(html).toContain('aria-live="polite"');
  });
});
