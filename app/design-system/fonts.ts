import localFont from "next/font/local";

/** Silkscreen, the pixel face of the site name. Bundled under its license (fonts/Silkscreen-OFL.txt), so pages request no font service. */
export const pixelFont = localFont({ src: "./fonts/Silkscreen-Regular.woff2", weight: "400", display: "swap" });
