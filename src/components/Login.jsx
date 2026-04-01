import { TH } from '../lib/theme'
import { Btn } from './Atoms'

export function Login({ onSignIn }) {
  return (
    <div style={{
      minHeight: '100vh', background: TH.bg, display: 'flex',
      alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <div style={{ maxWidth: 400, width: '100%', textAlign: 'center' }}>
        {/* Logo */}
        <div style={{ marginBottom: 32 }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 56, height: 56, borderRadius: 14,
            background: TH.amber, marginBottom: 16,
          }}>
            <span style={{ fontSize: 28 }}>⬡</span>
          </div>
          <h1 style={{ fontSize: 26, fontWeight: 600, color: TH.text, margin: 0 }}>
            SiteLayer
          </h1>
          <p style={{ fontSize: 14, color: TH.muted, marginTop: 6 }}>
            Real-time job intelligence for construction teams
          </p>
        </div>

        {/* Sign in card */}
        <div style={{
          background: TH.card, border: `1px solid ${TH.border}`,
          borderRadius: 10, padding: '28px 24px',
        }}>
          <p style={{ fontSize: 14, color: TH.muted, marginBottom: 24, lineHeight: 1.6 }}>
            Connect your tools once. Know how every job is performing — in real time.
          </p>
          <Btn
            onClick={onSignIn}
            style={{ width: '100%', padding: '12px', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}
          >
            <GoogleIcon />
            Continue with Google
          </Btn>
          <p style={{ fontSize: 11, color: TH.faint, marginTop: 16 }}>
            By continuing, you agree to our Terms of Service and Privacy Policy.
          </p>
        </div>
      </div>
    </div>
  )
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  )
}
