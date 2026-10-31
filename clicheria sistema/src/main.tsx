import React, { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, ArrowLeft, ArrowRight, Bell, BookOpen, CalendarDays, Check, CheckCircle2, Cookie,
  ChevronDown, ChevronRight, CircleAlert, ClipboardList, Clock3, Copy,
  Download, Factory, FileText, LayoutDashboard, Link2, LockKeyhole, LogOut, Mail, MapPin, Menu, Moon, Sun,
  Package, PackageCheck, PackagePlus, Pencil, Phone, Search, ShieldCheck,
  Trash2, Truck, Upload, UserCheck, UserRound, UsersRound, X,
} from 'lucide-react';
import './styles.css';

const STATUSES = ['Pedido criado', 'Em produção', 'Saiu para entrega', 'Entregue ao destino'] as const;
type Status = typeof STATUSES[number];
type User = { id: string; name: string; email: string; role: 'owner' | 'admin' | 'operator' | 'viewer' };
type Order = {
  id: string; number: string; customerName: string; customerEmail: string | null;
  customerPhone: string | null; customerCompany: string | null; product: string; quantity: number;
  dueDate: string | null; destination: string | null;
  internalNotes: string | null; status: Status; createdAt: string;
  createdByName: string; updatedAt: string; updatedByName: string;
  assignedTo: string | null; assignedToName: string | null;
  pendingReason: string | null; nextActionDate: string | null;
  artworkStatus: 'not_required' | 'pending' | 'approved' | 'changes_requested'; artworkNote: string | null;
  artworkReviewedByName: string | null; artworkReviewedAt: string | null;
  deliveryMode: 'own_fleet' | 'carrier' | 'customer_pickup' | null; carrierName: string | null;
  driverName: string | null; driverPhone: string | null; deliveryForecast: string | null;
  trackingCode: string | null; trackingUrl: string | null; departedAt: string | null; departedByName: string | null;
  deliveredAt: string | null; deliveredByName: string | null; receivedBy: string | null;
};
type Event = { id?: string; kind?: string; status: Status; summary?: string; details?: Record<string, unknown> | null; note?: string | null; actorName?: string; createdAt: string };
type Attachment = { id: string; label: string; category: 'artwork' | 'approval' | 'delivery_proof' | 'other'; originalName: string; mimeType: string; sizeBytes: number; customerVisible: boolean; uploadedByName: string; uploadedAt: string };
type Assignee = { id: string; name: string; role: User['role'] };
type ManagedUser = { id: string; name: string; email: string; role: User['role']; active: boolean; accountStatus: 'pending' | 'active' | 'inactive'; removedAt: string | null; emailVerifiedAt: string | null; createdAt: string };
type TurnstileApi = { render: (target: HTMLElement, options: Record<string, unknown>) => string; reset: (id: string) => void; remove: (id: string) => void };
declare global { interface Window { turnstile?: TurnstileApi } }
type Summary = {
  total: number; statusCounts: Record<Status, number>;
  overdueCount: number; dueSoonCount: number; dueOrders: Order[];
  activity: Array<{ status: Status; createdAt: string; actorName: string; orderNumber: string; customerName: string }>;
  series: Array<{ day: string; count: number }>; orders: Order[];
};
type ApiResult<T> = T;

class RequestError extends Error {
  status: number;
  details: Record<string, unknown>;
  constructor(message: string, status: number, details: Record<string, unknown> = {}) { super(message); this.status = status; this.details = details; }
}

async function api<T>(path: string, options: RequestInit = {}): Promise<ApiResult<T>> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...options, headers, credentials: 'include' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new RequestError(data.error || 'Não foi possível concluir esta ação.', response.status, data);
  return data as T;
}

async function uploadPrivateAttachment(path: string, file: File, options: { label: string; category: Attachment['category']; customerVisible: boolean }) {
  const response = await fetch(path, { method: 'POST', credentials: 'include', headers: {
    'Content-Type': file.type || 'application/octet-stream',
    'X-Op-File-Name': encodeURIComponent(file.name),
    'X-Op-File-Label': encodeURIComponent(options.label),
    'X-Op-File-Category': options.category,
    'X-Op-Customer-Visible': String(options.customerVisible),
  }, body: file });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new RequestError(data.error || 'Não foi possível guardar o arquivo.', response.status);
  return data as { file: Attachment };
}

function readableFileSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'OP';
}

function userRoleLabel(role: User['role']) {
  return role === 'owner' ? 'Conta Proprietária' : role === 'admin' ? 'Administrador' : role === 'viewer' ? 'Consulta' : 'Operador';
}

function useTheme() {
  const [theme, setTheme] = useState<'light' | 'black'>(() => {
    try { return readCookiePreferences()?.rememberTheme && localStorage.getItem('op-track-theme') === 'black' ? 'black' : 'light'; } catch { return 'light'; }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'black' ? '#0a111b' : '#10243a');
    try { if (readCookiePreferences()?.rememberTheme) localStorage.setItem('op-track-theme', theme); else localStorage.removeItem('op-track-theme'); } catch { /* Theme still applies for this session. */ }
  }, [theme]);
  const toggleTheme = useCallback(() => setTheme((current) => current === 'black' ? 'light' : 'black'), []);
  return { theme, toggleTheme };
}

function ThemeToggle({ theme, onToggle, labeled = false }: { theme: 'light' | 'black'; onToggle: () => void; labeled?: boolean }) {
  const label = theme === 'black' ? 'Ativar tema claro' : 'Ativar tema preto';
  return <button className={`theme-toggle ${labeled ? 'theme-toggle--labeled' : ''}`} onClick={onToggle} aria-label={label} title={label}>
    {theme === 'black' ? <Sun size={16} /> : <Moon size={16} />}{labeled && <span>{theme === 'black' ? 'Tema claro' : 'Tema preto'}</span>}
  </button>;
}

type CookiePreferences = { saved: true; rememberTheme: boolean; analytics: false };
function readCookiePreferences(): CookiePreferences | null {
  try {
    const value = JSON.parse(localStorage.getItem('optrack-cookie-preferences') || 'null');
    return value?.saved === true ? { saved: true, rememberTheme: value.rememberTheme === true, analytics: false } : null;
  } catch { return null; }
}

function useTurnstile(theme: 'light' | 'black', action: 'account' | 'tracking') {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [required, setRequired] = useState(true);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ turnstile: { enabled: boolean; required: boolean; siteKey: string | null } }>('/api/public-config')
      .then((config) => { setSiteKey(config.turnstile.siteKey); setEnabled(config.turnstile.enabled); setRequired(config.turnstile.required); })
      .catch(() => setError('Não foi possível carregar a verificação antirrobô.'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!enabled || !siteKey || !container.current) return;
    let active = true;
    const render = () => {
      if (!active || !container.current || !window.turnstile || widgetId.current) return;
      try {
        widgetId.current = window.turnstile.render(container.current, {
          sitekey: siteKey, theme: theme === 'black' ? 'dark' : 'light', language: 'pt-BR', action,
          callback: (nextToken: string) => { setToken(nextToken); setError(''); },
          'error-callback': () => { setToken(''); setError('A verificação falhou. Atualize o desafio e tente de novo.'); },
          'expired-callback': () => { setToken(''); setError('A verificação expirou. Confirme o desafio novamente.'); },
          'timeout-callback': () => { setToken(''); setError('A verificação demorou. Confirme o desafio novamente.'); },
        });
      } catch { setError('A verificação antirrobô não pôde ser iniciada.'); }
    };
    let script = document.querySelector<HTMLScriptElement>('script[data-optrack-turnstile]');
    const onLoad = () => render();
    const onError = () => setError('Não foi possível carregar o serviço de verificação. Verifique sua conexão.');
    if (!script) {
      script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true; script.defer = true; script.dataset.optrackTurnstile = 'true';
      script.addEventListener('load', onLoad, { once: true });
      script.addEventListener('error', onError, { once: true });
      document.head.append(script);
    } else if (window.turnstile) render();
    else { script.addEventListener('load', onLoad, { once: true }); script.addEventListener('error', onError, { once: true }); }
    return () => {
      active = false;
      script?.removeEventListener('load', onLoad); script?.removeEventListener('error', onError);
      if (widgetId.current) { window.turnstile?.remove(widgetId.current); widgetId.current = null; }
    };
  }, [action, enabled, siteKey, theme]);
  const reset = useCallback(() => {
    setToken(''); setError('');
    if (widgetId.current) window.turnstile?.reset(widgetId.current);
  }, []);
  return { container, enabled, required, loading, token, error, reset };
}

function TurnstileField({ captcha }: { captcha: ReturnType<typeof useTurnstile> }) {
  return <div className="captcha-wrap" aria-live="polite">
    {captcha.enabled ? <div ref={captcha.container} className="turnstile-widget" /> : <div className="captcha-status"><ShieldCheck size={14} />{captcha.loading ? 'Carregando verificação segura…' : captcha.required ? 'Proteção antirrobô indisponível.' : 'No ambiente local, permanecem ativos os limites de tentativas.'}</div>}
    {captcha.error && <p className="captcha-error"><CircleAlert size={13} />{captcha.error}</p>}
  </div>;
}

function formatDate(value?: string | null, includeTime = true) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', includeTime
    ? { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: 'short', year: 'numeric' }).format(date).replace(' de ', ' ');
}

function formatDay(value: string) {
  const date = new Date(`${value}T12:00:00`);
  return new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit' }).format(date).replace('.', '');
}

function Logo({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? 'brand--compact' : ''}`} aria-label="OP TRACK FLEX PREMIUM">
    <span className="brand-client-logo"><img src="/logo-flexpremium.png" alt="" /></span>
    {!compact && <span className="brand-name"><span>OP <b>TRACK</b></span><small>FLEX PREMIUM · PRODUÇÃO & RASTREIO</small></span>}
  </div>;
}

function StatusBadge({ status }: { status: Status }) {
  const index = STATUSES.indexOf(status);
  const Icon = [ClipboardList, Factory, Truck, PackageCheck][Math.max(index, 0)];
  return <span className={`status-badge status-badge--${index}`}><Icon size={13} strokeWidth={1.9} />{status}</span>;
}

function StatusTimeline({ events, current }: { events: Event[]; current: Status }) {
  const currentIndex = STATUSES.indexOf(current);
  return <ol className="timeline">
    {STATUSES.map((status, index) => {
      const event = events.find((item) => item.status === status && (!item.kind || item.kind === 'status'));
      const Icon = [ClipboardList, Factory, Truck, PackageCheck][index];
      const complete = index < currentIndex;
      const active = index === currentIndex;
      return <li className={`timeline-item ${complete ? 'is-complete' : ''} ${active ? 'is-current' : ''}`} key={status}>
        <div className="timeline-marker">{complete ? <Check size={16} /> : <Icon size={16} />}</div>
        <div className="timeline-copy"><strong>{status}</strong><span>{event ? formatDate(event.createdAt) : index === 0 ? 'Aguardando início' : 'Aguardando próxima etapa'}</span></div>
        {active && <span className="timeline-now">Etapa atual</span>}
      </li>;
    })}
  </ol>;
}

function Modal({ title, children, onClose, className = '' }: { title: string; children: React.ReactNode; onClose: () => void; className?: string }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={`modal ${className}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="modal-heading"><h2 id="modal-title">{title}</h2><button className="icon-button" onClick={onClose} aria-label="Fechar"><X size={18} /></button></div>
      {children}
    </section>
  </div>;
}

function Toast({ message, kind = 'success', onClose }: { message: string; kind?: 'success' | 'error'; onClose: () => void }) {
  useEffect(() => { const timeout = window.setTimeout(onClose, 4200); return () => window.clearTimeout(timeout); }, [onClose]);
  return <div className={`toast toast--${kind}`} role="status"><span className="toast-icon">{kind === 'success' ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}</span><span>{message}</span><button onClick={onClose} aria-label="Fechar aviso"><X size={15} /></button></div>;
}

