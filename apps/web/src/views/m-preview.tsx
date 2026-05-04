/**
 * /m-preview — internal showcase for the mobile design system primitives.
 * Renders every component in light + dark theme so we can eyeball the
 * tokens, AI surfaces, and system states without booting a real persona
 * screen.
 *
 * Gated behind `devSurfaceEnabled` (non-prod tiers only).
 */
import { useState } from 'react'
import {
  MAiAgent,
  MAiEyebrow,
  MAiStripe,
  MAttribution,
  MAvatar,
  MAvatarGroup,
  MBanner,
  MBody,
  MBottomTabs,
  MButton,
  MButtonRow,
  MButtonStack,
  MChip,
  MChipRow,
  MI,
  MKpi,
  MKpiRow,
  MLargeHead,
  MListInset,
  MListPlain,
  MListRow,
  MPill,
  MQuickAction,
  MQuickActionGrid,
  MSectionH,
  MShell,
  MStat,
  MStatStrip,
  MTopBar,
  Spark,
  initialsFor,
} from '../components/m/index.js'
import {
  MEmptyState,
  MErrorState,
  MOfflineHeader,
  MPermissionState,
  MSkeletonList,
} from '../components/m-states/index.js'

const SAMPLE_TABS = [
  { id: 'today', label: 'Today', Icon: MI.Home },
  { id: 'crew', label: 'Crew', Icon: MI.Users },
  { id: 'field', label: 'Field', Icon: MI.AlertTri, badge: 2 },
  { id: 'log', label: 'Log', Icon: MI.FileText },
  { id: 'time', label: 'Time', Icon: MI.Clock },
] as const

