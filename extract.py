"""Extract per-talk schedule data from downloaded workshop pages.

Strategy:
1. Strip script/style/HTML to visible text.
2. Locate a "Program/Schedule/Programme" region.
3. Split into time-prefixed entries; a "session header" line resets the current session.
4. Emit a structured list of items per workshop.

We deliberately keep this heuristic and inspect output rather than chase 100%.
"""
from __future__ import annotations
import json, os, re
from dataclasses import dataclass, asdict
from typing import Optional

from extractors import SITE_EXTRACTORS

SITES_DIR = "sites"

# Time patterns:
#   8:45, 08:45, 8h45, 8.45
#   8:45-10:00, 8:45–10:00, 8h45 - 10h00, 8:45 to 10:00
TIME_RE = re.compile(
    r"""
    (?P<full>
        (?P<start>\d{1,2}[:h.]\d{2})         # 9:00 / 9h00 / 9.00
        (?:\s*[-–—to]+\s*
           (?P<end>\d{1,2}[:h.]\d{2})
        )?
    )
    """, re.VERBOSE)

# Headings that often introduce a non-talk block we want to keep as a header item
HEADER_KEYWORDS = (
    "session", "keynote", "opening", "welcome", "break", "lunch",
    "coffee", "poster", "panel", "discussion", "closing", "introduction",
    "wrap", "reception", "registration", "demo"
)


def html_to_text(html: str) -> str:
    # Drop scripts/styles entirely
    html = re.sub(r"<script\b[^>]*>.*?</script>", " ", html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r"<style\b[^>]*>.*?</style>", " ", html, flags=re.DOTALL | re.IGNORECASE)
    # Replace block-level closing tags with newlines so we don't merge unrelated sections
    html = re.sub(r"</(p|div|li|h[1-6]|tr|td|th|br|article|section)>", "\n", html, flags=re.IGNORECASE)
    html = re.sub(r"<br\s*/?>", "\n", html, flags=re.IGNORECASE)
    # Strip remaining tags
    txt = re.sub(r"<[^>]+>", " ", html)
    # Decode common entities
    txt = (txt.replace("&nbsp;", " ")
              .replace("&amp;", "&")
              .replace("&lt;", "<")
              .replace("&gt;", ">")
              .replace("&#39;", "'")
              .replace("&quot;", '"')
              .replace("&#8217;", "’")
              .replace("&#8211;", "–")
              .replace("&#8212;", "—"))
    # Collapse spaces but keep newlines
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in txt.split("\n")]
    lines = [ln for ln in lines if ln]
    return "\n".join(lines)


def find_schedule_region(text: str) -> str:
    """Trim to the schedule section. Strategy:
    1. Prefer 'Schedule' / 'Timetable' / 'Workshop Schedule' / 'Technical Programme' headings.
    2. Otherwise, accept 'Programme'/'Program' BUT only if not immediately followed by 'Committee'.
    3. Score candidates by how many time tokens (\\d{1,2}[:h]\\d{2}) appear in the next ~3000 chars.
    4. Return the highest-scoring region, or whole text as fallback.
    """
    # Anchored to start of line, capturing the heading text itself
    head_pat = re.compile(
        r"^(?:[#\s>*]*)"
        r"(?P<head>(?:final\s+)?(?:workshop\s+)?(?:technical\s+|detailed\s+|tentative\s+|full\s+)?"
        r"(?:programme|program|schedule|timetable|agenda))\b[^\n]*$",
        re.IGNORECASE | re.MULTILINE,
    )
    bad_suffix_re = re.compile(r"^\s*committee", re.IGNORECASE)  # 'Program Committee'
    candidates: list[tuple[int, int]] = []  # (score, start_pos)
    for m in head_pat.finditer(text):
        # The next line — if it starts with 'committee', this heading is 'Program Committee'
        after = text[m.end():m.end() + 30]
        # Also detect 'Program Committee' as a single line
        head_line = m.group(0)
        if "committee" in head_line.lower():
            continue
        if bad_suffix_re.match(after.lstrip()):
            continue
        # Score: count of time tokens in window after the heading
        window = text[m.start():m.start() + 4000]
        score = len(re.findall(r"\b\d{1,2}[:h.]\d{2}\b", window))
        if score == 0:
            continue
        candidates.append((score, m.start()))
    if not candidates:
        return text
    candidates.sort(reverse=True)  # highest score first
    start = candidates[0][1]
    region = text[start:]
    stop_pat = re.compile(
        r"^\s*(organi[sz]ers?|organi[sz]ation|committees?|sponsors|important\s+dates|"
        r"call\s+for\s+papers|invited\s+speakers|registration|venue|contact|"
        r"program\s+committee|programme\s+committee|past\s+editions|related\s+work|"
        # Page-footer / page-chrome lines that frequently appear after the schedule
        r"banner\s+photo|report\s+abuse|page\s+details|page\s+updated|google\s+sites|"
        r"this\s+site\s+uses\s+cookies|subscribe|contact\s+us\s+at|accepted\s+papers)\s*$",
        re.IGNORECASE | re.MULTILINE,
    )
    m = stop_pat.search(region, pos=80)
    if m:
        region = region[:m.start()]
    return region