function AuthScreen({ setupRequired, onAuthenticated, onTrack, theme, onToggleTheme }: { setupRequired: boolean; onAuthenticated: (user: User) => void; onTrack: () => void; theme: 'light' | 'black'; onToggleTheme: () => void }) {
  const [mode, setMode] = useState<'login' | 'register' | 'verify'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [verificationMessage, setVerificationMessage] = useState('');
  const [devVerificationCode, setDevVerificationCode] = useState('');
  const [bootstrapToken, setBootstrapToken] = useState('');
  const [website, setWebsite] = useState('');
  const [pendingMessage, setPendingMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const captcha = useTurnstile(theme, 'account');
  const view = setupRequired && mode !== 'verify' ? 'setup' : mode;
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    if (captcha.loading || (captcha.required && !captcha.enabled) || (captcha.enabled && !captcha.token)) { setBusy(false); setError('Conclua a verificação antirrobô antes de continuar.'); return; }
    if (view === 'register' && password !== confirmPassword) { setBusy(false); setError('As senhas não coincidem.'); return; }
    try {
      if (view === 'register' || view === 'setup') {
        const result = await api<{ message: string; email: string; verificationRequired?: boolean; devVerificationCode?: string }>(view === 'register' ? '/api/register' : '/api/setup', {
          method: 'POST', body: JSON.stringify(view === 'register'
            ? { name, email, password, website, turnstileToken: captcha.token }
            : { name, email, password, bootstrapToken, turnstileToken: captcha.token }),
        });
        if (view === 'setup' || result.verificationRequired) {
          setMode('verify'); setEmail(result.email || email); setVerificationCode(''); setVerificationMessage(result.message); setDevVerificationCode(result.devVerificationCode || ''); setPendingMessage('');
        } else {
          setMode('login'); setPendingMessage(result.message); setDevVerificationCode('');
        }
        setPassword(''); setConfirmPassword(''); setName(''); setWebsite('');
      } else if (view === 'verify') {
        const result = await api<{ user?: User; message?: string }>('/api/register/verify', { method: 'POST', body: JSON.stringify({ email, code: verificationCode, turnstileToken: captcha.token }) });
        if (result.user) onAuthenticated(result.user);
        else { setPendingMessage(result.message || 'E-mail confirmado. O acesso aguarda aprovação da Conta Proprietária.'); setMode('login'); setVerificationCode(''); setDevVerificationCode(''); }
      } else {
        const result = await api<{ user: User }>('/api/login', { method: 'POST', body: JSON.stringify({ email, password, turnstileToken: captcha.token }) });
        onAuthenticated(result.user);
      }
    } catch (reason) {
      if (reason instanceof RequestError && reason.details.verificationRequired === true) {
        setMode('verify'); setPassword(''); setVerificationCode(''); setVerificationMessage(reason.message);
        setDevVerificationCode(typeof reason.details.devVerificationCode === 'string' ? reason.details.devVerificationCode : '');
        setEmail(typeof reason.details.email === 'string' ? reason.details.email : email);
      } else setError(reason instanceof Error ? reason.message : 'Erro ao acessar.');
    }
    finally { captcha.reset(); setBusy(false); }
  };
  const resendCode = async () => {
    setBusy(true); setError('');
    if (captcha.loading || (captcha.required && !captcha.enabled) || (captcha.enabled && !captcha.token)) { setBusy(false); setError('Conclua a verificação antirrobô antes de pedir outro código.'); return; }
    try {
      const result = await api<{ message: string; devVerificationCode?: string }>('/api/register/resend', { method: 'POST', body: JSON.stringify({ email, turnstileToken: captcha.token }) });
      setVerificationMessage(result.message); setDevVerificationCode(result.devVerificationCode || devVerificationCode);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Não foi possível reenviar o código.'); }
    finally { captcha.reset(); setBusy(false); }
  };
  const title = view === 'setup' ? 'Configure seu acesso' : view === 'register' ? 'Crie sua conta' : view === 'verify' ? 'Confirme seu e-mail' : 'Acesse sua operação';
  const description = view === 'setup' ? 'Crie a Conta Proprietária inicial. Ela administrará os acessos da equipe.' : view === 'register' ? 'Confirme o endereço de e-mail. Depois, a Conta Proprietária aprovará seu acesso.' : view === 'verify' ? 'Digite o código enviado ao endereço informado para confirmar que você consegue receber mensagens nele.' : 'Entre com sua conta para gerenciar as ordens de produção.';
  const switchMode = (next: 'login' | 'register') => { setMode(next); setError(''); setPendingMessage(''); setPassword(''); setConfirmPassword(''); setName(''); setWebsite(''); setVerificationCode(''); setVerificationMessage(''); setDevVerificationCode(''); captcha.reset(); };
  return <main className="auth-screen">
    <section className="auth-panel">
      <div className="auth-brand"><Logo /><ThemeToggle theme={theme} onToggle={onToggleTheme} /></div>
      <div className="auth-content">
        {!setupRequired && <div className="auth-access-tabs" role="tablist" aria-label="Acesso à equipe"><button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'auth-access-tab auth-access-tab--active' : 'auth-access-tab'} onClick={() => switchMode('login')}>Entrar</button><button type="button" role="tab" aria-selected={mode !== 'login'} className={mode !== 'login' ? 'auth-access-tab auth-access-tab--active' : 'auth-access-tab'} onClick={() => switchMode('register')}>Criar conta</button></div>}
        <div className="auth-symbol"><LockKeyhole size={21} /></div>
        <h1>{title}</h1>
        <p>{description}</p>
        {pendingMessage && <p className="auth-success" role="status">{pendingMessage}</p>}
        <form className="form-stack" onSubmit={submit}>
          {(view === 'setup' || view === 'register') && <Field label="Nome completo" value={name} onChange={setName} placeholder="Como podemos chamar você?" autoComplete="name" required />}
          {view === 'setup' && <Field label="Chave de ativação" type="password" value={bootstrapToken} onChange={setBootstrapToken} placeholder="Usada na primeira configuração publicada" autoComplete="off" />}
          {view !== 'verify' && <Field label="E-mail" type="email" value={email} onChange={setEmail} placeholder="nome@empresa.com.br" autoComplete="email" required />}
          {view === 'verify' && <><Field label="E-mail de confirmação" type="email" value={email} onChange={setEmail} autoComplete="email" required /><Field label="Código de confirmação" value={verificationCode} onChange={(value) => setVerificationCode(value.replace(/\D/g, '').slice(0, 8))} placeholder="8 dígitos" autoComplete="one-time-code" inputMode="numeric" maxLength={8} minLength={8} required />{verificationMessage && <p className="auth-success" role="status">{verificationMessage}</p>}{devVerificationCode && <div className="auth-verification-code"><span>Código de desenvolvimento · somente local</span><strong>{devVerificationCode}</strong></div>}</>}
          {view !== 'verify' && <Field label={view === 'register' ? 'Criar senha' : 'Senha'} type="password" value={password} onChange={setPassword} placeholder={view === 'login' ? 'Sua senha' : 'Mínimo de 12 caracteres'} autoComplete={view === 'login' ? 'current-password' : 'new-password'} minLength={view === 'login' ? undefined : 12} required />}
          {view === 'register' && <Field label="Confirmar senha" type="password" value={confirmPassword} onChange={setConfirmPassword} placeholder="Digite a senha novamente" autoComplete="new-password" minLength={12} required />}
          {view === 'register' && <label className="honeypot-field" aria-hidden="true">Website<input value={website} onChange={(event) => setWebsite(event.target.value)} tabIndex={-1} autoComplete="off" /></label>}
          <TurnstileField captcha={captcha} />
          {error && <InlineError>{error}</InlineError>}
          <button className="button button--primary button--wide" disabled={busy || captcha.loading || (captcha.required && !captcha.enabled) || (captcha.enabled && !captcha.token)}>{busy ? <span className="spinner" /> : view === 'setup' ? 'Criar Conta Proprietária' : view === 'register' ? 'Criar conta' : view === 'verify' ? 'Confirmar e-mail' : 'Entrar'}<ArrowRight size={16} /></button>
        </form>
        {view === 'verify' && <button className="auth-resend-button" type="button" onClick={resendCode} disabled={busy || captcha.loading || (captcha.required && !captcha.enabled) || (captcha.enabled && !captcha.token)}>{busy ? 'Aguarde…' : 'Reenviar código'}</button>}
        <button className="auth-track-link" onClick={onTrack}>Precisa acompanhar uma OP? <span>Rastrear pedido <ArrowRight size={14} /></span></button>
      </div>
      <div className="auth-footer"><ShieldCheck size={14} /> Ambiente seguro para sua operação</div>
    </section>
    <aside className="auth-aside">
      <div className="auth-aside-content"><span className="auth-eyebrow"><span /> CONTROLE OPERACIONAL</span>
        <h2>Do pedido à entrega,<br /><em>com visibilidade.</em></h2>
        <p>Um ponto de acompanhamento para sua equipe e uma resposta clara para cada cliente.</p>
        <div className="auth-aside-stages">{STATUSES.map((status, index) => <div className="auth-stage" key={status}><span className={`auth-stage-dot dot-${index}`} />{status}{index < 3 && <i />}</div>)}</div>
      </div>
      <div className="auth-aside-bottom"><span>OP TRACK FLEX PREMIUM</span><span>Rastreabilidade em cada etapa</span></div>
    </aside>
  </main>;
}

function Field({ label, value, onChange, placeholder, type = 'text', required, autoComplete, minLength, min, max, step, inputMode, maxLength, className = '' }: {
  label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string;
  required?: boolean; autoComplete?: string; minLength?: number; min?: number; max?: number; step?: number; inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode']; maxLength?: number; className?: string;
}) {
  return <label className={`field ${className}`}><span className="field-label">{label}{required && <i> *</i>}</span><input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} required={required} autoComplete={autoComplete} minLength={minLength} min={min} max={max} step={step} inputMode={inputMode} maxLength={maxLength} /></label>;
}

function TextAreaField({ label, value, onChange, placeholder, rows = 3 }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; rows?: number }) {
  return <label className="field"><span className="field-label">{label}</span><textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} rows={rows} /></label>;
}

function InlineError({ children }: { children: React.ReactNode }) { return <p className="inline-error"><CircleAlert size={15} />{children}</p>; }

