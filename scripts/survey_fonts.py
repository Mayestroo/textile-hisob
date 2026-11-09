import re

with open('apps/desktop/renderer/features/models/KonveyerView.tsx', encoding='utf-8') as f:
    tsx = f.read()

inline_fs = re.findall(r'fontSize:\s*[\'\"]([0-9\.]+)px[\'\"]', tsx)
print('KonveyerView.tsx inline font sizes:', sorted(set(inline_fs), key=float))

# Print all lines with fontSize in KonveyerView.tsx
for i, line in enumerate(tsx.splitlines()):
    if 'fontSize' in line:
        print(f'Line {i+1}: {line.strip()}')

with open('apps/desktop/renderer/index.css', encoding='utf-8') as f:
    css = f.read()

# Find all font-size inside konveyer classes
konveyer_blocks = re.findall(r'(\.[^{]*konveyer[^{]*\{[^}]*\})', css, re.DOTALL)
for b in konveyer_blocks:
    for m in re.findall(r'font-size:\s*([0-9\.]+)px', b):
        selector = b.split('{')[0].strip()
        print(f'{selector} -> {m}px')

