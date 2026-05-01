import { Route, Routes } from 'react-router-dom'
import {
  BillingRunDetailScreen,
  BillingRunListScreen,
  EstimatePushDetailScreen,
  EstimatePushListScreen,
  FinancialHubScreen,
} from '@/screens/financial'

export default function FinancialRoute() {
  return (
    <Routes>
      <Route index element={<FinancialHubScreen />} />
      <Route path="estimate-pushes" element={<EstimatePushListScreen />} />
      <Route path="estimate-pushes/:id" element={<EstimatePushDetailScreen />} />
      <Route path="billing-runs" element={<BillingRunListScreen />} />
      <Route path="billing-runs/:id" element={<BillingRunDetailScreen />} />
    </Routes>
  )
}