function TrackingPortal({ onBack, theme, onToggleTheme }: { onBack: () => void; theme: 'light' | 'black'; onToggleTheme: () => void }) {
  const captcha = useTurnstile(theme, 'tracking');
  const [orderNumber, setOrderNumber] = useState('');
  const [trackingCode, setTrackingCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ order: { number: string; customerName: string; status: Status; createdAt: string; deliveryForecast: string | null; trackingCode: string | null; trackingUrl: string | null; proofAvailable: boolean }; events: Event[] } | null>(null);
  const [proofBusy, setProofBusy] = useState(false);
  const [proofError, setProofError] = useState('');
  const [proofObjectUrl, setProofObjectUrl] = useState('');
  const [proofMime, setProofMime] = useState('');
  useEffect(() => () => { if (proofObjectUrl) URL.revokeObjectURL(proofObjectUrl); }, [proofObjectUrl]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setResult(null);
    if (captcha.loading || (captcha.required && !captcha.enabled) || (captcha.enabled && !captcha.token)) { setBusy(false); setError('Conclua a verificação antirrobô antes de consultar.'); return; }
    if (proofObjectUrl) URL.revokeObjectURL(proofObjectUrl);
    setProofObjectUrl(''); setProofError('');
    try { setResult(await api('/api/track', { method: 'POST', body: JSON.stringify({ orderNumber, trackingCode, turnstileToken: captcha.token }) })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Não foi possível consultar a OP.'); }
    finally { captcha.reset(); setBusy(false); }
  };
  const loadProof = async () => {
    setProofBusy(true); setProofError('');
    try {
      const response = await fetch('/api/track/proof', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderNumber, trackingCode }) });
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || 'Não foi possível abrir o comprovante.'); }
      const blob = await response.blob();
      if (proofObjectUrl) URL.revokeObjectURL(proofObjectUrl);
      setProofMime(blob.type); setProofObjectUrl(URL.createObjectURL(blob));
    } catch (reason) { setProofError(reason instanceof Error ? reason.message : 'Não foi possível abrir o comprovante.'); }
    finally { setProofBusy(false); }
  };
  return <main className="tracking-page">
    <header className="tracking-header"><Logo /><div className="tracking-header-actions"><ThemeToggle theme={theme} onToggle={onToggleTheme} /><button className="text-button" onClick={onBack}>Acesso da equipe <ArrowRight size={15} /></button></div></header>
    <div className="tracking-body">
      <section className="tracking-intro"><div className="tracking-kicker"><span /> ACOMPANHAMENTO DE PEDIDO</div><h1>Seu pedido,<br /><em>em cada etapa.</em></h1><p>Informe os dados de rastreamento recebidos da equipe para acompanhar sua OP.</p>
        <form className="tracking-form" onSubmit={submit}>
          <Field label="Número da OP" value={orderNumber} onChange={setOrderNumber} placeholder="Ex.: OP-2026-000001" required />
          <Field label="Código de rastreamento" value={trackingCode} onChange={setTrackingCode} placeholder="Código individual recebido" required />
          <TurnstileField captcha={captcha} />
          {error && <InlineError>{error}</InlineError>}
          <button className="button button--primary button--wide" disabled={busy || captcha.loading || (captcha.required && !captcha.enabled) || (captcha.enabled && !captcha.token)}>{busy ? <span className="spinner" /> : 'Consultar pedido'}<ArrowRight size={16} /></button>
          <p className="tracking-privacy"><LockKeyhole size={13} /> Seus dados são protegidos. Só você pode consultar este pedido.</p>
        </form>
      </section>
      <section className={`tracking-result ${result ? 'tracking-result--loaded' : ''}`} aria-live="polite">
        {result ? <>
          <div className="result-topline"><span>ACOMPANHAMENTO DA OP</span><span className="result-live"><i /> Atualizado agora</span></div>
          <div className="result-heading"><div><span className="result-label">Número do pedido</span><h2>{result.order.number}</h2></div><StatusBadge status={result.order.status} /></div>
          <div className="result-customer"><span className="result-label">Cliente</span><strong>{result.order.customerName}</strong></div>
          {(result.order.deliveryForecast || result.order.trackingUrl || result.order.trackingCode) && <div className="customer-delivery-info">
            {result.order.deliveryForecast && <div><span>Previsão de entrega</span><strong>{formatDate(`${result.order.deliveryForecast}T12:00:00`, false)}</strong></div>}
            {(result.order.trackingUrl || result.order.trackingCode) && <div><span>Rastreamento da entrega</span>{result.order.trackingUrl ? <a href={result.order.trackingUrl} target="_blank" rel="noopener noreferrer">{result.order.trackingCode || 'Acompanhar na transportadora'} <Link2 size={13} /></a> : <strong>{result.order.trackingCode}</strong>}</div>}
          </div>}
          <StatusTimeline events={result.events} current={result.order.status} />
          {result.order.proofAvailable && <section className="customer-proof"><div><strong>Comprovante de entrega disponível</strong><p>A equipe autorizou o compartilhamento deste arquivo.</p></div><button className="button button--secondary" onClick={loadProof} disabled={proofBusy}>{proofBusy ? <span className="spinner" /> : <Download size={14} />} Abrir comprovante</button>
            {proofError && <InlineError>{proofError}</InlineError>}
            {proofObjectUrl && (proofMime.startsWith('image/') ? <img className="customer-proof-image" src={proofObjectUrl} alt="Comprovante de entrega" /> : <a className="customer-proof-pdf" href={proofObjectUrl} target="_blank" rel="noopener noreferrer"><FileText size={15} /> Visualizar PDF</a>)}
          </section>}
          <div className="result-foot"><Clock3 size={14} /> Última atualização em {formatDate(result.events.at(-1)?.createdAt || result.order.createdAt)}</div>
        </> : <div className="tracking-placeholder">
          <div className="tracking-art"><div className="track-art-line" /><span className="track-art-node track-art-node--one"><ClipboardList size={16} /></span><span className="track-art-node track-art-node--two"><Factory size={17} /></span><span className="track-art-node track-art-node--three"><Truck size={16} /></span><span className="track-art-node track-art-node--four"><PackageCheck size={17} /></span></div>
          <strong>Acompanhe com tranquilidade</strong><p>As atualizações da sua OP aparecerão aqui assim que ela avançar pelas etapas.</p>
          <div className="placeholder-steps">{STATUSES.map((status, index) => <div key={status}><span>{String(index + 1).padStart(2, '0')}</span>{status}</div>)}</div>
        </div>}
      </section>
    </div>
    <footer className="tracking-footer"><span>OP TRACK FLEX PREMIUM</span><span>Rastreabilidade clara. Comunicação melhor.</span></footer>
  </main>;
}

function PrivacyTools({ theme }: { theme: 'light' | 'black' }) {
  const initialPreferences = readCookiePreferences();
  const [showBanner, setShowBanner] = useState(!initialPreferences);
  const [modal, setModal] = useState<'privacy' | 'cookies' | null>(null);
  const [rememberTheme, setRememberTheme] = useState(initialPreferences?.rememberTheme ?? false);
  const savePreferences = (remember: boolean) => {
    try {
      localStorage.setItem('optrack-cookie-preferences', JSON.stringify({ saved: true, rememberTheme: remember, analytics: false }));
      if (remember) localStorage.setItem('op-track-theme', theme); else localStorage.removeItem('op-track-theme');
    } catch { /* Privacy settings remain available for this visit. */ }
    setRememberTheme(remember); setShowBanner(false); setModal(null);
  };
  return <>
    <button className="privacy-tools-trigger" onClick={() => setModal('privacy')}><BookOpen size={13} /> Privacidade e cookies</button>
    {showBanner && <aside className="cookie-banner" role="region" aria-label="Preferências de privacidade"><div><strong>Privacidade e armazenamento</strong><p>Usamos o cookie de sessão necessário para login. Preferências opcionais ficam desativadas até você escolher.</p></div><div className="cookie-banner-actions"><button className="button button--secondary" onClick={() => { setModal('cookies'); setShowBanner(false); }}>Configurar</button><button className="button button--primary" onClick={() => savePreferences(false)}>Apenas necessários</button></div></aside>}
    {modal && <Modal title={modal === 'privacy' ? 'Privacidade e cookies' : 'Preferências de cookies'} onClose={() => setModal(null)} className="privacy-modal">
      {modal === 'privacy' ? <div className="privacy-document">
        <p className="privacy-template-note"><ShieldCheck size={14} /> Aviso modelo: antes de publicar, preencha os dados da empresa e valide os prazos e bases legais com o responsável pela operação.</p>
        <h3>Aviso de Privacidade — OP TRACK FLEX PREMIUM</h3>
        <p><strong>Controlador:</strong> [inserir razão social e CNPJ]. <strong>Contato para privacidade:</strong> [inserir e-mail de contato].</p>
        <h4>Dados e finalidades</h4><p>O sistema pode tratar nome, e-mail e perfil de acesso da equipe; nome e contatos do cliente; dados da OP e do destino; nome e telefone do motorista; comprovantes enviados; e registros de acesso e atualização. Esses dados são usados para administrar contas, produzir e acompanhar OPs, informar o cliente sobre entrega, guardar evidências operacionais e proteger o sistema contra abuso.</p>
        <h4>Acesso, serviços e compartilhamento</h4><p>A Conta Proprietária administra os acessos; administradores e operadores atualizam OPs; o perfil Consulta visualiza. O cliente acessa uma OP com número e código individual, e só recebe comprovantes que a equipe autorizar. No cadastro e na confirmação de acesso, o endereço de e-mail e o código temporário são enviados ao Resend para entrega da mensagem. A proteção antirrobô Turnstile da Cloudflare é usada em login, cadastro e consulta e pode receber dados técnicos do navegador e da conexão para validar a solicitação. Anexos podem usar Supabase Storage privado quando configurado. Hospedagem e outros fornecedores dependem da implantação escolhida.</p>
        <h4>Retenção e direitos</h4><p>A empresa responsável deve definir e informar os prazos de retenção conforme suas obrigações e necessidades. Para solicitar acesso, correção ou eliminação quando aplicável, ou esclarecer o tratamento, contate [inserir e-mail de privacidade]. A base legal aplicável a cada finalidade deve ser validada pelo controlador antes da publicação.</p>
        <h4>Cookies e armazenamento local</h4><p>O cookie <code>optrack_session</code> é estritamente necessário para manter a sessão da equipe e expira em até 12 horas. A escolha de lembrar o tema e a decisão deste aviso são guardadas no armazenamento local do navegador, não em cookies. Não há cookies de publicidade nem ferramenta de análise configurados neste projeto.</p>
        <p className="privacy-updated">Privacidade dos serviços: <a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noopener noreferrer">Cloudflare</a> · <a href="https://resend.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer">Resend</a>.</p>
        <button className="button button--secondary" onClick={() => setModal('cookies')}><Cookie size={14} /> Configurar cookies</button>
      </div> : <div className="cookie-settings">
        <p>O OP TRACK FLEX PREMIUM usa apenas o armazenamento necessário para manter sua sessão e, se você escolher, lembrar preferências visuais.</p>
        <div className="cookie-setting-row"><div><strong>Sessão e segurança</strong><p>Obrigatório para login e proteção contra falsificação. HttpOnly, SameSite Strict e duração de até 12 horas.</p></div><span className="required-cookie-state">Sempre ativo</span></div>
        <label className="cookie-setting-row cookie-setting-toggle"><div><strong>Lembrar tema neste navegador</strong><p>Guarda sua escolha entre tema claro e preto no armazenamento local. Você pode mudar depois.</p></div><input type="checkbox" checked={rememberTheme} onChange={(event) => setRememberTheme(event.target.checked)} /></label>
        <div className="cookie-setting-row"><div><strong>Análise e publicidade</strong><p>Não estão habilitadas no OP TRACK FLEX PREMIUM.</p></div><span className="optional-cookie-state">Desativadas</span></div>
        <div className="cookie-setting-row"><div><strong>Verificação antirrobô</strong><p>Necessária para login, cadastro e consulta pública. A Cloudflare processa a solicitação de verificação.</p></div><span className="required-cookie-state">Proteção</span></div>
        <div className="modal-actions"><button className="button button--secondary" onClick={() => savePreferences(false)}>Apenas necessários</button><button className="button button--primary" onClick={() => savePreferences(rememberTheme)}>Salvar preferências</button></div>
      </div>}
    </Modal>}
  </>;
}

type Section = 'dashboard' | 'orders' | 'create' | 'detail' | 'team';

