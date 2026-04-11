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
  const [editId, setEditId] = useState(null)
  const [editName, setEditName] = useState('')
  const [editRole, setEditRole] = useState('')
  const [showInactive, setShowInactive] = useState(false)

  useEffect(() => {
    loadWorkers()
  }, [companyId])

  async function loadWorkers() {
    setLoading(true)
    const { data: rows, error: listErr } = await workers.listAll(companyId)
    if (listErr) setError(listErr.message)
    else setWorkerList(rows || [])
    setLoading(false)
  }

  async function addWorker(e) {
    e.preventDefault()
    if (!newName.trim()) return
    setSaving(true)
    setError(null)
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

  function startEdit(w) {
    setEditId(w.id)
    setEditName(w.name)
    setEditRole(w.role || '')
  }

  async function saveEdit() {
    if (!editName.trim()) return
    setSaving(true)
    setError(null)
    const { error: updateErr } = await workers.update(editId, {
      name: editName.trim(),
      role: editRole.trim() || null,
    })
    if (updateErr) setError(updateErr.message)
    else {
      setEditId(null)
      await loadWorkers()
    }
    setSaving(false)
  }

  async function deleteWorker(id) {
    setSaving(true)
    setError(null)
    const { error: delErr } = await workers.delete(id)
    if (delErr) setError(delErr.message)
    else await loadWorkers()
    setSaving(false)
  }

  const activeWorkers = workerList.filter(w => w.is_active)
  const inactiveWorkers = workerList.filter(w => !w.is_active)
  const displayList = showInactive ? workerList : activeWorkers

  if (loading) return (
    <div style={{ padding: 40, textAlign: 'center' }}>
      <Spinner />
    </div>
  )

  return (
    <div style={{ padding: '24px 20px', maxWidth: 600 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 20, color: TH.text }}>Crew Roster</h2>
      <p style={{ margin: '0 0 20px', fontSize: 13, color: TH.muted }}>
        Manage your crew here. Workers you add will be available to assign in the Schedule tab.
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

      {/* Filter toggle */}
      {inactiveWorkers.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: TH.muted }}>
            {activeWorkers.length} active{inactiveWorkers.length > 0 && `, ${inactiveWorkers.length} inactive`}
          </div>
          <button
            onClick={() => setShowInactive(v => !v)}
            style={{ fontSize: 12, color: TH.muted, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
          >
            {showInactive ? 'Hide inactive' : 'Show inactive'}
          </button>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {displayList.length === 0 ? (
          <Card style={{ textAlign: 'center', padding: 32, color: TH.muted }}>
            {workerList.length === 0
              ? 'No workers yet. Add your first crew member above.'
              : 'No active workers. Toggle "Show inactive" to see all.'}
          </Card>
        ) : (
          displayList.map(w => (
            <Card key={w.id} style={{ padding: '12px 16px', opacity: w.is_active ? 1 : 0.6 }}>
              {editId === w.id ? (
                /* Edit mode */
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto auto', gap: 10, alignItems: 'end' }}>
                  <Input
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    placeholder="Name"
                  />
                  <Input
                    value={editRole}
                    onChange={e => setEditRole(e.target.value)}
                    placeholder="Role"
                  />
                  <Btn onClick={saveEdit} disabled={saving || !editName.trim()} style={{ fontSize: 12, padding: '8px 12px' }}>
                    Save
                  </Btn>
                  <Btn variant="ghost" onClick={() => setEditId(null)} style={{ fontSize: 12, padding: '8px 12px' }}>
                    Cancel
                  </Btn>
                </div>
              ) : (
                /* Display mode */
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 600, color: TH.text }}>{w.name}</div>
                    {w.role && <div style={{ fontSize: 12, color: TH.muted }}>{w.role}</div>}
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <button
                      onClick={() => startEdit(w)}
                      style={{
                        fontSize: 11, padding: '5px 10px', borderRadius: 4,
                        border: 'none', cursor: 'pointer',
                        background: 'transparent', color: TH.muted,
                      }}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => toggleActive(w.id, w.is_active)}
                      style={{
                        fontSize: 11, padding: '5px 10px', borderRadius: 4,
                        border: 'none', cursor: 'pointer',
                        background: w.is_active ? TH.green + '22' : TH.faint,
                        color: w.is_active ? TH.green : TH.muted,
                      }}
                    >
                      {w.is_active ? 'Active' : 'Inactive'}
                    </button>
                    {!w.is_active && (
                      <button
                        onClick={() => deleteWorker(w.id)}
                        style={{
                          fontSize: 11, padding: '5px 10px', borderRadius: 4,
                          border: 'none', cursor: 'pointer',
                          background: TH.red + '18', color: TH.red,
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              )}
            </Card>
          ))
        )}
      </div>
    </div>
  )
}
