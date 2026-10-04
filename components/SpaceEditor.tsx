"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Minus, Plus } from 'lucide-react';
import SphrApp from './SphrApp';
import SiteHeader from './site/SiteHeader';
import type { NavItem } from './site/Chrome';
import type { SceneListing } from '@/lib/scene-types';
import type { SceneEdits, StartView } from '@/lib/scene-edits';
import { spaceInfoLimits, type SpaceInfo } from '@/lib/space-info';
import type { RuntimeState } from '@/lib/types';
import type { ViewerSession } from '@/lib/viewer/ViewerSession';

type Capture = { view: StartView; thumbnail: string };
type Header = { brand: string; home?: string; nav: NavItem[]; account?: string; signOut?: 'account' | 'admin' };
type Tab = 'view' | 'details';
const fields = { description: '', location: '', capturedBy: '', capturedOn: '', contact: '', website: '', credits: '' };
type Fields = typeof fields;
const fieldsOf = (info: SpaceInfo): Fields => ({ description: info.description ?? '', location: info.location ?? '', capturedBy: info.capturedBy ?? '',
  capturedOn: info.capturedOn ?? '', contact: info.contact ?? '', website: info.website ?? '', credits: info.credits ?? '' });

/**
 * The page for editing a space: the space itself in a smaller viewer, with tabs for its
 * start view and thumbnail, and for its title and details (where it is, who captured it,
 * whom to contact).
 */