function App() {
  const { theme, toggleTheme } = useTheme();
  const [path, setPath] = useState(window.location.pathname);
  const [session, setSession] = useState<{ loading: boolean; setupRequired: boolean; user: User | null }>({ loading: true, setupRequired: false, user: null });
  const [section, setSection] = useState<Section>('dashboard');
  const [orderId, setOrderId] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [toast, setToast] = useState<{ message: string; kind?: 'success' | 'error' } | null>(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [searchSeed, setSearchSeed] = useState('');
  const [createdCode, setCreatedCode] = useState<{ orderNumber: string; code: string } | null>(null);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigatePath = useCallback((target: string) => {
    window.history.pushState({}, '', target);
    setPath(target);
  }, []);
  const loadSession = useCallback(async () => {
    try { const result = await api<{ setupRequired: boolean; user: User | null }>('/api/session'); setSession({ loading: false, setupRequired: result.setupRequired, user: result.user }); }
    catch { setSession({ loading: false, setupRequired: false, user: null }); }
  }, []);
  useEffect(() => { loadSession(); }, [loadSession]);
  const clearSearchSeed = useCallback(() => setSearchSeed(''), []);

  if (path === '/rastrear') return <><TrackingPortal onBack={() => navigatePath('/')} theme={theme} onToggleTheme={toggleTheme} /><PrivacyTools theme={theme} /></>;
  if (session.loading) return <><main className="loading-screen"><Logo /><span className="spinner spinner--dark" /></main><PrivacyTools theme={theme} /></>;
  if (!session.user) return <><AuthScreen setupRequired={session.setupRequired} onAuthenticated={(user) => setSession({ loading: false, setupRequired: false, user })} onTrack={() => navigatePath('/rastrear')} theme={theme} onToggleTheme={toggleTheme} /><PrivacyTools theme={theme} /></>;

  const activeSection: Section = (session.user.role !== 'owner' && section === 'team') || (session.user.role === 'viewer' && section === 'create') ? 'dashboard' : section;
  const go = (next: Section) => { setSection(next); setMobileMenu(false); if (next !== 'detail') setOrderId(''); };
  const openOrder = (id: string) => { setOrderId(id); setSection('detail'); setMobileMenu(false); };
  const changed = (message: string) => { setToast({ message }); setRefresh((value) => value + 1); };
  const failed = (message: string) => setToast({ message, kind: 'error' });

  return <><div className="app-shell">
    <aside className={`sidebar ${mobileMenu ? 'sidebar--open' : ''}`}>
      <div className="sidebar-brand"><Logo /></div>
      <div className="sidebar-section-label">OPERAÇÃO</div>
      <nav className="sidebar-nav" aria-label="Navegação principal">
        <NavItem active={activeSection === 'dashboard'} icon={<LayoutDashboard size={18} />} label="Visão geral" onClick={() => go('dashboard')} />
        <NavItem active={activeSection === 'orders'} icon={<ClipboardList size={18} />} label="Ordens de produção" onClick={() => go('orders')} />
        {session.user.role !== 'viewer' && <NavItem active={activeSection === 'create'} icon={<PackagePlus size={18} />} label="Nova OP" onClick={() => go('create')} />}
        {session.user.role === 'owner' && <><div className="sidebar-divider" /><div className="sidebar-section-label">ADMINISTRAÇÃO</div><NavItem active={activeSection === 'team'} icon={<UsersRound size={18} />} label="Equipe e acessos" onClick={() => go('team')} /></>}
      </nav>
      <div className="sidebar-bottom"><div className="sidebar-help"><span className="help-icon"><Activity size={17} /></span><div><strong>Rastreio em dia</strong><span>As atualizações são registradas por etapa.</span></div></div><a href="/rastrear" onClick={(event) => { event.preventDefault(); navigatePath('/rastrear'); }} className="sidebar-portal-link"><PackageCheck size={16} /> Abrir portal do cliente <ArrowRight size={14} /></a></div>
      {mobileMenu && <button className="sidebar-scrim" aria-label="Fechar menu" onClick={() => setMobileMenu(false)} />}
    </aside>
    <main className="main-area">
      <Topbar user={session.user} onSearch={(value) => { setSearchSeed(value); go('orders'); }} onLogout={async () => { await api('/api/logout', { method: 'POST' }).catch(() => undefined); setSession({ loading: false, setupRequired: false, user: null }); }} onMenu={() => setMobileMenu(true)} refresh={refresh} theme={theme} onToggleTheme={toggleTheme} />
      <div className="content-wrap">
        {activeSection === 'dashboard' && <Dashboard refresh={refresh} onOpenOrder={openOrder} onCreate={() => go('create')} onViewOrders={() => go('orders')} canEdit={session.user.role !== 'viewer'} />}
        {activeSection === 'orders' && <OrdersPage refresh={refresh} seed={searchSeed} clearSeed={clearSearchSeed} onOpenOrder={openOrder} onCreate={() => go('create')} canEdit={session.user.role !== 'viewer'} />}
        {activeSection === 'create' && session.user.role !== 'viewer' && <OrderCreate onCancel={() => go('orders')} onCreated={(id, number, code) => { setOrderId(id); setSection('detail'); setToast({ message: `A OP ${number} foi cadastrada.` }); setRefresh((value) => value + 1); setCreatedCode({ orderNumber: number, code }); }} />}
        {activeSection === 'detail' && <OrderDetail id={orderId} refresh={refresh} onBack={() => go('orders')} onChanged={changed} onError={failed} canEdit={session.user.role !== 'viewer'} />}
        {activeSection === 'team' && session.user.role === 'owner' && <TeamPage refresh={refresh} onChanged={changed} onError={failed} currentUserId={session.user.id} />}
      </div>
    </main>
    {mobileMenu && <button className="mobile-backdrop" aria-label="Fechar menu" onClick={() => setMobileMenu(false)} />}
    {toast && <Toast message={toast.message} kind={toast.kind} onClose={() => setToast(null)} />}
    {createdCode && <TrackingCodeModal orderNumber={createdCode.orderNumber} code={createdCode.code} onClose={() => setCreatedCode(null)} />}
  </div><PrivacyTools theme={theme} /></>;
}

function NavItem({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return <button className={`nav-item ${active ? 'nav-item--active' : ''}`} onClick={onClick}>{icon}<span>{label}</span>{active && <i />}</button>;
}

function Topbar({ user, onSearch, onLogout, onMenu, refresh, theme, onToggleTheme }: { user: User; onSearch: (value: string) => void; onLogout: () => void; onMenu: () => void; refresh: number; theme: 'light' | 'black'; onToggleTheme: () => void }) {
  const [query, setQuery] = useState('');
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [activity, setActivity] = useState<Summary['activity']>([]);
  const [profileOpen, setProfileOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [securityBusy, setSecurityBusy] = useState(false);
  const [securityError, setSecurityError] = useState('');
  const [securitySuccess, setSecuritySuccess] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => { api<Summary>('/api/dashboard?period=7d').then((data) => setActivity(data.activity.slice(0, 4))).catch(() => undefined); }, [refresh]);
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchInput.current?.focus(); }
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, []);
  const search = (event: FormEvent) => { event.preventDefault(); onSearch(query.trim()); };
  const savePassword = async (event: FormEvent) => {
    event.preventDefault(); setSecurityBusy(true); setSecurityError(''); setSecuritySuccess('');
    try {
      await api('/api/account/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword, confirmPassword }) });
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); setSecuritySuccess('Senha alterada. As outras sessões foram encerradas.');
    } catch (reason) { setSecurityError(reason instanceof Error ? reason.message : 'Não foi possível alterar a senha.'); }
    finally { setSecurityBusy(false); }
  };
  const closeSecurity = () => { setSecurityOpen(false); setSecurityError(''); setSecuritySuccess(''); setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); };
  return <><header className="topbar">
    <button className="mobile-menu-button" aria-label="Abrir menu" onClick={onMenu}><Menu size={20} /></button>
    <form className="global-search" onSubmit={search}><Search size={17} /><input ref={searchInput} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar OP, cliente ou projeto" aria-label="Buscar OP, cliente ou projeto" /><kbd>Ctrl K</kbd></form>
      <div className="topbar-actions">
      <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      <div className="popover-anchor"><button className={`icon-button topbar-icon ${notificationsOpen ? 'is-open' : ''}`} aria-label="Atividade recente" onClick={() => { setNotificationsOpen(!notificationsOpen); setProfileOpen(false); }}><Bell size={18} /></button>
        {notificationsOpen && <div className="popover notification-popover"><div className="popover-heading"><strong>Atividade recente</strong><span>{activity.length} atualizações</span></div>{activity.length ? activity.map((item, index) => <div className="popover-activity" key={`${item.orderNumber}-${item.createdAt}-${index}`}><span className={`mini-status-dot status-dot-${STATUSES.indexOf(item.status)}`} /><div><strong>{item.orderNumber}</strong><span>{item.status} · {item.customerName}</span><small>{formatDate(item.createdAt)}</small></div></div>) : <p className="popover-empty">As novas movimentações aparecerão aqui.</p>}</div>}
      </div>
      <div className="topbar-divider" />
      <div className="popover-anchor"><button className="profile-button" onClick={() => { setProfileOpen(!profileOpen); setNotificationsOpen(false); }}><span className="avatar">{initials(user.name)}</span><span className="profile-text"><strong>{user.name}</strong><small>{userRoleLabel(user.role)}</small></span><ChevronDown size={15} /></button>
        {profileOpen && <div className="popover profile-popover"><div className="profile-popover-user"><span className="avatar">{initials(user.name)}</span><div><strong>{user.name}</strong><small>{user.email}</small></div></div><button className="account-security-button" onClick={() => { setProfileOpen(false); setSecurityOpen(true); }}><LockKeyhole size={14} /> Alterar senha</button><button className="logout-button" onClick={onLogout}><LogOut size={15} /> Sair da conta</button></div>}
      </div>
    </div>
  </header>{securityOpen && <Modal title="Segurança da conta" onClose={closeSecurity} className="security-modal"><form className="form-stack" onSubmit={savePassword}><p className="security-hint">Use uma senha nova, exclusiva e com pelo menos 12 caracteres. A alteração encerra as demais sessões desta conta.</p><Field label="Senha atual" type="password" value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" required /><Field label="Nova senha" type="password" value={newPassword} onChange={setNewPassword} autoComplete="new-password" minLength={12} required /><Field label="Confirmar nova senha" type="password" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" minLength={12} required />{securityError && <InlineError>{securityError}</InlineError>}{securitySuccess && <p className="auth-success" role="status">{securitySuccess}</p>}<div className="modal-actions"><button type="button" className="button button--secondary" onClick={closeSecurity}>Fechar</button><button className="button button--primary" disabled={securityBusy}>{securityBusy ? <span className="spinner" /> : <LockKeyhole size={14} />} Atualizar senha</button></div></form></Modal>}</>;
}

function PageHeading({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return <div className="page-heading"><div><h1>{title}</h1><p>{description}</p></div>{action && <div className="page-heading-action">{action}</div>}</div>;
}

function StatCard({ label, value, icon, tone, detail }: { label: string; value: number; icon: React.ReactNode; tone: string; detail: string }) {
  return <article className="stat-card"><div className="stat-top"><span className={`stat-icon stat-icon--${tone}`}>{icon}</span><span className="stat-detail">{detail}</span></div><div className="stat-value">{value.toLocaleString('pt-BR')}</div><div className="stat-label">{label}</div></article>;
}

function Dashboard({ refresh, onOpenOrder, onCreate, onViewOrders, canEdit }: { refresh: number; onOpenOrder: (id: string) => void; onCreate: () => void; onViewOrders: () => void; canEdit: boolean }) {
  const [period, setPeriod] = useState('7d');
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { setError(''); api<Summary>(`/api/dashboard?period=${period}`).then(setData).catch((reason) => setError(reason.message)); }, [period, refresh]);
  const max = Math.max(...(data?.series.map((point) => point.count) || [0]), 1);
  return <>
    <PageHeading title="Visão geral" description="Acompanhe a movimentação das ordens de produção." action={canEdit && <button className="button button--primary" onClick={onCreate}><PackagePlus size={16} /> Nova OP</button>} />
    {error && <InlineError>{error}</InlineError>}
    <section className="stat-grid" aria-label="Indicadores de OPs">
      <StatCard label="Total de OPs" value={data?.total || 0} icon={<Package size={18} />} tone="navy" detail="No sistema" />
      <StatCard label="Pedidos criados" value={data?.statusCounts[STATUSES[0]] || 0} icon={<ClipboardList size={18} />} tone="blue" detail="Etapa 01" />
      <StatCard label="Em produção" value={data?.statusCounts[STATUSES[1]] || 0} icon={<Factory size={18} />} tone="amber" detail="Etapa 02" />
      <StatCard label="Saiu para entrega" value={data?.statusCounts[STATUSES[2]] || 0} icon={<Truck size={18} />} tone="violet" detail="Etapa 03" />
      <StatCard label="Entregues ao destino" value={data?.statusCounts[STATUSES[3]] || 0} icon={<PackageCheck size={18} />} tone="green" detail="Etapa 04" />
    </section>
    {!!(data?.overdueCount || data?.dueSoonCount) && <section className="surface attention-panel"><div className="panel-heading"><div><h2>Prazos que pedem atenção</h2><p>OPs abertas com data de entrega vencida ou nos próximos cinco dias.</p></div><div className="attention-totals">{!!data?.overdueCount && <span className="attention-count attention-count--late">{data.overdueCount} vencida{data.overdueCount === 1 ? '' : 's'}</span>}{!!data?.dueSoonCount && <span className="attention-count attention-count--soon">{data.dueSoonCount} próxima{data.dueSoonCount === 1 ? '' : 's'}</span>}</div></div>
      <div className="attention-list">{data?.dueOrders.map((order) => {
        const late = Boolean(order.dueDate && order.dueDate < new Date().toISOString().slice(0, 10));
        return <button className="attention-row" key={order.id} onClick={() => onOpenOrder(order.id)}><span className={`attention-mark ${late ? 'attention-mark--late' : ''}`} /><span className="attention-order"><strong>{order.number}</strong><small>{order.customerName}{order.customerCompany ? ` · ${order.customerCompany}` : ''}</small></span><span className={`attention-deadline ${late ? 'attention-deadline--late' : ''}`}>{late ? 'Vencida' : 'Entrega'} · {order.dueDate ? new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(new Date(`${order.dueDate}T12:00:00`)).replace('.', '') : '—'}</span><StatusBadge status={order.status} /><ChevronRight size={15} /></button>;
      })}</div>
      {data?.dueOrders.length === 0 && <EmptyState title="Tudo em dia" description="Não há entregas vencidas ou próximas do prazo." />}
    </section>}
    <section className="overview-grid">
      <article className="surface chart-panel"><div className="panel-heading"><div><h2>Movimentação das OPs</h2><p>Atualizações registradas no período</p></div><label className="select-wrap"><CalendarDays size={14} /><select value={period} onChange={(event) => setPeriod(event.target.value)} aria-label="Período do gráfico"><option value="7d">Últimos 7 dias</option><option value="30d">Últimos 30 dias</option><option value="all">Todo o período</option></select><ChevronDown size={14} /></label></div>
        <div className="chart-summary"><strong>{data?.series.reduce((sum, point) => sum + point.count, 0) || 0}</strong><span>movimentações no período</span></div>
        {data?.series.length ? <div className="bar-chart" role="img" aria-label="Gráfico de movimentações por dia">
          {data.series.map((point) => <div className="bar-column" key={point.day} title={`${formatDay(point.day)}: ${point.count} movimentações`}><span className="bar-value">{point.count || ''}</span><div className="bar-track"><i style={{ height: `${Math.max(point.count ? (point.count / max) * 100 : 3, 3)}%` }} /></div><small>{period === '7d' ? new Intl.DateTimeFormat('pt-BR', { weekday: 'short' }).format(new Date(`${point.day}T12:00:00`)).replace('.', '') : new Date(`${point.day}T12:00:00`).getDate()}</small></div>)}
        </div> : <EmptyState title="Sem movimentações no período" description="As atualizações de status das OPs aparecerão aqui." />}
        <div className="chart-legend"><span><i /> Movimentações registradas</span><span className="chart-range">{period === '7d' ? '7 dias' : period === '30d' ? '30 dias' : 'Histórico completo'}</span></div>
      </article>
      <article className="surface activity-panel"><div className="panel-heading"><div><h2>Atividade recente</h2><p>Últimas atualizações feitas pela equipe</p></div><span className="live-indicator"><i /> AO VIVO</span></div>
        {data?.activity.length ? <div className="activity-list">{data.activity.map((item, index) => <div className="activity-row" key={`${item.orderNumber}-${item.createdAt}-${index}`}><div className={`activity-marker marker-${STATUSES.indexOf(item.status)}`}>{[<ClipboardList size={15} />, <Factory size={15} />, <Truck size={15} />, <PackageCheck size={15} />][STATUSES.indexOf(item.status)]}</div><div className="activity-copy"><div><strong>{item.orderNumber}</strong><time>{formatDate(item.createdAt)}</time></div><p>{item.customerName} <span>·</span> {item.status}</p><small>Atualizado por {item.actorName}</small></div></div>)}</div> : <EmptyState title="Nenhuma atividade ainda" description="Quando sua equipe atualizar uma OP, o registro aparecerá aqui." />}
      </article>
    </section>
    <section className="surface table-panel dashboard-table"><div className="panel-heading"><div><h2>Últimas OPs cadastradas</h2><p>Pedidos criados mais recentemente</p></div><button className="text-button" onClick={onViewOrders}>Ver todas <ArrowRight size={15} /></button></div>
      {data?.orders.length ? <OrdersTable orders={data.orders} onOpen={onOpenOrder} /> : <EmptyState title="Sua operação começa aqui" description="Cadastre a primeira OP para acompanhar cada etapa do pedido." action={canEdit && <button className="button button--secondary" onClick={onCreate}><PackagePlus size={15} /> Cadastrar primeira OP</button>} />}
    </section>
    <footer className="content-footer"><span>OP TRACK FLEX PREMIUM <i /> Rastreabilidade operacional</span><span>Todos os dados são atualizados em tempo real</span></footer>
  </>;
}

