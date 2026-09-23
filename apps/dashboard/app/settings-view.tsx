'use client';
import { useEffect, useState } from 'react';
import { Save, Plus, ShieldCheck, BookOpen } from 'lucide-react';
import { api, type Bootstrap } from './lib';
import { Panel, Badge } from './workspace';
export function SettingsView({
  data,
  onChange,
}: {
  data: Bootstrap;
  onChange: (s?: string) => void;
}) {
  const [tab, setTab] = useState('services'),
    [error, setError] = useState(''),
    [settings, setSettings] = useState(data.settings),
    [knowledge, setKnowledge] = useState<any[]>([]),
    [entry, setEntry] = useState<any>(null);
  useEffect(() => {
    api('/v1/knowledge')
      .then((v) => setKnowledge(v.items))
      .catch((e) => setError(e.message));
  }, [data]);
  async function saveSettings() {
    try {
      const {
        greeting,
        transfer_enabled,
        transfer_number,
        booking_paused,
        transcript_retention_days,
        lead_retention_days,
      } = settings;
      await api('/v1/settings', 'PATCH', {
        greeting,
        transfer_enabled,
        transfer_number,
        booking_paused,
        transcript_retention_days,
        lead_retention_days,
      });
      onChange('Receptionist settings saved');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <div className="tabs">
        {[
          ['services', 'Services'],
          ['hours', 'Hours & staff'],
          ['behavior', 'Receptionist'],
          ['knowledge', 'Knowledge base'],
          ['privacy', 'Privacy'],
        ].map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? 'active' : ''}
            onClick={() => {
              setTab(id);
              setError('');
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <div className="notice danger">{error}</div>}
      {tab === 'services' && (
        <Panel
          title="Services & pricing"
          subtitle="Existing appointments retain their quoted price and duration."
        >
          <div className="service-grid">
            {data.services.map((s) => (
              <Service key={s.id} service={s} saved={() => onChange('Service updated')} />
            ))}
          </div>
        </Panel>
      )}
      {tab === 'hours' && (
        <div className="two-column">
          <Panel title="Business hours" subtitle={data.locations[0].timezone}>
            <HoursForm
              item={data.locations[0]}
              locationId={data.locations[0].id}
              isLocation
              saved={() => onChange('Business hours updated')}
            />
          </Panel>
          <Panel
            title="Staff schedules"
            subtitle="Use Block time for holidays, breaks, and time off."
          >
            {data.resources
              .filter((r) => r.kind === 'STAFF')
              .map((r) => (
                <div className="staff-settings" key={r.id}>
                  <h3>{r.name}</h3>
                  <HoursForm
                    item={{ ...r, hours: r.hours || data.locations[0].hours }}
                    locationId={data.locations[0].id}
                    saved={() => onChange('Staff schedule updated')}
                  />
                </div>
              ))}
          </Panel>
        </div>
      )}
      {tab === 'behavior' && (
        <div className="two-column">
          <Panel title="Greeting & booking">
            <div className="detail-pad">
              <label>
                Opening greeting
                <textarea
                  rows={4}
                  value={settings.greeting}
                  onChange={(e) => setSettings({ ...settings, greeting: e.target.value })}
                />
                <small>The greeting must identify the AI receptionist.</small>
              </label>
              <label className="toggle-row">
                <div>
                  <strong>Pause new bookings</strong>
                  <small>Availability and new reservations are disabled while paused.</small>
                </div>
                <input
                  type="checkbox"
                  checked={settings.booking_paused}
                  onChange={(e) => setSettings({ ...settings, booking_paused: e.target.checked })}
                />
              </label>
              <button className="button primary" onClick={saveSettings}>
                <Save size={16} /> Save settings
              </button>
            </div>
          </Panel>
          <Panel title="Human handoff">
            <div className="detail-pad">
              <label className="toggle-row">
                <div>
                  <strong>Enable human transfer</strong>
                  <small>Always offer a person when a caller requests one.</small>
                </div>
                <input
                  type="checkbox"
                  checked={settings.transfer_enabled}
                  onChange={(e) => setSettings({ ...settings, transfer_enabled: e.target.checked })}
                />
              </label>
              <label>
                Transfer number
                <input
                  type="tel"
                  placeholder="+15085550100"
                  value={settings.transfer_number}
                  onChange={(e) => setSettings({ ...settings, transfer_number: e.target.value })}
                />
              </label>
              <div className="notes-box">
                Transfer requests, repeated failures, and angry callers are routed to the team. If
                transfer fails, capture a follow-up lead.
              </div>
              <button className="button secondary" onClick={saveSettings}>
                Save handoff settings
              </button>
            </div>
          </Panel>
        </div>
      )}
      {tab === 'knowledge' && (
        <div className="two-column">
          <Panel
            title="Approved answers"
            subtitle="Only published answers can be spoken to callers."
            action={
              <button
                className="button secondary small"
                onClick={() =>
                  setEntry({
                    id: crypto.randomUUID(),
                    topic: '',
                    question: '',
                    answer: '',
                    published: false,
                  })
                }
              >
                <Plus size={15} /> Add answer
              </button>
            }
          >
            <div className="knowledge-list">
              {knowledge.map((k) => (
                <button key={k.id} onClick={() => setEntry(k)}>
                  <BookOpen size={18} />
                  <div>
                    <strong>{k.question}</strong>
                    <small>{k.topic}</small>
                  </div>
                  <Badge state={k.published ? 'PUBLISHED' : 'DRAFT'} />
                </button>
              ))}
            </div>
          </Panel>
          <Panel title={entry ? 'Edit answer' : 'Knowledge editor'}>
            <div className="detail-pad">
              {entry ? (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                      const { topic, question, answer, published } = entry;
                      await api('/v1/knowledge/' + entry.id, 'PUT', {
                        topic,
                        question,
                        answer,
                        published,
                      });
                      onChange('Knowledge answer saved');
                      setEntry(null);
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  <label>
                    Topic key
                    <input
                      required
                      maxLength={80}
                      value={entry.topic}
                      placeholder="parking, cancellation-policy…"
                      onChange={(e) => setEntry({ ...entry, topic: e.target.value })}
                    />
                  </label>
                  <label>
                    Question
                    <input
                      required
                      maxLength={300}
                      value={entry.question}
                      onChange={(e) => setEntry({ ...entry, question: e.target.value })}
                    />
                  </label>
                  <label>
                    Approved answer
                    <textarea
                      required
                      rows={6}
                      maxLength={2000}
                      value={entry.answer}
                      onChange={(e) => setEntry({ ...entry, answer: e.target.value })}
                    />
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={entry.published}
                      onChange={(e) => setEntry({ ...entry, published: e.target.checked })}
                    />{' '}
                    Publish for callers
                  </label>
                  <button className="button primary">Save answer</button>
                </form>
              ) : (
                <p className="muted">
                  Select an answer or add a new one. Keep policies clear, factual, and approved by
                  the business.
                </p>
              )}
            </div>
          </Panel>
        </div>
      )}
      {tab === 'privacy' && (
        <Panel title="Privacy & retention">
          <div className="detail-pad narrow">
            <div className="notice">
              <ShieldCheck size={22} />
              <div>
                <strong>Call recording is disabled.</strong>
                <p>
                  This release does not create audio recordings. Transcription requires the
                  configured consent flow.
                </p>
              </div>
            </div>
            <label>
              Transcript retention (days)
              <input
                type="number"
                min={1}
                max={90}
                value={settings.transcript_retention_days}
                onChange={(e) =>
                  setSettings({ ...settings, transcript_retention_days: Number(e.target.value) })
                }
              />
            </label>
            <label>
              Closed-lead retention (days)
              <input
                type="number"
                min={1}
                max={365}
                value={settings.lead_retention_days}
                onChange={(e) =>
                  setSettings({ ...settings, lead_retention_days: Number(e.target.value) })
                }
              />
            </label>
            <p className="muted">
              The retention worker purges eligible transcripts and closed leads. Customer exports
              are available in the customer directory. Deletion is an audited server operation;
              required booking and audit records are pseudonymized.
            </p>
            <button className="button primary" onClick={saveSettings}>
              Save retention settings
            </button>
          </div>
        </Panel>
      )}
    </>
  );
}
function Service({ service, saved }: any) {
  const [s, set] = useState(service),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <form
      className="service-card"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          const {
            name,
            description,
            duration_minutes,
            buffer_before,
            buffer_after,
            price_cents,
            active,
          } = s;
          await api(
            '/v1/services/' + s.id,
            'PATCH',
            {
              locationId: s.location_id,
              name,
              description,
              duration_minutes,
              buffer_before,
              buffer_after,
              price_cents,
              active,
            },
            crypto.randomUUID(),
          );
          saved();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <span className="service-icon">
        {service.name
          .split(' ')
          .map((s: string) => s[0])
          .join('')}
      </span>
      <label>
        Service name
        <input value={s.name} required onChange={(e) => set({ ...s, name: e.target.value })} />
      </label>
      <div className="form-grid">
        <label>
          Duration (min)
          <input
            type="number"
            min={5}
            max={480}
            value={s.duration_minutes}
            onChange={(e) => set({ ...s, duration_minutes: +e.target.value })}
          />
        </label>
        <label>
          Price (USD)
          <input
            type="number"
            min={0}
            step="0.01"
            value={s.price_cents / 100}
            onChange={(e) => set({ ...s, price_cents: Math.round(+e.target.value * 100) })}
          />
        </label>
        <label>
          Buffer before
          <input
            type="number"
            min={0}
            max={120}
            value={s.buffer_before}
            onChange={(e) => set({ ...s, buffer_before: +e.target.value })}
          />
        </label>
        <label>
          Buffer after
          <input
            type="number"
            min={0}
            max={120}
            value={s.buffer_after}
            onChange={(e) => set({ ...s, buffer_after: +e.target.value })}
          />
        </label>
      </div>
      <label>
        Description
        <textarea
          value={s.description}
          maxLength={1000}
          onChange={(e) => set({ ...s, description: e.target.value })}
        />
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={s.active}
          onChange={(e) => set({ ...s, active: e.target.checked })}
        />{' '}
        Available for booking
      </label>
      {error && <p className="notice danger">{error}</p>}
      <button className="button secondary full" disabled={busy}>
        {busy ? 'Saving…' : 'Save service'}
      </button>
    </form>
  );
}
function HoursForm({ item, locationId, isLocation = false, saved }: any) {
  const [name, setName] = useState(item.name),
    [address, setAddress] = useState(item.address || ''),
    [hours, setHours] = useState<any>(item.hours),
    [error, setError] = useState('');
  return (
    <form
      className="detail-pad"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api(
            '/v1/' + (isLocation ? 'locations/' : 'resources/') + item.id,
            'PATCH',
            isLocation
              ? { name, address, hours, booking_enabled: item.booking_enabled }
              : { locationId, name, hours, active: item.active },
            crypto.randomUUID(),
          );
          saved();
        } catch (e) {
          setError((e as Error).message);
        }
      }}
    >
      <label>
        {isLocation ? 'Location name' : 'Staff name'}
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      {isLocation && (
        <label>
          Business address
          <input value={address} onChange={(e) => setAddress(e.target.value)} />
        </label>
      )}
      <div className="hours-grid">
        {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map(
          (day, i) => (
            <div key={day}>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={!!hours[i + 1]}
                  onChange={(e) => {
                    const h = { ...hours };
                    if (e.target.checked) h[i + 1] = ['09:00', '18:00'];
                    else delete h[i + 1];
                    setHours(h);
                  }}
                />
                {day}
              </label>
              {hours[i + 1] ? (
                <>
                  <input
                    aria-label={day + ' opens'}
                    type="time"
                    value={hours[i + 1][0]}
                    onChange={(e) =>
                      setHours({ ...hours, [i + 1]: [e.target.value, hours[i + 1][1]] })
                    }
                  />
                  <span>–</span>
                  <input
                    aria-label={day + ' closes'}
                    type="time"
                    value={hours[i + 1][1]}
                    onChange={(e) =>
                      setHours({ ...hours, [i + 1]: [hours[i + 1][0], e.target.value] })
                    }
                  />
                </>
              ) : (
                <span className="muted">Closed</span>
              )}
            </div>
          ),
        )}
      </div>
      {error && <p className="notice danger">{error}</p>}
      <button className="button secondary">Save schedule</button>
      <p className="field-hint">Existing bookings remain in place when hours change.</p>
    </form>
  );
}
