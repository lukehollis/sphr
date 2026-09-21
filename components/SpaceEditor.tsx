"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Minus, Plus } from 'lucide-react';
import SphrApp from './SphrApp';
import type { SceneListing } from '@/lib/scene-types';
import type { SceneEdits, StartView } from '@/lib/scene-edits';
import type { RuntimeState } from '@/lib/types';
import type { ViewerSession } from '@/lib/viewer/ViewerSession';

type Capture = { view: StartView; thumbnail: string };
export default function SpaceEditor({ scene: initialScene, edits: initialEdits }: { scene: SceneListing; edits: SceneEdits }) {
  const session = useRef<ViewerSession | null>(null);
  const preview = useRef<HTMLElement | null>(null);
  const [scene, setScene] = useState(initialScene);
  const [edits, setEdits] = useState(initialEdits);
  const [title, setTitle] = useState(initialScene.title);
  const [capture, setCapture] = useState<Capture | undefined>();
  const [state, setState] = useState<RuntimeState | null>(null);
  const [ready, setReady] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  // Saving metadata must not restart the viewer or discard the camera being edited.
  const [viewerEdits, setViewerEdits] = useState(() => ({ title: initialScene.title, startView: initialEdits.startView }));
  const editor = useMemo(() => ({ onReady: (runtime: ViewerSession | null, reason: string | null) => {
    session.current = runtime; setReady(Boolean(runtime)); setIssue(reason);
  }, onState: setState }), []);
  const dirty = title !== scene.title || Boolean(capture);
  useEffect(() => { if (capture) preview.current?.scrollIntoView({ block: 'nearest' }); }, [capture]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function chooseView() {
    setError(''); setMessage('');
    try {
      const selected = session.current?.captureStartView();
      if (!selected) throw new Error('Wait for the viewer to load.');
      setCapture(selected);
      setMessage('Start view and thumbnail selected. Save changes to publish them.');
    } catch (error) { setError((error as Error).message); }
  }

  async function save(reset = false) {
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch(`/api/admin/scenes/${scene.sceneId}/edit`, { method: 'PUT',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, revision: edits.revision,
          ...(reset ? { capture: null } : capture ? { capture } : {}) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to save. Try again.');
      setScene(result.scene); setEdits(result.edits); setTitle(result.scene.title); setCapture(undefined);
      if (reset) { setViewerEdits({ title: result.scene.title, startView: null }); setReload(value => value + 1); }
      setMessage(reset ? 'Original start view and thumbnail restored.' : 'Changes saved.');
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }

  const canCapture = ready && !busy && !issue && state?.loading.ready && !state.navigating && state.viewMode === 'FPV';
  return <div className="space-editor">
    <section className="space-editor-view" aria-label="Choose a start view">
      <SphrApp key={reload} configUrl={scene.bootstrapUrl} edits={viewerEdits} editor={editor} preview={{ title: scene.title, image: scene.thumbnail }} />
      {ready && !issue && <div className="editor-zoom" aria-label="Zoom">
        <button aria-label="Zoom out" disabled={!canCapture} onClick={() => session.current?.adjustFieldOfView(5)}><Minus size={20} /></button>
        <button aria-label="Zoom in" disabled={!canCapture} onClick={() => session.current?.adjustFieldOfView(-5)}><Plus size={20} /></button>
      </div>}
    </section>
    <aside className="space-editor-panel">
      <div className="editor-fields">
      <nav aria-label="Editor"><a href="/admin">← Spaces</a><a href={scene.scenePath} target="_blank" rel="noreferrer">View space ↗</a></nav>
      <h1>Edit space</h1>
      <label htmlFor="space-title">Title</label>
      <input id="space-title" value={title} maxLength={200} disabled={busy} onChange={event => setTitle(event.target.value)} />
      <p className="editor-help">Move to the opening location, then look around and adjust the zoom.</p>
      {!issue && state?.viewMode === 'ORBIT' && <p className="editor-help">Double-click a location to return inside before capturing.</p>}
      {issue && <p className="editor-help" role="status">{issue}</p>}
      <figure ref={preview} className="editor-preview"><img src={capture?.thumbnail ?? scene.thumbnail} width={960} height={640} alt="Space thumbnail" /><figcaption>{capture ? 'Selected start view · unsaved' : 'Current thumbnail'}</figcaption></figure>
      <div className="editor-feedback" aria-live="polite">{message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}</div>
      {edits.startView && <button className="editor-reset" disabled={busy || dirty} onClick={() => void save(true)}>Restore original start and thumbnail</button>}
      </div>
      <div className="editor-actions">
      <button className="editor-capture" onClick={chooseView} disabled={!canCapture}><Camera size={18} /> Use current view</button>

      <button className="editor-save" disabled={busy || !dirty || !title.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save changes'}</button>
      </div>
    </aside>
  </div>;
}
