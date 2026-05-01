import { Route, Routes } from 'react-router-dom'
import {
  AuditLogScreen,
  BonusSimulatorScreen,
  CatalogBonusRulesScreen,
  CatalogCustomersScreen,
  CatalogDivisionsScreen,
  CatalogHubScreen,
  CatalogPricingProfilesScreen,
  CatalogServiceItemsScreen,
  CatalogWorkersScreen,
  SettingsScreen,
} from '@/screens/settings'
import { IntegrationsHubScreen, QboConnectionScreen, QboMappingsScreen } from '@/screens/integrations'
import {
  InventoryAdminHubScreen,
  InventoryItemsAdminScreen,
  InventoryLocationsAdminScreen,
  InventoryMovementsAdminScreen,
} from '@/screens/inventory-admin'

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
      <Route path="integrations" element={<IntegrationsHubScreen />} />
      <Route path="integrations/qbo" element={<QboConnectionScreen />} />
      <Route path="integrations/qbo/mappings" element={<QboMappingsScreen />} />
      <Route path="inventory" element={<InventoryAdminHubScreen />} />
      <Route path="inventory/items" element={<InventoryItemsAdminScreen />} />
      <Route path="inventory/locations" element={<InventoryLocationsAdminScreen />} />
      <Route path="inventory/movements" element={<InventoryMovementsAdminScreen />} />
      <Route path="bonus-sim" element={<BonusSimulatorScreen />} />
      <Route path="audit" element={<AuditLogScreen />} />
    </Routes>
  )
}
