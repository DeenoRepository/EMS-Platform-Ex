import type { ModuleManifest } from '@ems/contracts';

export const DEMO_MODULE_ID = 'business.demo-catalog';

export const demoModuleManifest: ModuleManifest = {
  id: DEMO_MODULE_ID,
  kind: 'business-module',
  contractVersion: '1.0.0',
  displayName: 'Демо-каталог производства',
  permissions: [
    {
      id: 'demo-catalog.view',
      displayName: 'Просмотр демо-каталога',
      description: 'Доступ к статическому каталогу образцов продукции',
    },
  ],
  uiContributions: [
    {
      id: 'nav.demo-catalog',
      targetSlot: 'sidebar',
      label: 'Демо-каталог',
      path: '/demo-catalog',
      requiredPermission: 'demo-catalog.view',
    },
  ],
};

export interface CatalogItem {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly category: string;
  readonly standard: string;
}

export const STATIC_CATALOG_ITEMS: readonly CatalogItem[] = [
  {
    id: 'cat-001',
    code: 'VALVE-DN50-PN16',
    name: 'Клапан запорный фланцевый DN50 PN16',
    category: 'Трубопроводная арматура',
    standard: 'ГОСТ 5762-2002',
  },
  {
    id: 'cat-002',
    code: 'PUMP-CENT-100',
    name: 'Насос центробежный консольный 100 м³/ч',
    category: 'Насосное оборудование',
    standard: 'ГОСТ 31839-2012',
  },
  {
    id: 'cat-003',
    code: 'SENSOR-PT100-EX',
    name: 'Термопреобразователь сопротивления Pt100',
    category: 'КИПиА',
    standard: 'ГОСТ 6651-2009',
  },
];
