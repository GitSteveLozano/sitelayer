import { Route, Routes } from 'react-router-dom'
import {
  RentalLifecycleDetailScreen,
  RentalRequestsQueueScreen,
  RentalsItemDetailScreen,
  RentalsListScreen,
  RentalsScanScreen,
  RentalsUtilizationScreen,
} from '@/screens/rentals'

export default function RentalsRoute() {
  return (
    <Routes>
      <Route index element={<RentalsListScreen />} />
      <Route path="scan" element={<RentalsScanScreen />} />
      <Route path="utilization" element={<RentalsUtilizationScreen />} />
      <Route path="requests" element={<RentalRequestsQueueScreen />} />
      <Route path="items/:id" element={<RentalsItemDetailScreen />} />
      <Route path="lifecycle/:id" element={<RentalLifecycleDetailScreen />} />
    </Routes>
  )
}
