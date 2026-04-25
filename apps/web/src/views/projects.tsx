import { LA_TEMPLATE } from '@sitelayer/domain'
import { useUser } from '@clerk/clerk-react'
import { apiDelete, apiPatch, apiPost, createCompany, inviteMembership } from '../api.js'
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
import { Checkbox } from '../components/ui/checkbox.js'
import { Input } from '../components/ui/input.js'
import { Select } from '../components/ui/select.js'
import { Textarea } from '../components/ui/textarea.js'
import type { RunAction } from './types.js'

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
  const { user } = useUser()
  const clerkUserId = user?.id ?? '—'
  const clerkEmail = user?.primaryEmailAddress?.emailAddress ?? '—'
  return (
    <>
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
        <dl className="kv">
          <div>
            <dt>Clerk user id</dt>
            <dd>{clerkUserId}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{clerkEmail}</dd>
          </div>
        </dl>
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
            })
          }
        >
          <Input name="new_company_slug" placeholder="acme-construction" />
          <Input name="new_company_name" placeholder="Acme Construction" />
        </FormRow>
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
        <ul className="list">
          {customers.map((customer) => (
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
        </FormRow>
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
        <ul className="list compact">
          {workers.map((worker) => (
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
