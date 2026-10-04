#!/usr/bin/env python3
"""Build the sky library tours can put behind a space.

Every sky here is public domain or CC0: Poly Haven and ambientCG skies (CC0), and NASA's
Deep Star Maps (public domain, NASA Goddard Scientific Visualization Studio) turned into
the night sky as seen from a latitude. Each sky becomes a 4096x2048 equirectangular JPEG
(the ground below the horizon replaced by haze in the horizon's colors, so every sky ends
the same way behind a space), a 1024x512 version that loads first, a thumbnail, and an
entry in index.json with the light the space should take on under it.

    python3 scripts/skies/build.py --cache <download dir> --out <output dir> [--only id,id]
    scripts/skies/upload.sh <output dir>

Then regenerate lib/experience/spacery/skies.ts from the printed TypeScript (--ts).
"""
import argparse
import io
import json
import math
import os
import sys
import urllib.request
import zipfile

os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
import cv2  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

Image.MAX_IMAGE_PIXELS = None
PUBLIC_BASE = "https://storage.googleapis.com/spacery-static/skies"
AGENT = {"User-Agent": "spacery-skies/1 (https://spacery.dev)"}
WIDTH = 4096

POLY = "Poly Haven (CC0)"
ACG = "ambientCG (CC0)"
NASA = "NASA Goddard Scientific Visualization Studio (public domain)"

