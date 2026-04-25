import { onCLS, onINP, onLCP, onFCP, onTTFB, type Metric } from 'web-vitals'
import { Sentry } from './instrument.js'

function report(metric: Metric) {
  Sentry.setMeasurement(metric.name, metric.value, metric.name === 'CLS' ? 'none' : 'millisecond')
  Sentry.addBreadcrumb({
    category: 'web-vitals',
    type: 'info',
    level: 'info',
    message: metric.name,
    data: { value: metric.value, rating: metric.rating, id: metric.id },
  })
}

export function captureWebVitals(): void {
  onCLS(report)
  onINP(report)
  onLCP(report)
  onFCP(report)
  onTTFB(report)
}
