"""Per-site HTML-aware extractors for workshops with rich structure.

These replace the text-line parser in extract.py for sites where titles,
authors, and abstracts are distinguishable via tags/classes — text-line
parsing was conflating them into mega-titles up to 2000 chars long.

Each extractor returns a list of dicts shaped like the generic parser:
    {time, end, title, authors, is_header}
"""
from __future__ import annotations
import re
from typing import Optional


# --------- HTML helpers ---------

def strip_html_comments(s: str) -> str:
    """Remove standard <!-- ... --> comments. If a comment is opened but
    never closed (common bug in hand-written workshop pages), treat the
    rest of the file as commented — matching browser behavior."""
    # Closed comments
    s = re.sub(r"<!--.*?-->", " ", s, flags=re.DOTALL)
    # Unclosed comment from <!-- to EOF
    idx = s.find("<!--")
    if idx != -1:
        s = s[:idx]
    return s


def strip_tags(s: str) -> str:
    """Remove all HTML tags from a fragment, leaving plain text."""
    s = re.sub(r"<[^>]+>", " ", s)
    s = (s.replace("&nbsp;", " ")
           .replace("&amp;", "&")
           .replace("&lt;", "<")
           .replace("&gt;", ">")
           .replace("&#39;", "'")
           .replace("&quot;", '"')
           .replace("&#8217;", "’")
           .replace("&#8211;", "–")
           .replace("&#8212;", "—"))
    return re.sub(r"\s+", " ", s).strip()


def normalize_time(t: str) -> tuple[str, Optional[str]]:
    """Return (start, end) from strings like '11:30–11:50', '08h45-10h15', '17:30'."""
    if not t:
        return "", None
    t = t.replace("&nbsp;", " ").strip()
    m = re.match(r"\s*(\d{1,2}[:h.]\d{2})\s*[-–—to]+\s*(\d{1,2}[:h.]\d{2})", t)
    if m:
        return (m.group(1).replace("h", ":").replace(".", ":"),
                m.group(2).replace("h", ":").replace(".", ":"))
    m = re.match(r"\s*(\d{1,2}[:h.]\d{2})", t)
    if m:
        return (m.group(1).replace("h", ":").replace(".", ":"), None)
    return strip_tags(t), None


HEADER_KEYWORDS = (
    "opening", "welcome", "coffee", "break", "lunch", "closing", "reception",
    "registration", "panel", "discussion", "poster session", "session "
)


def looks_like_header(title: str) -> bool:
    low = title.lower()
    if len(title) > 110:
        return False
    return any(kw in low for kw in HEADER_KEYWORDS)


def emit(items: list[dict], time: str, end: Optional[str], title: str,
         authors: str = "", is_header: Optional[bool] = None):
    title = title.strip(" \t.,;:|·-—–")
    if not title and not is_header:
        return
    if is_header is None:
        is_header = looks_like_header(title)
    items.append({"time": time, "end": end, "title": title,
                  "authors": strip_tags(authors), "is_header": is_header})


# --------- EMAS ----------
# Three row types:
#   1) Paper:   <tr><td class="time">TIME</td><td><details><summary>
#        <span class="paper-title"><a>TITLE</a> <badges></span><br/>
#        <span class="authors">A, B</span></summary><p class="abstract">…</p>
#      </details></td></tr>
#   2) Break:   <tr class="break-row"><td>TIME</td><td><strong>HEADING</strong></td></tr>
#   3) Session: <tr class="session-head"><td>TIME</td><td><strong>HEADING</strong></td></tr>
# Day separators: <h2 id="day-1--monday-may-25">…</h2>, <h2 id="day-2--tuesday-may-26">…</h2>

EMAS_ROW_ANY = re.compile(
    r'<tr(?P<cls>[^>]*)>\s*<td[^>]*>(?P<time>[^<]*)</td>\s*'
    r'<td[^>]*>(?P<body>.*?)</td>\s*</tr>',
    re.DOTALL,
)

EMAS_DAY_HEADER = re.compile(r'<h2[^>]*id="day-(\d+)[^"]*"[^>]*>(.*?)</h2>', re.DOTALL)


