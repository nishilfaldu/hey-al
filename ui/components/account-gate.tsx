"use client";

import { useEffect, useState, type FormEvent } from 'react';
import { VoiceApp } from './voice-app';

type User = { id: string; email: string };

export function AccountGate() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/session', { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        setUser(data.user);
        setError(null);
        setLoadFailed(false);
      })
      .catch(cause => { if (!controller.signal.aborted) { setLoadFailed(true); setError(cause instanceof Error ? cause.message : 'Could not check your sign-in.'); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [retry]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setUser(data.user);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not sign in. Please try again.'); }
    finally { setBusy(false); }
  }

  async function signOut() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/session', { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setUser(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not sign out.'); }
    finally { setBusy(false); }
  }

  if (loading) return <main className="account-screen"><p role="status">Getting Al ready…</p></main>;
  if (user) return <>
    <VoiceApp onSessionExpired={() => { setUser(null); setError('Please sign in again to start talking.'); }} />
    <div className="account-controls"><button onClick={signOut} disabled={busy}>{busy ? 'Signing out…' : 'Sign out'}</button>{error && <p role="alert">{error}</p>}</div>
  </>;
  return <main className="account-screen">
    <section className="account-card" aria-labelledby="account-title">
      <div className="account-glow" aria-hidden="true" />
      <p className="account-eyebrow">hey al</p>
      <h1 id="account-title">A little help,<br />out loud.</h1>
      <p className="account-intro">Sign in to talk with Al. New here? We’ll create your account.</p>
      <form onSubmit={submit}>
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={254} required disabled={busy} />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" minLength={8} maxLength={128} aria-describedby="password-hint" required disabled={busy} />
        <p id="password-hint" className="account-hint">Use at least 8 characters.</p>
        {error && <p className="account-error" role="alert">{error}</p>}
        <button className="account-submit" type="submit" disabled={busy}>{busy ? 'Just a moment…' : 'Continue to Al'}</button>
      </form>
      <p className="account-memory-note">Al remembers what matters across conversations.<br />You can ask Al to correct or forget something.</p>
      {loadFailed && <button className="account-retry" onClick={() => { setLoading(true); setRetry(value => value + 1); }}>Try again</button>}
    </section>
  </main>;
}
