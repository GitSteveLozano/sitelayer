import { useState } from 'react'
import { LifeBuoy } from 'lucide-react'
import { createSupportPacket } from '../api.js'
import { recordSupportEvent } from '../support-recorder.js'
import { Button } from './ui/button.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog.js'
import { Input } from './ui/input.js'
import { Textarea } from './ui/textarea.js'
import { toastError, toastSuccess } from './ui/toast.js'

type Props = {
  companySlug: string
}

export function SupportReportButton({ companySlug }: Props) {
  const [open, setOpen] = useState(false)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const [supportId, setSupportId] = useState<string | null>(null)

  async function submit() {
    if (!problem.trim()) {
      toastError('Problem required', 'Add a short description before creating a support packet.')
      return
    }
    setBusy(true)
    setSupportId(null)
    recordSupportEvent({ category: 'support', name: 'support_packet.submitted' })
    try {
      const result = await createSupportPacket(problem, companySlug)
      setSupportId(result.support_id)
      toastSuccess('Support packet created', `ID ${result.support_id}`)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'unknown error'
      toastError('Support packet failed', message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Create support packet"
          title="Create support packet"
        >
          <LifeBuoy aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Report a Problem</DialogTitle>
          <DialogDescription>
            Send the recent app timeline, API request IDs, and current screen state to support.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Textarea
            aria-label="Problem description"
            placeholder="What happened?"
            value={problem}
            onChange={(event) => setProblem(event.target.value)}
          />
          {supportId ? <Input aria-label="Support packet ID" readOnly value={supportId} /> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Creating...' : 'Create Packet'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
