#!/usr/bin/env python3
"""Fetch The Witcher 3 Gwent card data from witcher.fandom.com via the MediaWiki API.

Cloudflare blocks normal HTML page fetches, but api.php works.  We pull:
  - wikitext of every page in Category:The Witcher 3 gwent (card pages)
  - rendered text of the 5 faction deck pages + neutral cards page
  - rendered text of the main Gwent rules page

Outputs into research/ for the card-data build step.
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse

API = "https://witcher.fandom.com/api.php"
ROOT = os.path.dirname(os.path.abspath(__file__))
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36")


def fetch(params, retries=3):
    url = API + "?" + urllib.parse.urlencode(params)
    for attempt in range(retries):
        try:
            out = subprocess.run(
                ["curl", "-s", "-m", "30", "-A", UA, url],
                capture_output=True, text=True, check=True).stdout
            return json.loads(out)
        except Exception as exc:  # noqa: BLE001
            print(f"  retry {attempt + 1}: {exc}", file=sys.stderr)
            time.sleep(1.5)
    raise RuntimeError(f"failed: {url}")


def strip_wiki(s):
    """Crude wikitext -> plain text for readability."""
    s = re.sub(r"<br\s*/?>", "\n", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = re.sub(r"\[\[([^|\]]+)\|([^\]]+)\]\]", r"\2", s)
    s = re.sub(r"\[\[([^\]]+)\]\]", r"\1", s)
    s = re.sub(r"\{\{[Ss]mall\|([^}]*)\}\}", r"\1", s)
    s = re.sub(r"\{\{[Gg]went link\|([^}]*)\}\}", r"\1", s)
    s = re.sub(r"\{\{Patch\|[^}]*\}\}", "", s)
    s = re.sub(r"\{\{Crown Item\}\}", "crowns", s)
    s = re.sub(r"''+", "", s)
    return s.strip()


def parse_infobox(wikitext):
    """Pull name/deck/type/row/strength/spec_ability/source/id/caption/icon."""
    boxes = [m.start() for m in re.finditer(r"\{\{Infobox Gwent Card", wikitext, re.I)]
    if not boxes:
        return None
    # first infobox
    start = boxes[0]
    depth = 0
    i = start
    while i < len(wikitext) - 1:
        pair = wikitext[i:i + 2]
        if pair == "{{":
            depth += 1
            i += 2
            continue
        if pair == "}}":
            depth -= 1
            i += 2
            if depth == 0:
                break
            continue
        i += 1
    body = wikitext[start + 2:i - 2]
    fields = {}
    # split on top-level pipes
    parts, buf, depth = [], "", 0
    for ch in body:
        if ch == "{" or ch == "[":
            depth += 1
        elif ch == "}" or ch == "]":
            depth -= 1
        if ch == "|" and depth == 0:
            parts.append(buf)
            buf = ""
        else:
            buf += ch
    parts.append(buf)
    for part in parts[1:]:
        if "=" not in part:
            continue
        key, val = part.split("=", 1)
        fields[key.strip().lower()] = val.strip()

    def row_of(v):
        if not v:
            return []
        text = strip_wiki(v).lower()
        rows = []
        if "close" in text or "melee" in text:
            rows.append("melee")
        if "ranged" in text:
            rows.append("ranged")
        if "siege" in text:
            rows.append("siege")
        return rows

    t = strip_wiki(fields.get("type", ""))
    return {
        "name": strip_wiki(fields.get("name", "")),
        "deck": strip_wiki(fields.get("deck", "")),
        "type": t,
        "rows": row_of(fields.get("row", "")),
        "row_raw": strip_wiki(fields.get("row", "")),
        "strength": strip_wiki(fields.get("strength", "")),
        "ability": strip_wiki(fields.get("spec_ability", "")),
        "ability_raw": fields.get("spec_ability", ""),
        "source": strip_wiki(fields.get("source", "")),
        "source_raw": fields.get("source", ""),
        "id": strip_wiki(fields.get("id", "")),
        "id_raw": fields.get("id", ""),
        "caption": strip_wiki(fields.get("caption", "")),
        "icon": strip_wiki(fields.get("icon", "")),
    }


def main():
    os.makedirs(os.path.join(ROOT, "wiki"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "decks"), exist_ok=True)

    # --- 1. all card pages in Category:The Witcher 3 gwent ---------------
    members, cont = [], {}
    while True:
        params = {
            "action": "query", "list": "categorymembers",
            "cmtitle": "Category:The Witcher 3 gwent",
            "cmtype": "page", "cmlimit": "500", "format": "json",
        }
        params.update(cont)
        d = fetch(params)
        members += d["query"]["categorymembers"]
        if "continue" not in d:
            break
        cont = d["continue"]
    card_titles = [m["title"] for m in members]
    print(f"card pages: {len(card_titles)}")

    cards = []
    missing = []
    for i in range(0, len(card_titles), 40):
        batch = card_titles[i:i + 40]
        params = {
            "action": "query", "prop": "revisions",
            "rvprop": "content", "rvslots": "main",
            "titles": "|".join(batch), "format": "json", "redirects": "1",
        }
        d = fetch(params)
        for page in d["query"]["pages"].values():
            title = page["title"]
            if "revisions" not in page:
                missing.append(title)
                continue
            wikitext = page["revisions"][0]["slots"]["main"]["*"]
            with open(os.path.join(ROOT, "wiki", re.sub(r"[^A-Za-z0-9]+", "_", title) + ".wiki"),
                      "w", encoding="utf-8") as fh:
                fh.write(wikitext)
            info = parse_infobox(wikitext)
            if info is None:
                print("  no infobox:", title)
                continue
            info["page"] = title
            # notes section (useful for rules nuances)
            notes = re.search(r"==\s*Notes\s*==(.*?)(?:\n==|\Z)", wikitext, re.S)
            info["notes"] = strip_wiki(notes.group(1)) if notes else ""
            cards.append(info)
        time.sleep(0.2)

    # dedupe by page title
    seen, uniq = set(), []
    for c in cards:
        if c["page"] in seen:
            continue
        seen.add(c["page"])
        uniq.append(c)
    cards = uniq
    with open(os.path.join(ROOT, "cards-wiki.json"), "w", encoding="utf-8") as fh:
        json.dump(cards, fh, ensure_ascii=False, indent=1)
    print(f"parsed cards: {len(cards)}  missing: {missing}")

    # --- 2. rules + deck page text ---------------------------------------
    pages = {
        "Gwent": "rules-main",
        "Monsters Gwent deck": "deck-monsters",
        "Nilfgaardian Empire Gwent deck": "deck-nilfgaard",
        "Northern Realms Gwent deck": "deck-northern-realms",
        "Scoia'tael Gwent deck": "deck-scoiatael",
        "Skellige Gwent deck": "deck-skellige",
        "Gwent neutral cards": "deck-neutral",
    }
    for title, slug in pages.items():
        d = fetch({"action": "parse", "page": title, "prop": "text",
                   "format": "json", "redirects": "1"})
        html = d["parse"]["text"]["*"]
        with open(os.path.join(ROOT, "decks", slug + ".html"), "w", encoding="utf-8") as fh:
            fh.write(html)
        text = re.sub(r"<script.*?</script>", "", html, flags=re.S)
        text = re.sub(r"<[^>]+>", " ", text)
        import html as html_mod
        text = html_mod.unescape(text)
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n\s*\n+", "\n", text)
        with open(os.path.join(ROOT, "decks", slug + ".txt"), "w", encoding="utf-8") as fh:
            fh.write(text)
        print("fetched", title)

    # --- 3. ability category pages (rules definitions) -------------------
    cats = {
        "Gwent close combat cards": "rows",
        "Gwent hero cards": "hero",
        "Gwent spy cards": "spy",
        "Gwent medic cards": "medic",
        "Gwent morale boost cards": "morale",
        "Gwent muster cards": "muster",
        "Gwent tight bond cards": "bond",
        "Gwent agile cards": "agile",
        "Gwent weather cards": "weather",
        "Gwent special cards": "special",
        "Gwent leader cards": "leader",
        "Gwent neutral cards": "neutral",
        "Gwent summon avenger cards": "avenger",
    }
    cat_text = {}
    for title, slug in cats.items():
        d = fetch({"action": "parse", "page": title, "prop": "text",
                   "format": "json", "redirects": "1"})
        html = d["parse"]["text"]["*"]
        text = re.sub(r"<script.*?</script>", "", html, flags=re.S)
        text = re.sub(r"<[^>]+>", " ", text)
        import html as html_mod
        text = html_mod.unescape(text)
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n\s*\n+", "\n", text)
        cat_text[slug] = text
        with open(os.path.join(ROOT, "pages", "cat-" + slug + ".txt"), "w", encoding="utf-8") as fh:
            fh.write(text)
        print("fetched category", title)
    with open(os.path.join(ROOT, "ability-pages.json"), "w", encoding="utf-8") as fh:
        json.dump(cat_text, fh, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