function OrdersTable({ orders, onOpen }: { orders: Order[]; onOpen: (id: string) => void }) {
  return <div className="table-scroll"><table className="orders-table"><thead><tr><th>NÚMERO DA OP</th><th>CLIENTE</th><th>PRODUTO / PROJETO</th><th>RESPONSÁVEL</th><th>PRAZO</th><th>ETAPA ATUAL</th><th>ÚLTIMA MOVIMENTAÇÃO</th><th><span className="sr-only">Abrir</span></th></tr></thead><tbody>{orders.map((order) => {
    const late = Boolean(order.dueDate && order.dueDate < new Date().toISOString().slice(0, 10) && order.status !== STATUSES[3]);
    return <tr key={order.id} onClick={() => onOpen(order.id)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') onOpen(order.id); }}><td><button className="table-op-number" onClick={(event) => { event.stopPropagation(); onOpen(order.id); }}>{order.number}</button></td><td><span className="table-customer">{order.customerName}</span>{order.customerCompany && <small className="table-secondary">{order.customerCompany}</small>}</td><td><span className="table-product">{order.product}{order.quantity > 1 ? ` · ${order.quantity} un.` : ''}</span></td><td><span className="table-date">{order.assignedToName || 'Não atribuída'}</span></td><td><span className={`table-date ${late ? 'table-date--late' : ''}`}>{order.dueDate ? formatDate(`${order.dueDate}T12:00:00`, false) : 'Sem prazo'}</span></td><td><StatusBadge status={order.status} /></td><td><span className="table-date">{formatDate(order.updatedAt)}</span><small className="table-secondary">por {order.updatedByName}</small></td><td><button className="row-open" aria-label={`Abrir ${order.number}`} onClick={(event) => { event.stopPropagation(); onOpen(order.id); }}><ChevronRight size={17} /></button></td></tr>;
  })}</tbody></table></div>;
}

function EmptyState({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Package size={19} /></span><strong>{title}</strong><p>{description}</p>{action}</div>;
}

function OrdersPage({ refresh, seed, clearSeed, onOpenOrder, onCreate, canEdit }: { refresh: number; seed: string; clearSeed: () => void; onOpenOrder: (id: string) => void; onCreate: () => void; canEdit: boolean }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [search, setSearch] = useState(seed);
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => { if (seed) { setSearch(seed); clearSeed(); } }, [seed, clearSeed]);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setLoading(true); setError('');
      const params = new URLSearchParams(); if (search) params.set('search', search); if (status) params.set('status', status); if (from) params.set('from', from); if (to) params.set('to', to);
      api<{ orders: Order[] }>(`/api/orders?${params}`).then((result) => setOrders(result.orders)).catch((reason) => setError(reason.message)).finally(() => setLoading(false));
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [search, status, from, to, refresh]);
  const reset = () => { setSearch(''); setStatus(''); setFrom(''); setTo(''); };
  const filtersActive = search || status || from || to;
  return <>
    <PageHeading title="Ordens de produção" description="Consulte e acompanhe todas as OPs da sua operação." action={canEdit && <button className="button button--primary" onClick={onCreate}><PackagePlus size={16} /> Nova OP</button>} />
    <section className="surface list-surface">
      <div className="list-toolbar"><div className="list-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por OP, cliente ou projeto" aria-label="Buscar por OP, cliente ou projeto" /></div><label className="filter-select"><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Todos os status</option>{STATUSES.map((item) => <option key={item} value={item}>{item}</option>)}</select><ChevronDown size={14} /></label><label className="filter-date"><span>De</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} aria-label="Data inicial" /></label><label className="filter-date"><span>Até</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} aria-label="Data final" /></label>{filtersActive && <button className="reset-filters" onClick={reset}>Limpar filtros</button>}</div>
      <div className="list-meta"><span>{loading ? 'Carregando OPs…' : `${orders.length} ${orders.length === 1 ? 'OP encontrada' : 'OPs encontradas'}`}</span><span><i className="list-meta-dot" /> Dados atualizados automaticamente</span></div>
      {error ? <EmptyState title="Não foi possível carregar as OPs" description={error} /> : loading ? <div className="table-loading"><span className="spinner spinner--dark" /> Buscando ordens…</div> : orders.length ? <OrdersTable orders={orders} onOpen={onOpenOrder} /> : <EmptyState title={filtersActive ? 'Nenhuma OP encontrada' : 'Nenhuma OP cadastrada'} description={filtersActive ? 'Tente ajustar os filtros ou buscar por outro termo.' : 'Quando sua equipe cadastrar uma ordem de produção, ela aparecerá aqui.'} action={!filtersActive && canEdit && <button className="button button--secondary" onClick={onCreate}><PackagePlus size={15} /> Cadastrar primeira OP</button>} />}
    </section>
    <footer className="content-footer"><span>OP TRACK FLEX PREMIUM <i /> Consulta de ordens</span><span>Até 250 resultados por busca</span></footer>
  </>;
}

function blankOrder() { return { customerName: '', customerEmail: '', customerPhone: '', customerCompany: '', product: '', quantity: '1', dueDate: '', destination: '', internalNotes: '' }; }
type OrderFormValue = ReturnType<typeof blankOrder>;

function OrderFields({ value, setValue }: { value: OrderFormValue; setValue: (next: OrderFormValue) => void }) {
  const set = (key: keyof OrderFormValue) => (next: string) => setValue({ ...value, [key]: next });
  return <>
    <div className="form-section-heading"><span className="form-section-index">01</span><div><h3>Dados do cliente e do pedido</h3><p>Informações que identificam a ordem de produção.</p></div></div>
    <div className="form-grid"><Field label="Cliente / contato" value={value.customerName} onChange={set('customerName')} placeholder="Nome do contato ou cliente" required /><Field label="Empresa" value={value.customerCompany} onChange={set('customerCompany')} placeholder="Empresa atendida" /><Field label="Produto / projeto" value={value.product} onChange={set('product')} placeholder="Ex.: Clichê flexográfico — embalagem" required /><Field label="Quantidade" type="number" value={value.quantity} onChange={set('quantity')} min={1} max={1000000} step={1} required /><Field label="E-mail do cliente" type="email" value={value.customerEmail} onChange={set('customerEmail')} placeholder="cliente@empresa.com.br" /><Field label="Telefone" type="tel" value={value.customerPhone} onChange={set('customerPhone')} placeholder="(00) 00000-0000" /><Field label="Previsão de entrega" type="date" value={value.dueDate} onChange={set('dueDate')} /><Field label="Destino da entrega" value={value.destination} onChange={set('destination')} placeholder="Cidade, estado ou endereço" /></div>
    <div className="form-section-heading form-section-heading--second"><span className="form-section-index">02</span><div><h3>Observações internas</h3><p>Visíveis somente para a equipe OP TRACK FLEX PREMIUM.</p></div></div>
    <TextAreaField label="Anotações para a equipe" value={value.internalNotes} onChange={set('internalNotes')} placeholder="Detalhes úteis para acompanhar a produção…" rows={4} />
  </>;
}

function OrderCreate({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string, number: string, code: string) => void }) {
  const [value, setValue] = useState(blankOrder());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { const result = await api<{ order: Order; trackingCode: string }>('/api/orders', { method: 'POST', body: JSON.stringify(value) }); onCreated(result.order.id, result.order.number, result.trackingCode); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Não foi possível cadastrar esta OP.'); }
    finally { setBusy(false); }
  };
  return <>
    <PageHeading title="Cadastrar nova OP" description="Registre o pedido e gere os dados de acesso para o cliente." action={<button className="button button--quiet" onClick={onCancel}><ArrowLeft size={15} /> Voltar para OPs</button>} />
    <form className="surface order-form" onSubmit={submit}>
      <div className="order-form-top"><div className="order-form-symbol"><PackagePlus size={19} /></div><div><strong>Nova ordem de produção</strong><span>O número da OP e o código de rastreamento serão gerados ao salvar.</span></div><span className="required-legend"><i>*</i> Obrigatório</span></div>
      <div className="order-form-body"><OrderFields value={value} setValue={setValue} />{error && <InlineError>{error}</InlineError>}</div>
      <div className="order-form-footer"><span><ShieldCheck size={15} /> O código do cliente aparece uma única vez após o cadastro.</span><div><button type="button" className="button button--secondary" onClick={onCancel}>Cancelar</button><button className="button button--primary" disabled={busy}>{busy ? <span className="spinner" /> : <PackagePlus size={15} />} Cadastrar OP</button></div></div>
    </form>
    <footer className="content-footer"><span>OP TRACK FLEX PREMIUM <i /> Cadastro de OP</span><span>A primeira etapa será registrada automaticamente</span></footer>
  </>;
}

