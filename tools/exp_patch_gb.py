# Gera e testa o patch de multiplicador de EXP dos Pokémon de Game Boy / Color
# (EXP_PATCHES_GB em docs/app.js). Mesma ideia do tools/exp_patch.py (GBA).
#
# Uso:  python tools/exp_patch_gb.py <pasta com as ROMs> <pasta com os .sym do pret> <saida.json>
# Requer: pip install pyboy
#
# Gen 1 (GainExperience, pokered/pokeyellow) e Gen 2 (GiveExperiencePoints, pokegold/
# pokecrystal) calculam a EXP do mesmo jeito:
#     hMultiplicand = baseExp; hMultiplier = level; call Multiply
#     ld a, 7; ldh [hDivisor], a; ld b, 4; call Divide        <- site
# e depois aplicam BoostExp (×1,5, sem checar estouro) e usam só hQuotient+2/+3 (16 bits).
# O patch troca o `call Divide` por `call caverna`, num trecho livre (preenchido com 00)
# no fim do mesmo banco. A caverna chama o Divide original, multiplica o quociente pelos
# fatores F1 e F2 (1–255 cada, com o Multiply do próprio jogo: 10 = 10·1, 100 = 100·1,
# 1000 = 10·100) e corta no teto. Tetos (BoostExp em cima não pode passar de 65535):
#   Gen 1: 2 boosts (troca, treinador)            → 28927 × 2,25  = 65085
#   Gen 2: 3 boosts (troca, treinador, Lucky Egg) → 19199 × 3,375 = 64796
# O teste roda o `call` patchado no PyBoy (Multiply/Divide/callfar do jogo de verdade)
# para 1x/10x/100x/1000x e confere o resultado e os registradores bc/de/hl.
import sys, json, re
from pyboy import PyBoy

ROMS, SYMS, OUT = sys.argv[1:4]
G = {  # código do cabeçalho: (rom, sym, função, geração)
    'red':     ('pokemon-red.gb',      'pokered.sym',       'GainExperience',       1),
    'blue':    ('pokemon-blue.gb',     'pokeblue.sym',      'GainExperience',       1),
    'yellow':  ('pokemon-yellow.gb',   'pokeyellow.sym',    'GainExperience',       1),
    'gold':    ('pokemon-gold.gbc',    'pokegold.sym',      'GiveExperiencePoints', 2),
    'silver':  ('pokemon-silver.gbc',  'pokesilver.sym',    'GiveExperiencePoints', 2),
    'crystal': ('pokemon-crystal.gbc', 'pokecrystal11.sym', 'GiveExperiencePoints', 2),
}
CAPS = {1: 0x70FF, 2: 0x4AFF}
FACTORS = {1: (1, 1), 10: (10, 1), 100: (100, 1), 1000: (10, 100)}


def syms(path):
    out = {}
    for line in open(path):
        m = re.match(r'([0-9a-f]{2}):([0-9a-f]{4}) (\S+)', line)
        if m:
            out[m[3]] = (int(m[1], 16), int(m[2], 16))
    return out


def off(bank, addr):  # endereço do banco → offset no arquivo
    return addr if bank == 0 else bank * 0x4000 + (addr - 0x4000)


def cave_code(S, cap, f1, f2):
    lo = lambda a: [a & 0xFF, a >> 8]
    hp = S['hProduct'][1] & 0xFF
    hm = S['hMultiplier'][1] & 0xFF
    div, mul = S['Divide'][1], S['Multiply'][1]
    c = [0xC5, 0xD5, 0xE5]                      # push bc / de / hl
    c += [0xCD, *lo(div)]                       # call Divide (o original)
    lit1 = len(c) + 1
    c += [0x3E, f1, 0xE0, hm, 0xCD, *lo(mul)]   # ld a,F1 / ldh [hMultiplier],a / call Multiply
    lit2 = len(c) + 1
    c += [0x3E, f2, 0xE0, hm, 0xCD, *lo(mul)]   # ld a,F2 / ...
    # teto: se hProduct[0] ou [1] != 0, ou hProduct[2] > HIGH(cap) → cap ($xxFF)
    c += [0xF0, hp, 0xA7, 0x20, None]           # ldh a,[hProduct]   / and a / jr nz,.cap
    j1 = len(c) - 1
    c += [0xF0, hp + 1, 0xA7, 0x20, None]       # ldh a,[hProduct+1] / and a / jr nz,.cap
    j2 = len(c) - 1
    c += [0xF0, hp + 2, 0xFE, (cap >> 8) + 1, 0x38, None]  # ldh a,[hProduct+2] / cp HIGH+1 / jr c,.ok
    j3 = len(c) - 1
    capl = len(c)
    c += [0x3E, cap >> 8, 0xE0, hp + 2, 0x3E, 0xFF, 0xE0, hp + 3]
    okl = len(c)
    c += [0xAF, 0xE0, hp, 0xE0, hp + 1]         # xor a / zera hProduct[0..1]
    c += [0xE1, 0xD1, 0xC1, 0xC9]               # pop hl / de / bc, ret
    c[j1] = capl - (j1 + 1)
    c[j2] = capl - (j2 + 1)
    c[j3] = okl - (j3 + 1)
    return bytes(c), lit1, lit2