@dataclass
class Item:
    time: str
    end: Optional[str]
    title: str
    authors: str = ""
    is_header: bool = False


# Sentinels that, when seen mid-stream, stop further continuation text from
# being appended to the current item's title (catches "Abstract -", page footer markers).
STOP_ACCUMULATION_RE = re.compile(
    r"^(Abstract\b[\s\-—–:]|Banner\s+photo|Report\s+abuse|Page\s+details|"
    r"Page\s+updated|Google\s+Sites|This\s+site\s+uses\s+cookies|Contact\s+us\s+at|"
    r"Subscribe\b|Session\s+\d|Track\s+\d)",
    re.IGNORECASE,
)


def parse_schedule(text: str) -> list[Item]:
    """Walk lines; when a line starts with (or contains) a time, treat it as a new item.
    Continuation lines (no time) append to the previous item until the next time
    or a stop-accumulation sentinel is hit.
    """
    items: list[Item] = []
    cur: Optional[Item] = None
    stop_current = False

    for raw in text.splitlines():
        ln = raw.strip(" \t |•·-—–")
        if not ln:
            continue
        m = TIME_RE.search(ln)
        # Only treat as new item if the time is at or near the start of the line
        if m and m.start() <= 6:
            start_time = m.group("start").replace("h", ":").replace(".", ":")
            end_time = m.group("end")
            if end_time:
                end_time = end_time.replace("h", ":").replace(".", ":")
            rest = (ln[:m.start()] + ln[m.end():]).strip(" \t |·-—–:")
            low = rest.lower()
            is_hdr = any(kw in low for kw in HEADER_KEYWORDS) and len(rest) < 100
            cur = Item(time=start_time, end=end_time, title=rest, is_header=is_hdr)
            items.append(cur)
            stop_current = False
        else:
            if cur is None or stop_current:
                continue
            if STOP_ACCUMULATION_RE.match(ln):
                stop_current = True
                continue
            # Continuation: append to title or authors
            # Heuristic: if the line looks like a list of names (commas, capital words), it's authors.
            if not cur.authors and looks_like_authors(ln):
                cur.authors = ln
            else:
                # Append to title with a space, unless title is already long
                if len(cur.title) < 300:
                    cur.title = (cur.title + " " + ln).strip()
    # Dedupe consecutive identical items
    out = []
    for it in items:
        if out and out[-1].time == it.time and out[-1].title == it.title:
            continue
        out.append(it)
    return out


def looks_like_authors(s: str) -> bool:
    if len(s) > 220:
        return False
    # No punctuation that strongly implies prose
    if any(p in s for p in (": ", " - the ", " a ", "?", ";", "!")):
        return False
    parts = [p.strip() for p in re.split(r",| and ", s) if p.strip()]
    if len(parts) < 2:
        return False
    # Each part looks like a Name (1-4 words, mostly capitalized)
    name_like = 0
    for p in parts:
        words = p.split()
        if 1 <= len(words) <= 5 and sum(w[:1].isupper() for w in words) >= max(1, len(words) - 1):
            name_like += 1
    return name_like >= max(2, len(parts) - 1)


def process(file: str) -> dict:
    html = open(file, encoding="utf-8", errors="ignore").read()
    key = os.path.splitext(os.path.basename(file))[0]
    # Dispatch to per-site structured extractor if one exists; otherwise text parser.
    if key in SITE_EXTRACTORS:
        items_raw = SITE_EXTRACTORS[key](html)
        items = [Item(time=it["time"], end=it.get("end"),
                      title=it["title"], authors=it.get("authors", ""),
                      is_header=bool(it.get("is_header"))) for it in items_raw]
        text_chars = len(html)
        region_chars = -1  # not applicable
        extractor = "structured:" + key
    else:
        text = html_to_text(html)
        region = find_schedule_region(text)
        items = parse_schedule(region)
        text_chars = len(text)
        region_chars = len(region)
        extractor = "text"
    return {
        "file": os.path.basename(file),
        "extractor": extractor,
        "text_chars": text_chars,
        "region_chars": region_chars,
        "item_count": len(items),
        "header_count": sum(1 for i in items if i.is_header),
        "items": [asdict(i) for i in items],
    }


def main():
    files = sorted(os.path.join(SITES_DIR, f) for f in os.listdir(SITES_DIR))
    results = {}
    for f in files:
        key = os.path.splitext(os.path.basename(f))[0]
        try:
            results[key] = process(f)
        except Exception as e:
            results[key] = {"file": os.path.basename(f), "error": repr(e)}
    with open("workshop-extracts.json", "w") as out:
        json.dump(results, out, indent=2, ensure_ascii=False)
    # Summary
    print(f"{'site':<28} {'items':>6} {'hdrs':>5}  first item")
    for k, r in results.items():
        if "error" in r:
            print(f"{k:<28} ERROR {r['error']}")
            continue
        sample = r["items"][0]["title"][:60] if r["items"] else ""
        print(f"{k:<28} {r['item_count']:>6} {r['header_count']:>5}  {sample}")

if __name__ == "__main__":
    main()