export function MPreviewView() {
  const [active, setActive] = useState<string>('today')

  return (
    <div style={{ background: '#f0eee9', minHeight: '100vh', padding: '24px 0 80px' }}>
      <Header />
      <Section title="Light theme — full screen">
        <PhoneFrame>
          <MShell>
            <MTopBar
              back
              title="Hillcrest Mews"
              sub="Day 18 of 32"
              actionIcon={<MI.Settings size={20} />}
              actionLabel="Settings"
            />
            <MBody pad>
              <MLargeHead
                eyebrow="MON · APR 28"
                title="Today"
                sub="3 sites · 6 crew · 11:18 AM"
                right={<MAvatar initials="AC" tone="2" />}
              />
              <MKpiRow cols={3}>
                <MKpi label="On site" value="5" meta="of 7 expected" />
                <MKpi label="Live" value="$1,232" meta="22.7 crew-hrs" metaTone="green" />
                <MKpi label="Budget" value="35%" unit="of plan" />
              </MKpiRow>
              <div style={{ height: 16 }} />
              <MAiStripe
                eyebrow="OVERNIGHT"
                title="Drewski's order arrived. Hillcrest is unblocked."
                attribution={
                  <>
                    Based on <strong>overnight events</strong>.
                  </>
                }
                onDismiss={() => {}}
              >
                EPS sheets are staged. Crew can resume east elevation at first light.
              </MAiStripe>
              <MSectionH>Today on site</MSectionH>
              <MListInset>
                <MListRow
                  leading={<MI.Home size={18} />}
                  leadingTone="accent"
                  headline="Hillcrest Mews"
                  supporting="EPS · East elevation · 3 on site"
                  trailing={<span className="num">4.2 h</span>}
                  chev
                  onTap={() => {}}
                />
                <MListRow
                  leading={<MI.Home size={18} />}
                  headline="Aspen Ridge"
                  supporting="Basecoat · 4 on site"
                  trailing={<span className="num">3.8 h</span>}
                  chev
                />
                <MListRow
                  leading={<MI.Home size={18} />}
                  headline="Greenwillow"
                  supporting="Punch · 1 on site"
                  trailing={<span className="num">1.5 h</span>}
                  chev
                />
              </MListInset>
              <MSectionH link="See all">Quick actions</MSectionH>
              <MQuickActionGrid>
                <MQuickAction Icon={MI.Plus} label="New project" />
                <MQuickAction Icon={MI.FileText} label="Estimate" />
                <MQuickAction Icon={MI.Truck} label="Dispatch" />
                <MQuickAction Icon={MI.Camera} label="Photo" />
              </MQuickActionGrid>
              <MSectionH>Banners</MSectionH>
              <MBanner
                tone="info"
                title="QuickBooks reconciliation needed"
                body="3 invoices haven't synced since Tuesday."
                action={
                  <MButton variant="ghost" size="sm">
                    Open
                  </MButton>
                }
              />
              <MBanner tone="error" title="QuickBooks lost auth" body="Reconnect to resume invoice sync." />
              <MBanner tone="ok" title="Daily backup verified" />
              <MBanner
                title="Approaching daily OT"
                body="Marcus is at 7:30 elapsed — clock-out by 4:30 PM to stay under 40."
              />
            </MBody>
            <MBottomTabs tabs={SAMPLE_TABS} activeId={active} onSelect={setActive} />
          </MShell>
        </PhoneFrame>
      </Section>

      <Section title="Pills, chips, avatars, attribution">
        <PhoneFrame>
          <MShell>
            <MTopBar title="Atoms" />
            <MBody pad>
              <MSectionH>Pills</MSectionH>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '0 16px' }}>
                <MPill>Default</MPill>
                <MPill tone="accent" dot>
                  Live
                </MPill>
                <MPill tone="green" dot>
                  Approved
                </MPill>
                <MPill tone="red" dot>
                  Disputed
                </MPill>
                <MPill tone="amber">Pending</MPill>
                <MPill tone="blue">Note</MPill>
              </div>
              <MSectionH>Chips</MSectionH>
              <MChipRow>
                <MChip active>Active</MChip>
                <MChip count={3}>Awaiting</MChip>
                <MChip count={1}>Closeout</MChip>
                <MChip outline>All</MChip>
              </MChipRow>
              <MSectionH>Avatars</MSectionH>
              <div style={{ display: 'flex', gap: 12, padding: '0 16px', alignItems: 'center' }}>
                <MAvatar initials="MA" />
                <MAvatar initials="AC" tone="2" />
                <MAvatar initials="DR" tone="3" />
                <MAvatar initials="TR" tone="4" size="lg" />
                <MAvatar initials="SV" tone="5" size="sm" />
                <MAvatarGroup
                  avatars={[
                    { initials: 'AC', tone: '2' },
                    { initials: 'MA', tone: '3' },
                    { initials: 'DR', tone: '4' },
                    { initials: 'SV', tone: '5' },
                    { initials: 'JN', tone: '2' },
                    { initials: 'BL' },
                  ]}
                  max={4}
                />
              </div>
              <MSectionH>AI surfaces</MSectionH>
              <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                <p style={{ fontSize: 14, color: 'var(--m-ink-2)', margin: 0 }}>
                  <MAiEyebrow>Likely budget</MAiEyebrow> $48k–$72k for this archetype in this zip.
                </p>
                <MAiAgent
                  attribution={
                    <>
                      Drafted from <strong>yesterday's progress</strong>.
                    </>
                  }
                >
                  Anchor + plate east wall, top to bottom — leave the cornice for tomorrow.
                </MAiAgent>
                <MAttribution>
                  Based on <strong>7 closed jobs</strong>. <Spark size={11} state="muted" />
                </MAttribution>
              </div>
              <MSectionH>Buttons</MSectionH>
              <MButtonRow>
                <MButton variant="quiet">Break</MButton>
                <MButton variant="primary">Clock out</MButton>
              </MButtonRow>
              <div style={{ height: 12 }} />
              <MButtonStack>
                <MButton variant="primary">New project</MButton>
                <MButton variant="ghost">Import from QuickBooks</MButton>
              </MButtonStack>
              <MSectionH>Stat strip</MSectionH>
              <MStatStrip>
                <MStat label="Crew-hrs" value="52:14" />
                <MStat label="Labor cost" value="$2,148" />
                <MStat label="Pending" value="7" />
              </MStatStrip>
            </MBody>
          </MShell>
        </PhoneFrame>
      </Section>

      <Section title="System states">
        <SideBySide>
          <PhoneFrame>
            <MShell>
              <MTopBar title="Today" />
              <MBody>
                <MOfflineHeader queuedCount={4} onRetry={() => {}} />
                <MSectionH>Pending sync (4)</MSectionH>
                <MListInset>
                  <MListRow
                    leading={<MI.Clock size={18} />}
                    leadingTone="accent"
                    headline="Clock-in · 7:04 AM"
                    supporting="Marcus Lee · Hillcrest"
                    trailing={<MPill tone="accent">queued</MPill>}
                  />
                  <MListRow
                    leading={<MI.Camera size={18} />}
                    leadingTone="accent"
                    headline="3 photos · daily log"
                    supporting="Hillcrest · 12.4 MB"
                    trailing={<MPill tone="accent">queued</MPill>}
                  />
                  <MListRow
                    leading={<MI.AlertTri size={18} />}
                    leadingTone="amber"
                    headline="Issue flagged"
                    supporting="Foundation flashing · north corner"
                    trailing={<MPill tone="accent">queued</MPill>}
                  />
                </MListInset>
              </MBody>
            </MShell>
          </PhoneFrame>
          <PhoneFrame>
            <MShell>
              <MTopBar title="EST-2026-184" />
              <MErrorState
                title="Couldn't load estimate"
                body="We hit a snag pulling EST-2026-184 from QuickBooks. The estimate is saved — just the live sync failed."
                primaryLabel="Try again"
                secondaryLabel="Open offline copy"
              />
            </MShell>
          </PhoneFrame>
          <PhoneFrame>
            <MShell>
              <MTopBar title="Projects" actionIcon={<MI.Plus size={20} />} actionLabel="New" />
              <MEmptyState
                title="No projects yet"
                body="Start with an address or upload drawings — Sitelayer will help you get to a measurement plan in under a minute."
                primaryLabel="New project"
                secondaryLabel="Import from QuickBooks"
              />
            </MShell>
          </PhoneFrame>
          <PhoneFrame>
            <MShell>
              <MTopBar back title="Hillcrest Mews" sub="loading…" />
              <MBody pad>
                <div className="m-card" aria-busy="true" style={{ marginBottom: 16 }}>
                  <div
                    style={{
                      width: '60%',
                      height: 12,
                      borderRadius: 4,
                      background: 'var(--m-card-soft)',
                      marginBottom: 8,
                    }}
                  />
                  <div style={{ width: '40%', height: 9, borderRadius: 4, background: 'var(--m-card-soft)' }} />
                </div>
                <MSectionH>By scope</MSectionH>
                <MSkeletonList count={4} />
              </MBody>
            </MShell>
          </PhoneFrame>
          <PhoneFrame>
            <MShell>
              <MTopBar title="Permissions" />
              <MPermissionState
                title="Location is off"
                body="Sitelayer uses geofences to verify clock-in. Without location, your hours need a foreman to manually approve each one."
                primaryLabel="Open settings"
                secondaryLabel="Continue without location"
                icon={<MI.MapPin size={26} />}
              />
            </MShell>
          </PhoneFrame>
        </SideBySide>
      </Section>

      <Section title="Dark theme (worker)">
        <PhoneFrame dark>
          <MShell className="m-dark">
            <MTopBar title="Today" />
            <MBody pad>
              <MLargeHead eyebrow="HEY, MARCUS" title="Mon · April 28" right={<MAvatar initials="ML" tone="2" />} />
              <div className="m-card" style={{ marginBottom: 16 }}>
                <div className="m-topbar-eyebrow" style={{ marginBottom: 6 }}>
                  TODAY'S JOB ·{' '}
                  <span style={{ color: 'var(--m-accent-ink)' }}>{initialsFor('Ana Castillo')} scoped by Ana</span>
                </div>
                <div style={{ fontSize: 19, fontWeight: 600 }}>Hillcrest Mews — Phase 4</div>
                <div className="m-quiet-sm">EPS · East elevation · 7:00 AM start</div>
                <div style={{ borderTop: '1px solid var(--m-line)', margin: '12px 0' }} />
                <div className="m-topbar-eyebrow" style={{ textAlign: 'center' }}>
                  CURRENTLY CLOCKED IN
                </div>
                <div
                  style={{
                    textAlign: 'center',
                    fontSize: 60,
                    fontWeight: 600,
                    fontFeatureSettings: '"tnum"',
                    letterSpacing: '-0.02em',
                    lineHeight: 1,
                  }}
                >
                  4:24<span style={{ fontSize: 26, color: 'var(--m-ink-3)' }}>:18</span>
                </div>
                <div className="m-quiet-sm" style={{ textAlign: 'center', marginTop: 4 }}>
                  Started 7:04 AM · break 12:30–1:00
                </div>
                <div style={{ height: 12 }} />
                <MButtonRow>
                  <MButton variant="quiet">Break</MButton>
                  <MButton variant="primary">Clock out</MButton>
                </MButtonRow>
              </div>
              <MSectionH>Crew on site (3)</MSectionH>
              <div style={{ display: 'flex', gap: 12, padding: '0 16px' }}>
                <MAvatar initials="AC" tone="5" size="lg" />
                <MAvatar initials="ML" tone="2" size="lg" />
                <MAvatar initials="TR" tone="4" size="lg" />
              </div>
            </MBody>
          </MShell>
        </PhoneFrame>
      </Section>
    </div>
  )
}

function Header() {
  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '0 24px 16px' }}>
      <h1 style={{ fontSize: 28, margin: 0 }}>Mobile design system</h1>
      <p style={{ color: 'rgba(60,50,40,0.7)', fontSize: 14, marginTop: 6 }}>
        Showcase route — every primitive, AI atom, and system state. Source of truth lives in
        <code style={{ background: '#fff', padding: '2px 6px', borderRadius: 4, marginLeft: 6 }}>
          apps/web/src/styles/m.css
        </code>
        .
      </p>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px' }}>
      <div className="mb-stage-label">{title}</div>
      {children}
    </div>
  )
}

function SideBySide({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', justifyContent: 'center' }}>{children}</div>
}

function PhoneFrame({ children, dark }: { children: React.ReactNode; dark?: boolean }) {
  return (
    <div
      style={{
        width: 390,
        height: 844,
        margin: '12px auto',
        borderRadius: 36,
        background: dark ? '#0e0c0a' : '#fff',
        border: '1px solid rgba(0,0,0,0.08)',
        boxShadow: '0 12px 40px rgba(0,0,0,0.08)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {children}
    </div>
  )
}
