import { LA_TEMPLATE } from '@sitelayer/domain'
import { useUser } from '@clerk/clerk-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiDelete, apiGet, apiPatch, apiPost, createCompany, FIXTURES_ENABLED, inviteMembership } from '../api.js'
import type { ProjectRow } from '../api.js'

// Component variant so callers in fixtures mode never trigger Clerk's hook
// (which throws when ClerkProvider isn't mounted).
function ClerkIdentityPanel() {
  const { user } = useUser()
  return (
    <>
      <div>
        <dt>Clerk user id</dt>
        <dd>{user?.id ?? '—'}</dd>
      </div>
      <div>
        <dt>Email</dt>
        <dd>{user?.primaryEmailAddress?.emailAddress ?? '—'}</dd>
      </div>
    </>
  )
}

function FixtureIdentityPanel() {
  return (
    <>
      <div>
        <dt>Clerk user id</dt>
        <dd>fixture-user</dd>
      </div>
      <div>
        <dt>Email</dt>
        <dd>fixture@example.com</dd>
      </div>
    </>
  )
}
import type {
  BonusRuleRow,
  BootstrapResponse,
  CompaniesResponse,
  PricingProfileRow,
  SessionResponse,
  WorkerRow,
} from '../api.js'
import { BonusRuleEditor, CustomerEditor, PricingProfileEditor, WorkerEditor } from '../components/operations.js'
import { FormRow } from '../components/forms.js'
import { Button } from '../components/ui/button.js'
import { Checkbox } from '../components/ui/checkbox.js'
import { Input } from '../components/ui/input.js'
import { SearchInput, usePersistedSearch } from '../components/ui/search-input.js'
import { Select } from '../components/ui/select.js'
import { Textarea } from '../components/ui/textarea.js'
import type { RunAction } from './types.js'

function matches(needle: string, ...haystacks: Array<string | null | undefined>): boolean {
  if (!needle) return true
  const query = needle.toLowerCase()
  return haystacks.some((value) => typeof value === 'string' && value.toLowerCase().includes(query))
}

type ProjectsViewProps = {
  bootstrap: BootstrapResponse | null
  session: SessionResponse | null
  companies: CompaniesResponse['companies']
  companySlug: string
  busy: string | null
  error: string | null
  customers: BootstrapResponse['customers']
  workers: WorkerRow[]
  serviceItems: BootstrapResponse['serviceItems']
  divisions: BootstrapResponse['divisions']
  pricingProfiles: PricingProfileRow[]
  bonusRules: BonusRuleRow[]
  primaryDivision: string
  setCompanySlug: (companySlug: string) => void
  runAction: RunAction
}

