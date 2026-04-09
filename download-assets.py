"""
download-assets.py
Downloads all assets (images, fonts, video, CSS background URLs) from a cloned page.
Handles both absolute URLs (https://cdn.example.com/img.jpg) and
relative URLs (/imgs/hero.png, ../fonts/font.woff2).

Usage: python3 download-assets.py <job_dir> <base_url>
  job_dir  — directory containing page.html and assets/
  base_url — original page URL, used to resolve relative paths
"""

import sys, os, re, urllib.request, urllib.parse, hashlib

job_dir  = sys.argv[1]
base_url = sys.argv[2] if len(sys.argv) > 2 else ''

# Derive base origin + base dir from base_url
parsed   = urllib.parse.urlparse(base_url)
origin   = f"{parsed.scheme}://{parsed.netloc}"           # e.g. https://tryk9soothe.com
base_dir = origin + '/'.join(parsed.path.split('/')[:-1]) + '/'  # dir of the page

html_path   = os.path.join(job_dir, 'page.html')
assets_dir  = os.path.join(job_dir, 'assets')
os.makedirs(assets_dir, exist_ok=True)

with open(html_path, 'r', encoding='utf-8', errors='ignore') as f:
    html = f.read()

ASSET_EXTS = (
    '.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg',
    '.mp4', '.webm', '.mov',
    '.woff', '.woff2', '.ttf', '.otf',
    '.ico', '.avif',
)

def resolve(url):
    """Turn any URL (absolute, root-relative, relative) into an absolute URL."""
    url = url.strip()
    if url.startswith('data:') or url.startswith('blob:') or url.startswith('//'):
        if url.startswith('//'):
            return parsed.scheme + ':' + url
        return None  # data/blob can't be downloaded
    if url.startswith('http://') or url.startswith('https://'):
        return url
    if url.startswith('/'):
        return origin + url          # root-relative: /imgs/hero.png
    if base_url:
        return base_dir + url        # relative: ../fonts/font.woff2
    return None

# Patterns that capture asset references — both quoted and unquoted
patterns = [
    r'(?:src|data-src|data-bg|poster)=["\']([^"\']+)["\']',
    r'url\(["\']?([^"\')\s]+)["\']?\)',
    r'srcset=["\']([^"\']+)["\']',
    r'href=["\']([^"\']+\.(?:woff2?|ttf|otf|ico))["\']',
]

raw_urls = set()
for pat in patterns:
    for m in re.findall(pat, html):
        # srcset can be "url1 2x, url2 1x" — split on comma
        for part in m.split(','):
            candidate = part.strip().split(' ')[0]   # drop descriptor like "2x"
            if candidate:
                raw_urls.add(candidate)

# Resolve to absolute and filter to asset extensions
all_urls = set()
for raw in raw_urls:
    abs_url = resolve(raw)
    if not abs_url:
        continue
    clean = abs_url.split('?')[0].lower()
    if any(clean.endswith(e) for e in ASSET_EXTS):
        all_urls.add((raw, abs_url))

print(f'Found {len(all_urls)} asset URLs to download')

url_map = {}  # original ref → local path
for (raw, abs_url) in all_urls:
    try:
        h    = hashlib.md5(abs_url.encode()).hexdigest()[:8]
        fname = h + '-' + os.path.basename(abs_url.split('?')[0])[:60]
        local = os.path.join(assets_dir, fname)
        if not os.path.exists(local):
            req = urllib.request.Request(
                abs_url,
                headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'}
            )
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = resp.read()
            with open(local, 'wb') as f:
                f.write(data)
        url_map[raw]     = 'assets/' + fname   # replace raw ref
        url_map[abs_url] = 'assets/' + fname   # also replace absolute ref if present
        print(f'OK: {fname}  ({abs_url[:60]})')
    except Exception as e:
        print(f'SKIP: {abs_url[:70]}: {e}')

# Replace all URL references in HTML (longest first to avoid partial replacements)
for orig in sorted(url_map.keys(), key=len, reverse=True):
    html = html.replace(orig, url_map[orig])

