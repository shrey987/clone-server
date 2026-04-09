import sys, os, re, urllib.request, hashlib

job_dir = sys.argv[1]
html_path = os.path.join(job_dir, 'page.html')
assets_dir = os.path.join(job_dir, 'assets')
os.makedirs(assets_dir, exist_ok=True)

with open(html_path, 'r', encoding='utf-8', errors='ignore') as f:
    html = f.read()

patterns = [
    r'src=["\']((https?://)[^"\']+)["\']',
    r'data-src=["\']((https?://)[^"\']+)["\']',
    r'url\(["\']?((https?://)[^"\')\s]+)["\']?\)',
    r'srcset=["\']((https?://)[^"\']+)["\']',
]

ASSET_EXTS = ('.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.mp4', '.webm',
              '.woff', '.woff2', '.ttf', '.otf', '.ico')

all_urls = set()
for pat in patterns:
    for m in re.findall(pat, html):
        url = m[0].strip()
        clean = url.split('?')[0].lower()
        if any(clean.endswith(e) for e in ASSET_EXTS):
            all_urls.add(url)

print(f'Found {len(all_urls)} asset URLs')

url_map = {}
for url in all_urls:
    try:
        h = hashlib.md5(url.encode()).hexdigest()[:8]
        fname = h + '-' + os.path.basename(url.split('?')[0])[:50]
        local = os.path.join(assets_dir, fname)
        if not os.path.exists(local):
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = resp.read()
            with open(local, 'wb') as f:
                f.write(data)
        url_map[url] = 'assets/' + fname
        print(f'OK: {fname}')
    except Exception as e:
        print(f'SKIP: {url[:60]}: {e}')

# Replace all URLs in HTML
for orig, local in url_map.items():
    html = html.replace(orig, local)

# Also fix lazy-load: copy data-src value into src where src is empty
import re as _re
def fix_lazy(m):
    tag = m.group(0)
    dsrc = _re.search(r'data-src=["\']([^"\']+)["\']', tag)
    if not dsrc:
        return tag
    real = dsrc.group(1)
    tag = _re.sub(r'\bsrc=["\']["\']', f'src="{real}"', tag)
    return tag

html = _re.sub(r'<img[^>]+>', fix_lazy, html)

with open(html_path, 'w', encoding='utf-8') as f:
    f.write(html)

print(f'Assets done: {len(url_map)} downloaded, HTML updated')
