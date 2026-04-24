import { apiDelete, apiPatch, apiPost, startQboOAuth } from '../api.js'
import type {
  BootstrapResponse,
  IntegrationMappingRow,
  OfflineMutation,
  ProjectRow,
  QboConnectionResponse,
  SyncStatusResponse,
} from '../api.js'
import { IntegrationMappingEditor, MutationOutboxWidget, OfflineQueueWidget } from '../components/operations.js'
import { FormRow } from '../components/forms.js'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { Select } from '../components/ui/select.js'
import type { RunAction } from './types.js'

type IntegrationsViewProps = {
  companySlug: string
  busy: string | null
  qboConnection: QboConnectionResponse['connection']
  syncStatus: SyncStatusResponse | null
  integrationMappings: IntegrationMappingRow[]
  suggestedCustomerMappings: BootstrapResponse['customers']
  suggestedServiceItemMappings: BootstrapResponse['serviceItems']
  suggestedDivisionMappings: BootstrapResponse['divisions']
  suggestedProjectMappings: ProjectRow[]
  selectedProjectId: string
  offlineQueue: OfflineMutation[]
  syncRefreshKey: number
  refresh: () => Promise<void>
  refreshSummary: (projectId: string) => Promise<void>
  runAction: RunAction
}

export function IntegrationsView({
  companySlug,
  busy,
  qboConnection,
  syncStatus,
  integrationMappings,
  suggestedCustomerMappings,
  suggestedServiceItemMappings,
  suggestedDivisionMappings,
  suggestedProjectMappings,
  selectedProjectId,
  offlineQueue,
  syncRefreshKey,
  refresh,
  refreshSummary,
  runAction,
}: IntegrationsViewProps) {
  return (
    <section className="panel">
      <h2>Integration Stance</h2>
      <p>
        QBO, time tools, takeoff tools, and file systems stay behind adapters. The seeded workflow can be proven with
        fake data or direct database-backed flows before any external connector is added.
      </p>
      <div className="integrationGrid">
        <div className="integrationCard">
          <h3>QBO Connection</h3>
          <dl className="kv compactKv">
            <div>
              <dt>Provider</dt>
              <dd>{qboConnection?.provider ?? 'qbo'}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{qboConnection?.status ?? 'disconnected'}</dd>
            </div>
            <div>
              <dt>Account</dt>
              <dd>{qboConnection?.provider_account_id ?? 'not linked'}</dd>
            </div>
            <div>
              <dt>Last sync</dt>
              <dd>
                {qboConnection?.last_synced_at ? new Date(qboConnection.last_synced_at).toLocaleString() : 'never'}
              </dd>
            </div>
          </dl>
          <FormRow
            actionLabel="Seed / update QBO"
            busy={busy === 'qbo-connection'}
            onSubmit={(form) =>
              runAction('qbo-connection', async () => {
                await apiPost(
                  '/api/integrations/qbo',
                  {
                    provider_account_id: String(form.get('provider_account_id') ?? '').trim() || null,
                    sync_cursor: String(form.get('sync_cursor') ?? '').trim() || null,
                    status: String(form.get('status') ?? 'connected').trim() || 'connected',
                    expected_version: Number(form.get('expected_version') ?? 0) || undefined,
                  },
                  companySlug,
                )
              })
            }
          >
            <Input name="expected_version" type="hidden" defaultValue={qboConnection?.version ?? 1} />
            <Input
              name="provider_account_id"
              defaultValue={qboConnection?.provider_account_id ?? ''}
              placeholder="QBO realm / account id"
            />
            <Input name="sync_cursor" defaultValue={qboConnection?.sync_cursor ?? ''} placeholder="Sync cursor" />
            <Input name="status" defaultValue={qboConnection?.status ?? 'connected'} placeholder="Status" />
          </FormRow>
          <div className="actions">
            <Button
              type="button"
              disabled={busy === 'qbo-oauth'}
              onClick={() =>
                runAction(
                  'qbo-oauth',
                  async () => {
                    await startQboOAuth(companySlug)
                  },
                  { skipRefresh: true },
                )
              }
            >
              Connect with Intuit OAuth
            </Button>
            <Button
              type="button"
              onClick={() =>
                runAction('qbo-sync', async () => {
                  await apiPost(
                    '/api/integrations/qbo/sync',
                    { provider_account_id: qboConnection?.provider_account_id ?? null },
                    companySlug,
                  )
                  await refresh()
                })
              }
            >
              Sync QBO snapshot
            </Button>
          </div>
        </div>

        <div className="integrationCard">
          <h3>Queue Health</h3>
          <dl className="kv compactKv">
            <div>
              <dt>Pending outbox</dt>
              <dd>{syncStatus?.pendingOutboxCount ?? '0'}</dd>
            </div>
            <div>
              <dt>Pending sync events</dt>
              <dd>{syncStatus?.pendingSyncEventCount ?? '0'}</dd>
            </div>
            <div>
              <dt>Latest event</dt>
              <dd>
                {syncStatus?.latestSyncEvent
                  ? `${syncStatus.latestSyncEvent.entity_type}:${syncStatus.latestSyncEvent.entity_id}`
                  : 'none'}
              </dd>
            </div>
            <div>
              <dt>Connections</dt>
              <dd>{syncStatus?.connections.length ?? 0}</dd>
            </div>
          </dl>
          <div className="actions">
            <Button
              type="button"
              onClick={() =>
                runAction('queue-process', async () => {
                  await apiPost('/api/sync/process', { limit: 25 }, companySlug)
                  await refresh()
                })
              }
            >
              Process queue
            </Button>
          </div>
        </div>

        <div className="integrationCard">
          <h3>QBO Mappings</h3>
          <p className="muted">Explicit local-to-QBO mappings for customers, service items, divisions, and projects.</p>
          <div className="summaryGrid compact">
            <div>
              <dt>Mapped customers</dt>
              <dd>
                {
                  integrationMappings.filter(
                    (mapping) => mapping.entity_type === 'customer' && mapping.deleted_at === null,
                  ).length
                }
              </dd>
            </div>
            <div>
              <dt>Suggested customers</dt>
              <dd>{suggestedCustomerMappings.length}</dd>
            </div>
            <div>
              <dt>Total mappings</dt>
              <dd>{integrationMappings.length}</dd>
            </div>
            <div>
              <dt>Mapped service items</dt>
              <dd>
                {
                  integrationMappings.filter(
                    (mapping) => mapping.entity_type === 'service_item' && mapping.deleted_at === null,
                  ).length
                }
              </dd>
            </div>
            <div>
              <dt>Mapped divisions</dt>
              <dd>
                {
                  integrationMappings.filter(
                    (mapping) => mapping.entity_type === 'division' && mapping.deleted_at === null,
                  ).length
                }
              </dd>
            </div>
            <div>
              <dt>Mapped projects</dt>
              <dd>
                {
                  integrationMappings.filter(
                    (mapping) => mapping.entity_type === 'project' && mapping.deleted_at === null,
                  ).length
                }
              </dd>
            </div>
          </div>

          <h4>Suggested customer mappings</h4>
          <ul className="list compact">
            {suggestedCustomerMappings.length ? (
              suggestedCustomerMappings.map((customer) => (
                <li key={customer.id} className="splitRow">
                  <div>
                    <strong>{customer.name}</strong>
                    <p className="muted compact">
                      Local ref: {customer.id} · External ID: {customer.external_id}
                    </p>
                  </div>
                  <Button
                    type="button"
                    onClick={() =>
                      runAction(`qbo-suggest:${customer.id}`, async () => {
                        await apiPost(
                          '/api/integrations/qbo/mappings',
                          {
                            entity_type: 'customer',
                            local_ref: customer.id,
                            external_id: customer.external_id,
                            label: customer.name,
                            status: 'active',
                            notes: 'auto-suggested from seeded customer backfill',
                          },
                          companySlug,
                        )
                        await refresh()
                      })
                    }
                  >
                    Create mapping
                  </Button>
                </li>
              ))
            ) : (
              <li>No customers with external IDs need mappings.</li>
            )}
          </ul>

          <h4>Suggested service item mappings</h4>
          <ul className="list compact">
            {suggestedServiceItemMappings.length ? (
              suggestedServiceItemMappings.map((item) => (
                <li key={item.code} className="splitRow">
                  <div>
                    <strong>{item.code}</strong>
                    <p className="muted compact">
                      {item.name} · {item.category} · {item.unit}
                    </p>
                  </div>
                  <Button
                    type="button"
                    onClick={() =>
                      runAction(`qbo-service-item:${item.code}`, async () => {
                        await apiPost(
                          '/api/integrations/qbo/mappings',
                          {
                            entity_type: 'service_item',
                            local_ref: item.code,
                            external_id: item.code.startsWith('qbo-') ? item.code.slice(4) : item.code,
                            label: item.name,
                            status: 'active',
                            notes: 'auto-suggested from qbo item import',
                          },
                          companySlug,
                        )
                        await refresh()
                      })
                    }
                  >
                    Create mapping
                  </Button>
                </li>
              ))
            ) : (
              <li>No service items need mappings.</li>
            )}
          </ul>

          <h4>Division mappings</h4>
          <p className="muted compact">
            Division mappings are backfilled from QBO Class sync when the class name matches a local division name or
            code.
          </p>
          <ul className="list compact">
            {suggestedDivisionMappings.length ? (
              suggestedDivisionMappings.map((division) => (
                <li key={division.code} className="splitRow">
                  <div>
                    <strong>{division.code}</strong>
                    <p className="muted compact">{division.name}</p>
                  </div>
                  <span className="muted compact">Awaiting QBO class match</span>
                </li>
              ))
            ) : (
              <li>All divisions are mapped.</li>
            )}
          </ul>

          <h4>Project mappings</h4>
          <p className="muted compact">Projects are mapped automatically when their estimate is pushed to QBO.</p>
          <ul className="list compact">
            {suggestedProjectMappings.length ? (
              suggestedProjectMappings.slice(0, 3).map((project) => (
                <li key={project.id} className="splitRow">
                  <div>
                    <strong>{project.name}</strong>
                    <p className="muted compact">
                      {project.customer_name} · {project.division_code}
                    </p>
                  </div>
                  <Button
                    type="button"
                    onClick={() =>
                      runAction(`qbo-project:${project.id}`, async () => {
                        await apiPost(`/api/projects/${project.id}/estimate/push-qbo`, {}, companySlug)
                        await refresh()
                        if (selectedProjectId === project.id) {
                          await refreshSummary(project.id)
                        }
                      })
                    }
                  >
                    Push and map
                  </Button>
                </li>
              ))
            ) : (
              <li>All projects have QBO mappings.</li>
            )}
          </ul>

          <FormRow
            actionLabel="Save mapping"
            busy={busy === 'qbo-mapping'}
            onSubmit={(form) =>
              runAction('qbo-mapping', async () => {
                await apiPost(
                  '/api/integrations/qbo/mappings',
                  {
                    entity_type: String(form.get('entity_type') ?? '').trim(),
                    local_ref: String(form.get('local_ref') ?? '').trim(),
                    external_id: String(form.get('external_id') ?? '').trim(),
                    label: String(form.get('label') ?? '').trim() || null,
                    status: String(form.get('status') ?? 'active').trim() || 'active',
                    notes: String(form.get('notes') ?? '').trim() || null,
                    expected_version: Number(form.get('expected_version') ?? 0) || undefined,
                  },
                  companySlug,
                )
                await refresh()
              })
            }
          >
            <Select name="entity_type" defaultValue="customer">
              <option value="customer">customer</option>
              <option value="service_item">service_item</option>
              <option value="division">division</option>
              <option value="project">project</option>
            </Select>
            <Input name="local_ref" placeholder="Local ref / id / code" />
            <Input name="external_id" placeholder="QBO external id" />
            <Input name="label" placeholder="Label (optional)" />
            <Input name="status" placeholder="Status" defaultValue="active" />
            <Input name="notes" placeholder="Notes (optional)" />
          </FormRow>

          <ul className="list compact">
            {integrationMappings.length ? (
              integrationMappings.map((mapping) => (
                <li key={mapping.id}>
                  <IntegrationMappingEditor
                    mapping={mapping}
                    busy={busy === `qbo-mapping:${mapping.id}`}
                    onSubmit={(form) =>
                      runAction(`qbo-mapping:${mapping.id}`, async () => {
                        await apiPatch(
                          `/api/integrations/qbo/mappings/${mapping.id}`,
                          {
                            entity_type: String(form.get('entity_type') ?? '').trim(),
                            local_ref: String(form.get('local_ref') ?? '').trim(),
                            external_id: String(form.get('external_id') ?? '').trim(),
                            label: String(form.get('label') ?? '').trim() || null,
                            status: String(form.get('status') ?? '').trim() || 'active',
                            notes: String(form.get('notes') ?? '').trim() || null,
                            expected_version: Number(form.get('expected_version') ?? 0) || undefined,
                          },
                          companySlug,
                        )
                        await refresh()
                      })
                    }
                    onDelete={() =>
                      runAction(`qbo-mapping:${mapping.id}`, async () => {
                        await apiDelete(`/api/integrations/qbo/mappings/${mapping.id}`, companySlug, {
                          expected_version: mapping.version,
                        })
                        await refresh()
                      })
                    }
                  />
                </li>
              ))
            ) : (
              <li>No QBO mappings yet.</li>
            )}
          </ul>
        </div>
      </div>
      <MutationOutboxWidget companySlug={companySlug} refreshKey={syncRefreshKey} />
      <OfflineQueueWidget companySlug={companySlug} queue={offlineQueue} />
    </section>
  )
}
