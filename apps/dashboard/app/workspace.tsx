'use client';
import { useEffect, useState, useCallback } from 'react';
import { DateTime } from 'luxon';
import {
  AudioLines,
  CalendarDays,
  LayoutDashboard,
  Users,
  Phone,
  Settings,
  Activity,
  FlaskConical,
  Plus,
  ChevronLeft,
  ChevronRight,
  ArrowUpRight,
  ArrowRight,
  Check,
  Clock,
  RefreshCw,
  LogOut,
  Menu,
  Search,
  ShieldCheck,
  X,
  AlertCircle,
  CalendarCheck,
  Headphones,
  MessageSquare,
  BookOpen,
  CheckCircle2,
  ExternalLink,
} from 'lucide-react';
import { api, ApiError, setCsrf, money, localTime, type Bootstrap } from './lib';
import { BookingDialog, AppointmentDialog, BlockDialog } from './booking-dialog';
import { SettingsView } from './settings-view';
import { Simulator } from './simulator';
type View =
  'overview' | 'schedule' | 'customers' | 'calls' | 'operations' | 'settings' | 'simulator';
const nav = [
  ['overview', 'Overview', LayoutDashboard],
  ['schedule', 'Schedule', CalendarDays],
  ['customers', 'Customers', Users],
  ['calls', 'Calls & leads', Phone],
  ['operations', 'Operations', Activity],
  ['simulator', 'Receptionist lab', FlaskConical],
  ['settings', 'Settings', Settings],
] as const;
export function Badge({ state }: { state: string }) {
  return (
    <span className={'badge ' + state.toLowerCase()}>
      {state.replaceAll('_', ' ').toLowerCase()}
    </span>
  );
}
export function Empty({
  icon: Icon = CalendarDays,
  title,
  children,
}: {
  icon?: any;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={25} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function Panel({
  title,
  subtitle,
  action,
  children,
  className = '',
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={'panel ' + className}>
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
export default function Dashboard() {
  const [auth, setAuth] = useState<any>(undefined),
    [data, setData] = useState<Bootstrap | null>(null),
    [error, setError] = useState(''),
    [view, setView] = useState<View>('overview'),
    [mobile, setMobile] = useState(false),
    [refresh, setRefresh] = useState(0);
  const [metrics, setMetrics] = useState<any>({}),
    [appointments, setAppointments] = useState<any[]>([]),
    [blocks, setBlocks] = useState<any[]>([]),
    [slots, setSlots] = useState<any[]>([]),
    [date, setDate] = useState(''),
    [dialog, setDialog] = useState<any>(null),
    [toast, setToast] = useState('');
  useEffect(() => {
    api('/auth/me')
      .then((v) => {
        setCsrf(v.csrf);
        setAuth(v);
      })
      .catch(() => setAuth(null));
  }, []);
  const load = useCallback(async () => {
    if (!auth) return;
    try {
      const b = await api('/v1/bootstrap');
      setData(b);
      const zone = b.locations[0].timezone;
      const day = date || DateTime.now().setZone(zone).toISODate()!;
      if (!date) setDate(day);
      const start = DateTime.fromISO(day, { zone }).startOf('week'),
        end = start.plus({ weeks: 1 });
      const [m, a, s] = await Promise.all([
        api('/v1/metrics'),
        api(
          `/v1/appointments?from=${encodeURIComponent(start.toUTC().toISO()!)}&to=${encodeURIComponent(end.toUTC().toISO()!)}`,
        ),
        b.services.find((s: any) => s.active)
          ? api(
              '/v1/availability?' +
                new URLSearchParams({
                  locationId: b.locations[0].id,
                  serviceId: b.services.find((s: any) => s.active).id,
                  from: new Date().toISOString(),
                  limit: '5',
                }),
            ).catch(() => ({ slots: [] }))
          : Promise.resolve({ slots: [] }),
      ]);
      setMetrics(m);
      setAppointments(a.appointments);
      setBlocks(a.blocks);
      setSlots(s.slots);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [auth, date]);
  useEffect(() => {
    load();
  }, [load, refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  const changed = (message = 'Changes saved') => {
    setRefresh((r) => r + 1);
    setToast(message);
  };
  if (auth === undefined)
    return (
      <div className="loading-screen">
        <AudioLines size={36} />
        <p>Opening your workspace…</p>
      </div>
    );
  if (!auth)
    return (
      <Login
        onLogin={(v) => {
          setCsrf(v.csrf);
          setAuth(v);
        }}
      />
    );
  if (!data)
    return (
      <div className="loading-screen">
        <AudioLines size={36} />
        <p>{error || 'Loading appointments…'}</p>
        {error && <button onClick={() => load()}>Retry</button>}
      </div>
    );
  const location = data.locations[0],
    zone = location.timezone,
    today = DateTime.now().setZone(zone).toISODate(),
    todayItems = appointments.filter(
      (a) =>
        localTime(a.starts_at, zone, 'yyyy-MM-dd') === date &&
        !['CANCELLED', 'EXPIRED'].includes(a.state),
    );
  const name = nav.find((n) => n[0] === view)?.[1];
  return (
    <div className="shell">
      <aside className={'sidebar ' + (mobile ? 'open' : '')}>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setView('overview');
          }}
        >
          <span className="brand-mark">
            <AudioLines size={23} />
          </span>
          frontdesk<span className="brand-dot">.</span>
        </a>
        <div className="business-switch">
          <span className="business-avatar">
            {data.tenant.name
              .split(' ')
              .slice(0, 2)
              .map((n: string) => n[0])
              .join('')
              .toUpperCase()}
          </span>
          <div>
            <strong>{data.tenant.name.replace(' · Demo', '')}</strong>
            <small>{location.name}</small>
          </div>
          {auth.development && <span className="demo-tag">DEMO</span>}
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav>
          {nav.map(([id, label, Icon]) => (
            <button
              key={id}
              className={view === id ? 'active' : ''}
              onClick={() => {
                setView(id);
                setMobile(false);
              }}
            >
              <Icon size={19} />
              <span>{label}</span>
              {id === 'calls' && metrics.open_leads > 0 && <b>{metrics.open_leads}</b>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="pilot-status">
            <span className="status-dot" />
            <strong>{auth.development ? 'Development workspace' : 'Pilot workspace'}</strong>
            <p>
              {data.providerStatus.voice && data.settings.approved_for_live
                ? 'Live calling enabled.'
                : 'Live calls are not activated.'}
            </p>
            <button onClick={() => setView('operations')}>
              View launch checklist <ArrowRight size={14} />
            </button>
          </div>
          <button
            className="account"
            onClick={async () => {
              await api('/auth/logout', 'POST');
              setAuth(null);
              setData(null);
            }}
          >
            <span className="avatar">O</span>
            <span>
              <strong>Owner workspace</strong>
              <small>{data.role.toLowerCase()} access</small>
            </span>
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div>
            <button
              className="icon-button mobile-toggle"
              aria-label="Open navigation"
              onClick={() => setMobile(!mobile)}
            >
              <Menu size={20} />
            </button>
            <span className="breadcrumb">Workspace</span>
            <span className="slash">/</span>
            <strong>{name}</strong>
          </div>
          <div className="topbar-right">
            <span className="timezone">
              <Clock size={14} /> {zone}
            </span>
            <span className="recording-off">
              <ShieldCheck size={14} /> Recording off
            </span>
            <button
              className="icon-button"
              aria-label="Refresh workspace"
              onClick={() => changed('Workspace refreshed')}
            >
              <RefreshCw size={17} />
            </button>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {view === 'overview'
                  ? DateTime.fromISO(date, { zone }).toFormat('cccc, LLLL d, yyyy')
                  : 'FRONTDESK WORKSPACE'}
              </div>
              <h1>{view === 'overview' ? 'A clear view of your day.' : name}</h1>
              <p>
                {
                  {
                    overview: 'Every appointment, conversation, and next step. In one place.',
                    schedule: 'Manage the schedule your receptionist uses.',
                    customers: 'Customer details and appointment history.',
                    calls: 'Review conversations and close the loop on missed opportunities.',
                    operations: 'Message delivery, calendar health, and a complete audit trail.',
                    settings: 'Give your receptionist accurate information and clear boundaries.',
                    simulator: 'Exercise the booking workflow before connecting a phone number.',
                  }[view]
                }
              </p>
            </div>
            <div className="heading-actions">
              {['overview', 'schedule'].includes(view) && (
                <>
                  <button className="button secondary" onClick={() => setDialog({ kind: 'block' })}>
                    <Clock size={16} /> Block time
                  </button>
                  <button className="button primary" onClick={() => setDialog({ kind: 'book' })}>
                    <Plus size={17} /> New appointment
                  </button>
                </>
              )}
            </div>
          </div>
          {error && (
            <div className="notice danger">
              <AlertCircle size={18} />
              {error}
              <button onClick={() => load()}>Retry</button>
            </div>
          )}
          {view === 'overview' && (
            <>
              <div className="activation-banner">
                <div className="banner-icon">
                  <Headphones size={23} />
                </div>
                <div>
                  <strong>Your receptionist is ready for a test run.</strong>
                  <p>
                    Use the lab to book an appointment, trigger a conflict, and review the result.
                  </p>
                </div>
                <button className="button secondary" onClick={() => setView('simulator')}>
                  Open receptionist lab <ArrowUpRight size={16} />
                </button>
              </div>
              <div className="metrics-grid">
                {[
                  [
                    CalendarCheck,
                    'Confirmed appointments',
                    metrics.bookings || 0,
                    'All confirmed appointments',
                  ],
                  [
                    Phone,
                    'Calls handled',
                    metrics.calls || 0,
                    'Last 30 days · includes simulations',
                  ],
                  [
                    Users,
                    'Open follow-ups',
                    metrics.open_leads || 0,
                    'Customers waiting for your team',
                  ],
                  [
                    ShieldCheck,
                    'Booking conflicts',
                    metrics.conflicts || 0,
                    'Requests safely rejected',
                  ],
                ].map(([Icon, label, value, caption]: any) => (
                  <div className="metric" key={label}>
                    <div>
                      <span>{label}</span>
                      <Icon size={18} />
                    </div>
                    <strong>{value}</strong>
                    <small>{caption}</small>
                  </div>
                ))}
              </div>
              <Panel
                title="Reception performance"
                subtitle="Phone metrics cover 30 days. Lead and delivery totals reflect their current status."
              >
                <div className="detail-pad metrics-grid">
                  {[
                    ['Answered phone calls', metrics.answered_calls || 0],
                    ['Human transfers', metrics.transfers || 0],
                    ['Closed unconverted leads', metrics.lost_leads || 0],
                    ['Delivery failures', metrics.failures || 0],
                    ['Average phone call', Math.round(metrics.average_duration || 0) + 's'],
                    ['Estimated call cost', money(Math.round(metrics.cost_cents || 0))],
                    [
                      'Cost per phone booking',
                      metrics.telephone_bookings
                        ? money(Math.round(metrics.cost_cents / metrics.telephone_bookings))
                        : '—',
                    ],
                  ].map(([label, value]) => (
                    <div className="metric" key={String(label)}>
                      <div>{label}</div>
                      <strong>{value}</strong>
                    </div>
                  ))}
                </div>
                <div className="panel-footer">
                  Cost uses a planning allowance of $0.20 per phone minute, not provider billing.
                  Verify against invoices.
                </div>
              </Panel>
              <div className="overview-grid">
                <Panel
                  title={date === today ? "Today's appointments" : 'Appointments'}
                  subtitle={DateTime.fromISO(date).toFormat('cccc, LLLL d')}
                  action={
                    <button className="text-button" onClick={() => setView('schedule')}>
                      View calendar <ArrowRight size={15} />
                    </button>
                  }
                >
                  <div className="day-controls">
                    <button
                      className="icon-button"
                      aria-label="Previous day"
                      onClick={() =>
                        setDate(DateTime.fromISO(date).minus({ days: 1 }).toISODate()!)
                      }
                    >
                      <ChevronLeft size={18} />
                    </button>
                    <button className="text-button" onClick={() => setDate(today!)}>
                      Today
                    </button>
                    <input
                      aria-label="Appointment date"
                      type="date"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                    />
                    <button
                      className="icon-button"
                      aria-label="Next day"
                      onClick={() => setDate(DateTime.fromISO(date).plus({ days: 1 }).toISODate()!)}
                    >
                      <ChevronRight size={18} />
                    </button>
                  </div>
                  {todayItems.length ? (
                    <AppointmentList
                      items={todayItems}
                      zone={zone}
                      onSelect={(a: any) => setDialog({ kind: 'appointment', appointment: a })}
                    />
                  ) : (
                    <Empty title="A little breathing room.">
                      No appointments on this day. Add one manually or book through the receptionist
                      lab.
                    </Empty>
                  )}
                  <div className="panel-footer">
                    <span className="status-dot" /> Availability includes staff schedules, bay
                    capacity, and service buffers.
                  </div>
                </Panel>
                <div className="right-stack">
                  <Panel
                    title="Next available"
                    subtitle={data.services.find((s) => s.active)?.name || 'Configure a service'}
                    action={<span className="small-label">LIVE DATA</span>}
                  >
                    {slots.length ? (
                      <div className="slots-list">
                        {slots.map((slot, i) => (
                          <button key={i} onClick={() => setDialog({ kind: 'book', slot })}>
                            <span className="slot-day">
                              {localTime(slot.startsAt, zone, 'ccc')}
                              <b>{localTime(slot.startsAt, zone, 'd')}</b>
                            </span>
                            <span>
                              <strong>{localTime(slot.startsAt, zone)}</strong>
                              <small>{slot.staffName}</small>
                            </span>
                            <Plus size={17} />
                          </button>
                        ))}
                      </div>
                    ) : (
                      <Empty title="No open slots">Check hours, services, and blocked time.</Empty>
                    )}
                  </Panel>
                  <Panel title="Connected services">
                    <div className="connection-row">
                      <span className="connection-logo google">G</span>
                      <div>
                        <strong>Google Calendar</strong>
                        <small>Appointment mirror</small>
                      </div>
                      <Badge
                        state={data.providerStatus.calendar ? 'CONFIGURED' : 'NOT_CONNECTED'}
                      />
                    </div>
                    <div className="connection-row">
                      <span className="connection-logo">
                        <Phone size={18} />
                      </span>
                      <div>
                        <strong>Phone & messages</strong>
                        <small>Twilio</small>
                      </div>
                      <Badge state={data.providerStatus.voice ? 'CONFIGURED' : 'NOT_CONNECTED'} />
                    </div>
                    <button
                      className="text-button connection-link"
                      onClick={() => setView('operations')}
                    >
                      Manage connections <ArrowRight size={15} />
                    </button>
                  </Panel>
                </div>
              </div>
            </>
          )}
          {view === 'schedule' && (
            <Schedule
              data={data}
              date={date}
              setDate={setDate}
              appointments={appointments}
              blocks={blocks}
              onSelect={(a: any) => setDialog({ kind: 'appointment', appointment: a })}
              onNew={(startsAt: string) => setDialog({ kind: 'book', slot: { startsAt } })}
              onChange={changed}
            />
          )}
          {view === 'customers' && <Customers data={data} refresh={refresh} />}
          {view === 'calls' && <Calls refresh={refresh} onChange={changed} />}
          {view === 'operations' && <Operations data={data} refresh={refresh} onChange={changed} />}
          {view === 'settings' && <SettingsView data={data} onChange={changed} />}
          {view === 'simulator' && <Simulator data={data} onChange={changed} />}
          <footer className="workspace-footer">
            <span>Frontdesk · Pilot build 0.1.0</span>
            <span>
              {data.databaseMode === 'development-wasm'
                ? 'Local PostgreSQL-WASM · native concurrency validation pending'
                : 'Shared appointment schedule'}{' '}
              · No call recordings
            </span>
          </footer>
        </main>
      </div>
      {dialog?.kind === 'book' && (
        <BookingDialog
          data={data}
          slot={dialog.slot}
          close={() => setDialog(null)}
          saved={() => {
            setDialog(null);
            changed('Appointment committed to the booking database');
          }}
        />
      )}
      {dialog?.kind === 'appointment' && (
        <AppointmentDialog
          data={data}
          appointment={dialog.appointment}
          close={() => setDialog(null)}
          saved={() => {
            setDialog(null);
            changed('Appointment updated');
          }}
        />
      )}
      {dialog?.kind === 'block' && (
        <BlockDialog
          data={data}
          close={() => setDialog(null)}
          saved={() => {
            setDialog(null);
            changed('Time blocked');
          }}
        />
      )}
      {toast && (
        <div role="status" className="toast">
          <CheckCircle2 size={18} />
          {toast}
          <button aria-label="Dismiss notification" onClick={() => setToast('')}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
function Login({ onLogin }: { onLogin: (v: any) => void }) {
  const [code, setCode] = useState(''),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [dev, setDev] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api('/auth/config')
      .then((c) => setDev(c.development))
      .catch(() => setError('The backend is not available. Start the API server first.'));
  }, []);
  return (
    <div className="login-page">
      <div className="login-story">
        <a className="brand">
          <span className="brand-mark">
            <AudioLines size={23} />
          </span>
          frontdesk.
        </a>
        <div>
          <span className="eyebrow">MORE TIME FOR YOUR CUSTOMERS</span>
          <h1>
            A warm welcome.
            <br />A dependable schedule.
          </h1>
          <p>Your appointments, conversations, and follow-ups — brought together.</p>
          <div className="login-chips">
            <span>
              <CalendarCheck size={17} /> One shared schedule
            </span>
            <span>
              <ShieldCheck size={17} /> Protected bookings
            </span>
            <span>
              <Headphones size={17} /> Human handoff
            </span>
          </div>
        </div>
        <small>AI reception, with your team in control.</small>
      </div>
      <div className="login-form">
        <span className="empty-icon">
          <AudioLines size={26} />
        </span>
        <h2>Welcome to your workspace</h2>
        <p>Sign in to manage your business.</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              onLogin(
                await api('/auth/login', 'POST', dev ? { accessCode: code } : { email, password }),
              );
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {dev ? (
            <label>
              Local owner access code
              <input
                autoComplete="off"
                type="password"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
              <small>Use the generated code in .local/owner-access-code.txt.</small>
            </label>
          ) : (
            <>
              <label>
                Email
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="username"
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                />
              </label>
            </>
          )}
          {error && (
            <div role="alert" className="notice danger">
              {error}
            </div>
          )}
          <button className="button primary full" disabled={busy}>
            {busy ? 'Signing in…' : 'Open workspace'} <ArrowRight size={17} />
          </button>
        </form>
        <p className="login-footnote">
          {dev
            ? 'Local development access. Live services are disabled.'
            : 'Access is limited to invited business members.'}
        </p>
      </div>
    </div>
  );
}
function AppointmentList({
  items,
  zone,
  onSelect,
}: {
  items: any[];
  zone: string;
  onSelect: (a: any) => void;
}) {
  return (
    <div className="appointment-list">
      {items.map((a) => (
        <button key={a.id} className="appointment-row" onClick={() => onSelect(a)}>
          <div className="appointment-time">
            <strong>{localTime(a.starts_at, zone)}</strong>
            <small>{localTime(a.ends_at, zone)}</small>
          </div>
          <div className="appointment-stripe" />
          <div className="appointment-info">
            <strong>{a.customer_name}</strong>
            <span>
              {a.service_name} <i>·</i> {a.staff_name}
            </span>
          </div>
          <div className="appointment-end">
            <Badge state={a.state} />
            <small>{money(a.price_cents)}</small>
          </div>
          <ChevronRight size={16} />
        </button>
      ))}
    </div>
  );
}
function Schedule({ data, date, setDate, appointments, blocks, onSelect, onNew, onChange }: any) {
  const [mode, setMode] = useState('calendar'),
    zone = data.locations[0].timezone,
    start = DateTime.fromISO(date, { zone }).startOf('week'),
    days = Array.from({ length: 7 }, (_, i) => start.plus({ days: i }));
  return (
    <Panel
      title={start.toFormat('LLLL yyyy')}
      action={
        <div className="segmented">
          <button
            className={mode === 'calendar' ? 'selected' : ''}
            onClick={() => setMode('calendar')}
          >
            Calendar
          </button>
          <button className={mode === 'list' ? 'selected' : ''} onClick={() => setMode('list')}>
            List
          </button>
        </div>
      }
    >
      <div className="calendar-controls">
        <button
          className="button secondary small"
          onClick={() => setDate(DateTime.now().setZone(zone).toISODate())}
        >
          Today
        </button>
        <button
          className="icon-button"
          aria-label="Previous week"
          onClick={() => setDate(start.minus({ weeks: 1 }).toISODate())}
        >
          <ChevronLeft size={18} />
        </button>
        <button
          className="icon-button"
          aria-label="Next week"
          onClick={() => setDate(start.plus({ weeks: 1 }).toISODate())}
        >
          <ChevronRight size={18} />
        </button>
        <span>
          {start.toFormat('LLL d')} – {start.plus({ days: 6 }).toFormat('LLL d')}
        </span>
        <span className="muted">{zone}</span>
      </div>
      {mode === 'list' ? (
        <>
          {appointments.length ? (
            <AppointmentList items={appointments} zone={zone} onSelect={onSelect} />
          ) : (
            <Empty title="No appointments this week">
              Choose a day in the calendar to create one.
            </Empty>
          )}
        </>
      ) : (
        <div className="calendar-scroll">
          <div className="week-grid">
            <div className="time-header" />
            {days.map((day) => (
              <div
                className={'day-header ' + (day.toISODate() === date ? 'chosen' : '')}
                key={day.toISODate()}
              >
                <small>{day.toFormat('ccc')}</small>
                <button onClick={() => setDate(day.toISODate())}>{day.day}</button>
              </div>
            ))}
            <div className="time-column">
              {Array.from({ length: 12 }, (_, i) => (
                <span key={i}>
                  {i + 8 > 12 ? i - 4 : i + 8}
                  {i + 8 >= 12 ? ' PM' : ' AM'}
                </span>
              ))}
            </div>
            {days.map((day) => (
              <div className="day-column" key={day.toISODate()}>
                {Array.from({ length: 12 }, (_, i) => (
                  <button
                    key={i}
                    aria-label={`Book ${day.toFormat('cccc')} at ${i + 8}:00`}
                    className="hour-cell"
                    onClick={() =>
                      onNew(
                        day
                          .set({ hour: i + 8 })
                          .toUTC()
                          .toISO(),
                      )
                    }
                  />
                ))}
                {appointments
                  .filter(
                    (a: any) =>
                      localTime(a.starts_at, zone, 'yyyy-MM-dd') === day.toISODate() &&
                      !['CANCELLED', 'EXPIRED'].includes(a.state),
                  )
                  .map((a: any) => {
                    const t = DateTime.fromISO(a.starts_at).setZone(zone),
                      mins = t.hour * 60 + t.minute - 480,
                      duration =
                        (new Date(a.ends_at).getTime() - new Date(a.starts_at).getTime()) / 60000;
                    return (
                      <button
                        className={'calendar-event ' + a.state.toLowerCase()}
                        style={{
                          top: (mins / 60) * 62,
                          height: Math.max(43, (duration / 60) * 62 - 3),
                        }}
                        key={a.id}
                        onClick={() => onSelect(a)}
                      >
                        <strong>{a.customer_name}</strong>
                        <span>{a.service_name}</span>
                        <small>{localTime(a.starts_at, zone)}</small>
                      </button>
                    );
                  })}
                {blocks
                  .filter(
                    (b: any) => localTime(b.starts_at, zone, 'yyyy-MM-dd') === day.toISODate(),
                  )
                  .map((b: any) => {
                    const t = DateTime.fromISO(b.starts_at).setZone(zone);
                    return (
                      <div
                        key={b.id}
                        className="calendar-block"
                        style={{
                          top: ((t.hour * 60 + t.minute - 480) / 60) * 62,
                          height: Math.max(
                            40,
                            (Math.min(
                              720,
                              (new Date(b.ends_at).getTime() - new Date(b.starts_at).getTime()) /
                                60000,
                            ) /
                              60) *
                              62,
                          ),
                        }}
                      >
                        <strong>{b.reason}</strong>
                        <small>{b.resource_name}</small>
                      </div>
                    );
                  })}
              </div>
            ))}
          </div>
        </div>
      )}
      {blocks.length > 0 && (
        <div className="block-list">
          <h3>Blocked time this week</h3>
          {blocks.map((b: any) => (
            <div key={b.id}>
              <span>
                {b.reason} · {b.resource_name} · {localTime(b.starts_at, zone, 'ccc, LLL d h:mm a')}
              </span>
              <button
                className="text-button"
                onClick={async () => {
                  try {
                    await api(
                      '/v1/blocks/' + b.id,
                      'DELETE',
                      { locationId: b.location_id },
                      crypto.randomUUID(),
                    );
                    onChange('Block removed');
                  } catch (e) {
                    onChange((e as Error).message);
                  }
                }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
function Customers({ data, refresh }: { data: Bootstrap; refresh: number }) {
  const [items, setItems] = useState<any[]>([]),
    [search, setSearch] = useState(''),
    [selected, setSelected] = useState<any>(null),
    [error, setError] = useState('');
  useEffect(() => {
    api('/v1/customers?search=' + encodeURIComponent(search))
      .then((v) => setItems(v.customers))
      .catch((e) => setError(e.message));
  }, [search, refresh]);
  return (
    <div className="two-column">
      <Panel
        title="Customer directory"
        action={
          <div className="search-field">
            <Search size={16} />
            <input
              placeholder="Search name or phone"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        }
      >
        {error && <p className="notice danger">{error}</p>}
        {items.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Appointments</th>
                  <th>Last appointment</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() =>
                      api('/v1/customers/' + c.id)
                        .then(setSelected)
                        .catch((e) => setError(e.message))
                    }
                    className="clickable"
                  >
                    <td>
                      <strong>{c.name}</strong>
                      <small>{c.phone}</small>
                    </td>
                    <td>{c.appointments}</td>
                    <td>
                      {c.last_appointment
                        ? localTime(c.last_appointment, data.locations[0].timezone, 'LLL d, yyyy')
                        : '—'}
                    </td>
                    <td>
                      <ChevronRight size={16} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={Users} title="Your customer list starts here">
            Customers appear when you create an appointment.
          </Empty>
        )}
      </Panel>
      <Panel title={selected?.customer?.name || 'Customer details'}>
        {selected ? (
          <div className="detail-pad">
            <p>{selected.customer.phone}</p>
            <p className="muted">{selected.customer.notes || 'No customer notes.'}</p>
            <h3>Appointment history</h3>
            {selected.appointments.map((a: any) => (
              <div className="history-row" key={a.id}>
                <div>
                  <strong>{a.service_name}</strong>
                  <small>
                    {localTime(a.starts_at, data.locations[0].timezone, 'LLL d, yyyy · h:mm a')}
                  </small>
                </div>
                <Badge state={a.state} />
              </div>
            ))}
            <h3>Message consent</h3>
            <p className="muted">Written consent evidence is required before SMS delivery.</p>
            {selected.consents.map((c: any) => (
              <div className="history-row" key={c.id}>
                <span>{c.method.toLowerCase()}</span>
                <Badge state={c.granted ? 'GRANTED' : 'REVOKED'} />
              </div>
            ))}
            <ConsentForm
              customerId={selected.customer.id}
              saved={() => api('/v1/customers/' + selected.customer.id).then(setSelected)}
            />
            <button
              className="text-button"
              onClick={async () => {
                const d = await api('/v1/customers/' + selected.customer.id + '/export');
                const url = URL.createObjectURL(
                  new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }),
                );
                const a = document.createElement('a');
                a.href = url;
                a.download = 'customer-export.json';
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              Export customer data
            </button>
          </div>
        ) : (
          <Empty icon={Users} title="Select a customer">
            View appointment history and consent records.
          </Empty>
        )}
      </Panel>
    </div>
  );
}
function ConsentForm({ customerId, saved }: any) {
  const [evidence, setEvidence] = useState(''),
    [error, setError] = useState('');
  return (
    <form
      className="consent-form"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api('/v1/customers/' + customerId + '/consent', 'POST', {
            granted: true,
            method: 'WRITTEN_IMPORT',
            noticeVersion: 'appointment-sms-v1',
            evidence,
          });
          setEvidence('');
          saved();
        } catch (e) {
          setError((e as Error).message);
        }
      }}
    >
      <label>
        Written consent evidence
        <textarea
          placeholder="Where and when did the customer agree? Reference the signed form or web submission."
          required
          minLength={10}
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
        />
      </label>
      {error && <p className="notice danger">{error}</p>}
      <button className="button secondary small">Record consent</button>
    </form>
  );
}
function Calls({ refresh, onChange }: any) {
  const [calls, setCalls] = useState<any[]>([]),
    [leads, setLeads] = useState<any[]>([]),
    [selected, setSelected] = useState<any>(null),
    [error, setError] = useState('');
  useEffect(() => {
    Promise.all([api('/v1/calls'), api('/v1/leads')])
      .then(([c, l]) => {
        setCalls(c.calls);
        setLeads(l.leads);
      })
      .catch((e) => setError(e.message));
  }, [refresh]);
  return (
    <>
      <div className="two-column">
        <Panel
          title="Recent conversations"
          subtitle="Telephone calls and clearly labeled simulations"
        >
          {error && <p className="notice danger">{error}</p>}
          {calls.length ? (
            <div className="call-list">
              {calls.map((c) => (
                <button key={c.id} onClick={() => api('/v1/calls/' + c.id).then(setSelected)}>
                  <span className="call-icon">
                    <Phone size={18} />
                  </span>
                  <div>
                    <strong>
                      {c.mode === 'SIMULATOR'
                        ? 'Receptionist simulation'
                        : c.caller_phone || 'Incoming call'}
                    </strong>
                    <small>
                      {new Date(c.started_at).toLocaleString()} · {c.duration_seconds}s
                    </small>
                  </div>
                  <Badge state={c.outcome} />
                  <ChevronRight size={16} />
                </button>
              ))}
            </div>
          ) : (
            <Empty icon={Phone} title="No conversations yet">
              Start a simulation in the receptionist lab.
            </Empty>
          )}
        </Panel>
        <Panel title="Conversation detail" subtitle="Recording is disabled">
          {selected ? (
            <div className="transcript">
              <div className="summary-box">
                <small>SUMMARY</small>
                <p>{selected.call?.summary || 'Conversation in progress'}</p>
              </div>
              {selected.events.map((e: any) => (
                <div key={e.id} className={'transcript-item ' + e.kind.toLowerCase()}>
                  <small>{e.kind === 'ASSISTANT' ? 'AI RECEPTIONIST' : 'CALLER'}</small>
                  <p>{e.content.text}</p>
                </div>
              ))}
              <details>
                <summary>Tool history · {selected.tools.length} actions</summary>
                {selected.tools.map((t: any) => (
                  <div className="history-row" key={t.action_id}>
                    <span>{t.tool}</span>
                    <small>{t.duration_ms ?? '—'} ms</small>
                  </div>
                ))}
              </details>
            </div>
          ) : (
            <Empty icon={MessageSquare} title="The full conversation, in context">
              Select a call to review the transcript, outcome, and tool history.
            </Empty>
          )}
        </Panel>
      </div>
      <Panel
        title="Follow-up queue"
        subtitle="Capture the opportunity when booking cannot be completed"
      >
        {leads.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Reason</th>
                  <th>Requested service</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <strong>{l.name || 'Name not captured'}</strong>
                      <small>{l.phone || 'No callback number'}</small>
                    </td>
                    <td>{l.reason.replaceAll('_', ' ').toLowerCase()}</td>
                    <td>{l.notes || 'Review call details'}</td>
                    <td>
                      <select
                        aria-label={'Follow-up status for ' + (l.name || 'caller')}
                        value={l.status}
                        onChange={async (e) => {
                          await api('/v1/leads/' + l.id, 'PATCH', { status: e.target.value });
                          onChange('Follow-up updated');
                        }}
                      >
                        {['OPEN', 'CONTACTED', 'CONVERTED', 'CLOSED'].map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={CheckCircle2} title="Nothing waiting on you">
            Missed calls and unfinished bookings will appear here.
          </Empty>
        )}
      </Panel>
    </>
  );
}
function Operations({ data, refresh, onChange }: any) {
  const [ops, setOps] = useState<any>(null),
    [error, setError] = useState('');
  useEffect(() => {
    api('/v1/operations')
      .then(setOps)
      .catch((e) => setError(e.message));
  }, [refresh]);
  return (
    <>
      <div className="integration-cards">
        <div className="panel integration-card">
          <span className="connection-logo google">G</span>
          <h2>Google Calendar</h2>
          <p>External calendar mirror. Bookings stay in the central database.</p>
          <Badge state={ops?.calendar?.status || 'NOT_CONNECTED'} />
          <button
            className="button secondary"
            onClick={async () => {
              try {
                const r = await api('/v1/integrations/google/start', 'POST', {});
                window.location.assign(r.url);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Connect Google Calendar <ExternalLink size={15} />
          </button>
        </div>
        <div className="panel integration-card">
          <Phone size={27} />
          <h2>Phone & SMS</h2>
          <p>Provider credentials and a verified phone number are required.</p>
          <Badge state={data.providerStatus.voice ? 'CONFIGURED' : 'NOT_CONNECTED'} />
          <small>
            Live calling:{' '}
            {data.providerStatus.voice ? 'enabled in server configuration' : 'disabled'}.<br />
            SMS: consent required for each recipient.
          </small>
        </div>
        <div className="panel integration-card">
          <ShieldCheck size={27} />
          <h2>Launch readiness</h2>
          <p>Local application checks are separate from live-service validation.</p>
          <Badge state="PENDING_VALIDATION" />
          <small>
            Native concurrency, real call quality, calendar sync, delivery, and recovery drills
            remain required.
          </small>
        </div>
      </div>
      {error && <div className="notice danger">{error}</div>}
      {ops?.exceptions.length > 0 && (
        <Panel title="Calendar exceptions">
          <div className="detail-pad">
            {ops.exceptions.map((e: any) => (
              <div className="notice danger" key={e.id}>
                {e.reason}
                <div className="heading-actions">
                  {[
                    ['RECHECK_GOOGLE', 'Recheck Google'],
                    ['RESTORE_DATABASE_VERSION', 'Restore database version'],
                  ].map(([action, label]) => (
                    <button
                      className="button secondary small"
                      key={action}
                      onClick={async () => {
                        try {
                          const r = await api(
                            '/v1/integrations/google/exceptions/' + e.id + '/reconcile',
                            'POST',
                            { action },
                          );
                          onChange(r.notice);
                        } catch (err) {
                          setError((err as Error).message);
                        }
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <p>Resolve the external calendar event and reconcile before resuming bookings.</p>
          </div>
        </Panel>
      )}
      <Panel
        title="Message & sync queue"
        subtitle="Queued only after the booking transaction commits"
      >
        {ops?.jobs.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Status</th>
                  <th>Delivery</th>
                  <th>Attempts</th>
                  <th>Details</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ops.jobs.map((j: any) => (
                  <tr key={j.id}>
                    <td>
                      <strong>{j.kind.replaceAll('.', ' · ')}</strong>
                      <small>{new Date(j.created_at).toLocaleString()}</small>
                    </td>
                    <td>
                      <Badge state={j.status} />
                    </td>
                    <td>{j.delivery_status || '—'}</td>
                    <td>{j.attempts}</td>
                    <td>
                      <span className="muted">
                        {j.last_error?.replaceAll('_', ' ').toLowerCase() || '—'}
                      </span>
                    </td>
                    <td>
                      {['FAILED', 'BLOCKED'].includes(j.status) && (
                        <button
                          className="text-button"
                          onClick={async () => {
                            try {
                              await api('/v1/jobs/' + j.id + '/retry', 'POST', {});
                              onChange('Retry queued');
                            } catch (e) {
                              setError((e as Error).message);
                            }
                          }}
                        >
                          Retry
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={Activity} title="No queued actions">
            Confirmation messages and calendar updates appear after a successful booking.
          </Empty>
        )}
      </Panel>
      <Panel
        title="Audit trail"
        subtitle="Every appointment state change, including corrections and cancellations"
      >
        {ops?.audit.length ? (
          <div className="audit-list">
            {ops.audit.map((a: any) => (
              <div key={a.id}>
                <span className="audit-dot" />
                <div>
                  <strong>{a.action.replaceAll('_', ' ')}</strong>
                  <small>
                    {a.entity_type} ·{' '}
                    {a.actor.startsWith('call:') ? 'Receptionist' : 'Owner / system'} ·{' '}
                    {a.entity_id.slice(0, 8)}
                  </small>
                </div>
                <time>{new Date(a.created_at).toLocaleString()}</time>
              </div>
            ))}
          </div>
        ) : (
          <Empty icon={BookOpen} title="A clean slate">
            Changes to appointments and settings will be logged here.
          </Empty>
        )}
      </Panel>
    </>
  );
}
