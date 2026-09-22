// Reads a video's size, length and 360 metadata with ffprobe.
import { spawnSync } from 'node:child_process';

export function probeVideo(file) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { encoding: 'utf8' });
  if (result.status !== 0) return undefined;
  const data = JSON.parse(result.stdout);
  const video = data.streams.find(stream => stream.codec_type === 'video');
  if (!video) return undefined;
  const rotation = Number(video.side_data_list?.find(item => 'rotation' in item)?.rotation ?? video.tags?.rotate ?? 0);
  const [width, height] = Math.abs(rotation) % 180 === 90 ? [video.height, video.width] : [video.width, video.height];
  const spherical = Boolean(video.side_data_list?.some(item => /spherical/i.test(item.side_data_type ?? ''))) || /equirect|360/i.test(JSON.stringify(data.format.tags ?? {}));
  return { width, height, duration: Number(data.format.duration ?? video.duration ?? 0), codec: video.codec_name, spherical,
    equirectangular: Math.abs(width / height - 2) < 0.1, audio: data.streams.some(stream => stream.codec_type === 'audio') };
}
