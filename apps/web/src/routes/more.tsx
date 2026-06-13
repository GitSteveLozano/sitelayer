import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { AuditLogScreen } from '@/screens/settings/audit-log'
import { BonusSimulatorScreen } from '@/screens/settings/bonus-sim'
import { CatalogBonusRulesScreen } from '@/screens/settings/catalog-bonus-rules'
import { CatalogCustomersScreen } from '@/screens/settings/catalog-customers'
import { CatalogDivisionsScreen } from '@/screens/settings/catalog-divisions'
import { CatalogHubScreen } from '@/screens/settings/catalog-hub'
import { CatalogPricingProfilesScreen } from '@/screens/settings/catalog-pricing-profiles'
import { CatalogServiceItemsScreen } from '@/screens/settings/catalog-service-items'
import { CatalogWorkersScreen } from '@/screens/settings/catalog-workers'
import { DispatchLanesAdminScreen } from '@/screens/settings/dispatch-lanes'
import { NotificationsQueueScreen } from '@/screens/settings/notifications-queue'
import {
  CustomRoleScreen,
  HelpScreen,
  LoadedLaborScreen,
  MemberCapabilitiesScreen,
  PricingBookScreen,
  ProfileScreen,
  RolesScreen,
  WorkingHoursScreen,
} from '@/screens/settings/owner-settings-mobile'
import { QboConnectionScreen, QboCustomFieldsScreen, QboMappingsScreen } from '@/screens/integrations'
import {
  BranchesAdminScreen,
  DamageChargesAdminScreen,
  InventoryAdminHubScreen,
  InventoryItemsAdminScreen,
  InventoryLocationsAdminScreen,
  InventoryMovementsAdminScreen,
  ScaffoldCatalogAdminScreen,
} from '@/screens/inventory-admin'

/**
 * `/more/*` — the settings DETAIL sub-screens (pricing book, catalog,
 * inventory admin, QBO, …), each a full-screen page with its own back
 * chevron. The HUB itself is the designed settings home mounted at
 * `/settings/*` (audit M12); the legacy "Everything else" hub
 * (`screens/settings/index.tsx`) and the QBO-only integrations hub
 * (`screens/integrations/hub.tsx`) were retired, so the bare `/more` and
 * `/more/integrations` paths forward to the designed hub.
 */
export default function MoreRoute() {
  const navigate = useNavigate()
  return (
    <Routes>
      <Route index element={<Navigate to="/settings" replace />} />
      {/* M12 mobile settings sub-screens — full-screen detail pages reached
          from the settings hub, each with its own back-chevron top bar. */}
      <Route path="pricing-book" element={<PricingBookScreen navigate={navigate} />} />
      <Route path="loaded-labor" element={<LoadedLaborScreen navigate={navigate} />} />
      <Route path="working-hours" element={<WorkingHoursScreen navigate={navigate} />} />
      <Route path="roles" element={<RolesScreen navigate={navigate} />} />
      <Route path="roles/custom" element={<CustomRoleScreen navigate={navigate} />} />
      <Route path="roles/capabilities" element={<MemberCapabilitiesScreen navigate={navigate} />} />
      <Route path="profile" element={<ProfileScreen navigate={navigate} />} />
      <Route path="help" element={<HelpScreen navigate={navigate} />} />
      <Route path="catalog" element={<CatalogHubScreen />} />
      <Route path="catalog/customers" element={<CatalogCustomersScreen />} />
      <Route path="catalog/workers" element={<CatalogWorkersScreen />} />
      <Route path="catalog/service-items" element={<CatalogServiceItemsScreen />} />
      <Route path="catalog/pricing-profiles" element={<CatalogPricingProfilesScreen />} />
      <Route path="catalog/bonus-rules" element={<CatalogBonusRulesScreen />} />
      <Route path="catalog/divisions" element={<CatalogDivisionsScreen />} />
      {/* The five-connector integrations surface lives in the designed
          settings hub; the legacy QBO-only hub is gone. */}
      <Route path="integrations" element={<Navigate to="/settings" replace />} />
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
