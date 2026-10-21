"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Crosshair, Eye, Plus, Trash2 } from 'lucide-react';
import { defaultTagColor, mediaAddress, newTagId, tagColors, tagLimits, type SpaceTag, type TagMedia } from '@/lib/space-tags';
import type { TagSpot } from '@/lib/types';
import type { ViewerSession } from '@/lib/viewer/ViewerSession';
import { TagMediaView } from './TagCard';

type Placing = 'new' | 'move' | null;
type Saved = { tags: SpaceTag[] | null; revision: number };
type Feedback = { setBusy: (busy: boolean) => void; setError: (error: string) => void; setMessage: (message: string) => void };

/** A tag without its place, so a new spot stands in whole (a surface drops the panorama a tag hung in). */
function unplaced(tag: SpaceTag) {
  const { position: _position, normal: _normal, nodeId: _nodeId, ...rest } = tag;
  return rest;
}

/** A tag without the fields an edit emptied. */
function tidy(tag: SpaceTag): SpaceTag {
  return Object.fromEntries(Object.entries(tag).filter(([, value]) => value !== undefined && value !== '')) as SpaceTag;
}

/**
 * The space editor's Tags tab: the tags as edited, the chosen one, and placing one with a click in the viewer.
 * `events` are SphrApp's editor callbacks; the viewer shows every edit at once.
 */
