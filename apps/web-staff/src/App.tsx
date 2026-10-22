import { Suspense, lazy, useEffect } from 'react';

import { AuthProvider, useAuth, type AuthProviderProps } from './auth/AuthContext';
import { Loading } from './components/ui';
import { ROLE_LABELS } from './lib/actions';
import { hashFor, resolveRoute, useHashRoute } from './lib/routes';
import { LoginPage } from './pages/LoginPage';

// Bigger pages are split from the initial bundle.
const DashboardPage = lazy(() =>
  import('./dashboard/DashboardPage').then((m) => ({
    default: m.DashboardPage,
  })),
);
const SettingsPage = lazy(() =>
  import('./settings/SettingsPage').then((m) => ({
    default: m.SettingsPage,
  })),
);
const RegisterPage = lazy(() =>
  import('./pages/RegisterPage').then((m) => ({ default: m.RegisterPage })),
);

function Shell() {
  const { session, logout } = useAuth();
  const [route] = useHashRoute();
  const redirect = resolveRoute(route, session?.user.role ?? null);

  useEffect(() => {
    if (redirect !== null) window.location.replace(hashFor(redirect));
  }, [redirect]);
  if (redirect !== null) return <Loading />;

  if (session === null) {
    return (
      <div className="auth-layout">
        <header className="topbar auth-topbar">
          <strong className="brand">
            <span className="brand-dot"></span>
            Antre
          </strong>
          <div className="topbar-right">
            {route.name === 'register' ? (
              <span className="auth-topbar-link">
                Sudah punya akun? <a href="#/login">Masuk</a>
              </span>
            ) : (
              <span className="auth-topbar-link">
                Belum punya akun bisnis? <a href="#/daftar">Daftarkan bisnis Anda</a>
              </span>
            )}
          </div>
        </header>
        <div className="auth-container">
          <Suspense fallback={<Loading />}>
            {route.name === 'register' ? <RegisterPage /> : <LoginPage />}
          </Suspense>
        </div>
      </div>
    );
  }

  const role = session.user.role;
  return (
    <>
      <a className="skip-link" href="#main">
        Lompat ke konten
      </a>
      <header className="topbar">
        <div className="topbar-left">
          <strong className="brand">
            <span className="brand-dot"></span>
            Antre
          </strong>
          <nav aria-label="Menu utama">
            <a href="#/" aria-current={route.name === 'dashboard' ? 'page' : undefined}>
              Dashboard
            </a>
            {role === 'OWNER' ? (
              <a href="#/pengaturan" aria-current={route.name === 'settings' ? 'page' : undefined}>
                Pengaturan
              </a>
            ) : null}
          </nav>
        </div>
        <div className="topbar-right">
          <span className="who">
            <strong className="who-user">{session.user.email}</strong>{' '}
            <span className={`badge badge-role badge-role-${role.toLowerCase()}`}>
              {ROLE_LABELS[role]}
            </span>
          </span>
          <button type="button" className="btn-logout" onClick={logout}>
            Keluar
          </button>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="page">
        <Suspense fallback={<Loading />}>
          {route.name === 'settings' ? <SettingsPage tab={route.tab} /> : null}
          {route.name === 'dashboard' ? <DashboardPage /> : null}
          {route.name === 'not-found' ? <p>Halaman tidak ditemukan.</p> : null}
        </Suspense>
      </main>
    </>
  );
}

export function App(props: Omit<AuthProviderProps, 'children'>) {
  return (
    <AuthProvider {...props}>
      <Shell />
    </AuthProvider>
  );
}
