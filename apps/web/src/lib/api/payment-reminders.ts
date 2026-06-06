// Bulk payment reminders — wraps POST /api/payment-reminders in
// apps/api/src/routes/payment-reminders.ts. Enqueues one follow-up
// notification per selected project to the requesting operator.
import { useMutation } from '@tanstack/react-query'
import { request } from './client'

export interface SendPaymentRemindersInput {
  project_ids: string[]
}

export interface SendPaymentRemindersResult {
  reminders_sent: number
}

export function useSendPaymentReminders() {
  return useMutation<SendPaymentRemindersResult, Error, SendPaymentRemindersInput>({
    mutationFn: (input) =>
      request<SendPaymentRemindersResult>('/api/payment-reminders', { method: 'POST', json: input }),
  })
}