export function useTagEditing({ session, sceneId, initial, ready, showTags, feedback }: {
  session: RefObject<ViewerSession | null>; sceneId: string; initial: Saved; ready: boolean; showTags: () => void; feedback: Feedback;
}) {
  const [saved, setSaved] = useState(initial);
  // The tags the capture came with, once the viewer has read it.
  const [imported, setImported] = useState<SpaceTag[] | null>(null);
  const [issue, setIssue] = useState<string | null>(null);
  const [list, setList] = useState<SpaceTag[] | null>(initial.tags);
  const [chosen, setChosen] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [placing, setPlacing] = useState<Placing>(null);
  const [hint, setHint] = useState('');
  const latest = useRef({ list, chosen, placing, showTags });
  latest.current = { list, chosen, placing, showTags };

  const baseline = saved.tags ?? imported;
  const dirty = list !== null && baseline !== null && JSON.stringify(list) !== JSON.stringify(baseline);

  useEffect(() => { if (ready && list) session.current?.setTags(list); }, [ready, list, session]);
  useEffect(() => { if (ready) session.current?.selectTag(chosen); }, [ready, chosen, list, session]);

  const events = useMemo(() => ({
    onTags: (tags: SpaceTag[], reason: string | null) => {
      setImported(tags);
      setIssue(reason);
      setList(current => current ?? tags);
    },
    onTagSelect: (id: string | null) => {
      if (id) { setChosen(id); latest.current.showTags(); }
      // A click elsewhere lets the viewer's highlight go; the tag chosen here stays chosen.
      else if (latest.current.chosen) session.current?.selectTag(latest.current.chosen);
    },
    onTagPlace: (spot: TagSpot | null, loading?: boolean) => {
      const { placing: mode, chosen: id, list: tags } = latest.current;
      if (!mode) return;
      if (!spot) {
        setHint(loading ? 'The space’s 3D model is still loading. Click again in a moment.' : 'Nothing there can hold a tag. Click a wall, floor or object, or press Escape.');
        return;
      }
      setPlacing(null);
      setHint('');
      if (mode === 'move' && id) { setList((tags ?? []).map(tag => tag.id === id ? { ...unplaced(tag), ...spot } : tag)); return; }
      const tag: SpaceTag = { id: newTagId((tags ?? []).map(item => item.id)), title: '', color: defaultTagColor, ...spot };
      setList([...(tags ?? []), tag]);
      setChosen(tag.id);
      setFresh(tag.id);
    }
  }), [session]);

  const stopPlacing = useCallback(() => {
    session.current?.cancelTagPlacement();
    setPlacing(null);
    setHint('');
  }, [session]);
  useEffect(() => {
    if (!placing) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') stopPlacing(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [placing, stopPlacing]);

  function place(mode: 'new' | 'move') {
    feedback.setError(''); feedback.setMessage('');
    setHint(mode === 'new' ? 'Click where the tag goes: a wall, floor or object in the space.' : 'Click where this tag moves to.');
    setPlacing(mode);
    session.current?.startTagPlacement();
  }

  const update = (id: string, change: Partial<SpaceTag>) => setList(tags => tags?.map(tag => tag.id === id ? tidy({ ...tag, ...change }) : tag) ?? tags);

  function remove(id: string) {
    setList(tags => tags?.filter(tag => tag.id !== id) ?? tags);
    if (chosen === id) setChosen(null);
  }

  /** Saves the list, or with `restore` goes back to the tags the capture came with. */
  async function save(restore = false) {
    feedback.setBusy(true); feedback.setError(''); feedback.setMessage('');
    try {
      const tags = restore ? null : list;
      if (tags?.some(tag => !tag.title.trim())) throw new Error('Give every tag a title before saving.');
      const response = await fetch(`/api/admin/scenes/${sceneId}/tags`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags, revision: saved.revision }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to save. Try again.');
      setSaved({ tags: result.tags, revision: result.revision });
      const shown: SpaceTag[] = result.tags ?? imported ?? [];
      setList(shown);
      if (chosen && !shown.some(tag => tag.id === chosen)) setChosen(null);
      feedback.setMessage(restore ? 'The tags the capture came with are back.' : 'Tags saved. Visitors see them now.');
    } catch (error) { feedback.setError((error as Error).message); }
    finally { feedback.setBusy(false); }
  }

  return { saved, imported, issue, list, chosen, setChosen, fresh, placing, hint, dirty, events, place, stopPlacing, update, remove, save };
}

export type TagEditing = ReturnType<typeof useTagEditing>;

/** The editor's colors by name, for screen readers. */
const colorNames: Record<string, string> = { '#0098db': 'Blue', '#e03c31': 'Red', '#f7c948': 'Yellow', '#2e9d62': 'Green', '#8b5cf6': 'Violet', '#ffffff': 'White', '#111111': 'Black' };

const mediaKinds: { value: TagMedia['type'] | ''; label: string }[] = [
  { value: '', label: 'None' }, { value: 'image', label: 'Photo' }, { value: 'video', label: 'Video' }, { value: 'link', label: 'Link' }
];

/** The Tags tab: the list, the chosen tag's fields, and saving. */
export function TagsPanel({ editing, busy, viewerReady, session }: { editing: TagEditing; busy: boolean; viewerReady: boolean; session: RefObject<ViewerSession | null> }) {
  const { list, chosen, issue, placing } = editing;
  const tag = list?.find(item => item.id === chosen) ?? null;
  if (issue) return <p className="site-hint" role="status">{issue}</p>;
  if (!list) return <p className="site-hint" role="status">Loading the space’s tags…</p>;
  const restorable = editing.saved.tags !== null && (editing.imported?.length ?? 0) > 0;
  return <>
    <p className="site-hint">Tags pin a title, a description and a photo, video or link to a spot in the space. Visitors open them in the space or from its list of tags.</p>
    {list.length > 0 && <ul className="tag-edit-list" aria-label="Tags">
      {list.map(item => <li key={item.id}>
        <button type="button" aria-pressed={item.id === chosen} onClick={() => editing.setChosen(item.id === chosen ? null : item.id)}>
          <span className="tag-card-dot" style={{ background: item.color ?? defaultTagColor }} aria-hidden="true" />
          <span className="tag-edit-title">{item.title || 'Untitled tag'}</span>
          {item.source === 'matterport' && <span className="tag-edit-source">Matterport</span>}
        </button>
      </li>)}
    </ul>}
    {placing ? <div className="space-edit-actions">
      <p className="site-note" role="status">{editing.hint}</p>
      <button type="button" className="site-button site-button-secondary" onClick={editing.stopPlacing}>Stop placing</button>
    </div> : <div className="space-edit-actions">
      <button type="button" className="site-button site-button-secondary" disabled={!viewerReady || busy || list.length >= tagLimits.tags} onClick={() => editing.place('new')}>
        <Plus size={18} aria-hidden="true" /> Add a tag
      </button>
    </div>}
    {tag && <TagFields key={tag.id} tag={tag} editing={editing} busy={busy} viewerReady={viewerReady} session={session} />}
    <div className="space-edit-actions">
      <button type="button" className="site-button" disabled={busy || !editing.dirty || Boolean(placing)} onClick={() => void editing.save()}>{busy ? 'Saving…' : 'Save tags'}</button>
    </div>
    {restorable && <button type="button" className="site-link space-edit-reset" disabled={busy} onClick={() => void editing.save(true)}>Go back to the tags the capture came with</button>}
  </>;
}

function TagFields({ tag, editing, busy, viewerReady, session }: { tag: SpaceTag; editing: TagEditing; busy: boolean; viewerReady: boolean; session: RefObject<ViewerSession | null> }) {
  const set = (change: Partial<SpaceTag>) => editing.update(tag.id, change);
  const [mediaUrl, setMediaUrl] = useState(tag.media?.url ?? '');
  const [mediaType, setMediaType] = useState<TagMedia['type'] | ''>(tag.media?.type ?? '');
  const address = mediaUrl.trim() ? mediaAddress(mediaUrl.trim()) : undefined;
  const badAddress = Boolean(mediaType && mediaUrl.trim() && !address);
  function setMedia(type: TagMedia['type'] | '', url: string) {
    setMediaType(type); setMediaUrl(url);
    const valid = url.trim() ? mediaAddress(url.trim()) : undefined;
    set({ media: type && valid ? { type, url: valid } : undefined });
  }
  return <fieldset className="tag-edit-fields" disabled={busy}>
    <legend className="tag-edit-legend">{tag.title || 'New tag'}</legend>
    <div className="site-field"><label htmlFor="tag-title">Title</label>
      <input id="tag-title" className="site-input" value={tag.title} maxLength={tagLimits.title} autoFocus={tag.id === editing.fresh}
        placeholder="What visitors see first" onChange={event => set({ title: event.target.value })} /></div>
    <div className="site-field"><label htmlFor="tag-description">Description</label>
      <textarea id="tag-description" className="site-input" rows={4} value={tag.description ?? ''} maxLength={tagLimits.description}
        placeholder="What to know about this spot. Web addresses become links." onChange={event => set({ description: event.target.value })} /></div>
    <div className="site-field"><span className="site-field-label" id="tag-color-label">Color</span>
      <div className="tag-edit-swatches" role="group" aria-labelledby="tag-color-label">
        {tagColors.map(color => <button key={color} type="button" className="tag-edit-swatch" style={{ background: color }} aria-label={colorNames[color] ?? color} title={colorNames[color]}
          aria-pressed={(tag.color ?? defaultTagColor) === color} onClick={() => set({ color })} />)}
        <label className="tag-edit-custom" title="Another color">
          <input type="color" value={tag.color ?? defaultTagColor} aria-label="Another color" onChange={event => set({ color: event.target.value.toLowerCase() })} />
        </label>
      </div></div>
    <div className="space-edit-pair">
      <div className="site-field"><label htmlFor="tag-media-type">Photo, video or link</label>
        <select id="tag-media-type" className="site-input" value={mediaType} onChange={event => setMedia(event.target.value as TagMedia['type'] | '', mediaUrl)}>
          {mediaKinds.map(kind => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
        </select></div>
      {mediaType && <div className="site-field"><label htmlFor="tag-media-url">Web address</label>
        <input id="tag-media-url" className="site-input" value={mediaUrl} maxLength={tagLimits.url} inputMode="url" placeholder="https://"
          aria-invalid={badAddress} aria-describedby={badAddress ? 'tag-media-problem' : undefined} onChange={event => setMedia(mediaType, event.target.value)} /></div>}
    </div>
    {badAddress && <p className="site-alert" id="tag-media-problem">Start the address with https://</p>}
    {tag.media && tag.media.type !== 'link' && <div className="tag-edit-preview"><TagMediaView key={tag.media.url} media={tag.media} title={tag.title} /></div>}
    {tag.nodeId && <p className="site-hint">This space has no surfaces to pin to, so this tag shows from the panorama it was placed in.</p>}
    <div className="tag-edit-tools">
      <button type="button" className="site-button site-button-secondary" disabled={!viewerReady} onClick={() => session.current?.focusTag(tag.id)}><Eye size={18} aria-hidden="true" /> Show</button>
      <button type="button" className="site-button site-button-secondary" disabled={!viewerReady || Boolean(editing.placing)} onClick={() => editing.place('move')}><Crosshair size={18} aria-hidden="true" /> Move</button>
      <button type="button" className="site-button site-button-secondary" onClick={() => editing.remove(tag.id)}><Trash2 size={18} aria-hidden="true" /> Delete</button>
    </div>
  </fieldset>;
}
