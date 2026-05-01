import { Route, Routes } from 'react-router-dom'
import {
  CatalogBonusRulesScreen,
  CatalogCustomersScreen,
  CatalogDivisionsScreen,
  CatalogHubScreen,
  CatalogPricingProfilesScreen,
  CatalogServiceItemsScreen,
  CatalogWorkersScreen,
  SettingsScreen,
} from '@/screens/settings'

/**
 * More tab. The home is the existing Settings hub (push, notifications,
 * persona override). Phase 6 Batch 2 nests the Catalog hub + 6 reference-
 * data screens under /more/catalog/*.
 */
export default function MoreRoute() {
  return (
    <Routes>
      <Route index element={<SettingsScreen />} />
      <Route path="catalog" element={<CatalogHubScreen />} />
      <Route path="catalog/customers" element={<CatalogCustomersScreen />} />
      <Route path="catalog/workers" element={<CatalogWorkersScreen />} />
      <Route path="catalog/service-items" element={<CatalogServiceItemsScreen />} />
      <Route path="catalog/pricing-profiles" element={<CatalogPricingProfilesScreen />} />
      <Route path="catalog/bonus-rules" element={<CatalogBonusRulesScreen />} />
      <Route path="catalog/divisions" element={<CatalogDivisionsScreen />} />
    </Routes>
  )
}
