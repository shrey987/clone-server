"""
structural-transform.py v2
Post-capture structural fixes. Assets are already downloaded by playwright-capture.js.

Handles:
  1. Selective script removal (popup/tracking/analytics/cart only, keep interactive JS)
  2. VSL video gates (unhide display:none, height:0, etc.)
  3. Shopify product JSON fallback (if Replo imgs still have {{}} vars)
  4. Template var cleanup + UUID text removal
  5. Lazy-load fix (data-src -> src)

Usage: python3 structural-transform.py <job_dir> [<base_url>]
"""

import sys, os, re, json, urllib.request

job_dir  = sys.argv[1]
base_url = sys.argv[2] if len(sys.argv) > 2 else ''
html_path = os.path.join(job_dir, 'page.html')
assets_dir = os.path.join(job_dir, 'assets')

with open(html_path, 'r', encoding='utf-8', errors='ignore') as f:
    html = f.read()

original_len = len(html)

# ── 1. Selective script removal ──────────────────────────────────────────────
# ONLY remove scripts from known popup/tracking/analytics/cart domains.
# Keep all other scripts (carousels, accordions, page-builder runtime).

REMOVE_SCRIPT_PATTERNS = [
    # Popup / email capture
    r'klaviyo', r'privy\.com', r'optinmonster', r'justuno', r'sumo\.com',
    r'wisepops', r'poptin', r'sleeknote', r'getsitecontrol',
    # Cookie consent
    r'cookielaw\.org', r'cookiebot\.com', r'usercentrics\.eu', r'onetrust',
    # Chat widgets
    r'intercom', r'drift\.com', r'crisp\.chat', r'zdassets\.com', r'tawk\.to',
    r'lr-ingest\.io', r'logrocket',
    # Analytics / tracking
    r'googletagmanager\.com', r'google-analytics\.com', r'analytics\.google\.com',
    r'connect\.facebook\.net', r'hotjar\.com', r'heapanalytics',
    r'segment\.com', r'amplitude\.com', r'plausible\.io', r'usefathom\.com',
    r'bat\.bing\.com', r'snap\.licdn\.com', r'sc-static\.net', r'sentry\.io',
    r'meta.*pixel', r'fbevents',
    # Shopify cart/checkout (404 on static hosting)
    r'monorail', r'shopify.*checkout', r'web-pixels-manager',
]

# Build one big regex for script src matching
script_src_pattern = '|'.join(REMOVE_SCRIPT_PATTERNS)

# Remove script tags whose src matches any pattern
removed_scripts = 0
def _remove_script(match):
    global removed_scripts
    tag = match.group(0)
    # Check if src matches
    src_match = re.search(r'src=["\']([^"\']+)["\']', tag)
    if src_match:
        src = src_match.group(1)
        if re.search(script_src_pattern, src, re.IGNORECASE):
            removed_scripts += 1
            return ''
    return tag

html = re.sub(r'<script[^>]+src=["\'][^"\']+["\'][^>]*>.*?</script>', _remove_script, html, flags=re.DOTALL)

# Remove inline scripts that reference popup/tracking globals
inline_remove_patterns = [
    r'_klOnsite', r'klaviyo', r'KlaviyoSubscribe', r'window\.klaviyo',
    r'Privy\.', r'privy\.',
    r'OptinMonster', r'om_loaded',
    r'OneTrust', r'OptanonWrapper', r'CookieBot',
    r'gtag\s*\(', r'dataLayer\.push', r'fbq\s*\(',
    r'hotjar', r'hj\s*\(',
    r'Intercom\s*\(', r'drift\s*\.',
    # Redirect/navigation scripts (clones should never redirect away)
    r'window\.location\s*=', r'window\.location\.href\s*=',
    r'window\.location\.replace\s*\(', r'window\.location\.assign\s*\(',
    r'document\.location\s*=', r'location\.href\s*=',
    r'window\.top\.location', r'top\.location',
]
inline_pattern = '|'.join(inline_remove_patterns)

def _remove_inline_script(match):
    global removed_scripts
    content = match.group(0)
    if re.search(inline_pattern, content, re.IGNORECASE):
        removed_scripts += 1
        return ''
    return content

html = re.sub(
    r'<script(?:\s[^>]*)?>(?:(?!</script>).)*</script>',
    _remove_inline_script, html, flags=re.DOTALL
)

print(f'Scripts removed: {removed_scripts}')