def _extract_emas_items(fragment: str) -> list[dict]:
    items: list[dict] = []
    for m in EMAS_ROW_ANY.finditer(fragment):
        time_raw = m.group("time")
        body = m.group("body")
        if not re.search(r"\d", time_raw):
            continue
        start, end = normalize_time(time_raw)
        title_m = re.search(r'<span[^>]*class="paper-title"[^>]*>(.*?)</span>', body, re.DOTALL)
        if title_m:
            inner = title_m.group(1)
            em_m = re.search(r"<em[^>]*>(.*?)</em>", inner, re.DOTALL)
            title = strip_tags(em_m.group(1) if em_m else inner)
            auth_m = re.search(r'<span[^>]*class="authors"[^>]*>(.*?)</span>', body, re.DOTALL)
            authors = strip_tags(auth_m.group(1)) if auth_m else ""
            emit(items, start, end, title, authors, is_header=False)
        else:
            text = strip_tags(body)
            if text:
                emit(items, start, end, text, is_header=True)
    return items


def extract_emas(html: str, day_filter: Optional[int] = None) -> list[dict]:
    """If day_filter is 1 or 2, return only that day's rows; else full file."""
    day_markers = list(EMAS_DAY_HEADER.finditer(html))
    if not day_markers or day_filter is None:
        return _extract_emas_items(html)
    # Slice html into per-day chunks
    chunks: dict[int, str] = {}
    for i, m in enumerate(day_markers):
        day_num = int(m.group(1))
        start = m.end()
        end = day_markers[i + 1].start() if i + 1 < len(day_markers) else len(html)
        chunks[day_num] = html[start:end]
    if day_filter in chunks:
        return _extract_emas_items(chunks[day_filter])
    return _extract_emas_items(html)


def extract_emas_day1(html: str) -> list[dict]:
    return extract_emas(html, day_filter=1)


def extract_emas_day2(html: str) -> list[dict]:
    return extract_emas(html, day_filter=2)


# --------- ALA ----------
# Structure: <tr><td>TIME</td><td><b>HEADER</b><ul><li>AUTHORS<br/><a><em>TITLE</em></a></li>...</ul></td></tr>
# Or single-talk: <tr><td>TIME</td><td>AUTHORS<br/><a><em>TITLE</em></a></td></tr>
# Or header-only: <tr><td>TIME</td><td><b>TEXT</b></td></tr>

# Tolerant of malformed rows where </td> before </tr> is missing.
ALA_ROW = re.compile(
    r'<tr[^>]*>\s*<td[^>]*>(?P<time>[^<]*)</td>\s*'
    r'<td[^>]*>(?P<body>.*?)(?:</td>)?\s*</tr>',
    re.DOTALL,
)

ALA_LI = re.compile(r"<li[^>]*>(.*?)</li>", re.DOTALL)
ALA_TITLE_LINK = re.compile(r"<a[^>]*>\s*<em[^>]*>(.*?)</em>\s*</a>", re.DOTALL)
ALA_TITLE_PLAIN_EM = re.compile(r"<em[^>]*>(.*?)</em>", re.DOTALL)


def _ala_parse_item(body_inner: str) -> tuple[str, str]:
    """Given a chunk (li or td content), return (title, authors)."""
    title = ""
    m = ALA_TITLE_LINK.search(body_inner)
    if not m:
        m = ALA_TITLE_PLAIN_EM.search(body_inner)
    if m:
        title = strip_tags(m.group(1))
        # Authors = text before the link/em, with <br/> as separator
        head = body_inner[: m.start()]
        authors = strip_tags(head)
        return title, authors
    # No <em>: fall back to plain text
    text = strip_tags(body_inner)
    return text, ""


def extract_ala(html: str) -> list[dict]:
    html = strip_html_comments(html)
    items: list[dict] = []
    for m in ALA_ROW.finditer(html):
        time_raw = m.group("time").strip()
        body = m.group("body")
        # Skip the table header row (Time | Event etc.)
        if not re.search(r"\d", time_raw):
            continue
        start, end = normalize_time(time_raw)
        # Detect a header preface like <b>HEADER</b> at the top of the body
        header_match = re.match(r"\s*<b[^>]*>(.*?)</b>", body, re.DOTALL)
        header_text = strip_tags(header_match.group(1)) if header_match else ""

        # Keynote/invited talk: <b>Session X</b><br/>Invited Talk: <em>NAME</em>
        # — emit as a single header item, not as a paper.
        body_plain = strip_tags(body)
        is_keynote_like = bool(re.search(r"\b(invited talk|keynote)\b", body_plain, re.IGNORECASE))

        lis = ALA_LI.findall(body)
        if lis:
            if header_text:
                emit(items, start, end, header_text, is_header=True)
            for li in lis:
                title, authors = _ala_parse_item(li)
                if title:
                    emit(items, start, end, title, authors, is_header=False)
        else:
            if is_keynote_like:
                # Combine header + speaker into one header line
                emit(items, start, end, body_plain, is_header=True)
            else:
                title, authors = _ala_parse_item(body)
                if title:
                    is_hdr = header_text and not ALA_TITLE_LINK.search(body) and not ALA_TITLE_PLAIN_EM.search(body)
                    if is_hdr:
                        emit(items, start, end, header_text, is_header=True)
                    else:
                        emit(items, start, end, title, authors, is_header=False)
    return items


