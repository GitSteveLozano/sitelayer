import { useEffect } from 'react'
import { createRoutesFromChildren, matchRoutes, useLocation, useNavigationType } from 'react-router-dom'

type SentryModule = typeof import('@sentry/react')
type StartSpanOptions = Parameters<SentryModule['startSpan']>[0]
type SpanLike = { setAttribute: (name: string, value: boolean | number | string) => void }

const dsn = import.meta.env.VITE_SENTRY_DSN
const tier = import.meta.env.VITE_APP_TIER ?? 'local'
const defaultTraceRate = tier === 'prod' ? 0.1 : 1.0

let sentryModule: SentryModule | null = null
let sentryLoad: Promise<SentryModule | null> | null = null

async function loadSentry(): Promise<SentryModule | null> {
  if (!dsn) return null
  if (sentryModule) return sentryModule
  sentryLoad ??= import('@sentry/react')
    .then((mod) => {
      if (sentryModule) return sentryModule

      const apiUrl = import.meta.env.VITE_API_URL
      const propagationTargets: Array<string | RegExp> = [/^\//]
      if (typeof apiUrl === 'string' && apiUrl) {
        propagationTargets.push(apiUrl)
      }

      mod.init({
        dsn,
        environment:
          import.meta.env.VITE_SENTRY_ENVIRONMENT ??
          import.meta.env.VITE_APP_TIER ??
          import.meta.env.MODE ??
          'development',
        release: import.meta.env.VITE_SENTRY_RELEASE,
        tracesSampleRate: Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ?? defaultTraceRate),
        tracePropagationTargets: propagationTargets,
        integrations: [
          mod.reactRouterV7BrowserTracingIntegration({
            useEffect,
            useLocation,
            useNavigationType,
            createRoutesFromChildren,
            matchRoutes,
          }),
          mod.replayIntegration({
            maskAllText: true,
            maskAllInputs: true,
            blockAllMedia: true,
          }),
        ],
        replaysSessionSampleRate: Number(import.meta.env.VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE ?? 0.1),
        replaysOnErrorSampleRate: Number(import.meta.env.VITE_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE ?? 1.0),
      })
      sentryModule = mod
      return mod
    })
    .catch((error: unknown) => {
      console.warn('[sentry] failed to load browser SDK', error)
      return null
    })
  return sentryLoad
}

export function initSentry() {
  void loadSentry()
}

export function captureException(error: unknown, context?: Record<string, unknown>) {
  void loadSentry().then((mod) => {
    mod?.captureException(error, context)
  })
}

export function addBreadcrumb(breadcrumb: Record<string, unknown>) {
  void loadSentry().then((mod) => {
    mod?.addBreadcrumb(breadcrumb)
  })
}

export function setMeasurement(name: string, value: number, unit: string) {
  void loadSentry().then((mod) => {
    mod?.setMeasurement(name, value, unit)
  })
}

export function startSpan<T>(options: StartSpanOptions, callback: (span: SpanLike | undefined) => T): T {
  if (!sentryModule) return callback(undefined)
  return sentryModule.startSpan(options, callback)
}

export const Sentry = {
  addBreadcrumb,
  captureException,
  setMeasurement,
  startSpan,
}
