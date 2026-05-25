#!/usr/bin/env python3
"""Inspect each item folder and show its current categoryPath, plus a
suggested leaf based on the .art_s attribute (if any)."""
import json
import os
import sys

ROOT = "/Users/Max/Pictures/kleinanzeigen"
CATS_PATH = os.path.join(os.path.dirname(__file__), "..", "app", "categories.json")
SKIP_DIRS = {".thumbs", ".DS_Store", "VERKAUFT", "Other"}

with open(CATS_PATH) as f:
    cats = json.load(f)


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


def list_leaves(sub_node):
    return [c.get("name") for c in (sub_node.get("children") or [])]


def inspect(folder):
    p = os.path.join(ROOT, folder)
    dp = os.path.join(p, "data.json")
    if not os.path.exists(dp):
        return f"{folder}: NO data.json"
    with open(dp) as f:
        data = json.load(f)
    cp = data.get("categoryPath", "")
    title = data.get("title", "")
    parts = [s.strip() for s in cp.split(">") if s.strip()]
    parent = parts[0] if len(parts) > 0 else ""
    sub = parts[1] if len(parts) > 1 else ""
    leaf = parts[2] if len(parts) > 2 else ""

    parent_node = find_child(cats["tree"], parent) if parent else None
    sub_node = find_child(parent_node, sub) if parent_node and sub else None
    has_leaves = bool(sub_node and (sub_node.get("children") or []))

    if not has_leaves:
        marker = "OK" if cp else "EMPTY"
        return f"[{marker}] {folder:35s} | {title[:40]:40s} | {cp}"

    if leaf:
        return f"[OK]    {folder:35s} | {title[:40]:40s} | {cp}"

    # Need a leaf — try to resolve from art_s attribute
    art_val = None
    art_key = None
    for k, v in (data.get("dynamicFields") or {}).items():
        if k.endswith(".art_s") or k.endswith(".art"):
            art_val = v
            art_key = k
            break
    leaf_obj = find_leaf_by_value(sub_node, art_val) if art_val else None
    if leaf_obj:
        return (
            f"[AUTO]  {folder:35s} | {title[:40]:40s} | "
            f"{parent} > {sub} > {leaf_obj['name']}  (from {art_key}={art_val})"
        )

    leaves = list_leaves(sub_node)
    return (
        f"[NEED]  {folder:35s} | {title[:40]:40s} | {cp}\n"
        f"          options: {', '.join(leaves)}"
    )


def main():
    for d in sorted(os.listdir(ROOT)):
        if d in SKIP_DIRS or d.startswith("."):
            continue
        full = os.path.join(ROOT, d)
        if not os.path.isdir(full):
            continue
        print(inspect(d))


if __name__ == "__main__":
    main()