# --------- ASI ----------
# Structure: grid pairs of <div>TIME</div><div>CONTENT</div>
# CONTENT may contain a header line + <ul class="topics-list"><li>AUTHORS. <a>TITLE</a></li></ul>
# We anchor on the time-styled <div style="...font-weight:650;">TIME</div>

ASI_TIME_DIV = re.compile(
    r'<div[^>]*font-weight:650;[^>]*>\s*(?P<time>\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})\s*</div>'
    r'\s*<div[^>]*>(?P<body>.*?)</div>',
    re.DOTALL,
)
ASI_LI = re.compile(r"<li[^>]*>(.*?)</li>", re.DOTALL)
ASI_LINK_TITLE = re.compile(r"<a[^>]*>(.*?)</a>", re.DOTALL)


def extract_asi(html: str) -> list[dict]:
    items: list[dict] = []
    # Also catch h3 section headings as headers
    # Find each session block by h3, then iterate its inner time-divs.
    for h3 in re.finditer(r"<h3[^>]*>(.*?)</h3>", html, re.DOTALL):
        text = strip_tags(h3.group(1))
        # Only treat as header if it looks like a session/break heading with a time
        if re.search(r"\d{1,2}[:h.]\d{2}", text):
            # Extract leading time and treat rest as title
            tm = re.match(r"\s*(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})\s+(.*)", text)
            if tm:
                emit(items, tm.group(1), tm.group(2), tm.group(3).strip(), is_header=True)

    for m in ASI_TIME_DIV.finditer(html):
        time_raw = m.group("time")
        body = m.group("body")
        start, end = normalize_time(time_raw)
        lis = ASI_LI.findall(body)
        if lis:
            # Drop the <ul>...</ul> from body to keep just the prelude (e.g., "Paper Presentations")
            prelude = re.sub(r"<ul[^>]*>.*?</ul>", "", body, flags=re.DOTALL)
            prelude_text = strip_tags(prelude)
            # Strip trailing parenthetical "(x3 10mins + 2mins QnA)" duration notes — informative but noisy
            if prelude_text:
                emit(items, start, end, prelude_text, is_header=True)
            for li in lis:
                # ASI <li> format: "Author1, Author2 and Author3. <a>TITLE</a>"
                a_m = ASI_LINK_TITLE.search(li)
                if a_m:
                    title = strip_tags(a_m.group(1))
                    pre = li[: a_m.start()]
                    authors = strip_tags(pre).rstrip(". ").strip()
                    emit(items, start, end, title, authors, is_header=False)
                else:
                    text = strip_tags(li)
                    emit(items, start, end, text)
        else:
            text = strip_tags(body)
            if text:
                # Could be "Keynote 1: NAME (40mins + 10mins QnA)" — keep as is
                emit(items, start, end, text)
    return items


# --------- MASSpace ----------
# 4-column table. Two row shapes:
#   Session header:  <td>TIME</td><td>&nbsp;</td><td><b>Session 1</b></td><td>&nbsp;</td>
#   Paper row:       <td>&nbsp;</td><td>TIME</td><td>TITLE (with <i>...</i>)</td><td>AUTHORS</td>
# The time can be in col 1 OR col 2 — we pick whichever has digits.

MASSPACE_ROW = re.compile(
    r'<tr[^>]*>\s*<td[^>]*>(?P<c1>.*?)</td>\s*'
    r'<td[^>]*>(?P<c2>.*?)</td>\s*'
    r'<td[^>]*>(?P<c3>.*?)</td>\s*'
    r'<td[^>]*>(?P<c4>.*?)</td>\s*</tr>',
    re.DOTALL,
)


