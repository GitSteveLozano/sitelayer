import { useState, useEffect } from 'react'
import { auth, companies } from '../lib/db'

export function useAuth() {
  const [session, setSession]   = useState(null)
  const [company, setCompany]   = useState(null)
  const [loading, setLoading]   = useState(true)

  useEffect(() => {
    // Get initial session
    auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session) loadCompany(session.user)
      else setLoading(false)
    })

    // Listen for auth changes
    const { data: { subscription } } = auth.onAuthChange((_event, session) => {
      setSession(session)
      if (session) loadCompany(session.user)
      else { setCompany(null); setLoading(false) }
    })

    return () => subscription.unsubscribe()
  }, [])

  async function loadCompany(user) {
    setLoading(true)
    const { data } = await companies.getOrCreate(user.id, user.email)
    setCompany(data)
    setLoading(false)
  }

  return {
    session,
    user:    session?.user ?? null,
    company,
    loading,
    signIn:  auth.signInWithGoogle,
    signOut: auth.signOut,
  }
}