# ── 2. VSL gate removal ─────────────────────────────────────────────────────
def unhide_element(m):
    tag = m.group(0)
    tag = re.sub(r'height\s*:\s*0\s*(?:px)?;?\s*', '', tag, flags=re.IGNORECASE)
    tag = re.sub(r'max-height\s*:\s*0\s*(?:px)?;?\s*', '', tag, flags=re.IGNORECASE)
    tag = re.sub(r'overflow\s*:\s*hidden\s*;?\s*', '', tag, flags=re.IGNORECASE)
    tag = re.sub(r'display\s*:\s*none\s*;?\s*', '', tag, flags=re.IGNORECASE)
    tag = re.sub(r'visibility\s*:\s*hidden\s*;?\s*', '', tag, flags=re.IGNORECASE)
    tag = re.sub(r'opacity\s*:\s*0\s*(?:\.\d+)?\s*;?\s*', '', tag, flags=re.IGNORECASE)
    tag = re.sub(r'pointer-events\s*:\s*none\s*;?\s*', '', tag, flags=re.IGNORECASE)
    tag = re.sub(r'\s*style\s*=\s*["\']["\']', '', tag)
    return tag

html = re.sub(
    r'<(?:div|section|article|main|aside|header|footer|form)[^>]+style=["\'][^"\']*'
    r'(?:height\s*:\s*0|display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0)'
    r'[^"\']*["\'][^>]*>',
    unhide_element, html, flags=re.IGNORECASE
)

# ── 3. Shopify product image injection ───────────────────────────────────────
# For Shopify product pages: always fetch product images from JSON API and
# inject a static hero image. This handles both broken {{}} images AND
# collapsed Replo/GemPages carousels where the image exists but renders tiny.
broken_img_count = len(re.findall(r'<img[^>]+src=["\'][^"\']*\{\{[^}]+\}\}', html, re.IGNORECASE))
has_replo_carousel = 'data-replo-component-root="carousel"' in html

if '/products/' in base_url:
    try:
        from urllib.parse import urlparse
        parsed = urlparse(base_url)
        origin = f"{parsed.scheme}://{parsed.netloc}"
        path_parts = parsed.path.strip('/').split('/')
        prod_idx = path_parts.index('products')
        handle = path_parts[prod_idx + 1].split('?')[0].split('#')[0]
        product_json_url = f'{origin}/products/{handle}.json'
        print(f'Fetching Shopify product JSON: {product_json_url}')

        req = urllib.request.Request(product_json_url, headers={
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
        })
        with urllib.request.urlopen(req, timeout=15) as resp:
            pdata = json.loads(resp.read())

        images = pdata.get('product', {}).get('images', [])
        shopify_imgs = []
        for i, img in enumerate(images):
            img_src = img.get('src', '')
            if not img_src:
                continue
            fname = f'shopify-product-{i}.jpg'
            local = os.path.join(assets_dir, fname)
            try:
                req2 = urllib.request.Request(img_src, headers={
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
                })
                with urllib.request.urlopen(req2, timeout=20) as resp2:
                    with open(local, 'wb') as f:
                        f.write(resp2.read())
                shopify_imgs.append(f'assets/{fname}')
            except Exception as e:
                print(f'Shopify img SKIP {i}: {e}')

        # Replace broken {{}} imgs in-place with real product images
        _idx = [0]
        def _replace_broken(match):
            if _idx[0] < len(shopify_imgs):
                src = shopify_imgs[_idx[0]]
                _idx[0] += 1
                return f'<img src="{src}" style="width:100%;height:auto;object-fit:contain;display:block;" alt="Product" />'
            return ''

        if shopify_imgs:
            html = re.sub(
                r'<img[^>]+src=["\'][^"\']*\{\{[^}]+\}\}[^"\']*["\'][^>]*/?>',
                _replace_broken, html, flags=re.IGNORECASE
            )
            print(f'Replaced {min(broken_img_count, len(shopify_imgs))} broken imgs with Shopify product images')

        # For Replo carousels: REMOVE the broken carousel DOM and replace with static gallery
        if shopify_imgs and has_replo_carousel:
            thumbs = ''
            for i, src in enumerate(shopify_imgs[:8]):
                border = '2px solid #333' if i == 0 else '1px solid #ddd'
                thumbs += f'<img src="{src}" alt="Product {i+1}" style="width:70px;height:70px;object-fit:cover;cursor:pointer;border:{border};border-radius:4px;flex-shrink:0;" onclick="document.getElementById(\'clone-hero-img\').src=this.src;document.querySelectorAll(\'#clone-hero-thumbs img\').forEach(i=>i.style.borderColor=\'#ddd\');this.style.borderColor=\'#333\'" />\n'

            gallery_html = f'''<div id="clone-hero-gallery" style="width:100%;max-width:600px;">
  <img id="clone-hero-img" src="{shopify_imgs[0]}" alt="Product" style="width:100%;height:auto;max-height:600px;object-fit:contain;display:block;border-radius:8px;background:#f5f5f5;margin-bottom:12px;" />
  <div id="clone-hero-thumbs" style="display:flex;gap:8px;overflow-x:auto;">{thumbs}</div>
</div>'''

            # Replace ONLY the first product carousel (data-replo-part="slides")
            # This is the main product image gallery. Other carousels (testimonials, UGC) stay.
            first_slides = re.search(
                r'<div[^>]*data-replo-part="slides"[^>]*data-replo-root-id="[^"]*"[^>]*>',
                html
            )
            if first_slides:
                # Walk backwards to find the outermost wrapper div for this carousel section
                # Look for the nearest ancestor that's a Replo component wrapper
                search_back = max(0, first_slides.start() - 3000)
                pre = html[search_back:first_slides.start()]

                # Find parent divs with data-rid (Replo component wrappers)
                parent_divs = list(re.finditer(r'<div[^>]*data-rid="[^"]*"[^>]*class="r-[^"]*"[^>]*>', pre))

                if parent_divs:
                    # Use the parent as our removal target
                    parent_start = search_back + parent_divs[-1].start()

                    # Track div depth from parent to find its closing tag
                    depth = 1
                    pos = search_back + parent_divs[-1].end()
                    while depth > 0 and pos < len(html):
                        next_open = html.find('<div', pos)
                        next_close = html.find('</div>', pos)
                        if next_close == -1:
                            break
                        if next_open != -1 and next_open < next_close:
                            depth += 1
                            pos = next_open + 4
                        else:
                            depth -= 1
                            if depth == 0:
                                end = next_close + 6
                                html = html[:parent_start] + gallery_html + html[end:]
                                print(f'Replaced product carousel ({end - parent_start} chars) with static gallery ({len(shopify_imgs)} images)')
                                break
                            pos = next_close + 6
                else:
                    # No parent wrapper found, just inject before the slides
                    html = html[:first_slides.start()] + gallery_html + html[first_slides.start():]
                    print(f'Injected static gallery before first carousel slides')
    except Exception as e:
        print(f'Shopify product image injection failed: {e}')