def extract_masspace(html: str) -> list[dict]:
    items: list[dict] = []
    for m in MASSPACE_ROW.finditer(html):
        c1, c2, c3, c4 = m.group("c1"), m.group("c2"), m.group("c3"), m.group("c4")
        c1_text, c2_text = strip_tags(c1), strip_tags(c2)
        # Find which column carries the time
        if re.search(r"\d{1,2}[:h.]\d{2}", c1_text):
            time_raw = c1_text
            # session header
            start, end = normalize_time(time_raw)
            title = strip_tags(c3)
            authors = strip_tags(c4)
            is_hdr = bool(re.search(r"<b[^>]*>", c3)) and not authors
            emit(items, start, end, title, authors, is_header=is_hdr or None)
        elif re.search(r"\d{1,2}[:h.]\d{2}", c2_text):
            time_raw = c2_text
            start, end = normalize_time(time_raw)
            title_html = c3
            # Strip the "[paper]" link block — it's metadata, not part of the title
            title_html_clean = re.sub(r"\[\s*<a[^>]*>paper</a>\s*\]", "", title_html)
            # Also strip the "Invited Talk:" prefix if present, but keep title
            title = strip_tags(title_html_clean)
            authors = strip_tags(c4)
            emit(items, start, end, title, authors, is_header=False)
        # else: row has no time at all — skip
    return items


# --------- CLaRAMAS ----------
# Main schedule: <tr><td><strong>TIME</strong></td><td>(duration)</td><td>EVENT</td><td>ROOM</td></tr>
# Plus a SECOND table mapping papers->slots, with header columns "Paper title | Session | Starting at | Paper authors".
# The first table gives us session blocks; the second gives us individual papers.

CLARAMAS_SCHED_ROW = re.compile(
    r'<tr[^>]*>\s*<td[^>]*><strong>(?P<time>[^<]+)</strong></td>\s*'
    r'<td[^>]*>(?P<dur>.*?)</td>\s*'
    r'<td[^>]*>(?P<event>.*?)</td>\s*'
    r'<td[^>]*>(?P<room>.*?)</td>\s*</tr>',
    re.DOTALL,
)
# Paper-mapping table rows: 4 cells: title | session | start time | authors
CLARAMAS_PAPER_ROW = re.compile(
    r'<tr[^>]*>\s*<td[^>]*>(?P<title>(?:(?!<td).)*?)</td>\s*'
    r'<td[^>]*>(?P<session>[^<]*)</td>\s*'
    r'<td[^>]*>(?P<start>[^<]*)</td>\s*'
    r'<td[^>]*>(?P<authors>(?:(?!<td).)*?)</td>\s*</tr>',
    re.DOTALL,
)


def extract_claramas(html: str) -> list[dict]:
    items: list[dict] = []
    # Schedule blocks
    for m in CLARAMAS_SCHED_ROW.finditer(html):
        time_raw = m.group("time")
        if not re.search(r"\d", time_raw):
            continue
        start, end = normalize_time(time_raw)
        event = strip_tags(m.group("event"))
        if event:
            emit(items, start, end, event, is_header=True)

    # Individual papers live in a SECOND table whose header is
    # "Paper title | Session | Starting at | Paper authors". Locate it and only
    # search rows within that table — otherwise the paper-row regex matches the
    # schedule table too, since both have 4-cell rows.
    paper_table_match = re.search(
        r'<table[^>]*>\s*(?:<thead[^>]*>)?[^<]*<tr[^>]*>\s*'
        r'<th[^>]*>\s*Paper\s+title\s*</th>'
        r'.*?</table>',
        html, re.DOTALL | re.IGNORECASE,
    )
    if paper_table_match:
        paper_html = paper_table_match.group(0)
        for m in CLARAMAS_PAPER_ROW.finditer(paper_html):
            title = strip_tags(m.group("title"))
            if title.lower() in ("paper title", ""):
                continue
            start_time = strip_tags(m.group("start"))
            ts, te = normalize_time(start_time) if start_time else ("", None)
            authors = strip_tags(m.group("authors"))
            emit(items, ts, te, title, authors, is_header=False)
    return items


# --------- Dispatch ----------

SITE_EXTRACTORS = {
    # EMAS spans two days, but the EMAS_mon page is empty (the schedule lives on
    # EMAS_tue's URL). We slice EMAS_tue by <h2 id="day-N"> headers and dispatch
    # the right slice per day during merge.
    "EMAS_tue": extract_emas,        # used for both days during single-file extract
    "EMAS_mon": extract_emas,
    "ALA_mon": extract_ala,
    "ALA_tue": extract_ala,
    "ASI_mon": extract_asi,
    "MASSpace_tue": extract_masspace,
    "CLaRAMAS_tue": extract_claramas,
}

# Day-split aware variants used by merge.py when a single source covers both days.
SITE_EXTRACTORS_DAY1 = {"EMAS_tue": extract_emas_day1}
SITE_EXTRACTORS_DAY2 = {"EMAS_tue": extract_emas_day2}