# id, source, source id, name, kind, place, description
SKIES = [
    ("clear-noon", "polyhaven", "qwantani_noon_puresky", "Clear noon", "day", "Drakensberg foothills, South Africa", "A cloudless blue sky with the sun high overhead."),
    ("fair-clouds", "polyhaven", "kloofendal_48d_partly_cloudy_puresky", "Fair weather clouds", "day", "Johannesburg, South Africa", "Bright midday sun with scattered white clouds."),
    ("summer-cumulus", "polyhaven", "sunflowers_puresky", "Summer cumulus", "day", None, "Puffy summer clouds across a deep blue sky."),
    ("alpine-clear", "polyhaven", "pizzo_pernice_puresky", "Alpine clear", "day", "Pizzo Pernice, Italian Alps", "Thin mountain air, a hard sun and a clean blue dome."),
    ("bright-midday", "polyhaven", "kloofendal_43d_clear_puresky", "Bright midday", "day", "Johannesburg, South Africa", "A crisp midday sky with a few wisps of cloud."),
    ("high-clouds", "polyhaven", "aristea_wreck_puresky", "High broken clouds", "day", "Namaqualand coast, South Africa", "A soft sun behind high, broken coastal clouds."),
    ("island-clouds", "ambientcg", "DaySkyHDRI054B", "Island clouds", "day", "Borkum, Germany", "Flat-bottomed North Sea clouds in a blue sky."),
    ("towering-clouds", "ambientcg", "DaySkyHDRI007B", "Towering clouds", "day", None, "Big bright cumulus building up through the afternoon."),
    ("clear-morning", "polyhaven", "qwantani_mid_morning_puresky", "Clear morning", "day", "Drakensberg foothills, South Africa", "A clear mid-morning sky with the sun still climbing."),
    ("hazy-midday", "polyhaven", "farm_field_puresky", "Hazy midday", "day", "Limpopo, South Africa", "Warm, hazy farmland light with thin cloud."),
    ("overcast", "polyhaven", "kloofendal_overcast_puresky", "Overcast", "cloudy", "Johannesburg, South Africa", "An even gray sky with soft light and no shadows."),
    ("misty-morning", "polyhaven", "kloofendal_misty_morning_puresky", "Misty morning", "cloudy", "Johannesburg, South Africa", "Cool white mist with the sun hidden behind it."),
    ("winter-overcast", "polyhaven", "snow_field_puresky", "Winter overcast", "cloudy", "Sumy, Ukraine", "A low winter sky over snow, pale and quiet."),
    ("thunderhead", "ambientcg", "DaySkyHDRI061B", "Thunderhead", "storm", None, "A dark storm cloud building in a bright sky."),
    ("storm-at-dusk", "ambientcg", "EveningSkyHDRI030A", "Storm at dusk", "storm", None, "Heavy storm clouds with the last light breaking under them."),
    ("rainy-evening", "ambientcg", "EveningSkyHDRI029B", "Rainy evening", "storm", None, "Low rain clouds rolling in at the end of the day."),
    ("dawn", "polyhaven", "qwantani_dawn_puresky", "Dawn", "sunrise", "Drakensberg foothills, South Africa", "The pale glow on the horizon before the sun is up."),
    ("clear-sunrise", "polyhaven", "qwantani_sunrise_puresky", "Clear sunrise", "sunrise", "Drakensberg foothills, South Africa", "The sun just clearing a cloudless horizon."),
    ("cape-town-sunrise", "polyhaven", "table_mountain_1_puresky", "Cape Town sunrise", "sunrise", "Table Mountain, Cape Town", "A bright sunrise with streaks of high cloud."),
    ("swabian-sunrise", "polyhaven", "drackenstein_quarry_puresky", "Swabian sunrise", "sunrise", "Swabian Jura, Germany", "Soft warm sunrise light through layered cloud."),
    ("foggy-sunrise", "ambientcg", "MorningSkyHDRI007B", "Foggy sunrise", "sunrise", None, "A pink sun glowing through ground fog."),
    ("golden-afternoon", "polyhaven", "lonely_road_afternoon_puresky", "Golden afternoon", "sunset", "Free State, South Africa", "A low warm sun late in a clear afternoon."),
    ("sunset", "polyhaven", "qwantani_sunset_puresky", "Sunset", "sunset", "Drakensberg foothills, South Africa", "A warm sunset under a few lit clouds."),
    ("sunset-over-water", "polyhaven", "belfast_sunset_puresky", "Sunset over water", "sunset", "Belfast, Mpumalanga, South Africa", "A calm, lilac sunset with the sun on the horizon."),
    ("golden-clouds", "ambientcg", "EveningSkyHDRI032B", "Golden clouds", "sunset", None, "Evening clouds lit gold and orange from below."),
    ("clear-sunset", "polyhaven", "rosendal_park_sunset_puresky", "Clear sunset", "sunset", "Rosendal, Free State, South Africa", "A soft orange glow along a clear horizon."),
    ("steppe-sunrise", "polyhaven", "scythian_tombs_puresky", "Steppe sunrise", "sunrise", "Poltava steppe, Ukraine", "Feathery clouds over open steppe at sunrise."),
    ("dusk", "polyhaven", "qwantani_dusk_2_puresky", "Dusk", "dusk", "Drakensberg foothills, South Africa", "The sun just gone, a warm band under a cooling sky."),
    ("blue-hour", "ambientcg", "EveningSkyHDRI042B", "Blue hour", "dusk", None, "Deep blue twilight with a last pale glow."),
    ("milky-way", "polyhaven", "qwantani_night_puresky", "Milky Way", "night", "Drakensberg foothills, South Africa", "A clear dark night with the Milky Way overhead."),
    ("moonlit-stars", "polyhaven", "kloppenheim_02_puresky", "Moonlit stars", "night", "Mpumalanga, South Africa", "Stars and a bright moon in a clear sky."),
    ("moonrise", "polyhaven", "qwantani_moonrise_puresky", "Moonrise", "night", "Drakensberg foothills, South Africa", "The moon rising over the horizon among stars."),
    ("cloudy-night", "polyhaven", "kloppenheim_07_puresky", "Cloudy night", "night", "Mpumalanga, South Africa", "Moonlight breaking through a low, cloudy night."),
    ("galactic-core", "ambientcg", "NightSkyHDRI008", "Galactic core", "night", None, "The bright core of the Milky Way arching across the sky."),
    ("full-moon", "ambientcg", "NightSkyHDRI003", "Full moon", "night", None, "A full moon high in a starry sky."),
    ("northern-lights", "ambientcg", "NightSkyHDRI004", "Northern lights", "night", None, "Curtains of aurora over a starry sky."),
    ("northern-stars", "nasa", "38", "Northern stars", "night", "Seen from 38 degrees north", "Every star and the Milky Way as seen from the Mediterranean on a summer night."),
    ("southern-stars", "nasa", "-30", "Southern stars", "night", "Seen from 30 degrees south", "The southern sky with the Milky Way's core overhead."),
]