out = {}
for code, (romf, symf, fn, gen) in G.items():
    rom = bytearray(open(f'{ROMS}/{romf}', 'rb').read())
    S = syms(f'{SYMS}/{symf}')
    bank, start = S[fn]
    hd = S['hDivisor'][1] & 0xFF
    div = S['Divide'][1]
    pat = bytes([0x3E, 0x07, 0xE0, hd, 0x06, 0x04, 0xCD, div & 0xFF, div >> 8])
    o0 = off(bank, start)
    i = rom.find(pat, o0, o0 + 0x200)
    assert i > 0 and rom.find(pat, i + 1, o0 + 0x200) < 0, code
    site_off = i + 6
    site = 0x4000 + (site_off - bank * 0x4000)
    # caverna: fim do banco preenchido com 00, depois do último símbolo do banco
    last = max(a for b, a in S.values() if b == bank and a < 0x8000)
    end = bank * 0x4000 + 0x4000
    p = end
    while rom[p - 1] == 0x00:
        p -= 1
    free = max(p, off(bank, last) + 1) + 16
    cap = CAPS[gen]
    blob, lit1, lit2 = cave_code(S, cap, 1, 1)
    assert free + len(blob) < end, code
    cave = 0x4000 + (free - bank * 0x4000)
    assert all(b == 0 for b in rom[free:free + len(blob)])
    sitePatch = bytes([0xCD, cave & 0xFF, cave >> 8])
    out[code] = dict(site=site_off, siteOrig=rom[site_off:site_off + 3].hex(), sitePatch=sitePatch.hex(),
                     cave=free, caveOrig=rom[free:free + len(blob)].hex(), cavePatch=blob.hex(),
                     lit1=free + lit1, lit2=free + lit2, cap=cap)

    # ---- teste no PyBoy
    hp = S['hProduct'][1]
    for M in (1, 10, 100, 1000):
        p = bytearray(rom)
        f1, f2 = FACTORS[M]
        if M > 1:
            b2 = bytearray(blob); b2[lit1] = f1; b2[lit2] = f2
            p[free:free + len(b2)] = b2
            p[site_off:site_off + 3] = sitePatch
        path = f'{OUT}.{code}.{M}.gb'
        open(path, 'wb').write(p)
        pb2 = PyBoy(path, window='null', sound_emulated=False)
        pb2.tick(120, False)
        for be, lvl in ((64, 5), (142, 30), (255, 100), (1, 2), (134, 100)):
            dividend = be * lvl
            want_base = dividend // 7
            want = min(want_base * M, cap) if M > 1 else want_base
            got = {}

            def start(ctx):
                if got.get('started'):
                    return
                got['started'] = True
                rf = pb2.register_file
                pb2.memory[0xFFFF] = 0                 # sem interrupções
                pb2.memory[0x2000] = bank              # banco da função
                pb2.memory[S.get('hLoadedROMBank', S.get('hROMBank'))[1]] = bank
                for k, v in enumerate(dividend.to_bytes(4, 'big')):
                    pb2.memory[hp + k] = v
                pb2.memory[hp + 4] = 7
                rf.B, rf.C, rf.D, rf.E, rf.HL = 4, 0x12, 0x34, 0x56, 0x789A
                rf.SP = 0xDFF0
                rf.PC = site

            def done(ctx):
                if 'v' in got:
                    return
                rf = pb2.register_file
                got['v'] = int.from_bytes(bytes(pb2.memory[hp + k] for k in range(4)), 'big')
                got['q23'] = pb2.memory[hp + 2] << 8 | pb2.memory[hp + 3]
                got['regs'] = (rf.C, rf.D, rf.E, rf.HL)
                got['sp'] = rf.SP

            pb2.hook_register(0, 0x0040, start, None)
            pb2.hook_register(bank, site + 3, done, None)
            pb2.tick(3, False)
            assert 'v' in got, (code, M, 'não chegou no retorno')
            assert got['q23'] == want, (code, M, be, lvl, got, want)
            if M > 1:
                assert got['v'] == want, (code, M, 'hProduct[0..1] não zerado', got)
            assert got['regs'] == (0x12, 0x34, 0x56, 0x789A), (code, M, 'registradores', got)
            assert got['sp'] == 0xDFF0, (code, M, 'pilha', hex(got['sp']))
            # volta a um estado limpo para o próximo caso
            pb2.stop(False)
            pb2 = PyBoy(path, window='null', sound_emulated=False)
            pb2.tick(120, False)
        pb2.stop(False)
    print(f'{code} ok  banco {bank:#04x} site {site:#06x} caverna {cave:#06x} ({len(blob)} B) teto {cap}  testes 1x/10x/100x/1000x passaram')

json.dump(out, open(OUT, 'w'), indent=1)
