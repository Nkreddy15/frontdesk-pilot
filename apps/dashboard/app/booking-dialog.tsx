'use client';
import { useEffect, useRef, useState } from 'react';
import { DateTime } from 'luxon';
import { X, CalendarCheck, AlertCircle, ArrowRight, Clock } from 'lucide-react';
import { api, ApiError, money, localTime, dateInput, toInstant, type Bootstrap } from './lib';
export function Modal({
  title,
  subtitle,
  close,
  children,
}: {
  title: string;
  subtitle?: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    panel.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Tab') {
        const nodes = panel.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select,textarea,a[href]',
        );
        if (!nodes?.length) return;
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      previous?.focus();
    };
  }, [close]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
      >
        <div className="modal-heading">
          <span className="empty-icon">
            <CalendarCheck size={23} />
          </span>
          <button className="icon-button" aria-label="Close dialog" onClick={close}>
            <X size={20} />
          </button>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}
export function BookingDialog({
  data,
  slot,
  close,
  saved,
}: {
  data: Bootstrap;
  slot?: any;
  close: () => void;
  saved: () => void;
}) {
  const location = data.locations[0],
    zone = location.timezone;
  const [serviceId, setService] = useState(data.services.find((s) => s.active)?.id || ''),
    [staffId, setStaff] = useState(
      slot?.staffId || data.resources.find((r) => r.kind === 'STAFF' && r.active)?.id || '',
    ),
    [time, setTime] = useState(
      slot?.startsAt
        ? dateInput(slot.startsAt, zone)
        : DateTime.now()
            .setZone(zone)
            .plus({ days: 1 })
            .set({ hour: 9, minute: 0 })
            .toFormat("yyyy-MM-dd'T'HH:mm"),
    );
  const [name, setName] = useState(''),
    [phone, setPhone] = useState(''),
    [notes, setNotes] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [alternatives, setAlternatives] = useState<any[]>([]),
    [receipt, setReceipt] = useState<any>(null);
  const key = useRef({ hash: '', value: '' });
  const service = data.services.find((s) => s.id === serviceId);
  return (
    <Modal
      title={receipt ? 'Appointment confirmed' : 'New appointment'}
      subtitle={
        receipt
          ? 'The booking database has committed this appointment.'
          : 'Owner and receptionist bookings share this schedule.'
      }
      close={close}
    >
      {receipt ? (
        <div className="modal-body">
          <div className="success-receipt">
            <CalendarCheck size={34} />
            <h3>{receipt.appointment.customer_name}</h3>
            <p>{receipt.appointment.service_name}</p>
            <strong>
              {localTime(receipt.appointment.starts_at, zone, 'cccc, LLLL d · h:mm a ZZZZ')}
            </strong>
            <p>{receipt.appointment.staff_name}</p>
            <small>Booking reference</small>
            <code>{receipt.manageCode}</code>
          </div>
          <p className="muted">
            Messages and calendar updates are queued separately. A booking is valid even if an
            external service is unavailable.
          </p>
          <button className="button primary full" onClick={saved}>
            Done
          </button>
        </div>
      ) : (
        <form
          className="modal-body"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            setAlternatives([]);
            try {
              const body = {
                locationId: location.id,
                serviceId,
                staffId,
                startsAt: toInstant(time, zone),
                customer: { name, phone, notes: '' },
                notes,
              };
              const digest = JSON.stringify(body);
              if (key.current.hash !== digest)
                key.current = { hash: digest, value: crypto.randomUUID() };
              setReceipt(await api('/v1/appointments', 'POST', body, key.current.value));
            } catch (e) {
              if (e instanceof ApiError && e.data.error === 'SLOT_CONFLICT') {
                setError('That time was just taken. Choose a fresh option below.');
                setAlternatives(e.data.alternatives || []);
              } else setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="form-grid">
            <label className="span-two">
              Service
              <select value={serviceId} onChange={(e) => setService(e.target.value)}>
                {data.services
                  .filter((s) => s.active)
                  .map((s) => (
                    <option value={s.id} key={s.id}>
                      {s.name} · {s.duration_minutes} min · {money(s.price_cents)}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Team member
              <select value={staffId} onChange={(e) => setStaff(e.target.value)}>
                {data.resources
                  .filter((r) => r.kind === 'STAFF' && r.active)
                  .map((r) => (
                    <option value={r.id} key={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Date & time
              <input
                type="datetime-local"
                required
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </label>
            <div className="field-hint span-two">
              <Clock size={14} />
              {zone} · {service?.buffer_before || 0} min before / {service?.buffer_after || 0} min
              after
            </div>
            <label>
              Customer name
              <input
                required
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Full name"
              />
            </label>
            <label>
              Callback number
              <input
                type="tel"
                required
                pattern="\+[1-9][0-9]{7,14}"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+15085550100"
              />
            </label>
            <label className="span-two">
              Appointment notes
              <textarea
                maxLength={1000}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Vehicle details or relevant requests. Do not enter sensitive information."
              />
            </label>
          </div>
          {error && (
            <div role="alert" className="notice danger">
              <AlertCircle size={18} />
              {error}
            </div>
          )}
          {alternatives.length > 0 && (
            <div className="conflict-options">
              {alternatives.map((s, i) => (
                <button
                  className="button secondary"
                  type="button"
                  key={i}
                  onClick={() => {
                    setTime(dateInput(s.startsAt, zone));
                    setStaff(s.staffId);
                    setError('');
                    setAlternatives([]);
                  }}
                >
                  {s.label} <ArrowRight size={15} />
                </button>
              ))}
            </div>
          )}
          <div className="form-note">
            <ShieldIcon /> Availability is checked again when you save. No message is sent before
            the booking commits.
          </div>
          <div className="modal-actions">
            <button type="button" className="button secondary" onClick={close}>
              Cancel
            </button>
            <button className="button primary" disabled={busy}>
              {busy ? 'Checking & booking…' : 'Confirm appointment'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
function ShieldIcon() {
  return <CalendarCheck size={18} />;
}
export function AppointmentDialog({
  data,
  appointment: a,
  close,
  saved,
}: {
  data: Bootstrap;
  appointment: any;
  close: () => void;
  saved: () => void;
}) {
  const zone = data.locations[0].timezone;
  const [mode, setMode] = useState('detail'),
    [time, setTime] = useState(dateInput(a.starts_at, zone)),
    [staff, setStaff] = useState(a.staff_id),
    [reason, setReason] = useState('Customer requested cancellation'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [options, setOptions] = useState<any[]>([]);
  const key = useRef(crypto.randomUUID());
  async function change(state?: string) {
    setBusy(true);
    setError('');
    try {
      if (state)
        await api(
          '/v1/appointments/' + a.id + '/state',
          'POST',
          { locationId: a.location_id, expectedVersion: a.version, state, reason },
          key.current,
        );
      else
        await api(
          '/v1/appointments/' + a.id,
          'PATCH',
          {
            locationId: a.location_id,
            expectedVersion: a.version,
            startsAt: toInstant(time, zone),
            staffId: staff,
          },
          key.current,
        );
      saved();
    } catch (e) {
      if (e instanceof ApiError && e.data.alternatives) setOptions(e.data.alternatives);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        mode === 'reschedule'
          ? 'Reschedule appointment'
          : mode === 'cancel'
            ? 'Cancel appointment'
            : a.customer_name
      }
      subtitle={a.service_name}
      close={close}
    >
      <div className="modal-body">
        <div className="appointment-facts">
          <div>
            <small>When</small>
            <strong>{localTime(a.starts_at, zone, 'cccc, LLLL d · h:mm a ZZZZ')}</strong>
          </div>
          <div>
            <small>Team member</small>
            <strong>{a.staff_name}</strong>
          </div>
          <div>
            <small>Callback</small>
            <strong>{a.phone}</strong>
          </div>
          <div>
            <small>Status</small>
            <strong>{a.state.toLowerCase()}</strong>
          </div>
        </div>
        {a.notes && <p className="notes-box">{a.notes}</p>}
        {mode === 'reschedule' && (
          <>
            <label>
              New date & time
              <input
                type="datetime-local"
                value={time}
                onChange={(e) => {
                  setTime(e.target.value);
                  key.current = crypto.randomUUID();
                }}
              />
            </label>
            <label>
              Team member
              <select
                value={staff}
                onChange={(e) => {
                  setStaff(e.target.value);
                  key.current = crypto.randomUUID();
                }}
              >
                {data.resources
                  .filter((r) => r.kind === 'STAFF')
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </label>
            <p className="muted">
              Your original appointment remains booked until this change succeeds.
            </p>
          </>
        )}
        {mode === 'cancel' && (
          <label>
            Cancellation reason
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
          </label>
        )}
        {error && (
          <div className="notice danger" role="alert">
            {error}
          </div>
        )}
        {options.map((s, i) => (
          <button
            className="button secondary full"
            key={i}
            onClick={() => {
              setTime(dateInput(s.startsAt, zone));
              setStaff(s.staffId);
              key.current = crypto.randomUUID();
              setOptions([]);
            }}
          >
            {s.label}
          </button>
        ))}
        <div className="modal-actions">
          {mode === 'detail' ? (
            a.state === 'CONFIRMED' ? (
              <>
                <button
                  className="button danger-button"
                  onClick={() => {
                    setMode('cancel');
                    key.current = crypto.randomUUID();
                  }}
                >
                  Cancel appointment
                </button>
                <button
                  className="button secondary"
                  onClick={() => {
                    setMode('reschedule');
                    key.current = crypto.randomUUID();
                  }}
                >
                  Reschedule
                </button>
                <button
                  className="button primary"
                  disabled={busy || new Date(a.ends_at) > new Date()}
                  onClick={() => change('COMPLETED')}
                >
                  Complete
                </button>
              </>
            ) : (
              <button className="button secondary" onClick={close}>
                Close
              </button>
            )
          ) : (
            <>
              <button className="button secondary" onClick={() => setMode('detail')}>
                Back
              </button>
              <button
                className={'button ' + (mode === 'cancel' ? 'danger-button' : 'primary')}
                disabled={busy}
                onClick={() => change(mode === 'cancel' ? 'CANCELLED' : undefined)}
              >
                {busy ? 'Saving…' : mode === 'cancel' ? 'Confirm cancellation' : 'Save change'}
              </button>
            </>
          )}
        </div>
        {mode === 'detail' &&
          a.state === 'CONFIRMED' &&
          new Date(a.starts_at).getTime() + 900000 < Date.now() && (
            <button className="text-button" disabled={busy} onClick={() => change('NO_SHOW')}>
              Mark as no-show
            </button>
          )}
      </div>
    </Modal>
  );
}
export function BlockDialog({
  data,
  close,
  saved,
}: {
  data: Bootstrap;
  close: () => void;
  saved: () => void;
}) {
  const zone = data.locations[0].timezone,
    base = DateTime.now().setZone(zone).plus({ days: 1 }).set({ hour: 9, minute: 0 });
  const [resource, setResource] = useState(data.resources[0].id),
    [start, setStart] = useState(base.toFormat("yyyy-MM-dd'T'HH:mm")),
    [end, setEnd] = useState(base.plus({ hours: 1 }).toFormat("yyyy-MM-dd'T'HH:mm")),
    [reason, setReason] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const key = useRef({ hash: '', value: '' });
  return (
    <Modal
      title="Block time"
      subtitle="For time off, breaks, holidays, or unavailable equipment."
      close={close}
    >
      <form
        className="modal-body"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const body = {
              locationId: data.locations[0].id,
              resourceId: resource,
              startsAt: toInstant(start, zone),
              endsAt: toInstant(end, zone),
              reason,
            };
            const digest = JSON.stringify(body);
            if (key.current.hash !== digest)
              key.current = { hash: digest, value: crypto.randomUUID() };
            await api('/v1/blocks', 'POST', body, key.current.value);
            saved();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Resource
          <select value={resource} onChange={(e) => setResource(e.target.value)}>
            {data.resources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {r.kind.toLowerCase()}
              </option>
            ))}
          </select>
        </label>
        <div className="form-grid">
          <label>
            Starts
            <input
              type="datetime-local"
              required
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label>
            Ends
            <input
              type="datetime-local"
              required
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
        </div>
        <label>
          Reason
          <input
            required
            maxLength={200}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Lunch, time off, holiday…"
          />
        </label>
        <p className="muted">
          Existing appointments cannot be overwritten by a block. Resolve any conflict first. Times
          use {zone}.
        </p>
        {error && (
          <div role="alert" className="notice danger">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={close}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? 'Saving…' : 'Block time'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