# How much light a space keeps under each kind of sky, before the sky's own colors tint it.
KIND_LIGHT = {"day": 1.0, "cloudy": 0.88, "storm": 0.7, "sunrise": 0.88, "sunset": 0.86, "dusk": 0.66, "night": 0.46}
NO_MOON = {"milky-way", "galactic-core"}
CREDIT = {"polyhaven": POLY, "ambientcg": ACG, "nasa": NASA}


def fetch(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    print("  downloading", url, file=sys.stderr)
    request = urllib.request.Request(url, headers=AGENT)
    with urllib.request.urlopen(request, timeout=600) as response, open(path + ".part", "wb") as out:
        while True:
            chunk = response.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
    os.replace(path + ".part", path)
    return path


def srgb_to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def load_polyhaven(cache, source):
    info = json.load(urllib.request.urlopen(urllib.request.Request(f"https://api.polyhaven.com/files/{source}", headers=AGENT)))
    path = fetch(info["tonemapped"]["url"], os.path.join(cache, f"{source}.jpg"))
    image = Image.open(path)
    image.draft("RGB", (WIDTH * 2, WIDTH))  # decode at a fraction of 16-24K for speed
    return np.asarray(image.convert("RGB").resize((WIDTH, WIDTH // 2), Image.LANCZOS), dtype=np.float32) / 255.0


def load_ambientcg(cache, source):
    path = fetch(f"https://ambientcg.com/get?file={source}_4K.zip", os.path.join(cache, f"{source}_4K.zip"))
    with zipfile.ZipFile(path) as archive:
        image = Image.open(io.BytesIO(archive.read(f"{source}_4K_TONEMAPPED.jpg"))).convert("RGB")
    return np.asarray(image.resize((WIDTH, WIDTH // 2), Image.LANCZOS), dtype=np.float32) / 255.0


def load_nasa(cache, latitude):
    """NASA's star map (celestial coordinates) turned into the sky above `latitude` at the
    sidereal time the Milky Way's core is highest, with a faint airglow along the horizon."""
    path = fetch("https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/starmap_2020_8k.exr", os.path.join(cache, "starmap_2020_8k.exr"))
    stars = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if stars is None:
        raise RuntimeError("OpenCV could not read the EXR star map")
    stars = cv2.cvtColor(stars[:, :, :3], cv2.COLOR_BGR2RGB).astype(np.float32)
    # Render at the star map's own size and shrink after, so faint stars average in instead of dropping out.
    height, width = stars.shape[0], stars.shape[1]
    phi = math.radians(float(latitude))
    lst = math.radians(17.76 * 15)  # Sagittarius A* at its highest
    u = (np.arange(width, dtype=np.float32) + 0.5) / width
    v = (np.arange(height, dtype=np.float32) + 0.5) / height
    uu, vv = np.meshgrid(u, v)
    # Three's equirect convention: u = atan2(z, x) / 2pi + 0.5, v = 1 - (asin(y) / pi + 0.5) from the top.
    lon = (uu - 0.5) * 2 * math.pi
    alt = (0.5 - vv) * math.pi
    x, y, z = np.cos(alt) * np.cos(lon), np.sin(alt), np.cos(alt) * np.sin(lon)
    # North is -z, east is +x in a space with no heading of its own.
    north, east, up = -z, x, y
    sin_dec = math.sin(phi) * up + math.cos(phi) * north
    dec = np.arcsin(np.clip(sin_dec, -1, 1))
    hour = np.arctan2(-east, math.cos(phi) * up - math.sin(phi) * north)
    ra = (lst - hour) % (2 * math.pi)
    # The map is centered on 0h with right ascension increasing to the left.
    map_x = ((0.5 - ra / (2 * math.pi)) % 1.0) * stars.shape[1]
    map_y = (0.5 - dec / math.pi) * stars.shape[0]
    sky = cv2.remap(stars, map_x.astype(np.float32), map_y.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
    sky = cv2.resize(sky, (WIDTH, WIDTH // 2), interpolation=cv2.INTER_AREA)
    alt = cv2.resize(alt.astype(np.float32), (WIDTH, WIDTH // 2), interpolation=cv2.INTER_AREA)
    sky = sky / np.percentile(sky, 99.7) * 0.9
    sky = sky / (1 + sky * 0.35)  # keep bright stars from clipping flat
    # Airglow and a little light pollution low on the horizon, darker toward the zenith.
    elevation = np.clip(alt, 0, None)[..., None]
    glow = np.array([0.004, 0.006, 0.013], dtype=np.float32) + np.array([0.030, 0.034, 0.042], dtype=np.float32) * np.exp(-elevation / 0.18)
    extinction = np.clip(np.sin(elevation) * 4, 0.15, 1)  # stars fade into the horizon haze
    return linear_to_srgb(sky * extinction + glow).astype(np.float32)


def darken_night(image):
    """Some tonemapped night skies are exposed like day. A curve that maps the sky's middle
    tone to a dark night keeps stars and the moon near white and their glow smooth."""
    height = image.shape[0]
    median = float(np.median(image[: height // 2] @ LUMA))
    target = 0.1
    if median <= 0.16:
        return image
    gamma = math.log(target) / math.log(median)
    cool = np.array([0.9, 0.96, 1.06], dtype=np.float32)
    return np.clip(np.power(np.clip(image, 0, 1), gamma) * cool, 0, 1).astype(np.float32)


def haze_below_horizon(image):
    """Replace everything under the horizon with haze in the colors of the sky just above it,
    evening out into one color further down, so every sky ends the same way behind a space."""
    height, width, _ = image.shape
    horizon = int(height / 2)
    band = srgb_to_linear(image[horizon - height // 30: horizon - height // 90])  # 2 to 6 degrees up
    color = band.mean(axis=0)  # per column
    wrapped = np.concatenate([color, color, color]).astype(np.float32)  # the horizon wraps around
    color = cv2.GaussianBlur(wrapped[None], (0, 0), sigmaX=width / 30, sigmaY=0.1)[0][width: 2 * width]
    overall = color.mean(axis=0)
    rows = np.arange(height, dtype=np.float32)
    depth = np.clip((rows - horizon) / (height - horizon), 0, 1)[:, None, None]  # 0 at the horizon, 1 straight down
    even = np.clip(depth / 0.35, 0, 1)
    even = even * even * (3 - 2 * even)
    ground = (color[None] * (1 - even) + overall * even) * (1 - 0.5 * np.sqrt(depth))
    blend = np.clip((rows - horizon + height / 180) / (height / 45), 0, 1)[:, None, None]
    linear = srgb_to_linear(image) * (1 - blend) + ground * blend
    return linear_to_srgb(linear).astype(np.float32)


# Moonlight reads as blue on film; nights lean this way whatever their stars look like.
MOONLIGHT = np.array([0.5, 0.62, 1.0])
WHITE_SHARE = {"day": 0.85, "cloudy": 0.8, "storm": 0.6, "sunrise": 0.3, "sunset": 0.25, "dusk": 0.35, "night": 0.05}
LUMA = np.array([0.2126, 0.7152, 0.0722])


def light_for(image, kind, moonless=False):
    """The tint a space takes on under this sky, eased toward white and dimmed by the kind of
    sky, and where its sun or moon is. Sunrises and sunsets take the color of the horizon
    under the sun; other skies the color of their brightest light."""
    height, width, _ = image.shape
    linear = srgb_to_linear(image[: height // 2])
    luminance = linear @ LUMA
    dome = linear.reshape(-1, 3).mean(axis=0)
    if kind in ("sunrise", "sunset", "dusk"):
        band = linear[height // 2 - height // 18: height // 2 - height // 200].mean(axis=0)  # half a degree to ten degrees up
        glow = np.convolve(np.concatenate([band @ LUMA] * 3), np.ones(width // 24) / (width // 24), mode="same")[width: 2 * width]
        center = int(np.argmax(glow))
        window = [(center + offset) % width for offset in range(-width // 12, width // 12)]
        hue = band[window].mean(axis=0)
        if kind == "dusk":  # the glow is low and small; most of the light is the cooling sky
            hue = 0.45 * hue / max(hue.max(), 1e-6) + 0.55 * dome / max(dome.max(), 1e-6)
    elif kind == "night":
        hue = MOONLIGHT
    else:
        brightest = luminance >= np.quantile(luminance, 0.995)
        hue = linear[brightest].mean(axis=0)
    hue = hue / max(hue.max(), 1e-6)
    share = WHITE_SHARE[kind]
    blurred = cv2.GaussianBlur(luminance.astype(np.float32), (0, 0), 6)
    y, x = np.unravel_index(np.argmax(blurred), blurred.shape)
    sun = None
    # A sun or moon is a small spot much brighter than the sky; the Milky Way is bright but broad.
    if not moonless and blurred[y, x] > 1.8 * np.median(blurred) and (blurred > 0.92 * blurred[y, x]).mean() < 0.004:
        sun = [round((x + 0.5) / width, 4), round((y + 0.5) / height, 4)]
    level = KIND_LIGHT[kind] * (1.25 if kind == "night" and sun else 1)  # moonlit nights are less dark
    tint = (share + (1 - share) * hue) * level
    return "#" + "".join(f"{int(round(min(channel, 1) * 255)):02x}" for channel in tint), sun


def save(image, path, size, quality):
    pixels = (np.clip(image, 0, 1) * 255 + 0.5).astype(np.uint8)
    picture = Image.fromarray(pixels)
    if picture.size != size:
        picture = picture.resize(size, Image.LANCZOS)
    picture.save(path, "JPEG", quality=quality, optimize=True, progressive=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cache", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--only", default="")
    parser.add_argument("--ts", action="store_true", help="print lib/experience/spacery/skies.ts entries")
    args = parser.parse_args()
    os.makedirs(args.cache, exist_ok=True)
    os.makedirs(args.out, exist_ok=True)
    only = {item for item in args.only.split(",") if item}
    index_path = os.path.join(args.out, "index.json")
    entries = {entry["id"]: entry for entry in json.load(open(index_path))["skies"]} if os.path.exists(index_path) else {}
    for sky_id, source, source_id, name, kind, place, description in SKIES:
        if only and sky_id not in only:
            continue
        print(sky_id, file=sys.stderr)
        loader = {"polyhaven": load_polyhaven, "ambientcg": load_ambientcg, "nasa": load_nasa}[source]
        image = loader(args.cache, source_id)
        if kind == "night" and source != "nasa":
            image = darken_night(image)
        image = haze_below_horizon(image)
        folder = os.path.join(args.out, sky_id)
        os.makedirs(folder, exist_ok=True)
        save(image, os.path.join(folder, "4k.jpg"), (WIDTH, WIDTH // 2), 88)
        save(image, os.path.join(folder, "1k.jpg"), (1024, 512), 84)
        save(image[: image.shape[0] * 3 // 5], os.path.join(folder, "thumb.jpg"), (320, 96), 80)
        # A moonless night: the bright spot is the Milky Way's core or a town's glow, not a moon.
        light, sun = light_for(image, kind, moonless=source == "nasa" or sky_id in NO_MOON)
        link = {"polyhaven": f"https://polyhaven.com/a/{source_id}", "ambientcg": f"https://ambientcg.com/a/{source_id}", "nasa": "https://svs.gsfc.nasa.gov/4851"}[source]
        entries[sky_id] = {
            "id": sky_id, "label": name, "kind": kind, "description": description,
            **({"place": place} if place else {}),
            "image": f"{PUBLIC_BASE}/{sky_id}/4k.jpg", "preview": f"{PUBLIC_BASE}/{sky_id}/1k.jpg", "thumb": f"{PUBLIC_BASE}/{sky_id}/thumb.jpg",
            "light": light, **({"sun": sun} if sun else {}),
            "credit": CREDIT[source], "source": link,
        }
    order = [sky[0] for sky in SKIES]
    skies = [entries[sky_id] for sky_id in order if sky_id in entries]
    json.dump({"version": 1, "skies": skies}, open(index_path, "w"), indent=1)
    print(f"{len(skies)} skies in {index_path}", file=sys.stderr)
    if args.ts:
        for entry in skies:
            print("  {" + ", ".join(f"{key}: {json.dumps(value, ensure_ascii=False)}" for key, value in entry.items()) + "},")


if __name__ == "__main__":
    main()
