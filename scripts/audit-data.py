#!/usr/bin/env python3
"""Audit data.json files. Usage: python3 audit-data.py [folder]"""
import json, glob, os, sys
from collections import Counter

folder = sys.argv[1] if len(sys.argv) > 1 else '/Users/Max/Pictures/kleinanzeigen'
files = sorted(glob.glob(os.path.join(folder, '*/data.json')))
print(f'folder: {folder}')
print(f'files: {len(files)}')

KNOWN_TOP = {
    'title','description','price','priceType','zipCode','street','categoryPath',
    'locationId','condition','dynamicFields','autocompleteFields','versandMode',
    'shippingOptions','customShippingCost','buyNow','photoOrder','posted','marke',
}

extra_top = Counter()
df_keys = Counter()
two_lvl, three_lvl, other_lvl = [], [], []
versand_modes = Counter()
posted_count = 0
shipping_options_count = 0

for f in files:
    d = json.load(open(f))
    name = os.path.basename(os.path.dirname(f))
    for k in d.keys():
        if k not in KNOWN_TOP:
            extra_top[k] += 1
    df = d.get('dynamicFields') or {}
    for k in df.keys(): df_keys[k] += 1
    cp = d.get('categoryPath','')
    parts = [p.strip() for p in cp.split('>') if p.strip()]
    if len(parts) == 2: two_lvl.append((name, cp))
    elif len(parts) == 3: three_lvl.append((name, cp))
    else: other_lvl.append((name, cp, len(parts)))
    versand_modes[d.get('versandMode') or '(missing)'] += 1
    if d.get('posted'): posted_count += 1
    if d.get('shippingOptions'): shipping_options_count += 1

print('\n--- unexpected top-level keys ---')
for k,c in extra_top.most_common(): print(f'  {k}: {c}')

print('\n--- dynamicFields keys ---')
for k,c in df_keys.most_common(): print(f'  {k}: {c}')

print(f'\n--- categoryPath: 2-level={len(two_lvl)} 3-level={len(three_lvl)} other={len(other_lvl)} ---')
print('  2-level samples:')
for n,p in two_lvl[:5]: print(f'    {n}: {p}')
print('  3-level samples:')
for n,p in three_lvl[:5]: print(f'    {n}: {p}')
if other_lvl:
    print('  ! malformed:')
    for n,p,L in other_lvl: print(f'    {n}: {p!r} ({L} parts)')

print(f'\n--- versandMode distribution ---')
for k,c in versand_modes.most_common(): print(f'  {k}: {c}')

print(f'\nposted: {posted_count}/{len(files)}')
print(f'shippingOptions present: {shipping_options_count}/{len(files)}')
