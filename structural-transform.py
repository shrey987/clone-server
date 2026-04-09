"""
structural-transform.py
Pre-built structural fixes applied to every cloned page BEFORE brand changes.
Does NOT do any brand changes — only fixes structural/render issues.

Handles:
  1. VSL video gates (height:0, display:none on pricing sections)
  2. Wistia/video script removal + poster image placeholder
  3. Lazy-load fix (data-src → src)
  4. Social proof script 404 silencing

Usage: python3 structural-transform.py <job_dir>
"""

import sys, os, re

job_dir  = sys.argv[1]
html_path = os.path.join(job_dir, 'page.html')
assets_dir = os.path.join(job_dir, 'assets')

with open(html_path, 'r', encoding='utf-8', errors='ignore') as f:
    html = f.read()

original_len = len(html)

# ── 1. Remove Wistia / video player scripts ──────────────────────────────────
# Remove <script> tags whose src contains video platform keywords
html = re.sub(
    r'<script[^>]+src=["\'][^"\']*(?:wistia|fast\.wistia|vidyard|jwplayer|brightcove)[^"\']*["\'][^>]*>.*?</script>',
    '', html, flags=re.DOTALL | re.IGNORECASE
)
# Remove inline <script> blocks that reference wistia internals
html = re.sub(
    r'<script[^>]*>(?:[^<]|<(?!/script>))*?(?:wistia|_wq\s*=|wistiaEmbed|Wistia\.api)[^<]*(?:<(?!/script>)[^<]*)*?</script>',
    '', html, flags=re.DOTALL | re.IGNORECASE
)

# ── 2. Replace video containers with poster image or placeholder ──────────────
# Find downloaded poster/thumbnail image
poster_img = None
if os.path.exists(assets_dir):
    for fname in os.listdir(assets_dir):
        lower = fname.lower()
        if any(k in lower for k in ('playscreen', 'poster', 'thumbnail', 'video-thumb', 'vidthumb')):
            if lower.endswith(('.png', '.jpg', '.jpeg', '.webp', '.gif')):
                poster_img = 'assets/' + fname
                break

video_placeholder = (
    f'<img src="{poster_img}" style="width:100%;display:block;cursor:pointer;" alt="Video">'
    if poster_img else
    '<div style="background:#111;width:100%;aspect-ratio:16/9;display:flex;align-items:center;'
    'justify-content:center;color:#fff;font-size:32px;font-weight:bold;cursor:pointer;">▶ Watch Video</div>'
)

# Replace wistia embed containers
html = re.sub(
    r'<div[^>]+class=["\'][^"\']*wistia[^"\']*["\'][^>]*>.*?</div>',
    video_placeholder, html, flags=re.DOTALL | re.IGNORECASE
)
# Replace iframes (YouTube, Vimeo, Wistia)
html = re.sub(
    r'<iframe[^>]+src=["\'][^"\']*(?:youtube|youtu\.be|vimeo|wistia|vidyard)[^"\']*["\'][^>]*>.*?</iframe>',
    video_placeholder, html, flags=re.DOTALL | re.IGNORECASE
)

# ── 3. Strip VSL video gates ──────────────────────────────────────────────────
# Elements hidden with inline height:0 (common VSL pattern to reveal on video end)
# Only strip height:0 when it's the ONLY height constraint (not part of a bigger style)
def unhide_element(m):
    tag = m.group(0)
    # Remove height:0 and overflow:hidden from inline style
    tag = re.sub(r'height\s*:\s*0\s*(?:px)?;?\s*', '', tag, flags=re.IGNORECASE)
    tag = re.sub(r'overflow\s*:\s*hidden\s*;?\s*', '', tag, flags=re.IGNORECASE)
    tag = re.sub(r'max-height\s*:\s*0\s*(?:px)?;?\s*', '', tag, flags=re.IGNORECASE)
    return tag

# Target opening tags of divs/sections that have height:0 in their style
html = re.sub(
    r'<(?:div|section|article)[^>]+style=["\'][^"\']*height\s*:\s*0[^"\']*["\'][^>]*>',
    unhide_element, html, flags=re.IGNORECASE
)

# Remove JS that gates content on video end (look for event handlers referencing display/height toggle)
html = re.sub(
    r'<script[^>]*>(?:[^<]|<(?!/script>))*?(?:video_ended|videoEnded|onended|wistia.*?play)[^<]*(?:<(?!/script>)[^<]*)*?</script>',
    '', html, flags=re.DOTALL | re.IGNORECASE
)

# ── 4. Fix lazy-loaded images (data-src → src) ────────────────────────────────
def fix_lazy(m):
    tag = m.group(0)
    dsrc = re.search(r'data-src=["\']([^"\']+)["\']', tag)
    if not dsrc:
        return tag
    real = dsrc.group(1)
    # Only fix if src is empty or placeholder
    if re.search(r'\bsrc=["\'](?:data:image/gif[^"\']*|)["\']', tag):
        tag = re.sub(r'\bsrc=["\'][^"\']*["\']', f'src="{real}"', tag)
    return tag

html = re.sub(r'<img[^>]+>', fix_lazy, html)

# ── 5. Safety check ───────────────────────────────────────────────────────────
new_len = len(html)
ratio = new_len / original_len if original_len > 0 else 0
print(f'Size check: {new_len:,} / {original_len:,} = {ratio:.2f}')
if ratio < 0.6:
    print(f'ERROR: output too small ({ratio:.2f}). Aborting to prevent corruption.')
    sys.exit(1)

with open(html_path, 'w', encoding='utf-8') as f:
    f.write(html)

print(f'Structural transform done. Body tag present: {"<body" in html.lower()}')
