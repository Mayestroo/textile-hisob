import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModelSizesView } from '../ModelSizesView';

const mockModels = [
  {
    id: 'm1',
    name: 'Barisha-tursik-100',
    hisobSheetName: 'Barisha-tursik-100-hisob',
    title: 'Barisha-tursik-100',
    party: '1',
    color: 'Qora',
    size: 'XL',
    operations: [],
    pattaOpsOrder: [],
    hisobQuantities: {},
  },
  {
    id: 'm-lasina',
    name: 'КИК-ФИРМА-ЛАСИНА',
    hisobSheetName: 'КИК-ФИРМА-ЛАСИНА-hisob',
    title: 'КИК-ФИРМА-ЛАСИНА',
    party: '6',
    color: 'Qora',
    size: 'S',
    operations: [],
    pattaOpsOrder: [],
    hisobQuantities: {},
  },
];

const mockConfigs = {
  m1: {
    sizeNames: ['S', 'M', 'L', 'XL', 'XXL'],
    scaleType: 'letters',
    isConfigured: true,
  },
  'm-lasina': {
    sizeNames: [],
    scaleType: 'letters',
    isConfigured: false,
  },
};

describe('ModelSizesView', () => {
  it('renders title, subtitle and action buttons', () => {
    const html = renderToStaticMarkup(<ModelSizesView models={mockModels} pattaBatchConfigs={mockConfigs} />);
    expect(html).toContain("Model o&#x27;lchamlari");
    expect(html).toContain('Har model uchun razmerlarni sozlash');
    expect(html).toContain('Boshqa modeldan nusxalash');
    expect(html).toContain('Saqlash');
  });

  it('renders left card with models and correct status badges', () => {
    const html = renderToStaticMarkup(<ModelSizesView models={mockModels} pattaBatchConfigs={mockConfigs} />);
    expect(html).toContain('Barisha-tursik-100');
    expect(html).toContain('КИК-ФИРМА-ЛАСИНА');
    expect(html).toContain('5 razmer');
    expect(html).toContain('Sozlanmagan');
  });

  it('renders right card with active model and size capsules', () => {
    const html = renderToStaticMarkup(<ModelSizesView models={mockModels} pattaBatchConfigs={mockConfigs} />);
    expect(html).toContain('Ishlab chiqariladigan razmerlar');
    expect(html).toContain('Faqat yoqilgan razmerlar buyurtma, bichuv va pattada ko&#x27;rinadi');
    expect(html).toContain("O&#x27;lcham qo&#x27;shish");
    expect(html).toContain('capsule-on');
    expect(html).toContain('capsule-off');
    expect(html).toContain('Modellar nomi haqiqiy. Razmerlar soni namuna.');
  });

  it('filters out letter sizes when scale is numeric (Raqamli)', () => {
    const numericConfigs = {
      m1: {
        sizeNames: ['52', '54', '48'],
        scaleType: 'numbers',
        isConfigured: true,
      },
    };
    const html = renderToStaticMarkup(<ModelSizesView models={mockModels} pattaBatchConfigs={numericConfigs} />);
    // Should contain numeric sizes
    expect(html).toContain('48');
    expect(html).toContain('52');
    expect(html).toContain('54');
    // Should NOT contain default letter capsules in the rendered size list when numeric scale is active
    expect(html).not.toMatch(/>\s*XXL\s*</);
  });
});