export default function SpaceEditor({ scene: initialScene, edits: initialEdits, info: initialInfo, infoRevision, header,
  back = { href: '/admin', label: 'Spaces' }, tourHref }: { scene: SceneListing; edits: SceneEdits; info: SpaceInfo; infoRevision: number;
  header: Header; back?: { href: string; label: string }; tourHref?: string }) {
  const session = useRef<ViewerSession | null>(null);
  const preview = useRef<HTMLElement | null>(null);
  const [tab, setTab] = useState<Tab>('view');
  const [scene, setScene] = useState(initialScene);
  const [edits, setEdits] = useState(initialEdits);
  const [title, setTitle] = useState(initialScene.title);
  const [saved, setSaved] = useState({ info: initialInfo, revision: infoRevision });
  const [form, setForm] = useState(() => fieldsOf(initialInfo));
  const [capture, setCapture] = useState<Capture | undefined>();
  const [state, setState] = useState<RuntimeState | null>(null);
  const [ready, setReady] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  // Saving must not restart the viewer or discard the camera being edited.
  const [viewerEdits, setViewerEdits] = useState(() => ({ title: initialScene.title, startView: initialEdits.startView }));
  const editor = useMemo(() => ({ onReady: (runtime: ViewerSession | null, reason: string | null) => {
    session.current = runtime; setReady(Boolean(runtime)); setIssue(reason);
  }, onState: setState }), []);
  const detailsDirty = title !== scene.title
    || (Object.keys(fields) as (keyof Fields)[]).some(key => form[key] !== fieldsOf(saved.info)[key]);
  const dirty = Boolean(capture) || detailsDirty;
  useEffect(() => { if (capture) preview.current?.scrollIntoView({ block: 'nearest' }); }, [capture]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function show(next: Tab) { setTab(next); setError(''); setMessage(''); }

  function chooseView() {
    setError(''); setMessage('');
    try {
      const selected = session.current?.captureStartView();
      if (!selected) throw new Error('Wait for the viewer to load.');
      setCapture(selected);
      setMessage('Start view and thumbnail selected. Save to publish them.');
    } catch (error) { setError((error as Error).message); }
  }

  async function putEdit(body: object) {
    const response = await fetch(`/api/admin/scenes/${scene.sceneId}/edit`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to save. Try again.');
    setScene(result.scene); setEdits(result.edits); setTitle(result.scene.title);
    return result;
  }

  async function saveView(reset = false) {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await putEdit({ title: scene.title, revision: edits.revision, ...(reset ? { capture: null } : capture ? { capture } : {}) });
      setCapture(undefined);
      if (reset) { setViewerEdits({ title: result.scene.title, startView: null }); setReload(value => value + 1); }
      setMessage(reset ? 'Original start view and thumbnail restored.' : 'Start view saved.');
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }

  async function saveDetails() {
    setBusy(true); setError(''); setMessage('');
    try {
      if (title !== scene.title) await putEdit({ title, revision: edits.revision });
      const info = form;
      const response = await fetch(`/api/admin/scenes/${scene.sceneId}/details`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ info, revision: saved.revision }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to save. Try again.');
      setSaved({ info: result.info, revision: result.revision }); setForm(fieldsOf(result.info));
      setMessage('Details saved. Visitors see them under the space’s title.');
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }

  const set = (key: keyof Fields) => (event: { target: { value: string } }) => setForm(current => ({ ...current, [key]: event.target.value }));
  const canCapture = ready && !busy && !issue && state?.loading.ready && !state.navigating && state.viewMode === 'FPV';
  return <div className="site"><div className="site-frame">
    <SiteHeader {...header} />
    <main className="site-main space-edit">
      <a className="site-back" href={back.href}>← {back.label}</a>
      <div className="site-title">
        <div><h1>{scene.title}</h1></div>
        <div className="site-actions">
          <a className="site-link" href={scene.scenePath} target="_blank" rel="noreferrer">View space ↗</a>
          <a className="site-button site-button-secondary" href={tourHref ?? `/admin/scenes/${scene.sceneId}/tour`}>Make a tour or scavenger hunt</a>
        </div>
      </div>
      <div className="space-edit-grid">
        <section className="space-edit-viewer" data-theme="dark" aria-label="The space">
          <SphrApp key={reload} configUrl={scene.bootstrapUrl} edits={viewerEdits} editor={editor} preview={{ title: scene.title, image: scene.thumbnail }} />
          {tab === 'view' && ready && !issue && <div className="editor-zoom" aria-label="Zoom">
            <button aria-label="Zoom out" disabled={!canCapture} onClick={() => session.current?.adjustFieldOfView(5)}><Minus size={20} /></button>
            <button aria-label="Zoom in" disabled={!canCapture} onClick={() => session.current?.adjustFieldOfView(-5)}><Plus size={20} /></button>
          </div>}
        </section>
        <section className="space-edit-panel">
          <div className="site-segmented space-edit-tabs" role="tablist" aria-label="Edit">
            <button role="tab" id="tab-view" aria-controls="panel-view" aria-selected={tab === 'view'} aria-pressed={tab === 'view'} onClick={() => show('view')}>Start view</button>
            <button role="tab" id="tab-details" aria-controls="panel-details" aria-selected={tab === 'details'} aria-pressed={tab === 'details'} onClick={() => show('details')}>Details</button>
          </div>

          {tab === 'view' && <div className="space-edit-tab" role="tabpanel" id="panel-view" aria-labelledby="tab-view">
            <p className="site-hint">Move to where visitors should arrive, look around and zoom, then use the current view. It also becomes the thumbnail.</p>
            {!issue && state?.viewMode === 'ORBIT' && <p className="site-hint">Double-click a location to go back inside before capturing.</p>}
            {issue && <p className="site-hint" role="status">{issue}</p>}
            <figure ref={preview} className="editor-preview"><img src={capture?.thumbnail ?? scene.thumbnail} width={960} height={640} alt="Space thumbnail" />
              <figcaption>{capture ? 'Selected start view, not saved yet' : 'Current thumbnail'}</figcaption></figure>
            <div className="space-edit-actions">
              <button className="site-button site-button-secondary" onClick={chooseView} disabled={!canCapture}><Camera size={18} /> Use current view</button>
              <button className="site-button" disabled={busy || !capture} onClick={() => void saveView()}>{busy ? 'Saving…' : 'Save start view'}</button>
            </div>
            {edits.startView && <button className="site-link space-edit-reset" disabled={busy || Boolean(capture)} onClick={() => void saveView(true)}>Restore the original start view and thumbnail</button>}
          </div>}

          {tab === 'details' && <form className="site-form space-edit-tab" role="tabpanel" id="panel-details" aria-labelledby="tab-details"
            onSubmit={event => { event.preventDefault(); void saveDetails(); }}>
            <div className="site-field"><label htmlFor="space-title">Title</label>
              <input id="space-title" className="site-input" value={title} maxLength={200} disabled={busy} onChange={event => setTitle(event.target.value)} /></div>
            <div className="site-field"><label htmlFor="space-description">Description</label>
              <textarea id="space-description" className="site-input" rows={4} value={form.description} maxLength={spaceInfoLimits.description} disabled={busy}
                placeholder="What the space is and what to look for" onChange={set('description')} /></div>
            <div className="site-field"><label htmlFor="space-location">Location</label>
              <input id="space-location" className="site-input" value={form.location} maxLength={spaceInfoLimits.location} disabled={busy}
                placeholder="Place, city, country" onChange={set('location')} /></div>
            <div className="space-edit-pair">
              <div className="site-field"><label htmlFor="space-captured-by">Captured by</label>
                <input id="space-captured-by" className="site-input" value={form.capturedBy} maxLength={spaceInfoLimits.capturedBy} disabled={busy}
                  placeholder="Person or studio" onChange={set('capturedBy')} /></div>
              <div className="site-field"><label htmlFor="space-captured-on">Captured on</label>
                <input id="space-captured-on" className="site-input" type="date" value={form.capturedOn} disabled={busy} onChange={set('capturedOn')} /></div>
            </div>
            <div className="site-field"><label htmlFor="space-contact">Contact</label>
              <input id="space-contact" className="site-input" value={form.contact} maxLength={spaceInfoLimits.contact} disabled={busy}
                placeholder="Email or web address for questions" onChange={set('contact')} /></div>
            <div className="site-field"><label htmlFor="space-website">Website</label>
              <input id="space-website" className="site-input" value={form.website} maxLength={spaceInfoLimits.website} disabled={busy} inputMode="url"
                placeholder="example.com" onChange={set('website')} /></div>
            <div className="site-field"><label htmlFor="space-credits">Credits</label>
              <textarea id="space-credits" className="site-input" rows={2} value={form.credits} maxLength={spaceInfoLimits.credits} disabled={busy}
                placeholder="Who else to thank, and any license" onChange={set('credits')} /></div>
            <div className="space-edit-actions"><button type="submit" className="site-button" disabled={busy || !detailsDirty || !title.trim()}>{busy ? 'Saving…' : 'Save details'}</button></div>
          </form>}

          <div className="site-feedback" aria-live="polite">
            {message && <p className="site-note" role="status">{message}</p>}
            {error && <p className="site-alert" role="alert">{error}</p>}
          </div>
        </section>
      </div>
    </main>
  </div></div>;
}