# Fix lazy-load: copy data-src into empty src
def fix_lazy(m):
    tag = m.group(0)
    dsrc = re.search(r'data-src=["\']([^"\']+)["\']', tag)
    if not dsrc:
        return tag
    real = dsrc.group(1)
    tag = re.sub(r'\bsrc=["\']["\']', f'src="{real}"', tag)
    return tag

html = re.sub(r'<img[^>]+>', fix_lazy, html)

# ── Download Wistia video thumbnails ──────────────────────────────────────────
# Wistia loads real thumbnails via JS — they don't appear in the static HTML.
# Fetch from Wistia embed JSON API and save as 'wistia-thumb-{id}.jpg'.
import json as _json
wistia_ids = set(re.findall(r'wistia_async_([a-z0-9]+)', html))
for wid in wistia_ids:
    try:
        thumb_api = f'https://fast.wistia.com/embed/medias/{wid}.json'
        req = urllib.request.Request(
            thumb_api,
            headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'}
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = _json.load(resp)
        # Thumbnail URL is at media.assets[].type=="still_image" or media.thumbnail.url
        thumb_url = None
        for asset in data.get('media', {}).get('assets', []):
            if asset.get('type') in ('still_image', 'thumbnail', 'original_still_image'):
                thumb_url = asset.get('url')
                break
        if not thumb_url:
            thumb_url = data.get('media', {}).get('thumbnail', {}).get('url')
        if thumb_url:
            # Download thumbnail
            fname = f'wistia-thumb-{wid}.jpg'
            local = os.path.join(assets_dir, fname)
            req2 = urllib.request.Request(
                thumb_url,
                headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'}
            )
            with urllib.request.urlopen(req2, timeout=20) as resp2:
                data2 = resp2.read()
            with open(local, 'wb') as f:
                f.write(data2)
            print(f'Wistia thumb: {fname}  ({thumb_url[:60]})')
        else:
            print(f'Wistia thumb: no URL found for {wid}')
    except Exception as e:
        print(f'Wistia thumb SKIP {wid}: {e}')

# ── Download Shopify product images from product JSON API ────────────────────
# Shopify product pages have images loaded via JS/Liquid that don't appear in
# static HTML. Fetch from /products/{handle}.json for the real image URLs.
import json as _json2
if '/products/' in base_url:
    try:
        # Extract product handle: /products/travel-cushion → travel-cushion
        path_parts = parsed.path.strip('/').split('/')
        prod_idx = path_parts.index('products')
        handle = path_parts[prod_idx + 1].split('?')[0].split('#')[0]
        product_json_url = f'{origin}/products/{handle}.json'
        print(f'Shopify product detected: fetching {product_json_url}')

        req = urllib.request.Request(
            product_json_url,
            headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'}
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            pdata = _json2.loads(resp.read())

        images = pdata.get('product', {}).get('images', [])
        shopify_img_paths = []
        for i, img in enumerate(images):
            img_src = img.get('src', '')
            if not img_src:
                continue
            fname = f'shopify-product-{i}.jpg'
            local = os.path.join(assets_dir, fname)
            try:
                req2 = urllib.request.Request(
                    img_src,
                    headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'}
                )
                with urllib.request.urlopen(req2, timeout=20) as resp2:
                    with open(local, 'wb') as f:
                        f.write(resp2.read())
                shopify_img_paths.append(f'assets/{fname}')
                print(f'Shopify img: {fname}  ({img_src[:60]})')
            except Exception as e:
                print(f'Shopify img SKIP {i}: {e}')

        # Write a manifest so structural-transform can find them
        if shopify_img_paths:
            manifest = os.path.join(job_dir, 'shopify-images.json')
            with open(manifest, 'w') as f:
                _json2.dump(shopify_img_paths, f)
            print(f'Shopify: {len(shopify_img_paths)} product images downloaded')
    except Exception as e:
        print(f'Shopify product JSON failed: {e}')

with open(html_path, 'w', encoding='utf-8') as f:
    f.write(html)

print(f'Assets done: {len(url_map)//2} downloaded, HTML updated')
