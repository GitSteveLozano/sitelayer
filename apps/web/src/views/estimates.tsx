import { formatMoney } from '@sitelayer/domain'
import { apiPatch, apiPost } from '../api.js'
import type { BootstrapResponse, ProjectSummary } from '../api.js'
import { AnalyticsWidget, ProjectEditor } from '../components/operations.js'
import { Button } from '../components/ui/button.js'
import type { RunAction } from './types.js'

type EstimatesViewProps = {
  bootstrap: BootstrapResponse | null
  summary: ProjectSummary | null
  selectedProjectId: string
  companySlug: string
  busy: string | null
  divisions: BootstrapResponse['divisions']
  measurableServiceItems: BootstrapResponse['serviceItems']
  setSelectedProjectId: (projectId: string) => void
  refresh: () => Promise<void>
  refreshSummary: (projectId: string) => Promise<void>
  runAction: RunAction
}

export function EstimatesView({
  bootstrap,
  summary,
  selectedProjectId,
  companySlug,
  busy,
  divisions,
  measurableServiceItems,
  setSelectedProjectId,
  refresh,
  refreshSummary,
  runAction,
}: EstimatesViewProps) {
  return (
    <>
      <section className="grid">
        <article className="panel">
          <h2>Selected Project Summary</h2>
          {summary ? (
            <div className="summary">
              <p>
                <strong>{summary.project.name}</strong> · {summary.project.customer_name} ·{' '}
                {summary.project.division_code}
              </p>
              <p className="muted">
                Status: {summary.project.status}
                {summary.project.closed_at ? ` · closed ${summary.project.closed_at}` : ''}
                {summary.project.summary_locked_at ? ` · summary locked ${summary.project.summary_locked_at}` : ''}
              </p>
              <dl className="kv">
                <div>
                  <dt>Bid total</dt>
                  <dd>{formatMoney(Number(summary.project.bid_total))}</dd>
                </div>
                <div>
                  <dt>Estimate total</dt>
                  <dd>{formatMoney(summary.metrics.estimateTotal)}</dd>
                </div>
                <div>
                  <dt>Labor cost</dt>
                  <dd>{formatMoney(summary.metrics.laborCost)}</dd>
                </div>
                <div>
                  <dt>Total cost</dt>
                  <dd>{formatMoney(summary.metrics.totalCost)}</dd>
                </div>
                <div>
                  <dt>Margin</dt>
                  <dd>{(summary.metrics.margin.margin * 100).toFixed(2)}%</dd>
                </div>
                <div>
                  <dt>Bonus</dt>
                  <dd>{summary.metrics.bonus.eligible ? formatMoney(summary.metrics.bonus.payout) : 'Not eligible'}</dd>
                </div>
              </dl>

              <div className="actions">
                <Button
                  type="button"
                  onClick={() =>
                    void runAction('estimate-recompute', async () => {
                      await apiPost(`/api/projects/${summary.project.id}/estimate/recompute`, {}, companySlug)
                      await refreshSummary(summary.project.id)
                    })
                  }
                >
                  Recompute estimate
                </Button>
                <Button
                  type="button"
                  onClick={() =>
                    void runAction('project-closeout', async () => {
                      await apiPost(
                        `/api/projects/${summary.project.id}/closeout`,
                        { expected_version: summary.project.version },
                        companySlug,
                      )
                      await refreshSummary(summary.project.id)
                      await refresh()
                    })
                  }
                >
                  Close out project
                </Button>
              </div>

              <div className="summaryLists">
                <div>
                  <h3>Measurements</h3>
                  <ul className="list compact">
                    {summary.measurements.length ? (
                      summary.measurements.map((measurement) => (
                        <li key={`${measurement.service_item_code}:${measurement.notes ?? ''}:${measurement.quantity}`}>
                          <strong>{measurement.service_item_code}</strong>
                          <span>
                            {measurement.quantity} {measurement.unit}
                            {measurement.notes ? ` · ${measurement.notes}` : ''}
                          </span>
                        </li>
                      ))
                    ) : (
                      <li>No measurements yet</li>
                    )}
                  </ul>
                </div>

                <div>
                  <h3>Estimate Lines</h3>
                  <ul className="list compact">
                    {summary.estimateLines.length ? (
                      summary.estimateLines.map((line) => (
                        <li key={`${line.service_item_code}:${line.quantity}:${line.rate}`}>
                          <strong>{line.service_item_code}</strong>
                          <span>
                            {line.quantity} {line.unit} · {formatMoney(Number(line.amount))}
                          </span>
                        </li>
                      ))
                    ) : (
                      <li>No estimate lines yet</li>
                    )}
                  </ul>
                </div>
              </div>

              <ProjectEditor
                project={summary.project}
                divisions={divisions}
                busy={busy === 'project-update'}
                onSubmit={(form) =>
                  runAction('project-update', async () => {
                    await apiPatch(
                      `/api/projects/${summary.project.id}`,
                      {
                        name: String(form.get('name') ?? '').trim(),
                        customer_name: String(form.get('customer_name') ?? '').trim(),
                        division_code: String(form.get('division_code') ?? summary.project.division_code),
                        status: String(form.get('status') ?? summary.project.status),
                        bid_total: Number(form.get('bid_total') ?? summary.project.bid_total),
                        labor_rate: Number(form.get('labor_rate') ?? summary.project.labor_rate),
                        target_sqft_per_hr: Number(form.get('target_sqft_per_hr') ?? 0) || null,
                        bonus_pool: Number(form.get('bonus_pool') ?? summary.project.bonus_pool),
                        expected_version: Number(form.get('expected_version') ?? 0) || undefined,
                      },
                      companySlug,
                    )
                  })
                }
              />
            </div>
          ) : (
            <p className="muted">Pick a project to see measurements, estimate lines, and live cost analytics.</p>
          )}
        </article>

        <article className="panel">
          <h2>Project List</h2>
          <ul className="list">
            {bootstrap?.projects?.map((project) => (
              <li
                key={project.id}
                className={project.id === selectedProjectId ? 'active' : ''}
                onClick={() => setSelectedProjectId(project.id)}
              >
                <div className="stacked">
                  <strong>{project.name}</strong>
                  <span className="muted compact">
                    {project.customer_name} · {project.division_code}
                  </span>
                </div>
                <span className="projectMeta">
                  <span className="badge">{project.status}</span>
                  <span className="metaInline">
                    {formatMoney(Number(project.bid_total))}
                    {project.closed_at ? ` · closed ${project.closed_at}` : ''}
                    {project.summary_locked_at ? ` · locked ${project.summary_locked_at}` : ''}
                  </span>
                </span>
              </li>
            )) ?? <li>Waiting for seed data</li>}
          </ul>
        </article>
      </section>

      <section className="grid">
        <article className="panel">
          <h2>Divisions</h2>
          <ul className="list compact">
            {divisions.map((division) => (
              <li key={division.code}>
                <strong>{division.code}</strong>
                <span>{division.name}</span>
              </li>
            ))}
          </ul>
        </article>

        <article className="panel">
          <h2>Curated Service Items</h2>
          <ul className="list compact">
            {measurableServiceItems.map((item) => (
              <li key={item.code}>
                <strong>{item.code}</strong>
                <span>
                  {item.name} · {item.unit} · {item.default_rate ?? 'n/a'}
                </span>
              </li>
            ))}
          </ul>
        </article>
      </section>

      <section className="panel">
        <h2>Analytics Preview</h2>
        <AnalyticsWidget companySlug={companySlug} />
      </section>
    </>
  )
}
