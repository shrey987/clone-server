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

with open(html_path, 'w', encoding='utf-8') as f:
    f.write(html)

print(f'Assets done: {len(url_map)//2} downloaded, HTML updated')