export function ProjectsView({
  bootstrap,
  session,
  companies,
  companySlug,
  busy,
  error,
  customers,
  workers,
  serviceItems,
  divisions,
  pricingProfiles,
  bonusRules,
  primaryDivision,
  setCompanySlug,
  runAction,
}: ProjectsViewProps) {
  const [projectSearch, setProjectSearch] = usePersistedSearch(companySlug, 'projects')
  const [workerSearch, setWorkerSearch] = usePersistedSearch(companySlug, 'workers')
  const [customerSearch, setCustomerSearch] = usePersistedSearch(companySlug, 'customers')

  const projects = bootstrap?.projects ?? []

  // Server-side project filter. When the user types, we hit
  // GET /api/projects?q=...&status=...&customer_id=... with a 300 ms debounce
  // and replace the in-memory filter result. When the search box is empty,
  // we fall back to the bootstrap snapshot so this view keeps working
  // offline / for the initial paint.
  const [serverFilteredProjects, setServerFilteredProjects] = useState<ProjectRow[] | null>(null)
  const trimmedSearch = projectSearch.trim()
  useEffect(() => {
    if (!trimmedSearch) {
      setServerFilteredProjects(null)
      return
    }
    let cancelled = false
    const handle = window.setTimeout(() => {
      const params = new URLSearchParams()
      params.set('q', trimmedSearch)
      apiGet<{ projects: ProjectRow[] }>(`/api/projects?${params.toString()}`, companySlug)
        .then((response) => {
          if (cancelled) return
          setServerFilteredProjects(response.projects ?? [])
        })
        .catch(() => {
          if (cancelled) return
          // Fall back to the in-memory filter if the network call fails so
          // the search box never becomes a permanent dead-end.
          setServerFilteredProjects(null)
        })
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [trimmedSearch, companySlug])

  const filteredProjects =
    serverFilteredProjects ??
    projects.filter((project) =>
      matches(projectSearch, project.name, project.customer_name, project.division_code, project.status),
    )
  const filteredWorkers = workers.filter((worker) => matches(workerSearch, worker.name, worker.role))
  const filteredCustomers = customers.filter((customer) => matches(customerSearch, customer.name, customer.external_id))

  // Show the onboarding banner only when the user has a single company and it
  // contains zero projects. This is the unambiguous "new tenant" signal — once
  // there's a project, the banner is noise.
  const showOnboardingBanner = bootstrap !== null && companies.length <= 1 && projects.length === 0
  const [quickCreateOpen, setQuickCreateOpen] = useState(false)

  return (
    <>
      {showOnboardingBanner ? (
        <section
          className="panel"
          data-testid="onboarding-banner"
          style={{
            background: 'rgba(59, 130, 246, 0.1)',
            borderLeft: '4px solid rgb(59, 130, 246)',
          }}
        >
          <h2>Welcome — let&apos;s set up your account</h2>
          <p className="muted compact">
            Create your company, seed a first project, invite your crew, and connect QuickBooks. Takes about two
            minutes.
          </p>
          <div style={{ marginTop: 8 }}>
            <Link to="/onboarding">
              <Button type="button" data-testid="onboarding-banner-cta">
                Set up
              </Button>
            </Link>
          </div>
        </section>
      ) : null}
      <section className="hero">
        <p className="eyebrow">Greenfield reset</p>
        <h1>Sitelayer</h1>
        <p className="lede">
          A construction operations layer with a fixed workflow backbone, tenant-scoped data, and adapter-first
          integrations.
        </p>
        <p className="lede compact">
          Tenant: {bootstrap?.company.name ?? 'loading...'} · Template: {bootstrap?.template.name ?? LA_TEMPLATE.name}
        </p>
      </section>

      <section className="panel">
        <h2>Auth Shell</h2>
        <dl className="kv">
          <div>
            <dt>User</dt>
            <dd>{session?.user.id ?? 'loading...'}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>{session?.user.role ?? 'loading...'}</dd>
          </div>
          <div>
            <dt>Active company</dt>
            <dd>{session?.activeCompany.slug ?? companySlug}</dd>
          </div>
          <div>
            <dt>Memberships</dt>
            <dd>{session?.memberships.length ?? 0}</dd>
          </div>
        </dl>
      </section>

      <section className="panel">
        <h2>Clerk Identity</h2>
        <p className="muted">Signed in via Clerk; the API receives the Clerk session JWT on every request.</p>
        <dl className="kv">{FIXTURES_ENABLED ? <FixtureIdentityPanel /> : <ClerkIdentityPanel />}</dl>
      </section>

      <section className="panel">
        <h2>Company Switcher</h2>
        <FormRow
          actionLabel="Load company"
          busy={busy === 'company'}
          onSubmit={(form) =>
            runAction(
              'company',
              async () => {
                const nextSlug = String(form.get('company_slug') ?? form.get('company_slug_manual') ?? '').trim()
                if (!nextSlug) throw new Error('company slug is required')
                setCompanySlug(nextSlug)
              },
              { skipRefresh: true },
            )
          }
        >
          <Select
            name="company_slug"
            defaultValue={companySlug}
            onChange={(event) => setCompanySlug(event.target.value)}
          >
            {companies.map((company) => (
              <option key={company.id} value={company.slug}>
                {company.name} · {company.slug}
              </option>
            ))}
            {!companies.some((company) => company.slug === companySlug) ? (
              <option value={companySlug}>{companySlug}</option>
            ) : null}
          </Select>
          <Input name="company_slug_manual" defaultValue={companySlug} placeholder="Or type a company slug" />
        </FormRow>
      </section>

      <section className="panel">
        <h2>Create Company</h2>
        <p className="muted">
          Provisions a new tenant with default divisions, service items, pricing profile, and bonus rule. The current
          user becomes admin.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Link to="/onboarding">
            <Button type="button" size="lg" data-testid="create-company-big-button">
              Create company (guided wizard)
            </Button>
          </Link>
          {quickCreateOpen ? (
            <FormRow
              actionLabel="Create company"
              busy={busy === 'create-company'}
              onSubmit={(form) =>
                runAction('create-company', async () => {
                  const slug = String(form.get('new_company_slug') ?? '')
                    .trim()
                    .toLowerCase()
                  const name = String(form.get('new_company_name') ?? '').trim()
                  if (!slug) throw new Error('slug is required')
                  if (!name) throw new Error('name is required')
                  const response = await createCompany({ slug, name }, companySlug)
                  setCompanySlug(response.company.slug)
                  setQuickCreateOpen(false)
                })
              }
            >
              <Input name="new_company_slug" placeholder="acme-construction" />
              <Input name="new_company_name" placeholder="Acme Construction" />
            </FormRow>
          ) : (
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() => setQuickCreateOpen(true)}
              style={{ alignSelf: 'flex-start', padding: 0 }}
              data-testid="quick-create-toggle"
            >
              Quick create (slug + name only)
            </Button>
          )}
        </div>
      </section>

      {session?.user.role === 'admin' && session?.activeCompany.id ? (
        <section className="panel">
          <h2>Invite Member</h2>
          <p className="muted">Add another Clerk user to the active company. Admins can promote/demote roles here.</p>
          <FormRow
            actionLabel="Invite"
            busy={busy === 'invite-member'}
            onSubmit={(form) =>
              runAction(
                'invite-member',
                async () => {
                  const inviteUserId = String(form.get('invite_user_id') ?? '').trim()
                  const role = String(form.get('invite_role') ?? 'member').trim()
                  if (!inviteUserId) throw new Error('user id is required')
                  await inviteMembership(session.activeCompany.id, { clerk_user_id: inviteUserId, role }, companySlug)
                },
                { skipRefresh: true },
              )
            }
          >
            <Input name="invite_user_id" placeholder="Clerk user id (user_xxxxxxxx)" />
            <Select name="invite_role" defaultValue="member">
              <option value="admin">admin</option>
              <option value="foreman">foreman</option>
              <option value="office">office</option>
              <option value="member">member</option>
            </Select>
          </FormRow>
        </section>
      ) : null}

      <section className="panel">
        <h2>Workflow Backbone</h2>
        <ol className="stages">
          {bootstrap?.workflowStages?.map((stage) => <li key={stage}>{stage}</li>) ?? (
            <li>Loading workflow stages...</li>
          )}
        </ol>
      </section>

      <section className="grid">
        <article className="panel">
          <h2>Company Snapshot</h2>
          <dl className="kv">
            <div>
              <dt>Projects</dt>
              <dd>{bootstrap?.projects.length ?? 0}</dd>
            </div>
            <div>
              <dt>Customers</dt>
              <dd>{customers.length}</dd>
            </div>
            <div>
              <dt>Workers</dt>
              <dd>{workers.length}</dd>
            </div>
            <div>
              <dt>Service Items</dt>
              <dd>{serviceItems.length}</dd>
            </div>
          </dl>
          <div className="searchWrap">
            <SearchInput
              value={projectSearch}
              onChange={setProjectSearch}
              placeholder="Search projects by name, customer, division, status"
              aria-label="Search projects"
            />
            <p className="muted compact">
              {filteredProjects.length} of {projects.length} project{projects.length === 1 ? '' : 's'}
              {projectSearch ? ` match "${projectSearch}"` : ''}
            </p>
          </div>
          {projectSearch ? (
            <ul className="list compact">
              {filteredProjects.map((project) => (
                <li key={project.id}>
                  <div className="stacked">
                    <strong>{project.name}</strong>
                    <span className="muted compact">
                      {project.customer_name} · {project.division_code} · {project.status}
                    </span>
                  </div>
                </li>
              ))}
              {filteredProjects.length === 0 ? <li className="muted">No matches.</li> : null}
            </ul>
          ) : null}
        </article>

        <article className="panel">
          <h2>API Status</h2>
          <p>{error ? error : bootstrap ? 'Connected' : 'Loading bootstrap...'}</p>
          <p className="muted">This is the company-scoped working set for the seeded tenant.</p>
        </article>
      </section>

      <section className="panel">
        <h2>Create Customer</h2>
        <FormRow
          actionLabel="Add customer"
          busy={busy === 'customer'}
          onSubmit={(form) =>
            runAction('customer', async () => {
              await apiPost(
                '/api/customers',
                {
                  name: String(form.get('name') ?? '').trim(),
                  external_id: String(form.get('external_id') ?? '').trim() || null,
                  source: 'manual',
                },
                companySlug,
              )
            })
          }
        >
          <Input name="name" placeholder="Customer name" />
          <Input name="external_id" placeholder="External ID (optional)" />
        </FormRow>
      </section>

      <section className="panel">
        <h2>Customers</h2>
        <div className="searchWrap">
          <SearchInput
            value={customerSearch}
            onChange={setCustomerSearch}
            placeholder="Search customers by name or QBO id"
            aria-label="Search customers"
          />
          <p className="muted compact">
            {filteredCustomers.length} of {customers.length} customer{customers.length === 1 ? '' : 's'}
            {customerSearch ? ` match "${customerSearch}"` : ''}
          </p>
        </div>
        <ul className="list">
          {filteredCustomers.map((customer) => (
            <li key={customer.id}>
              <CustomerEditor
                customer={customer}
                busy={busy === `customer:${customer.id}`}
                onSubmit={(form) =>
                  runAction(`customer:${customer.id}`, async () => {
                    await apiPatch(
                      `/api/customers/${customer.id}`,
                      {
                        name: String(form.get('name') ?? '').trim(),
                        external_id: String(form.get('external_id') ?? '').trim() || null,
                        source: String(form.get('source') ?? customer.source),
                        expected_version: Number(form.get('expected_version') ?? 0) || undefined,
                      },
                      companySlug,
                    )
                  })
                }
                onDelete={() =>
                  runAction(`customer:${customer.id}`, async () => {
                    await apiDelete(`/api/customers/${customer.id}`, companySlug, {
                      expected_version: customer.version,
                    })
                  })
                }
              />
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2>Create Project</h2>
        <FormRow
          actionLabel="Add project"
          busy={busy === 'project'}
          onSubmit={(form) =>
            runAction('project', async () => {
              const siteLatRaw = String(form.get('site_lat') ?? '').trim()
              const siteLngRaw = String(form.get('site_lng') ?? '').trim()
              const siteRadiusRaw = String(form.get('site_radius_m') ?? '').trim()
              await apiPost(
                '/api/projects',
                {
                  name: String(form.get('name') ?? '').trim(),
                  customer_name: String(form.get('customer_name') ?? '').trim(),
                  division_code: String(form.get('division_code') ?? primaryDivision),
                  status: 'lead',
                  bid_total: Number(form.get('bid_total') ?? 0),
                  labor_rate: Number(form.get('labor_rate') ?? 38),
                  target_sqft_per_hr: Number(form.get('target_sqft_per_hr') ?? 0) || null,
                  bonus_pool: Number(form.get('bonus_pool') ?? 0),
                  site_lat: siteLatRaw ? Number(siteLatRaw) : null,
                  site_lng: siteLngRaw ? Number(siteLngRaw) : null,
                  site_radius_m: siteRadiusRaw ? Number(siteRadiusRaw) : 100,
                },
                companySlug,
              )
            })
          }
        >
          <Input name="name" placeholder="Project name" />
          <Input name="customer_name" placeholder="Customer / builder" />
          <Select name="division_code" defaultValue={primaryDivision}>
            {divisions.map((division) => (
              <option key={division.code} value={division.code}>
                {division.code} - {division.name}
              </option>
            ))}
          </Select>
          <Input name="bid_total" placeholder="Bid total" type="number" step="0.01" />
          <Input name="labor_rate" placeholder="Labor rate" type="number" step="0.01" defaultValue="38" />
          <Input name="target_sqft_per_hr" placeholder="Target sqft/hr" type="number" step="0.01" />
          <Input name="bonus_pool" placeholder="Bonus pool" type="number" step="0.01" />
          <Input name="site_lat" placeholder="Site latitude (e.g. 49.8951)" type="number" step="0.000001" />
          <Input name="site_lng" placeholder="Site longitude (e.g. -97.1384)" type="number" step="0.000001" />
          <Input name="site_radius_m" placeholder="Geofence radius (m)" type="number" step="1" defaultValue="100" />
        </FormRow>
      </section>

      <section className="panel">
        <h2>Site Geofences</h2>
        <p className="muted">
          Set lat/lng and a radius (metres) per project. Crew clock-ins auto-resolve to the project whose geofence
          contains their phone position. 100 m covers most residential lots.
        </p>
        <ul className="list compact">
          {projects.map((project) => (
            <li key={project.id}>
              <form
                className="formRow"
                onSubmit={(event) => {
                  event.preventDefault()
                  const form = new FormData(event.currentTarget)
                  const siteLatRaw = String(form.get('site_lat') ?? '').trim()
                  const siteLngRaw = String(form.get('site_lng') ?? '').trim()
                  const siteRadiusRaw = String(form.get('site_radius_m') ?? '').trim()
                  runAction(`project-geofence:${project.id}`, async () => {
                    await apiPatch(
                      `/api/projects/${project.id}`,
                      {
                        site_lat: siteLatRaw ? Number(siteLatRaw) : null,
                        site_lng: siteLngRaw ? Number(siteLngRaw) : null,
                        site_radius_m: siteRadiusRaw ? Number(siteRadiusRaw) : null,
                        expected_version: project.version,
                      },
                      companySlug,
                    )
                  })
                }}
              >
                <div className="stacked">
                  <strong>{project.name}</strong>
                  <span className="muted compact">
                    {project.customer_name} · {project.division_code}
                  </span>
                </div>
                <Input
                  name="site_lat"
                  placeholder="Lat"
                  type="number"
                  step="0.000001"
                  defaultValue={project.site_lat ?? ''}
                />
                <Input
                  name="site_lng"
                  placeholder="Lng"
                  type="number"
                  step="0.000001"
                  defaultValue={project.site_lng ?? ''}
                />
                <Input
                  name="site_radius_m"
                  placeholder="Radius (m)"
                  type="number"
                  step="1"
                  defaultValue={project.site_radius_m ?? 100}
                />
                <Button type="submit" disabled={busy === `project-geofence:${project.id}`}>
                  {busy === `project-geofence:${project.id}` ? 'Saving...' : 'Save geofence'}
                </Button>
              </form>
            </li>
          ))}
          {projects.length === 0 ? <li className="muted">No projects yet.</li> : null}
        </ul>
      </section>

      <section className="panel">
        <h2>Create Worker</h2>
        <FormRow
          actionLabel="Add worker"
          busy={busy === 'worker'}
          onSubmit={(form) =>
            runAction('worker', async () => {
              await apiPost(
                '/api/workers',
                {
                  name: String(form.get('name') ?? '').trim(),
                  role: String(form.get('role') ?? 'crew').trim() || 'crew',
                },
                companySlug,
              )
            })
          }
        >
          <Input name="name" placeholder="Worker name" />
          <Input name="role" placeholder="Role" defaultValue="crew" />
        </FormRow>
      </section>

      <section className="panel">
        <h2>Workers</h2>
        <div className="searchWrap">
          <SearchInput
            value={workerSearch}
            onChange={setWorkerSearch}
            placeholder="Search workers by name or role"
            aria-label="Search workers"
          />
          <p className="muted compact">
            {filteredWorkers.length} of {workers.length} worker{workers.length === 1 ? '' : 's'}
            {workerSearch ? ` match "${workerSearch}"` : ''}
          </p>
        </div>
        <ul className="list compact">
          {filteredWorkers.map((worker) => (
            <li key={worker.id}>
              <WorkerEditor
                worker={worker}
                busy={busy === `worker:${worker.id}`}
                onSubmit={(form) =>
                  runAction(`worker:${worker.id}`, async () => {
                    await apiPatch(
                      `/api/workers/${worker.id}`,
                      {
                        name: String(form.get('name') ?? '').trim(),
                        role: String(form.get('role') ?? '').trim(),
                        expected_version: Number(form.get('expected_version') ?? 0) || undefined,
                      },
                      companySlug,
                    )
                  })
                }
                onDelete={() =>
                  runAction(`worker:${worker.id}`, async () => {
                    await apiDelete(`/api/workers/${worker.id}`, companySlug, { expected_version: worker.version })
                  })
                }
              />
            </li>
          ))}
        </ul>
      </section>

      <section className="grid">
        <article className="panel">
          <h2>Pricing Profiles</h2>
          <FormRow
            actionLabel="Add pricing profile"
            busy={busy === 'pricing-profile'}
            onSubmit={(form) =>
              runAction('pricing-profile', async () => {
                const configRaw = String(form.get('config') ?? '').trim()
                const config = configRaw ? JSON.parse(configRaw) : {}
                await apiPost(
                  '/api/pricing-profiles',
                  {
                    name: String(form.get('name') ?? '').trim(),
                    is_default: form.get('is_default') === 'on',
                    config,
                  },
                  companySlug,
                )
              })
            }
          >
            <Input name="name" placeholder="Profile name" defaultValue="Default" />
            <label className="checkbox">
              <Checkbox name="is_default" type="checkbox" defaultChecked />
              <span>Default profile</span>
            </label>
            <Textarea
              name="config"
              placeholder={`{\n  "template": "la-default"\n}`}
              rows={4}
              defaultValue={JSON.stringify({ template: 'la-default' }, null, 2)}
            />
          </FormRow>
          <ul className="list compact">
            {pricingProfiles.map((profile) => (
              <li key={profile.id}>
                <PricingProfileEditor
                  profile={profile}
                  busy={busy === `pricing-profile:${profile.id}`}
                  onSubmit={(form) =>
                    runAction(`pricing-profile:${profile.id}`, async () => {
                      const configRaw = String(form.get('config') ?? '').trim()
                      const config = configRaw ? JSON.parse(configRaw) : {}
                      await apiPatch(
                        `/api/pricing-profiles/${profile.id}`,
                        {
                          name: String(form.get('name') ?? '').trim(),
                          is_default: form.get('is_default') === 'on',
                          config,
                          expected_version: Number(form.get('expected_version') ?? 0) || undefined,
                        },
                        companySlug,
                      )
                    })
                  }
                  onDelete={() =>
                    runAction(`pricing-profile:${profile.id}`, async () => {
                      await apiDelete(`/api/pricing-profiles/${profile.id}`, companySlug, {
                        expected_version: profile.version,
                      })
                    })
                  }
                />
              </li>
            ))}
          </ul>
        </article>

        <article className="panel">
          <h2>Bonus Rules</h2>
          <FormRow
            actionLabel="Add bonus rule"
            busy={busy === 'bonus-rule'}
            onSubmit={(form) =>
              runAction('bonus-rule', async () => {
                const configRaw = String(form.get('config') ?? '').trim()
                const config = configRaw ? JSON.parse(configRaw) : {}
                await apiPost(
                  '/api/bonus-rules',
                  {
                    name: String(form.get('name') ?? '').trim(),
                    is_active: form.get('is_active') === 'on',
                    config,
                  },
                  companySlug,
                )
              })
            }
          >
            <Input name="name" placeholder="Rule name" defaultValue="Default Margin Bonus" />
            <label className="checkbox">
              <Checkbox name="is_active" type="checkbox" defaultChecked />
              <span>Active rule</span>
            </label>
            <Textarea
              name="config"
              placeholder={`{\n  "basis": "margin",\n  "threshold": 0.15\n}`}
              rows={4}
              defaultValue={JSON.stringify({ basis: 'margin', threshold: 0.15 }, null, 2)}
            />
          </FormRow>
          <ul className="list compact">
            {bonusRules.map((rule) => (
              <li key={rule.id}>
                <BonusRuleEditor
                  rule={rule}
                  busy={busy === `bonus-rule:${rule.id}`}
                  onSubmit={(form) =>
                    runAction(`bonus-rule:${rule.id}`, async () => {
                      const configRaw = String(form.get('config') ?? '').trim()
                      const config = configRaw ? JSON.parse(configRaw) : {}
                      await apiPatch(
                        `/api/bonus-rules/${rule.id}`,
                        {
                          name: String(form.get('name') ?? '').trim(),
                          is_active: form.get('is_active') === 'on',
                          config,
                          expected_version: Number(form.get('expected_version') ?? 0) || undefined,
                        },
                        companySlug,
                      )
                    })
                  }
                  onDelete={() =>
                    runAction(`bonus-rule:${rule.id}`, async () => {
                      await apiDelete(`/api/bonus-rules/${rule.id}`, companySlug, { expected_version: rule.version })
                    })
                  }
                />
              </li>
            ))}
          </ul>
        </article>
      </section>
    </>
  )
}