function TrackingCodeModal({ orderNumber, code, onClose }: { orderNumber: string; code: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(`OP: ${orderNumber}\nCódigo de rastreamento: ${code}`); setCopied(true); setCopyError(false); } catch { setCopied(false); setCopyError(true); } };
  return <Modal title="Compartilhe os dados de rastreamento" onClose={onClose} className="tracking-code-modal">
    <div className="token-success"><span><CheckCircle2 size={21} /></span><div><strong>{orderNumber} cadastrada</strong><small>Envie estes dados ao cliente para ele acompanhar a OP.</small></div></div>
    <div className="token-display"><span>NÚMERO DA OP</span><strong>{orderNumber}</strong><span>CÓDIGO INDIVIDUAL</span><strong className="token-code">{code}</strong></div>
    <div className="token-warning"><LockKeyhole size={15} /><p>Por segurança, o código completo só será exibido agora. Guarde-o ou compartilhe com o cliente.</p></div>
    {copyError && <p className="copy-error">Não foi possível copiar automaticamente. Selecione e copie os dados acima.</p>}
    <div className="modal-actions"><button className="button button--secondary" onClick={onClose}>Fechar</button><button className="button button--primary" onClick={copy}>{copied ? <Check size={16} /> : <Copy size={15} />}{copied ? 'Copiado' : 'Copiar dados'}</button></div>
  </Modal>;
}

