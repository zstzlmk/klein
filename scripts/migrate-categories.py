#!/usr/bin/env python3
"""Migrate every item's data.json to use a 3-level categoryPath.

For each <project>/<item>/data.json:
  - If categoryPath already has 3 segments (or the sub-category has no
    children), leave it alone.
  - Otherwise read dynamicFields.<...>.art_s, look up the matching leaf
    in app/categories.json, and rewrite categoryPath to "A > B > C".
  - Write a backup data.json.bak next to the original on first migration.

Idempotent: safe to run multiple times.
"""
import json
import os
import shutil
import sys

ROOT = "/Users/Max/Pictures/kleinanzeigen"
CATS_PATH = os.path.join(os.path.dirname(__file__), "..", "app", "categories.json")
SKIP_DIRS = {".thumbs", ".DS_Store", "VERKAUFT", "Other"}


def find_child(node, name):
    for c in node.get("children") or []:
        if c.get("name") == name:
            return c
    return None


def find_leaf_by_value(sub_node, value):
    for c in sub_node.get("children") or []:
        if c.get("fieldValue") == value:
            return c
    return None


def migrate_one(folder, cats):
    p = os.path.join(ROOT, folder)
    dp = os.path.join(p, "data.json")
    if not os.path.exists(dp):
        return ("skip", folder, "no data.json")

    with open(dp) as f:
        data = json.load(f)

    cp = data.get("categoryPath", "")
    parts = [s.strip() for s in cp.split(">") if s.strip()]
    if len(parts) >= 3:
        return ("ok", folder, cp)

    parent = parts[0] if len(parts) > 0 else ""
    sub = parts[1] if len(parts) > 1 else ""
    parent_node = find_child(cats["tree"], parent) if parent else None
    sub_node = find_child(parent_node, sub) if parent_node and sub else None
    if not sub_node:
        return ("skip", folder, f"unknown sub-category: {cp}")
    if not (sub_node.get("children") or []):
        return ("ok", folder, f"{cp} (sub is leaf)")

    art_val = None
    for k, v in (data.get("dynamicFields") or {}).items():
        if k.endswith(".art_s") or k.endswith(".art"):
            art_val = v
            break
    if not art_val:
        return ("manual", folder, f"no art_s for {cp}")

    leaf_obj = find_leaf_by_value(sub_node, art_val)
    if not leaf_obj:
        return ("manual", folder, f"art_s={art_val} not found in {cp}")

    new_path = f"{parent} > {sub} > {leaf_obj['name']}"
    backup = dp + ".bak"
    if not os.path.exists(backup):
        shutil.copy2(dp, backup)
    data["categoryPath"] = new_path
    with open(dp, "w") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)
    return ("migrated", folder, f"{cp}  ->  {new_path}")


def main():
    with open(CATS_PATH) as f:
        cats = json.load(f)

    results = {"migrated": [], "ok": [], "manual": [], "skip": []}
    for d in sorted(os.listdir(ROOT)):
        if d in SKIP_DIRS or d.startswith("."):
            continue
        full = os.path.join(ROOT, d)
        if not os.path.isdir(full):
            continue
        status, name, msg = migrate_one(d, cats)
        results[status].append((name, msg))

    for status in ("migrated", "ok", "manual", "skip"):
        if not results[status]:
            continue
        print(f"\n=== {status.upper()} ({len(results[status])}) ===")
        for name, msg in results[status]:
            print(f"  {name}: {msg}")

    print(
        f"\nTotal: {len(results['migrated'])} migrated, "
        f"{len(results['ok'])} already ok, "
        f"{len(results['manual'])} need manual edit, "
        f"{len(results['skip'])} skipped"
    )


if __name__ == "__main__":
    main()
