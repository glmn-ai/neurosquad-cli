import unicodedata, sys
print('//', unicodedata.unidata_version, file=sys.stderr)
def ranges(pred):
    out=[]; start=None
    for cp in range(0x110000):
        ok=pred(cp)
        if ok and start is None: start=cp
        if not ok and start is not None: out.append((start,cp-1)); start=None
    if start is not None: out.append((start,0x10ffff))
    return out
def eaw(cp):
    try: return unicodedata.east_asian_width(chr(cp))
    except: return 'N'
W=ranges(lambda c: eaw(c) in ('W','F') and unicodedata.category(chr(c))!='Cn' or (0x3400<=c<=0x4DBF) or (0x4E00<=c<=0x9FFF) or (0x20000<=c<=0x2FFFD) or (0x30000<=c<=0x3FFFD))
A=ranges(lambda c: eaw(c)=='A' and unicodedata.category(chr(c)) not in ('Co','Cn') and c<0xE000)
def fmt(name, rs):
    flat=[]
    for a,b in rs: flat += [a,b]
    lines=[]; row=[]
    for i,v in enumerate(flat):
        row.append('0x%x'%v)
        if len(row)==12: lines.append('  '+', '.join(row)+','); row=[]
    if row: lines.append('  '+', '.join(row)+',')
    return 'export const %s: readonly number[] = [\n%s\n]\n' % (name, '\n'.join(lines))
print('// Generated from Unicode %s EastAsianWidth (via Python unicodedata) - do not edit by hand.' % unicodedata.unidata_version)
print('// Flat [start, end, start, end, ...] inclusive code point ranges, sorted.\n')
print('/** East_Asian_Width W or F: two terminal cells. */')
print(fmt('WIDE_RANGES', W))
print('/** East_Asian_Width A (outside the private use area): one cell in Western locales, two in some CJK setups. */')
print(fmt('AMBIGUOUS_RANGES', A))
print(len(W), len(A), file=sys.stderr)
