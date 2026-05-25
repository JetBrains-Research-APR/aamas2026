"""Merge extracted workshop schedules into program.json.

Mapping: each session in PROGRAM_DATA has a unique (day, code). We map our
extract keys to those sessions. For two-day workshops where the extracted
file covers both days (e.g. ALA, EMAS), we attach the full schedule to
both day's session entries — splitting cleanly is brittle without explicit
day markers.
"""
import json
import os
from copy import deepcopy

from extractors import extract_emas_day1, extract_emas_day2

# Map workshop-extracts.json keys -> list of (day_substr, session_code, override_extractor_fn) targets.
# override_extractor_fn (if set) is run against the original site HTML and replaces the merged items
# for that target — used for two-day workshops where a single page covers both days (EMAS).
MAPPINGS: dict[str, list[tuple]] = {
    "ALA_mon": [("Monday, 25 May", "ALA", None), ("Tuesday, 26 May", "ALA", None)],
    "ARMS_mon": [("Monday, 25 May", "ARMS", None)],
    "ASI_mon": [("Monday, 25 May", "ASI", None)],
    "ATT_tue": [("Tuesday, 26 May", "ATT", None)],
    "CLaRAMAS_tue": [("Tuesday, 26 May", "CLaRAMAS", None)],
    "COINE_mon": [("Monday, 25 May", "COINE", None)],
    "EMAS_tue": [
        ("Monday, 25 May", "EMAS", "emas_day1"),
        ("Tuesday, 26 May", "EMAS", "emas_day2"),
    ],
    "GAIW_tue": [("Tuesday, 26 May", "GAIW", None)],
    "MASSpace_tue": [("Tuesday, 26 May", "MASSpace", None)],
    "NEXUS_mon": [("Monday, 25 May", "NEXUS", None)],
    "OptLearnMAS_mon": [("Monday, 25 May", "OptLearnMAS", None)],
    "SE_mon": [("Monday, 25 May", "SE", None)],
}

OVERRIDE_EXTRACTORS = {
    "emas_day1": extract_emas_day1,
    "emas_day2": extract_emas_day2,
}


def item_to_paper(item: dict) -> dict:
    time_str = item["time"]
    if item.get("end"):
        time_str = f"{item['time']}–{item['end']}"
    paper = {
        "is_heading": bool(item.get("is_header")),
        "time": time_str,
        "title": item.get("title", "").strip(),
        "authors": item.get("authors", "") or "",
    }
    return paper


def main():
    program = json.load(open("program.json"))
    extracts = json.load(open("workshop-extracts.json"))

    # Build (day, code) -> session reference for fast lookup
    sessions_index: dict[tuple[str, str], dict] = {}
    for day in program:
        for slot in day["slots"]:
            for sess in slot["sessions"]:
                sessions_index[(day["day"], sess.get("code", ""))] = sess

    merged_count = 0
    missing_targets = []
    for key, targets in MAPPINGS.items():
        ex = extracts.get(key)
        if not ex or not ex.get("items"):
            print(f"  SKIP {key}: no extract items")
            continue
        default_papers = [item_to_paper(it) for it in ex["items"]]
        for day, code, override_key in targets:
            sess = sessions_index.get((day, code))
            if not sess:
                missing_targets.append((key, day, code))
                continue
            # If this target uses an override extractor (e.g. day-split EMAS),
            # re-run it against the original HTML file to get a day-specific slice.
            if override_key:
                site_path = os.path.join("sites", ex["file"])
                with open(site_path, encoding="utf-8", errors="ignore") as f:
                    src_html = f.read()
                items = OVERRIDE_EXTRACTORS[override_key](src_html)
                papers = [item_to_paper(it) for it in items]
            else:
                papers = default_papers
            # Replace papers if currently empty; otherwise extend.
            if not sess.get("papers"):
                sess["papers"] = deepcopy(papers)
            else:
                sess["papers"].extend(deepcopy(papers))
            sess["schedule_source"] = ex.get("file", key)
            merged_count += 1
            print(f"  MERGED {key} -> {day} / {code}  ({len(papers)} items{', day-split' if override_key else ''})")

    if missing_targets:
        print("\nMissing session targets:")
        for k, d, c in missing_targets:
            print(f"  {k} -> ({d}, {c})")

    # Mark workshops whose external pages had no schedule data yet
    no_schedule_codes = {"AI4CNI", "C-MAS", "MABS", "RaD-AI", "EXTRAAMAS"}
    for (day, code), sess in sessions_index.items():
        if code in no_schedule_codes and not sess.get("papers"):
            sess["schedule_status"] = "not yet published on workshop site"

    with open("program-merged.json", "w") as f:
        json.dump(program, f, indent=2, ensure_ascii=False)

    # Summary
    total_sessions = sum(1 for _ in sessions_index)
    sessions_with_papers = sum(1 for s in sessions_index.values() if s.get("papers"))
    total_papers = sum(len(s.get("papers", [])) for s in sessions_index.values())
    print(f"\n=== Merge summary ===")
    print(f"  total sessions: {total_sessions}")
    print(f"  sessions with paper-level data: {sessions_with_papers}")
    print(f"  total paper entries: {total_papers}")
    print(f"  merges applied: {merged_count}")


if __name__ == "__main__":
    main()