function OrderDetail({ id, refresh, onBack, onChanged, onError, canEdit }: { id: string; refresh: number; onBack: () => void; onChanged: (message: string) => void; onError: (message: string) => void; canEdit: boolean }) {
  const [detail, setDetail] = useState<{ order: Order; events: Event[]; attachments: Attachment[] } | null>(null);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [editing, setEditing] = useState(false);
  const [confirmStatus, setConfirmStatus] = useState(false);
  const [note, setNote] = useState('');
  const [receivedBy, setReceivedBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [codeModal, setCodeModal] = useState('');
  const [editValue, setEditValue] = useState<OrderFormValue>(blankOrder());
  const [operations, setOperations] = useState({ assignedTo: '', pendingReason: '', nextActionDate: '', artworkStatus: 'not_required', artworkNote: '' });
  const [logistics, setLogistics] = useState({ deliveryMode: '', carrierName: '', driverName: '', driverPhone: '', deliveryForecast: '', trackingCode: '', trackingUrl: '' });
  const [attempt, setAttempt] = useState({ reason: '', nextAttemptDate: '' });
  const [upload, setUpload] = useState({ file: null as File | null, label: '', category: 'artwork' as Attachment['category'], customerVisible: false });
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [result, staff] = await Promise.all([api<{ order: Order; events: Event[]; attachments: Attachment[] }>(`/api/orders/${id}`), api<{ users: Assignee[] }>('/api/assignees')]);
      setDetail(result); setAssignees(staff.users);
      setEditValue({ customerName: result.order.customerName, customerEmail: result.order.customerEmail || '', customerPhone: result.order.customerPhone || '', customerCompany: result.order.customerCompany || '', product: result.order.product, quantity: String(result.order.quantity || 1), dueDate: result.order.dueDate || '', destination: result.order.destination || '', internalNotes: result.order.internalNotes || '' });
      setOperations({ assignedTo: result.order.assignedTo || '', pendingReason: result.order.pendingReason || '', nextActionDate: result.order.nextActionDate || '', artworkStatus: result.order.artworkStatus || 'not_required', artworkNote: result.order.artworkNote || '' });
      setLogistics({ deliveryMode: result.order.deliveryMode || '', carrierName: result.order.carrierName || '', driverName: result.order.driverName || '', driverPhone: result.order.driverPhone || '', deliveryForecast: result.order.deliveryForecast || '', trackingCode: result.order.trackingCode || '', trackingUrl: result.order.trackingUrl || '' });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Não foi possível carregar os dados da OP.'); }
  }, [id]);
  useEffect(() => { load(); }, [load, refresh]);
  if (!detail) return <div className="detail-loading"><span className="spinner spinner--dark" /> Carregando OP…{error && <InlineError>{error}</InlineError>}</div>;
  const { order, events, attachments } = detail;
  const nextStatus = STATUSES[STATUSES.indexOf(order.status) + 1];
  const stageEvents = events.filter((event) => !event.kind || event.kind === 'status');
  const fileEvents = events.filter((event) => event.kind === 'delivery_attempt');
  const save = async () => { setBusy(true); setError(''); try { await api(`/api/orders/${id}`, { method: 'PATCH', body: JSON.stringify(editValue) }); setEditing(false); await load(); onChanged('Dados da OP atualizados.'); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Não foi possível salvar.'); } finally { setBusy(false); } };
  const saveOperations = async () => { setBusy(true); setError(''); try { await api(`/api/orders/${id}/operations`, { method: 'POST', body: JSON.stringify(operations) }); await load(); onChanged('Responsável, pendências e aprovação atualizados.'); } catch (reason) { const message = reason instanceof Error ? reason.message : 'Não foi possível atualizar os dados operacionais.'; setError(message); onError(message); } finally { setBusy(false); } };
  const saveLogistics = async () => { setBusy(true); setError(''); try { await api(`/api/orders/${id}/logistics`, { method: 'PATCH', body: JSON.stringify(logistics) }); await load(); onChanged('Dados de entrega e logística atualizados.'); } catch (reason) { const message = reason instanceof Error ? reason.message : 'Não foi possível salvar a logística.'; setError(message); onError(message); } finally { setBusy(false); } };
  const saveAttempt = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { await api(`/api/orders/${id}/delivery-attempt`, { method: 'POST', body: JSON.stringify(attempt) }); setAttempt({ reason: '', nextAttemptDate: '' }); await load(); onChanged('Ocorrência de entrega registrada no histórico.'); } catch (reason) { const message = reason instanceof Error ? reason.message : 'Não foi possível registrar a ocorrência.'; setError(message); onError(message); } finally { setBusy(false); } };
  const uploadFile = async (event: FormEvent) => { event.preventDefault(); if (!upload.file) { setError('Selecione um arquivo para enviar.'); return; } setBusy(true); setError(''); try { await uploadPrivateAttachment(`/api/orders/${id}/files`, upload.file, upload); setUpload({ file: null, label: '', category: 'artwork', customerVisible: false }); await load(); onChanged('Arquivo salvo na área privada da OP.'); } catch (reason) { const message = reason instanceof Error ? reason.message : 'Não foi possível enviar o arquivo.'; setError(message); onError(message); } finally { setBusy(false); } };
  const advance = async () => { setBusy(true); try { await api(`/api/orders/${id}/status`, { method: 'POST', body: JSON.stringify({ status: nextStatus, note, receivedBy }) }); setConfirmStatus(false); setNote(''); setReceivedBy(''); await load(); onChanged(`Etapa atualizada: ${nextStatus}.`); } catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível atualizar o status.'); } finally { setBusy(false); } };
  const rotateCode = async () => { setBusy(true); try { const result = await api<{ trackingCode: string }>(`/api/orders/${id}/tracking-code`, { method: 'POST' }); setCodeModal(result.trackingCode); } catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível gerar outro código.'); } finally { setBusy(false); } };
  const modeLabel = order.deliveryMode === 'own_fleet' ? 'Frota própria' : order.deliveryMode === 'carrier' ? 'Transportadora' : order.deliveryMode === 'customer_pickup' ? 'Retirada pelo cliente' : 'Não definida';
  const artworkLabel = order.artworkStatus === 'approved' ? 'Aprovada' : order.artworkStatus === 'changes_requested' ? 'Precisa de ajuste' : order.artworkStatus === 'pending' ? 'Aguardando aprovação' : 'Não se aplica';
  return <>
    <div className="detail-breadcrumb"><button className="breadcrumb-link" onClick={onBack}><ArrowLeft size={15} /> Ordens de produção</button><ChevronRight size={14} /><span>{order.number}</span></div>
    <div className="detail-heading"><div><div className="detail-title-line"><h1>{order.number}</h1><StatusBadge status={order.status} /></div><p>Criada em {formatDate(order.createdAt)} por {order.createdByName} · Última atualização em {formatDate(order.updatedAt)} por {order.updatedByName}</p></div><div className="detail-actions">{canEdit && <><button className="button button--secondary" onClick={rotateCode} disabled={busy}><LockKeyhole size={15} /> Gerar código do cliente</button>{nextStatus && <button className="button button--primary" onClick={() => setConfirmStatus(true)} disabled={busy}><ArrowRight size={15} /> Avançar para {nextStatus}</button>}</>}</div></div>
    {error && <InlineError>{error}</InlineError>}
    <div className="detail-grid">
      <section className="surface detail-main"><div className="panel-heading"><div><h2>Acompanhamento da OP</h2><p>Histórico de etapas e atualizações registradas</p></div>{canEdit && <button className="icon-label-button" onClick={() => setEditing(!editing)}><Pencil size={15} /> {editing ? 'Cancelar edição' : 'Editar dados'}</button>}</div>
        <StatusTimeline events={stageEvents} current={order.status} />
        <div className="detail-history"><div className="history-header"><h3>Histórico de movimentações</h3><span>{events.length} {events.length === 1 ? 'registro' : 'registros'}</span></div>{events.map((event, index) => <div className="history-row" key={event.id || `${event.kind}-${event.createdAt}-${index}`}><span className={`history-point marker-${STATUSES.indexOf(event.status)}`} /><div className="history-copy"><div><strong>{event.summary || event.status}</strong><time>{formatDate(event.createdAt)}</time></div><span>Atualizado por {event.actorName || order.createdByName}</span>{event.note && <p className="history-note">{event.note}</p>}{event.kind === 'delivery_attempt' && <p className="history-note">Motivo: {String(event.details?.reason || 'Não informado')} · Próxima tentativa: {String(event.details?.nextAttemptDate || 'Não informada')}</p>}{event.kind === 'status' && typeof event.details?.receivedBy === 'string' && <p className="history-note">Recebido por: {event.details.receivedBy}</p>}</div></div>)}</div>
      </section>
      <aside className="detail-aside">
        {editing ? <section className="surface detail-card detail-edit-card"><div className="detail-card-heading"><h2>Editar informações</h2><p>As etapas e o histórico serão preservados.</p></div><div className="detail-edit-fields"><Field label="Cliente / contato" value={editValue.customerName} onChange={(value) => setEditValue({ ...editValue, customerName: value })} required /><Field label="Empresa" value={editValue.customerCompany} onChange={(value) => setEditValue({ ...editValue, customerCompany: value })} /><Field label="Produto / projeto" value={editValue.product} onChange={(value) => setEditValue({ ...editValue, product: value })} required /><Field label="Quantidade" type="number" value={editValue.quantity} onChange={(value) => setEditValue({ ...editValue, quantity: value })} min={1} max={1000000} step={1} required /><Field label="E-mail do cliente" type="email" value={editValue.customerEmail} onChange={(value) => setEditValue({ ...editValue, customerEmail: value })} /><Field label="Telefone" value={editValue.customerPhone} onChange={(value) => setEditValue({ ...editValue, customerPhone: value })} /><Field label="Prazo da OP" type="date" value={editValue.dueDate} onChange={(value) => setEditValue({ ...editValue, dueDate: value })} /><Field label="Destino" value={editValue.destination} onChange={(value) => setEditValue({ ...editValue, destination: value })} /><TextAreaField label="Observações internas" value={editValue.internalNotes} onChange={(value) => setEditValue({ ...editValue, internalNotes: value })} /></div><button className="button button--primary button--wide" onClick={save} disabled={busy}>{busy ? <span className="spinner" /> : <Check size={15} />} Salvar alterações</button></section> : <>
          <section className="surface detail-card"><div className="detail-card-heading"><h2>Dados do pedido</h2><p>Informações cadastradas pela equipe</p></div><InfoRow icon={<UserRound size={16} />} label="Cliente / contato" value={order.customerName} /><InfoRow icon={<Factory size={16} />} label="Empresa" value={order.customerCompany || 'Não informada'} /><InfoRow icon={<Package size={16} />} label="Produto / projeto" value={`${order.product}${order.quantity > 1 ? ` · ${order.quantity} unidades` : ''}`} /><InfoRow icon={<CalendarDays size={16} />} label="Prazo da OP" value={order.dueDate ? formatDate(`${order.dueDate}T12:00:00`, false) : 'Não informado'} /><InfoRow icon={<Mail size={16} />} label="E-mail" value={order.customerEmail || 'Não informado'} /><InfoRow icon={<Phone size={16} />} label="Telefone" value={order.customerPhone || 'Não informado'} /><InfoRow icon={<MapPin size={16} />} label="Destino" value={order.destination || 'Não informado'} /></section>
          {canEdit && <section className="tracking-share-card"><div className="share-card-icon"><LockKeyhole size={17} /></div><h3>Acesso do cliente</h3><p>Gere um código individual e compartilhe junto ao número da OP.</p><button className="button button--secondary button--wide" onClick={rotateCode} disabled={busy}><Copy size={14} /> Gerar código de rastreamento</button></section>}
        </>}
      </aside>
    </div>

    <section className="surface order-operations-panel"><div className="panel-heading"><div><h2>Responsável, pendências e arte</h2><p>Próximas ações e decisões da equipe, com registro de autoria.</p></div><span className="internal-only-badge"><LockKeyhole size={12} /> Interno</span></div>
      {canEdit ? <><div className="operations-fields"><label className="field"><span className="field-label">Responsável pela OP</span><span className="select-input-wrap"><select value={operations.assignedTo} onChange={(event) => setOperations({ ...operations, assignedTo: event.target.value })}><option value="">Sem responsável atribuído</option>{assignees.map((person) => <option key={person.id} value={person.id}>{person.name} · {userRoleLabel(person.role)}</option>)}</select><ChevronDown size={14} /></span></label><TextAreaField label="Pendência / motivo de parada" value={operations.pendingReason} onChange={(value) => setOperations({ ...operations, pendingReason: value })} placeholder="Ex.: aguardando aprovação da arte" rows={2} /><Field label="Próxima ação até" type="date" value={operations.nextActionDate} onChange={(value) => setOperations({ ...operations, nextActionDate: value })} /><label className="field"><span className="field-label">Aprovação da arte</span><span className="select-input-wrap"><select value={operations.artworkStatus} onChange={(event) => setOperations({ ...operations, artworkStatus: event.target.value })}><option value="not_required">Não se aplica</option><option value="pending">Aguardando aprovação</option><option value="approved">Aprovada</option><option value="changes_requested">Precisa de ajuste</option></select><ChevronDown size={14} /></span></label><TextAreaField label="Observação da arte" value={operations.artworkNote} onChange={(value) => setOperations({ ...operations, artworkNote: value })} placeholder="Orientação ou ajuste solicitado" rows={2} /></div><div className="operations-footer"><span>{order.artworkReviewedByName ? `Última revisão da arte por ${order.artworkReviewedByName} · ${formatDate(order.artworkReviewedAt)}` : 'A aprovação ficará registrada com o usuário e o horário.'}</span><button className="button button--secondary" onClick={saveOperations} disabled={busy}>{busy ? <span className="spinner" /> : <Check size={14} />} Salvar dados operacionais</button></div></> : <div className="operations-readonly"><InfoRow icon={<UserCheck size={16} />} label="Responsável" value={order.assignedToName || 'Não atribuído'} /><InfoRow icon={<CalendarDays size={16} />} label="Pendência" value={order.pendingReason || 'Nenhuma pendência registrada'} /><InfoRow icon={<Clock3 size={16} />} label="Próxima ação" value={order.nextActionDate ? formatDate(`${order.nextActionDate}T12:00:00`, false) : '—'} /><InfoRow icon={<FileText size={16} />} label="Aprovação da arte" value={`${artworkLabel}${order.artworkReviewedByName ? ` · por ${order.artworkReviewedByName} em ${formatDate(order.artworkReviewedAt)}` : ''}`} /></div>}
    </section>

    <section className="surface logistics-panel"><div className="panel-heading"><div><h2>Entrega e logística</h2><p>Dados operacionais da entrega. Telefone do motorista e ocorrências são visíveis somente à equipe.</p></div><span className="internal-only-badge"><Truck size={12} /> {modeLabel}</span></div>
      {canEdit ? <><div className="logistics-fields"><label className="field"><span className="field-label">Modalidade</span><span className="select-input-wrap"><select value={logistics.deliveryMode} onChange={(event) => setLogistics({ ...logistics, deliveryMode: event.target.value, ...(event.target.value === 'customer_pickup' ? { carrierName: '', driverName: '', driverPhone: '' } : {}) })}><option value="">Escolha a modalidade</option><option value="own_fleet">Frota própria</option><option value="carrier">Transportadora</option><option value="customer_pickup">Retirada pelo cliente</option></select><ChevronDown size={14} /></span></label>{logistics.deliveryMode === 'carrier' && <Field label="Transportadora" value={logistics.carrierName} onChange={(value) => setLogistics({ ...logistics, carrierName: value })} placeholder="Nome da transportadora" required />}{logistics.deliveryMode !== 'customer_pickup' && <><Field label="Motorista · somente equipe" value={logistics.driverName} onChange={(value) => setLogistics({ ...logistics, driverName: value })} placeholder="Nome do motorista" /><Field label="Telefone do motorista · somente equipe" value={logistics.driverPhone} onChange={(value) => setLogistics({ ...logistics, driverPhone: value })} placeholder="(00) 00000-0000" /></>}<Field label="Previsão de entrega" type="date" value={logistics.deliveryForecast} onChange={(value) => setLogistics({ ...logistics, deliveryForecast: value })} /><Field label="Código de rastreio da entrega" value={logistics.trackingCode} onChange={(value) => setLogistics({ ...logistics, trackingCode: value })} placeholder="Código da transportadora" /><Field label="Link de rastreio HTTPS" value={logistics.trackingUrl} onChange={(value) => setLogistics({ ...logistics, trackingUrl: value })} placeholder="https://transportadora.com/rastreio/..." /></div><div className="logistics-footer"><span>{order.departedAt ? `Saiu para entrega em ${formatDate(order.departedAt)} · registrado por ${order.departedByName || 'equipe'}` : 'A data, a hora e o responsável da saída são registrados ao avançar o status.'}{order.deliveredAt && <> · Entregue em {formatDate(order.deliveredAt)} por {order.deliveredByName || 'equipe'}{order.receivedBy ? ` · Recebido por ${order.receivedBy}` : ''}</>}</span><button className="button button--secondary" onClick={saveLogistics} disabled={busy}>{busy ? <span className="spinner" /> : <Check size={14} />} Salvar logística</button></div></> : <div className="logistics-readonly"><InfoRow icon={<Truck size={16} />} label="Modalidade" value={modeLabel} />{order.carrierName && <InfoRow icon={<Factory size={16} />} label="Transportadora" value={order.carrierName} />}{order.driverName && <InfoRow icon={<UserRound size={16} />} label="Motorista · equipe" value={`${order.driverName}${order.driverPhone ? ` · ${order.driverPhone}` : ''}`} />}<InfoRow icon={<CalendarDays size={16} />} label="Previsão" value={order.deliveryForecast ? formatDate(`${order.deliveryForecast}T12:00:00`, false) : 'Não informada'} />{order.trackingCode && <InfoRow icon={<Link2 size={16} />} label="Código de rastreio" value={order.trackingCode} />}{order.trackingUrl && <a className="tracking-external-link" href={order.trackingUrl} target="_blank" rel="noopener noreferrer">Abrir rastreio externo <Link2 size={13} /></a>}{order.departedAt && <InfoRow icon={<Clock3 size={16} />} label="Saiu para entrega" value={`${formatDate(order.departedAt)} · ${order.departedByName || 'equipe'}`} />}{order.deliveredAt && <InfoRow icon={<CheckCircle2 size={16} />} label="Entregue ao destino" value={`${formatDate(order.deliveredAt)} · ${order.deliveredByName || 'equipe'}${order.receivedBy ? ` · Recebido por ${order.receivedBy}` : ''}`} />}</div>}
      {canEdit && order.status === STATUSES[2] && <form className="delivery-attempt-form" onSubmit={saveAttempt}><div><strong>Registrar tentativa ou ocorrência</strong><p>O status permanece em “Saiu para entrega” e o registro anterior não é removido.</p></div><TextAreaField label="Motivo / ocorrência interna" value={attempt.reason} onChange={(value) => setAttempt({ ...attempt, reason: value })} placeholder="Ex.: endereço fechado" rows={2} /><Field label="Próxima tentativa" type="date" value={attempt.nextAttemptDate} onChange={(value) => setAttempt({ ...attempt, nextAttemptDate: value })} required /><button className="button button--secondary" disabled={busy}>{busy ? <span className="spinner" /> : <Clock3 size={14} />} Registrar ocorrência</button></form>}
      {!canEdit && fileEvents.map((event) => <p key={event.id} className="internal-event-note">{event.summary} · {formatDate(event.createdAt)} por {event.actorName} — {String(event.details?.reason || '')}</p>)}
    </section>

    <section className="surface attachments-panel"><div className="panel-heading"><div><h2>Arquivos do pedido</h2><p>Artes, aprovações e comprovantes guardados em área privada.</p></div><span className="internal-only-badge"><LockKeyhole size={12} /> Privado</span></div>
      {canEdit && <form className="attachment-upload-form" onSubmit={uploadFile}><Field label="Nome claro do arquivo" value={upload.label} onChange={(value) => setUpload({ ...upload, label: value })} placeholder="Ex.: Arte final aprovada" required /><label className="field"><span className="field-label">Categoria</span><span className="select-input-wrap"><select value={upload.category} onChange={(event) => setUpload({ ...upload, category: event.target.value as Attachment['category'], customerVisible: event.target.value === 'delivery_proof' ? upload.customerVisible : false })}><option value="artwork">Arte</option><option value="approval">Aprovação</option><option value="delivery_proof">Comprovante de entrega</option><option value="other">Outro arquivo</option></select><ChevronDown size={14} /></span></label><label className="field"><span className="field-label">Arquivo · PDF ou imagem até 6 MB</span><input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp" onChange={(event) => setUpload({ ...upload, file: event.target.files?.[0] || null })} required /></label>{upload.category === 'delivery_proof' && <label className="customer-share-check"><input type="checkbox" checked={upload.customerVisible} onChange={(event) => setUpload({ ...upload, customerVisible: event.target.checked })} /><span>Autorizar este comprovante no portal do cliente</span></label>}<button className="button button--primary" disabled={busy}>{busy ? <span className="spinner" /> : <Upload size={14} />} Adicionar arquivo</button></form>}
      {attachments.length ? <div className="attachments-list">{attachments.map((file) => <div className="attachment-row" key={file.id}><span className="attachment-icon"><FileText size={17} /></span><div className="attachment-copy"><strong>{file.label}</strong><span>{file.originalName} · {readableFileSize(file.sizeBytes)} · {file.category === 'artwork' ? 'Arte' : file.category === 'approval' ? 'Aprovação' : file.category === 'delivery_proof' ? 'Comprovante' : 'Outro'}</span><small>Enviado por {file.uploadedByName} · {formatDate(file.uploadedAt)}</small></div>{file.customerVisible && <span className="shared-proof-badge">Cliente autorizado</span>}<a className="attachment-download" href={`/api/orders/${id}/files/${file.id}`} target="_blank" rel="noopener noreferrer" aria-label={`Abrir ${file.label}`}><Download size={15} /></a></div>)}</div> : <EmptyState title="Nenhum arquivo nesta OP" description="Adicione arte, aprovação ou comprovante para reunir os documentos do pedido." />}
      <p className="attachment-security-note">Acesso autenticado para a equipe. O cliente só recebe comprovantes de entrega marcados explicitamente para compartilhamento.</p>
    </section>

    {confirmStatus && <Modal title="Confirmar avanço da OP" onClose={() => setConfirmStatus(false)} className="confirm-modal"><div className="confirm-body"><span className="confirm-icon"><ArrowRight size={18} /></span><p>Confirma a atualização da OP <strong>{order.number}</strong> para:</p><StatusBadge status={nextStatus} />{nextStatus === STATUSES[3] && <Field label="Nome de quem recebeu" value={receivedBy} onChange={setReceivedBy} placeholder="Pessoa que recebeu a OP" required />}<TextAreaField label="Observação interna (opcional)" value={note} onChange={setNote} placeholder="Adicione uma nota para o histórico interno" rows={3} /></div><div className="modal-actions"><button className="button button--secondary" onClick={() => setConfirmStatus(false)}>Cancelar</button><button className="button button--primary" onClick={advance} disabled={busy || (nextStatus === STATUSES[3] && !receivedBy.trim())}>{busy ? <span className="spinner" /> : <Check size={15} />} Confirmar atualização</button></div></Modal>}
    {codeModal && <TrackingCodeModal orderNumber={order.number} code={codeModal} onClose={() => setCodeModal('')} />}
  </>;
}

function InfoRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) { return <div className="info-row"><span className="info-icon">{icon}</span><div><small>{label}</small><strong>{value}</strong></div></div>; }

function TeamPage({ refresh, onChanged, onError, currentUserId }: { refresh: number; onChanged: (message: string) => void; onError: (message: string) => void; currentUserId: string }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [activeTab, setActiveTab] = useState<'requests' | 'team' | 'removed'>('requests');
  const [removingUser, setRemovingUser] = useState<ManagedUser | null>(null);
  const [createdAccount, setCreatedAccount] = useState<{ email: string; devVerificationCode?: string } | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [updatingId, setUpdatingId] = useState('');
  const [error, setError] = useState('');
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [role, setRole] = useState<User['role']>('operator');
  const load = useCallback(() => api<{ users: ManagedUser[] }>('/api/users').then((result) => setUsers(result.users)).catch((reason) => setError(reason.message)), []);
  useEffect(() => { load(); }, [load, refresh]);
  const create = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try {
    const result = await api<{ user: { email: string }; devVerificationCode?: string }>('/api/users', { method: 'POST', body: JSON.stringify({ name, email, password, role }) });
    setName(''); setEmail(''); setPassword(''); setShowForm(false); await load();
    setCreatedAccount({ email: result.user.email, devVerificationCode: result.devVerificationCode });
    onChanged('Conta criada. A pessoa precisa confirmar o e-mail antes da aprovação de acesso.');
  } catch (reason) { const message = reason instanceof Error ? reason.message : 'Não foi possível criar o acesso.'; setError(message); onError(message); } finally { setBusy(false); } };
  const updateUser = async (person: ManagedUser, changes: { role?: User['role']; active?: boolean }) => {
    setUpdatingId(person.id); setError('');
    try { await api(`/api/users/${person.id}`, { method: 'PATCH', body: JSON.stringify({ role: changes.role ?? person.role, active: changes.active ?? person.active }) }); await load(); onChanged(changes.active === undefined ? 'Perfil atualizado.' : changes.active ? 'Acesso aprovado e ativado.' : 'Acesso desativado.'); }
    catch (reason) { const message = reason instanceof Error ? reason.message : 'Não foi possível atualizar este acesso.'; setError(message); onError(message); await load(); }
    finally { setUpdatingId(''); }
  };
  const removeUser = async () => {
    if (!removingUser) return;
    const person = removingUser;
    setUpdatingId(person.id); setError('');
    try {
      const result = await api<{ removed: 'deleted' | 'archived' }>(`/api/users/${person.id}`, { method: 'DELETE' });
      setRemovingUser(null); await load();
      onChanged(result.removed === 'deleted' ? 'Conta removida.' : 'Acesso removido; histórico preservado na aba Removidas.');
    } catch (reason) { const message = reason instanceof Error ? reason.message : 'Não foi possível remover esta conta.'; setError(message); onError(message); }
    finally { setUpdatingId(''); }
  };
  const pendingCount = users.filter((person) => person.accountStatus === 'pending' && !person.removedAt).length;
  const removedCount = users.filter((person) => Boolean(person.removedAt)).length;
  const teamCount = users.length - pendingCount - removedCount;
  const visibleUsers = activeTab === 'requests' ? users.filter((person) => person.accountStatus === 'pending' && !person.removedAt) : activeTab === 'removed' ? users.filter((person) => Boolean(person.removedAt)) : users.filter((person) => person.accountStatus !== 'pending' && !person.removedAt);
  return <>
    <PageHeading title="Equipe e acessos" description="A Conta Proprietária aprova cadastros e concede perfis. Administradores e operadores cuidam das OPs." action={<button className="button button--primary" onClick={() => setShowForm(true)}><UsersRound size={16} /> Adicionar pessoa</button>} />
    {error && <InlineError>{error}</InlineError>}
    <section className="surface team-surface"><div className="team-tabs" role="tablist" aria-label="Acessos da equipe">
      <button role="tab" aria-selected={activeTab === 'requests'} className={activeTab === 'requests' ? 'team-tab team-tab--active' : 'team-tab'} onClick={() => setActiveTab('requests')}>Solicitações <span className="team-tab-count">{pendingCount}</span></button>
      <button role="tab" aria-selected={activeTab === 'team'} className={activeTab === 'team' ? 'team-tab team-tab--active' : 'team-tab'} onClick={() => setActiveTab('team')}>Equipe <span className="team-tab-count">{teamCount}</span></button>
      <button role="tab" aria-selected={activeTab === 'removed'} className={activeTab === 'removed' ? 'team-tab team-tab--active' : 'team-tab'} onClick={() => setActiveTab('removed')}>Removidas <span className="team-tab-count">{removedCount}</span></button>
    </div><div className="panel-heading"><div><h2>{activeTab === 'requests' ? 'Solicitações de acesso' : activeTab === 'removed' ? 'Contas removidas' : 'Contas liberadas'}</h2><p>{activeTab === 'requests' ? 'Somente a Conta Proprietária pode revisar e liberar estes cadastros.' : activeTab === 'removed' ? 'Acesso encerrado. Contas com histórico podem ser restauradas sem perder autoria das OPs.' : 'Contas ativas e desativadas que já passaram pela aprovação.'}</p></div><span className="team-count">{activeTab === 'requests' ? `${pendingCount} pendente${pendingCount === 1 ? '' : 's'}` : activeTab === 'removed' ? `${removedCount} removida${removedCount === 1 ? '' : 's'}` : `${teamCount} conta${teamCount === 1 ? '' : 's'}`}</span></div>
      <div className="team-table"><div className="team-table-head"><span>USUÁRIO</span><span>PERFIL</span><span>STATUS</span><span>CRIADO EM</span><span>AÇÃO</span></div>{visibleUsers.map((person) => {
        const roleLabel = userRoleLabel(person.role);
        const self = person.id === currentUserId;
        const unverified = !person.emailVerifiedAt;
        const awaitingEmail = person.accountStatus === 'pending' && unverified && !person.removedAt;
        const statusLabel = person.removedAt ? 'Removida' : awaitingEmail ? 'Aguardando confirmação do e-mail' : person.accountStatus === 'pending' ? 'Aguardando aprovação' : person.active ? 'Ativo' : 'Desativado';
        return <div className="team-row" key={person.id}><div className="team-user"><span className="avatar">{initials(person.name)}</span><div><strong>{person.name}</strong><small>{person.email}</small></div></div>
          {person.role === 'owner' ? <div className="team-role-control"><span className="role-label role-label--admin">Conta Proprietária</span><small>Controle total</small></div> : <label className="field team-role-control"><span className="sr-only">Perfil de {person.name}</span><span className="select-input-wrap"><select value={person.role} disabled={self || Boolean(person.removedAt) || updatingId === person.id} onChange={(event) => updateUser(person, { role: event.target.value as User['role'] })}><option value="admin">Administrador</option><option value="operator">Operador</option><option value="viewer">Consulta</option></select><ChevronDown size={13} /></span><small>{roleLabel}</small></label>}
          <span className={`user-state ${person.removedAt ? 'user-state--removed' : `user-state--${person.accountStatus}`}`}><i /> {statusLabel}</span><span className="table-date">{formatDate(person.createdAt, false)}</span>
          <div className="team-actions">{person.removedAt ? <button className="button button--primary team-user-action" disabled={updatingId === person.id} onClick={() => updateUser(person, { active: true })}>{updatingId === person.id ? <span className="spinner" /> : <Check size={13} />} Restaurar</button> : <><button className={`button ${person.active ? 'button--secondary' : 'button--primary'} team-user-action`} disabled={self || awaitingEmail || updatingId === person.id} title={awaitingEmail ? 'Aguarde a confirmação enviada para o e-mail desta pessoa.' : undefined} onClick={() => updateUser(person, { active: !person.active })}>{updatingId === person.id ? <span className="spinner spinner--dark" /> : awaitingEmail ? <Mail size={13} /> : person.accountStatus === 'pending' ? <Check size={13} /> : person.active ? <X size={13} /> : <Check size={13} />}{awaitingEmail ? 'Aguardando e-mail' : person.accountStatus === 'pending' ? 'Aprovar' : person.active ? 'Desativar' : 'Reativar'}</button><button className="button button--secondary team-user-remove" aria-label={`Remover ${person.name}`} title="Remover conta" disabled={person.role === 'owner' || updatingId === person.id} onClick={() => setRemovingUser(person)}><Trash2 size={13} /></button></>}</div>
        </div>;
      })}{visibleUsers.length === 0 && <div className="team-empty"><CheckCircle2 size={18} /><strong>{activeTab === 'requests' ? 'Nenhuma solicitação pendente' : activeTab === 'removed' ? 'Nenhuma conta removida' : 'Nenhuma conta nesta lista'}</strong><span>{activeTab === 'requests' ? 'Novos cadastros aparecerão aqui para aprovação.' : activeTab === 'removed' ? 'Contas com histórico aparecerão aqui e poderão ser restauradas.' : 'Use “Adicionar pessoa” para criar um acesso diretamente.'}</span></div>}</div>
    </section>
    <div className="team-permissions"><ShieldCheck size={16} /><div><strong>Controle de acesso</strong><p>A Conta Proprietária é a única que aprova cadastros, cria administradores e gerencia perfis. Administradores e operadores atualizam OPs; Consulta é somente leitura. Novos cadastros começam sem acesso.</p></div></div>
    {showForm && <Modal title="Adicionar pessoa à equipe" onClose={() => { setShowForm(false); setError(''); }}><form className="team-form" onSubmit={create}><Field label="Nome completo" value={name} onChange={setName} placeholder="Nome da pessoa" required /><Field label="E-mail" type="email" value={email} onChange={setEmail} placeholder="nome@empresa.com.br" required /><Field label="Senha inicial" type="password" value={password} onChange={setPassword} placeholder="Mínimo de 12 caracteres" minLength={12} required /><label className="field"><span className="field-label">Perfil de acesso</span><span className="select-input-wrap"><select value={role} onChange={(event) => setRole(event.target.value as User['role'])}><option value="operator">Operador</option><option value="viewer">Consulta</option><option value="admin">Administrador</option></select><ChevronDown size={14} /></span></label>{error && <InlineError>{error}</InlineError>}<div className="modal-actions"><button type="button" className="button button--secondary" onClick={() => setShowForm(false)}>Cancelar</button><button className="button button--primary" disabled={busy}>{busy ? <span className="spinner" /> : <UsersRound size={15} />} Criar acesso</button></div></form></Modal>}
    {createdAccount && <Modal title="Conta criada" onClose={() => setCreatedAccount(null)}><div className="created-account-notice"><p>{createdAccount.devVerificationCode ? <>Use o código de desenvolvimento para confirmar o e-mail de <strong>{createdAccount.email}</strong>. Depois, a Conta Proprietária deverá aprovar o acesso.</> : <>Enviamos a confirmação para <strong>{createdAccount.email}</strong>. A pessoa precisa confirmar o e-mail e, depois, aguardar a aprovação da Conta Proprietária.</>}</p>{createdAccount.devVerificationCode && <div className="auth-verification-code"><span>Código de desenvolvimento · somente local</span><strong>{createdAccount.devVerificationCode}</strong></div>}<div className="modal-actions"><button className="button button--primary" onClick={() => setCreatedAccount(null)}>Entendi</button></div></div></Modal>}
    {removingUser && <Modal title="Remover conta?" onClose={() => setRemovingUser(null)} className="remove-account-modal"><div className="remove-account-copy"><strong>{removingUser.name}</strong><p>{removingUser.accountStatus === 'pending' ? 'Esta solicitação ainda não foi aprovada. A conta pendente será apagada e o e-mail poderá ser cadastrado novamente.' : 'O acesso será encerrado e as sessões revogadas. Se houver OPs ou arquivos associados, a conta será arquivada em Removidas para preservar o histórico; sem histórico, o registro será apagado.'}</p></div><div className="modal-actions"><button className="button button--secondary" onClick={() => setRemovingUser(null)}>Cancelar</button><button className="button button--danger" disabled={updatingId === removingUser.id} onClick={removeUser}>{updatingId === removingUser.id ? <span className="spinner" /> : <Trash2 size={14} />} Confirmar remoção</button></div></Modal>}
  </>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
