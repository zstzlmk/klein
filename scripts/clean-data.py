#!/usr/bin/env python3
"""Clean up data.json files.

Drops:
  - top-level `city` (not in schema; zipCode is the source of truth)
  - dynamicFields["pstad-city"]            — never read by automation
  - dynamicFields["*.versand_s"]           — superseded by top-level versandMode
  - dynamicFields["attributeMap[*]"] keys  — historical double-wrapping bug
  - dynamicFields["attributeMap[*]_s"] keys — same bug, double-wrapped + extra _s
  - dynamicFields["X"] when "X_s" is also present (kept the canonical _s form)

Adds:
  - versandMode if missing, inferred from shippingOptions / customShippingCost
"""
import json, glob, os, sys, re

folder = '/Users/Max/Pictures/kleinanzeigen'
dry_run = False
for arg in sys.argv[1:]:
    if arg == '--dry': dry_run = True
    else: folder = arg

DEAD_TOP_KEYS = {'city'}
DEAD_DF_KEYS = {'pstad-city'}

def clean(d):
    changes = []

    # Drop dead top-level keys
    for k in list(DEAD_TOP_KEYS):
        if k in d:
            d.pop(k); changes.append(f'-top:{k}')

    df = d.get('dynamicFields') or {}
    keys = list(df.keys())
    for k in keys:
        # Pure cruft
        if k in DEAD_DF_KEYS:
            df.pop(k); changes.append(f'-df:{k}'); continue
        # versand_s (any namespace) — versandMode is the source of truth
        if k.endswith('.versand_s'):
            df.pop(k); changes.append(f'-df:{k}'); continue
        # double-wrapped attributeMap[...] keys (with or without trailing _s)
        if k.startswith('attributeMap['):
            df.pop(k); changes.append(f'-df:{k}'); continue

    # Canonicalize: strip "_s" suffix, prefer the bare form (matches schema keys).
    keys = list(df.keys())
    for k in keys:
        if not k.endswith('_s'): continue
        bare = k[:-2]
        if bare in df:
            # Both forms exist — drop the _s, keep the bare
            df.pop(k); changes.append(f'-df:{k} (dup of {bare})')
        else:
            # Only _s form exists — rename to bare
            df[bare] = df.pop(k); changes.append(f'~df:{k} -> {bare}')

    # Infer versandMode if missing
    if 'versandMode' not in d:
        if d.get('shippingOptions'): d['versandMode'] = 'ja'; changes.append('+versandMode=ja')
        elif d.get('customShippingCost'): d['versandMode'] = 'custom'; changes.append('+versandMode=custom')
        else: d['versandMode'] = 'nein'; changes.append('+versandMode=nein')

    return changes


files = sorted(glob.glob(os.path.join(folder, '*/data.json')))
total_changes = 0
for f in files:
    d = json.load(open(f))
    changes = clean(d)
    if not changes: continue
    total_changes += len(changes)
    name = os.path.basename(os.path.dirname(f))
    print(f'{name}: {", ".join(changes)}')
    if not dry_run:
        with open(f, 'w') as out:
            json.dump(d, out, indent=4, ensure_ascii=False)

print(f'\n{"DRY RUN — " if dry_run else ""}cleaned {total_changes} fields across {len(files)} files')
