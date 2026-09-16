# Observatory E57 workflow video

`observatory-e57-workflow.mp4` demonstrates the Loomis–Michael Telescope Observatory
Matterport import in SPHR. The README poster links to the MP4 so it remains usable
in GitHub and Markdown viewers that do not support embedded video.

- Recorded from the real local SPHR viewer on 2026-09-16, after the borderless-button update.
- H.264 MP4, 1280 × 800, 30 fps delivery, approximately 49 seconds, silent.
- Browser frames retain their capture timing; the opening command overview and
  closing sharing explanation are editorial cards, not a recording of a new import.
- The package contains 53 scans, 318 calibrated 2048² cube faces, and a photo-textured
  mesh with 49,999 triangles. Counts come from the existing validated import manifest.
- Source E57 SHA-256: `64dd2a96aa4768058a970ff98338bdd669f389e4a1375ed2426583d1cc7b364e`.

## Transcript

1. **Migrate:** import a Matterport ZIP/E57 with `npm run import:matterport`.
   Derive photograph orientation from camera poses, preserve meters, fuse measured
   depth, bake the photo atlas, and validate before publishing the package.
2. **Open:** select the observatory from the scene collection; it opens automatically.
3. **Explore:** drag to look around the calibrated panorama.
4. **Move:** single-click a floor marker to navigate to another scan.
5. **Dollhouse:** zoom out to the textured mesh and orbit the reconstructed building.
6. **Return:** double-click the dollhouse to animate back into first person.
7. **Share:** use `/s/bc8d61ff42cf/loomis-michael-telescope-observatory` on the host
   serving SPHR and its scene assets. The stable ID survives title changes.

The media files are documentation assets; the original E57 and full migrated
package remain outside Git. See [the migration guide](../matterport.md) for the
complete procedure and [hosting](../scene-library.md) for public scene URLs.
