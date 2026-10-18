import { useState, type FormEvent } from 'react';

import { describeError } from '../api/errors';
import { useAuth } from '../auth/AuthContext';
import { ErrorNotice, InfoNotice, TextField } from '../components/ui';

export function LoginPage() {
  const { login, notice } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (email.trim() === '' || password === '') {
      setError('Email dan kata sandi wajib diisi.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (failure) {
      setError(describeError(failure));
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <form className="card stack" onSubmit={(event) => void submit(event)} noValidate>
        <h1>Masuk ke Antre</h1>
        {notice !== null ? <InfoNotice>{notice}</InfoNotice> : null}
        <ErrorNotice message={error} />
        <TextField
          label="Email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
        />
        <TextField
          label="Kata sandi"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Memproses...' : 'Masuk'}
        </button>
        <p>
          Belum punya akun bisnis? <a href="#/daftar">Daftarkan bisnis Anda</a>
        </p>
      </form>
    </main>
  );
}
