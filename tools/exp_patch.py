# Gera e testa o patch de multiplicador de EXP usado em docs/app.js (EXP_PATCHES).
#
# Uso:  python tools/exp_patch.py <pasta com as ROMs> <saida.json>
# Requer: pip install keystone-engine capstone unicorn
#
# Endereços (site do `bl __divsi3` em Cmd_getexp/atk23_getexp, __divsi3 e a função
# morta usada como caverna) vêm dos .sym do pret (branch `symbols` de pokeemerald,
# pokefirered e pokeruby). A caverna foi escolhida entre funções sem nenhum `bl` nem
# ponteiro apontando para elas na ROM. O teste roda o trecho patchado no Unicorn com
# o __divsi3 da própria ROM, para 1x/10x/100x/1000x.
import sys, struct, json
from keystone import Ks, KS_ARCH_ARM, KS_MODE_THUMB
from capstone import Cs, CS_ARCH_ARM, CS_MODE_THUMB
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_THUMB
from unicorn.arm_const import *
R = sys.argv[1]
CAP = 9700  # 9700 × 1,5 (troca) × 1,5 (treinador) × 1,5 (Lucky Egg) = 32737 < 32767 (s16 do controlador)
G = {  # code: (rom, call site do bl __divsi3, __divsi3, caverna = função morta)
 'BPEE': ('pokemon-emerald.gba',   0x0804a4ae, 0x082e7540, 0x0801229c),
 'BPRE': ('pokemon-firered.gba',   0x08021bea, 0x081e4018, 0x080fc228),
 'BPGE': ('pokemon-leafgreen.gba', 0x08021bea, 0x081e3ff4, 0x080fc200),
 'AXVE': ('pokemon-ruby.gba',      0x08020192, 0x081e0868, 0x080913a4),
 'AXPE': ('pokemon-sapphire.gba',  0x08020192, 0x081e07f8, 0x080913a4),
}
ks = Ks(KS_ARCH_ARM, KS_MODE_THUMB); cs = Cs(CS_ARCH_ARM, CS_MODE_THUMB)
def bl(frm, to):
    o = (to - (frm + 4)) >> 1
    assert -(1 << 21) <= o < (1 << 21)
    return struct.pack('<HH', 0xF000 | ((o >> 11) & 0x7FF), 0xF800 | (o & 0x7FF))
out = {}
for code, (rom, site, div, cave) in G.items():
    data = bytearray(open(f'{R}/{rom}', 'rb').read())
    assert cave % 4 == 0
    asm = f"""
      push {{lr}}
      ldr r2, [pc, #20]
      muls r0, r2
      bl {div:#x}
      ldr r1, [pc, #16]
      cmp r0, r1
      bls done
      mov r0, r1
    done:
      pop {{r1}}
      bx r1
    """
    enc, _ = ks.asm(asm, cave)
    body = bytes(enc)
    pad = (-len(body)) % 4
    blob = body + b'\x00\xbf' * (pad // 2)
    lit_off = len(blob)
    blob += struct.pack('<II', 1000, CAP)
    # confere os ldr pc-relativos: apontam para lit_off e lit_off+4
    ins = list(cs.disasm(blob[:lit_off], cave))
    for x in ins:
        if x.mnemonic == 'ldr':
            pc = (x.address + 4) & ~3; tgt = pc + int(x.op_str.split('#')[1].rstrip(']'), 0)
            assert tgt - cave in (lit_off, lit_off + 4), (x.op_str, hex(tgt - cave))
    orig_site = bytes(data[site - 0x08000000: site - 0x08000000 + 4])
    assert orig_site == bl(site, div), code
    orig_cave = bytes(data[cave - 0x08000000: cave - 0x08000000 + len(blob)])
    out[code] = dict(site=site - 0x08000000, cave=cave - 0x08000000, litM=cave - 0x08000000 + lit_off,
                     siteOrig=orig_site.hex(), sitePatch=bl(site, cave).hex(), caveOrig=orig_cave.hex(), cavePatch=blob.hex())
    # ---- teste no Unicorn: roda o bl patchado na ROM inteira, com o __divsi3 de verdade
    for M in (1, 10, 100, 1000):
        p = bytearray(data)
        p[site - 0x08000000: site - 0x08000000 + 4] = bl(site, cave)
        b2 = bytearray(blob); b2[lit_off:lit_off + 4] = struct.pack('<I', M)
        p[cave - 0x08000000: cave - 0x08000000 + len(b2)] = b2
        uc = Uc(UC_ARCH_ARM, UC_MODE_THUMB)
        uc.mem_map(0x08000000, len(p)); uc.mem_write(0x08000000, bytes(p))
        uc.mem_map(0x03000000, 0x8000)
        for yl in (64 * 5, 142 * 30, 255 * 100, 1):
            uc.reg_write(UC_ARM_REG_R0, yl); uc.reg_write(UC_ARM_REG_R1, 7)
            uc.reg_write(UC_ARM_REG_SP, 0x03007f00); uc.reg_write(UC_ARM_REG_LR, 0xdead)
            uc.emu_start(site | 1, site + 4, count=500)
            got = uc.reg_read(UC_ARM_REG_R0); want = min(yl * M // 7, CAP)
            assert got == want, (code, M, yl, got, want)
            assert uc.reg_read(UC_ARM_REG_SP) == 0x03007f00, 'pilha desbalanceada'
    print(f'{code} ok  site={site:#x} caverna={cave:#x} ({len(blob)} B)  testes 1x/10x/100x/1000x passaram')
json.dump(out, open(sys.argv[2], 'w'), indent=1)
