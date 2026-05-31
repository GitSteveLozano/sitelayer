import { Route, Routes, useNavigate } from 'react-router-dom'
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
  CustomRoleScreen,
  DispatchLanesAdminScreen,
  HelpScreen,
  LoadedLaborScreen,
  NotificationsQueueScreen,
  PricingBookScreen,
  ProfileScreen,
  RolesScreen,
  SettingsScreen,
  WorkingHoursScreen,
} from '@/screens/settings'
import {
  IntegrationsHubScreen,
  QboConnectionScreen,
  QboCustomFieldsScreen,
  QboMappingsScreen,
} from '@/screens/integrations'
import {
  BranchesAdminScreen,
  DamageChargesAdminScreen,
  InventoryAdminHubScreen,
  InventoryItemsAdminScreen,
  InventoryLocationsAdminScreen,
  InventoryMovementsAdminScreen,
  ScaffoldCatalogAdminScreen,
} from '@/screens/inventory-admin'

export default function MoreRoute() {
  const navigate = useNavigate()
  return (
    <Routes>
      <Route index element={<SettingsScreen />} />
      {/* M12 mobile settings sub-screens — full-screen detail pages reached
          from the settings hub, each with its own back-chevron top bar. */}
      <Route path="pricing-book" element={<PricingBookScreen navigate={navigate} />} />
      <Route path="loaded-labor" element={<LoadedLaborScreen navigate={navigate} />} />
      <Route path="working-hours" element={<WorkingHoursScreen navigate={navigate} />} />
      <Route path="roles" element={<RolesScreen navigate={navigate} />} />
      <Route path="roles/custom" element={<CustomRoleScreen navigate={navigate} />} />
      <Route path="profile" element={<ProfileScreen navigate={navigate} />} />
      <Route path="help" element={<HelpScreen navigate={navigate} />} />
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
      <Route path="integrations/qbo/custom-fields" element={<QboCustomFieldsScreen />} />
      <Route path="inventory" element={<InventoryAdminHubScreen />} />
      <Route path="inventory/items" element={<InventoryItemsAdminScreen />} />
      <Route path="inventory/locations" element={<InventoryLocationsAdminScreen />} />
      <Route path="inventory/movements" element={<InventoryMovementsAdminScreen />} />
      <Route path="inventory/branches" element={<BranchesAdminScreen />} />
      <Route path="inventory/scaffold-catalog" element={<ScaffoldCatalogAdminScreen />} />
      <Route path="inventory/damage-charges" element={<DamageChargesAdminScreen />} />
      <Route path="bonus-sim" element={<BonusSimulatorScreen />} />
      <Route path="audit" element={<AuditLogScreen />} />
      <Route path="dispatch-lanes" element={<DispatchLanesAdminScreen />} />
      <Route path="notifications-queue" element={<NotificationsQueueScreen />} />
    </Routes>
  )
}
