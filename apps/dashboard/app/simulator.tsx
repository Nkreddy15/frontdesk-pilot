'use client';
import { useState, useRef } from 'react';
import { DateTime } from 'luxon';
import {
  Phone,
  PhoneOff,
  AudioLines,
  ArrowRight,
  ShieldCheck,
  CheckCircle2,
  Users,
  RefreshCw,
  AlertCircle,
} from 'lucide-react';
import { api, toInstant, money, type Bootstrap } from './lib';
import { Panel, Badge } from './workspace';
export function Simulator({
  data,
  onChange,
}: {
  data: Bootstrap;
  onChange: (message?: string) => void;
}) {
  const [call, setCall] = useState<string | null>(null),
    [messages, setMessages] = useState<any[]>([]),
    [reply, setReply] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [service, setService] = useState(data.services[0].id),
    [staff, setStaff] = useState(data.resources.find((r) => r.kind === 'STAFF')!.id),
    [name, setName] = useState(''),
    [phone, setPhone] = useState(''),
    [from, setFrom] = useState(
      DateTime.now()
        .setZone(data.locations[0].timezone)
        .plus({ days: 1 })
        .set({ hour: 10, minute: 0 })
        .toFormat("yyyy-MM-dd'T'HH:mm"),
    ),
    [reference, setReference] = useState('');
  const pending = useRef<{ key: string; hash: string }>({ key: '', hash: '' });
  const bottom = useRef<HTMLDivElement>(null);
  async function action(command: any, label?: string) {
    if (!call) return;
    const hash = JSON.stringify(command);
    if (hash !== pending.current.hash) pending.current = { key: crypto.randomUUID(), hash };
    const r = await api('/v1/simulator/calls/' + call + '/actions', 'POST', {
      actionId: pending.current.key,
      command,
    });
    pending.current = { key: '', hash: '' };
    if (label) setMessages((m) => [...m, { who: 'caller', text: label }]);
    setMessages((m) => [...m, { who: 'assistant', text: r.say }]);
    setReply(r);
    onChange('Receptionist action saved');
    setTimeout(() => bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);
    return r;
  }
  async function run(fn: () => Promise<any>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="notice lab-notice">
        <FlaskIcon />
        <div>
          <strong>Interactive workflow simulation</strong>
          <p>
            This lab uses real booking transactions. It does not place phone calls or test speech
            recognition. Use fictional customer details.
          </p>
        </div>
      </div>
      <div className="simulator-layout">
        <Panel title="Incoming call" subtitle="Guided test controls">
          <div className="detail-pad">
            {!call ? (
              <>
                <div className="phone-orb">
                  <Phone size={32} />
                </div>
                <h3 className="center">Take your receptionist for a test drive.</h3>
                <p className="muted center">
                  Check availability, review the details, then confirm. The result appears in your
                  schedule.
                </p>
                <button
                  className="button primary full"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const r = await api('/v1/simulator/calls', 'POST', {
                        locationId: data.locations[0].id,
                      });
                      setCall(r.callId);
                      setMessages([{ who: 'assistant', text: r.say }]);
                      setReply(r);
                    })
                  }
                >
                  <Phone size={17} /> Start simulated call
                </button>
              </>
            ) : (
              <>
                <label>
                  Requested service
                  <select value={service} onChange={(e) => setService(e.target.value)}>
                    {data.services
                      .filter((s) => s.active)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} · {money(s.price_cents)}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Preferred team member
                  <select value={staff} onChange={(e) => setStaff(e.target.value)}>
                    {data.resources
                      .filter((r) => r.kind === 'STAFF')
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                  </select>
                </label>
                <div className="form-grid">
                  <label>
                    Caller name
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Synthetic Customer"
                    />
                  </label>
                  <label>
                    Callback number
                    <input
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="+15085550101"
                    />
                  </label>
                </div>
                <label>
                  Preferred date & time
                  <input
                    type="datetime-local"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                  <small>{data.locations[0].timezone}</small>
                </label>
                <button
                  disabled={busy || !name || !phone || reply?.ended}
                  className="button primary full"
                  onClick={() =>
                    run(async () => {
                      await action(
                        {
                          type: 'DETAILS',
                          serviceId: service,
                          staffId: staff,
                          name,
                          phone,
                          from: toInstant(from, data.locations[0].timezone),
                        },
                        `${name}, ${phone}. I would like ${data.services.find((s) => s.id === service)?.name}.`,
                      );
                      await action({ type: 'AVAILABILITY' }, 'What times are available?');
                    })
                  }
                >
                  Find appointments <ArrowRight size={16} />
                </button>
                <div className="lab-controls">
                  <button
                    className="button secondary small"
                    disabled={busy || reply?.ended}
                    onClick={() =>
                      run(() =>
                        action(
                          { type: 'QUESTION', topic: 'prices' },
                          'What do your services cost?',
                        ),
                      )
                    }
                  >
                    Ask about prices
                  </button>
                  <button
                    className="button secondary small"
                    disabled={busy || reply?.ended}
                    onClick={() =>
                      run(() => action({ type: 'TRANSFER' }, 'Can I speak to a person?'))
                    }
                  >
                    <Users size={15} /> Human handoff
                  </button>
                  <button
                    className="button secondary small"
                    disabled={busy || reply?.ended}
                    onClick={() =>
                      run(() => action({ type: 'CORRECT' }, 'I need to change a detail.'))
                    }
                  >
                    <RefreshCw size={14} /> Correct details
                  </button>
                  <button
                    className="button secondary small"
                    disabled={busy || reply?.ended}
                    onClick={() => run(() => action({ type: 'DISCONNECT' }, 'Call disconnected.'))}
                  >
                    <PhoneOff size={14} /> Drop call
                  </button>
                </div>
                <details className="manage-test">
                  <summary>Reschedule or cancel a booking</summary>
                  <label>
                    Booking reference
                    <input
                      value={reference}
                      onChange={(e) => setReference(e.target.value.toUpperCase())}
                      maxLength={12}
                    />
                  </label>
                  <button
                    className="button secondary small"
                    disabled={busy || !phone || reference.length !== 12}
                    onClick={() =>
                      run(() =>
                        action(
                          { type: 'LOOKUP', phone, reference },
                          'Please look up my appointment.',
                        ),
                      )
                    }
                  >
                    Verify booking
                  </button>
                  {reply?.phase === 'MANAGE' && (
                    <div className="lab-controls">
                      <button
                        className="button secondary small"
                        onClick={() =>
                          run(() => action({ type: 'RESCHEDULE' }, 'I would like to reschedule.'))
                        }
                      >
                        Reschedule
                      </button>
                      <button
                        className="button danger-button small"
                        onClick={() =>
                          run(() =>
                            action({ type: 'CANCEL_APPOINTMENT' }, 'Please cancel my appointment.'),
                          )
                        }
                      >
                        Cancel appointment
                      </button>
                    </div>
                  )}
                </details>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      if (!reply?.ended) await action({ type: 'END' }, 'Goodbye.');
                      setCall(null);
                      setReply(null);
                      setMessages([]);
                    })
                  }
                >
                  End & reset simulation
                </button>
              </>
            )}
            {error && (
              <div className="notice danger" role="alert">
                <AlertCircle size={18} />
                {error}
              </div>
            )}
          </div>
        </Panel>
        <Panel
          title="Conversation"
          subtitle={
            call
              ? 'Actions and replies are saved in Calls & leads.'
              : 'No phone connection is active.'
          }
          action={reply && <Badge state={reply.phase} />}
        >
          <div className="conversation-stage">
            {messages.length ? (
              messages.map((m, i) => (
                <div key={i} className={'chat-message ' + m.who}>
                  <span className="chat-avatar">
                    {m.who === 'assistant' ? <AudioLines size={17} /> : <Users size={16} />}
                  </span>
                  <div>
                    <small>{m.who === 'assistant' ? 'AI RECEPTIONIST' : 'TEST CALLER'}</small>
                    <p>{m.text}</p>
                  </div>
                </div>
              ))
            ) : (
              <div className="conversation-empty">
                <AudioLines size={46} />
                <h3>Every word has a next step.</h3>
                <p>Start a call to see the receptionist workflow in action.</p>
              </div>
            )}
            {reply?.slots?.length > 0 && !reply?.ended && (
              <div className="lab-slot-options">
                {reply.slots.map((s: any, i: number) => (
                  <div key={i}>
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        run(() =>
                          action({ type: 'SELECT_SLOT', index: i }, `Option ${i + 1}, please.`),
                        )
                      }
                    >
                      <span>
                        <strong>{s.label}</strong>
                        <small>{s.staffName}</small>
                      </span>
                      <ArrowRight size={16} />
                    </button>
                    <button
                      className="race-link"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await api(
                            '/v1/appointments',
                            'POST',
                            {
                              locationId: data.locations[0].id,
                              serviceId: service,
                              staffId: s.staffId,
                              startsAt: s.startsAt,
                              customer: {
                                name: 'Owner conflict test',
                                phone: '+15085550199',
                                notes: '',
                              },
                              notes: 'Synthetic booking created by the conflict demonstration.',
                            },
                            crypto.randomUUID(),
                          );
                          await action(
                            { type: 'SELECT_SLOT', index: i },
                            'The owner just booked that same slot.',
                          );
                        })
                      }
                    >
                      Test conflict: owner takes this slot
                    </button>
                  </div>
                ))}
              </div>
            )}
            {['REVIEW', 'RESCHEDULE_REVIEW', 'CANCEL_REVIEW'].includes(reply?.phase) && (
              <div className="review-box">
                <ShieldCheck size={22} />
                <div>
                  <strong>Review the details above.</strong>
                  <p>
                    Confirm only if the service, team member, date, time, timezone, name, and
                    callback number are correct.
                  </p>
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() =>
                      run(() => action({ type: 'CONFIRM' }, 'Yes, those details are correct.'))
                    }
                  >
                    {busy ? 'Committing…' : 'Yes, confirm these details'}
                  </button>
                </div>
              </div>
            )}
            {reply?.confirmed && (
              <div className="committed-banner">
                <CheckCircle2 size={22} />
                <div>
                  <strong>Database commit verified</strong>
                  <p>
                    {reply.appointment?.state === 'CANCELLED'
                      ? 'The cancellation is saved.'
                      : 'The appointment is visible in the owner schedule.'}
                  </p>
                </div>
              </div>
            )}
            <div ref={bottom} />
          </div>
        </Panel>
      </div>
    </>
  );
}
function FlaskIcon() {
  return <ShieldCheck size={22} />;
}
