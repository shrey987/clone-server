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
# Find downloaded poster/thumbnail image — prefer Wistia thumbnail (real video frame)
# over playscreen overlay (just the play button UI)
poster_img = None
if os.path.exists(assets_dir):
    fnames = os.listdir(assets_dir)
    # First try: Wistia API thumbnail (real video frame)
    for fname in fnames:
        if fname.startswith('wistia-thumb-') and fname.lower().endswith(('.jpg', '.jpeg', '.png', '.webp')):
            poster_img = 'assets/' + fname
            break
    # Fallback: playscreen/poster images
    if not poster_img:
        for fname in fnames:
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

# Replace iframes (YouTube, Vimeo, Wistia)
html = re.sub(
    r'<iframe[^>]+src=["\'][^"\']*(?:youtube|youtu\.be|vimeo|wistia|vidyard)[^"\']*["\'][^>]*>.*?</iframe>',
    video_placeholder, html, flags=re.DOTALL | re.IGNORECASE
)

# Insert poster image into Wistia placeholder containers.
# Wistia uses #ekran1, #ekran, etc. as mount points that JS fills with the video player.
# Since we strip Wistia scripts, these are empty. Insert the poster img into each.
# Pattern: <div id="ekran..."></div>  →  <div id="ekran..."><img src=poster /></div>
if poster_img:
    poster_tag = f'<img src="{poster_img}" style="width:100%;display:block;cursor:pointer;" id="video-poster-placeholder" alt="Play Video">'
    html = re.sub(
        r'(<div[^>]+id=["\']ekran\w*["\'][^>]*>)(</div>)',
        lambda m: m.group(1) + poster_tag + m.group(2),
        html, flags=re.IGNORECASE
    )
    print(f'Poster injected into ekran containers: {poster_img}')

# Inject CSS to hide Wistia/video JS-generated DOM overlay elements.
# When Playwright renders the page, Wistia JS creates a complex DOM tree (wistia_grid_*, w-vulcan-v2,
# w-ui-container, etc.) that overlays on top of everything, showing as a black box because the
# blob: video src can't load cross-domain. Hide all of these via injected CSS, leaving the
# poster img placeholder visible beneath them.
wistia_css = f'''<style id="clone-video-fix">
  /* Hide Wistia JS-rendered player overlay — blob: video won't load cross-domain */
  .wistia_responsive_padding, .wistia_responsive_wrapper,
  .wistia_embed, [id^="wistia_chrome"], [id^="wistia_grid_"],
  [id^="w-vulcan"], .w-ui-container, .w-video-wrapper, .w-chrome,
  video[src^="blob:"], video[src*="fast.wistia"] {{
    display: none !important;
    height: 0 !important;
    overflow: hidden !important;
  }}
  /* Unhide Wistia mount points (Wistia JS sets display:none and height:Xpx on these via JS).
     Also reset position:absolute to relative so the element contributes to parent height.
     Without this, #video1 collapses to its border height (6px) because all children
     are absolutely positioned. */
  [id^="ekran"] {{
    display: block !important;
    position: relative !important;
    height: auto !important;
    width: 100% !important;
    overflow: visible !important;
  }}
  /* Reset Wistia-collapsed video container heights (Wistia JS sets height:6px inline) */
  #video1, #video, #video2 {{
    height: auto !important;
    overflow: visible !important;
  }}
  /* Show poster placeholder and original thumbnail */
  #video-poster-placeholder, #thumb, img.pulsing {{
    display: block !important;
    width: 100% !important;
    cursor: pointer !important;
  }}
  /* Keep loading overlay hidden */
  #LoadingDiv {{ display: none !important; }}
</style>'''

# JS fix: page JS runs after load and overrides CSS, re-collapsing #video1 to 6px.
# Inject a script at end of <body> that uses setProperty('!important') to win back.
poster_src = poster_img if poster_img else ''
video_js = f'''<script id="clone-video-js">
(function() {{
  function fixVideo() {{
    ['video1','video','video2'].forEach(function(id) {{
      var el = document.getElementById(id);
      if (el) {{
        el.style.setProperty('height','auto','important');
        el.style.setProperty('overflow','visible','important');
      }}
    }});
    document.querySelectorAll('[id^="ekran"]').forEach(function(e) {{
      e.style.setProperty('display','block','important');
      e.style.setProperty('position','relative','important');
      e.style.setProperty('height','auto','important');
      e.style.setProperty('width','100%','important');
      e.style.setProperty('overflow','visible','important');
    }});
    ['video-poster-placeholder','thumb'].forEach(function(id) {{
      var el = document.getElementById(id);
      if (el) el.style.setProperty('display','block','important');
    }});
  }}
  window.addEventListener('load', fixVideo);
  setTimeout(fixVideo, 500);
  setTimeout(fixVideo, 1500);
}})();
</script>'''

if '</head>' in html:
    html = html.replace('</head>', wistia_css + '\n</head>', 1)
elif '<body' in html:
    html = html.replace('<body', wistia_css + '\n<body', 1)

if '</body>' in html:
    html = html.replace('</body>', video_js + '\n</body>', 1)

# ── 3. Strip VSL video gates ──────────────────────────────────────────────────
# VSL pages hide pricing/CTA sections until video plays, using either:
#   - style="height:0; overflow:hidden" on divs/sections
#   - style="display:none" on main/div/section containers
# Strip BOTH patterns from ALL block-level elements.

def unhide_element(m):
    tag = m.group(0)
    # Remove all VSL gate CSS patterns from inline style
    tag = re.sub(r'height\s*:\s*0\s*(?:px)?;?\s*', '', tag, flags=re.IGNORECASE)
    tag = re.sub(r'max-height\s*:\s*0\s*(?:px)?;?\s*', '', tag, flags=re.IGNORECASE)
    tag = re.sub(r'overflow\s*:\s*hidden\s*;?\s*', '', tag, flags=re.IGNORECASE)
    tag = re.sub(r'display\s*:\s*none\s*;?\s*', '', tag, flags=re.IGNORECASE)
    tag = re.sub(r'visibility\s*:\s*hidden\s*;?\s*', '', tag, flags=re.IGNORECASE)
    tag = re.sub(r'opacity\s*:\s*0\s*(?:\.\d+)?\s*;?\s*', '', tag, flags=re.IGNORECASE)
    tag = re.sub(r'pointer-events\s*:\s*none\s*;?\s*', '', tag, flags=re.IGNORECASE)
    tag = re.sub(r'position\s*:\s*absolute\s*;?\s*left\s*:\s*-\d+\w*\s*;?\s*', '', tag, flags=re.IGNORECASE)
    # Clean up empty style attribute
    tag = re.sub(r'\s*style\s*=\s*["\']["\']', '', tag)
    return tag

# Target opening tags of block elements gated by VSL-style CSS
# Catches: height:0, display:none, visibility:hidden, opacity:0
html = re.sub(
    r'<(?:div|section|article|main|aside|header|footer|form)[^>]+style=["\'][^"\']*'
    r'(?:height\s*:\s*0|display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0)'
    r'[^"\']*["\'][^>]*>',
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
