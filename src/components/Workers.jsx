import { useState, useEffect } from 'react'
import { TH } from '../lib/theme'
import { Card, Label, Input, Btn, Spinner } from './Atoms'
import { workers } from '../lib/db'

export function Workers({ companyId }) {
  const [workerList, setWorkerList] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState('')
  const [error, setError] = useState(null)

  useEffect(() => {
    loadWorkers()
  }, [companyId])

  async function loadWorkers() {
    setLoading(true)
    const { data: rows, error: listErr } = await workers.list(companyId)
    if (listErr) setError(listErr.message)
    else setWorkerList(rows || [])
    setLoading(false)
  }

  async function addWorker(e) {
    e.preventDefault()
    if (!newName.trim()) return
    setSaving(true)
    const { error: createErr } = await workers.create({
      company_id: companyId,
      name: newName.trim(),
      role: newRole.trim() || null,
      is_active: true,
    })
    if (createErr) setError(createErr.message)
    else {
      setNewName('')
      setNewRole('')
      await loadWorkers()
    }
    setSaving(false)
  }

  async function toggleActive(id, current) {
    await workers.update(id, { is_active: !current })
    await loadWorkers()
  }

  if (loading) return (
    <div style={{ padding: 40, textAlign: 'center' }}>
      <Spinner />
    </div>
  )

  return (
    <div style={{ padding: '24px 20px', maxWidth: 600 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 20, color: TH.text }}>Crew Roster</h2>
      <p style={{ margin: '0 0 20px', fontSize: 13, color: TH.muted }}>
        Add workers here, then assign them to projects in the Schedule tab.
      </p>

      {error && (
        <div style={{ padding: 12, background: '#ef444422', borderRadius: 6, color: TH.red, fontSize: 13, marginBottom: 16 }}>
          {error}
        </div>
      )}

      <Card style={{ marginBottom: 20 }}>
        <form onSubmit={addWorker}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 12, alignItems: 'end' }}>
            <Input label="Name" value={newName} onChange={e => setNewName(e.target.value)} placeholder="Mike Smith" />
            <Input label="Role (optional)" value={newRole} onChange={e => setNewRole(e.target.value)} placeholder="Foreman" />
            <Btn type="submit" disabled={saving || !newName.trim()}>
              {saving ? 'Adding…' : 'Add Worker'}
            </Btn>
          </div>
        </form>
      </Card>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {workerList.length === 0 ? (
          <Card style={{ textAlign: 'center', padding: 32, color: TH.muted }}>
            No workers yet. Add your first crew member above.
          </Card>
        ) : (
          workerList.map(w => (
            <Card key={w.id} style={{ padding: '12px 16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 600, color: TH.text }}>{w.name}</div>
                  {w.role && <div style={{ fontSize: 12, color: TH.muted }}>{w.role}</div>}
                </div>
                <button
                  onClick={() => toggleActive(w.id, w.is_active)}
                  style={{
                    fontSize: 12,
                    padding: '6px 12px',
                    borderRadius: 4,
                    border: 'none',
                    cursor: 'pointer',
                    background: w.is_active ? TH.green + '22' : TH.faint,
                    color: w.is_active ? TH.green : TH.muted,
                  }}
                >
                  {w.is_active ? 'Active' : 'Inactive'}
                </button>
              </div>
            </Card>
          ))
        )}
      </div>
    </div>
  )
}
