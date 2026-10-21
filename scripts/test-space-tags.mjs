// Tags in a space (lib/space-tags.ts): what an editor may save, what the viewer shows, and how a card links text and plays video.
//   node --test scripts/test-space-tags.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaAddress, newTagId, parseSpaceTags, readableTags, SpaceTagError, tagLimits, textRuns, videoPlayer } from '../lib/space-tags.ts';

const door = { id: 'tag-door', title: 'Front door', position: { x: 1, y: 1.4, z: -2 } };

test('a saved tag keeps what is filled in, tidied', () => {
  const [tag] = parseSpaceTags([{ ...door, title: '  Front\tdoor ', description: 'Built 1902.\r\n\r\n\r\n  See https://example.org/door.  ', normal: { x: 0, y: 0, z: 2 },
    color: '#E03C31', media: { type: 'image', url: ' https://example.org/door.jpg ' }, source: 'matterport', nodeId: 'pano-024', extra: 'dropped' }]);
  assert.deepEqual(tag, { id: 'tag-door', title: 'Front door', description: 'Built 1902.\n\nSee https://example.org/door.', position: { x: 1, y: 1.4, z: -2 },
    normal: { x: 0, y: 0, z: 1 }, color: '#e03c31', media: { type: 'image', url: 'https://example.org/door.jpg' }, source: 'matterport', nodeId: 'pano-024' });
  assert.deepEqual(parseSpaceTags([{ ...door, normal: { x: 0, y: 0, z: 0 }, media: { type: 'link', url: '' }, description: ' ' }]), [door], 'empty fields are left out');
});

test('a tag the editor cannot save says why', () => {
  const refused = (tags, message) => assert.throws(() => parseSpaceTags(tags), error => error instanceof SpaceTagError && message.test(error.message));
  refused({}, /as a list/);
  refused([{ ...door, title: '  ' }], /title/);
  refused([{ ...door, id: 'has space' }], /ID/);
  refused([door, door], /same ID/);
  refused([{ ...door, position: { x: 1, y: Number.NaN, z: 0 } }], /point/);
  refused([{ ...door, color: 'red' }], /#rrggbb/);
  refused([{ ...door, media: { type: 'image', url: 'http://example.org/door.jpg' } }], /https/);
  refused([{ ...door, media: { type: 'audio', url: 'https://example.org/a.mp3' } }], /photo, a video or a link/);
  refused([{ ...door, title: 'x'.repeat(tagLimits.title + 1) }], /under 200/);
  refused(Array.from({ length: tagLimits.tags + 1 }, (_, index) => ({ ...door, id: `tag-${index}` })), /up to 300/);
});

test('the viewer shows the tags it can read and skips the rest', () => {
  assert.deepEqual(readableTags([door, { ...door }, { id: 'broken' }, { ...door, id: 'tag-window', title: 'Window' }]).map(tag => tag.id), ['tag-door', 'tag-window']);
  assert.deepEqual(readableTags(undefined), []);
  assert.deepEqual(readableTags({ tags: [door] }), []);
});

test('media lives on https or in the capture itself', () => {
  assert.equal(mediaAddress('https://iiif.mused.org/door.jpg'), 'https://iiif.mused.org/door.jpg');
  assert.equal(mediaAddress('/datasets/matterport/great-pyramid/tags/a1.jpg'), '/datasets/matterport/great-pyramid/tags/a1.jpg');
  for (const bad of ['http://example.org/a.jpg', 'https://user:pass@example.org/a.jpg', 'javascript:alert(1)', '/datasets/../etc/passwd', '//evil.example/a.jpg', 'https://localhost/a.jpg']) {
    assert.equal(mediaAddress(bad), undefined, bad);
  }
});

test('a card links the web addresses in a description and leaves the punctuation', () => {
  assert.deepEqual(textRuns('See the plan (https://example.org/a_(b)) and https://example.org/c. Or http://old.example.org!'), [
    { text: 'See the plan (' }, { text: 'https://example.org/a_(b)', href: 'https://example.org/a_(b)' }, { text: ') and ' },
    { text: 'https://example.org/c', href: 'https://example.org/c' }, { text: '. Or ' }, { text: 'http://old.example.org', href: 'http://old.example.org/' }, { text: '!' }
  ]);
  assert.deepEqual(textRuns('No links here.'), [{ text: 'No links here.' }]);
  assert.deepEqual(textRuns('Not one: https://localhost/x'), [{ text: 'Not one: https://localhost/x' }], 'an address that is not on a site stays text');
});

test('videos play in the card from YouTube, Vimeo or a file, and anything else is a link out', () => {
  assert.deepEqual(videoPlayer('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10'), { kind: 'frame', src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' });
  assert.deepEqual(videoPlayer('https://youtu.be/dQw4w9WgXcQ'), { kind: 'frame', src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' });
  assert.deepEqual(videoPlayer('https://youtube.com/shorts/dQw4w9WgXcQ'), { kind: 'frame', src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' });
  assert.deepEqual(videoPlayer('https://vimeo.com/76979871'), { kind: 'frame', src: 'https://player.vimeo.com/video/76979871' });
  assert.deepEqual(videoPlayer('https://example.org/clip.mp4'), { kind: 'file', src: 'https://example.org/clip.mp4' });
  assert.equal(videoPlayer('https://www.facebook.com/watch/?v=123'), null);
});

test('new tags get IDs no other tag has', () => {
  const taken = new Set(['tag-a']);
  for (let index = 0; index < 50; index++) {
    const id = newTagId(taken);
    assert.match(id, /^tag-[a-z0-9]+$/);
    assert.ok(!taken.has(id));
    taken.add(id);
  }
});