# ── 4. Template var + UUID cleanup ───────────────────────────────────────────
# Remove any remaining broken {{}} img tags
html = re.sub(r'<img[^>]+src=["\'][^"\']*\{\{[^}]+\}\}[^"\']*["\'][^>]*/?>',
    '', html, flags=re.IGNORECASE)
# Clean {{}} from alt/title attributes
html = re.sub(r'((?:alt|title|aria-label)=["\'])[^"\']*\{\{[^}]+\}\}[^"\']*(["\'])',
    r'\1\2', html, flags=re.IGNORECASE)
# Remove visible UUID text nodes
html = re.sub(
    r'<(?:a|span|div|p)[^>]*>\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*</(?:a|span|div|p)>',
    '', html, flags=re.IGNORECASE
)

remaining_vars = len(re.findall(r'\{\{[^}]+\}\}', html))
if remaining_vars > 0:
    print(f'WARNING: {remaining_vars} unresolved template vars remain')
else:
    print('Template/UUID cleanup: clean')

# ── 5. Lazy-load fix ────────────────────────────────────────────────────────
def fix_lazy(m):
    tag = m.group(0)
    dsrc = re.search(r'data-src=["\']([^"\']+)["\']', tag)
    if not dsrc:
        return tag
    real = dsrc.group(1)
    tag = re.sub(r'\bsrc=["\']["\']', f'src="{real}"', tag)
    return tag

html = re.sub(r'<img[^>]+>', fix_lazy, html)

# ── 6. Fix product image gallery display ─────────────────────────────────────
# Replo/GemPages carousel JS may not init on static clones, causing the hero
# image to stay at thumbnail size. Inject CSS to force the first carousel slide
# to display as a large image if we detect a Replo/Shopify carousel.
gallery_fix_css = '''<style id="clone-gallery-fix">
/* Static product gallery (replaces broken Replo/GemPages carousels) */
#clone-hero-gallery {
  display: block !important;
  width: 100% !important;
  max-width: 600px !important;
}
/* Generic carousel fixes (Swiper, Slick) */
.swiper-container, .slick-slider {
  width: 100% !important;
  overflow: hidden !important;
}
</style>'''

if '</head>' in html:
    html = html.replace('</head>', gallery_fix_css + '\n</head>', 1)

# Remove meta refresh redirects
html = re.sub(r'<meta[^>]+http-equiv=["\']refresh["\'][^>]*>', '', html, flags=re.IGNORECASE)

# ── Safety check ─────────────────────────────────────────────────────────────
if len(html) < original_len * 0.4:
    print(f'ABORT: Output ({len(html)}) is less than 40% of input ({original_len})')
    sys.exit(1)

with open(html_path, 'w', encoding='utf-8') as f:
    f.write(html)

print(f'Structural transform done. {original_len} -> {len(html)} bytes ({len(html)/original_len:.0%})')
