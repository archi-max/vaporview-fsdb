# Generates corpus.s: hand-picked and random RV32IMC + Zicsr + Zifencei encodings as .insn
# directives. Assemble + disassemble it with GNU binutils (see make_expected.sh) to get the
# expected text for every encoding.
import gzip, random
random.seed(411)
words = []

def r(n): return random.getrandbits(n)

# Hand-picked encodings that hit every alias rule.
hand = [
  0x00000013, 0x00a00093, 0x00050593, 0x00008067, 0x00050067, 0x000500e7, 0x00850067, 0x008500e7,
  0x00c58533, 0x40c58533, 0x40b00533, 0x00b03533, 0x0005a533, 0x00b02533, 0xfff54513, 0x0ff57513,
  0x00153513, 0x0000100f, 0x0ff0000f, 0x8330000f, 0x0100000f, 0x0330000f, 0x00000073, 0x00100073,
  0x30200073, 0x10200073, 0x10500073, 0x12000073, 0x12050073, 0x12b50073, 0xc0001073,
  0xc0002573, 0xc0102573, 0xc0202573, 0xc8002573, 0x30002573, 0x30051073, 0x3002a073, 0x3002b073,
  0x3000d073, 0x3000e073, 0x3000f073, 0x34151573, 0x34115573, 0x7c002573,
  0x123452b7, 0x00001517, 0x0080006f, 0xff9ff06f, 0x008000ef, 0x0100056f,
  0x00050463, 0x00051463, 0x00054463, 0x00055463, 0x00a04463, 0x00a05463, 0x00b50463, 0xfeb56ee3,
  0x00452503, 0xffc12283, 0x00a12223, 0x00a10023, 0x00a11023, 0x02b50533, 0x02b54533, 0x02b57533,
]
for w in hand: words.append((4, w))
hand_c = [0x0001, 0x4501, 0x557d, 0x8082, 0x8502, 0x9502, 0x852e, 0x952e, 0x9002, 0x0808, 0x4108,
          0xc108, 0x1141, 0x6505, 0x7179, 0x8105, 0x8505, 0x8905, 0x8d0d, 0x8d2d, 0x8d4d, 0x8d6d,
          0xa001, 0x2001, 0xc111, 0xe111, 0x050a, 0x4502, 0xc02a, 0x0000, 0x0505, 0x157d]
for h in hand_c: words.append((2, h))

def enc_r(f7, rs2, rs1, f3, rd, op): return (f7<<25)|(rs2<<20)|(rs1<<15)|(f3<<12)|(rd<<7)|op
def enc_i(imm, rs1, f3, rd, op): return ((imm & 0xfff)<<20)|(rs1<<15)|(f3<<12)|(rd<<7)|op

csrs = [0x001,0x002,0x003,0xc00,0xc01,0xc02,0xc80,0xc81,0xc82,0xc03,0xc1f,0xc83,0x100,0x104,0x105,0x106,
        0x140,0x141,0x142,0x143,0x144,0x180,0xf11,0xf12,0xf13,0xf14,0x300,0x301,0x302,0x303,0x304,0x305,
        0x306,0x310,0x340,0x341,0x342,0x343,0x344,0x34a,0x34b,0x3a0,0x3b0,0x3b5,0xb00,0xb02,0xb03,0xb80,
        0xb82,0x320,0x323,0x7a0,0x7a1,0x7a2,0x7a3,0x7b0,0x7b1,0x7b2,0x7b3,0x30a,0x10a,0xf15,0x31a]
regsmall = lambda: random.choice([0, 1, 2, r(5), r(5)])
for _ in range(1500):
    k = random.randrange(12)
    rd, rs1, rs2 = regsmall(), regsmall(), regsmall()
    if k == 0: w = (r(20)<<12)|(rd<<7)|random.choice([0x37,0x17])
    elif k == 1: w = (r(20)<<12)|(rd<<7)|0x6f
    elif k == 2: w = enc_i(random.choice([0, r(12), 4, -4]), rs1, 0, rd, 0x67)
    elif k == 3: w = (r(7)<<25)|(rs2<<20)|(rs1<<15)|(random.choice([0,1,4,5,6,7])<<12)|(r(5)<<7)|0x63
    elif k == 4: w = enc_i(r(12), rs1, random.choice([0,1,2,4,5]), rd, 0x03)
    elif k == 5: w = (r(7)<<25)|(rs2<<20)|(rs1<<15)|(random.choice([0,1,2])<<12)|(r(5)<<7)|0x23
    elif k == 6:
        f3 = random.choice([0,2,3,4,6,7,0,3,4,7])
        imm = random.choice([0, 1, -1, 255, r(12)])
        w = enc_i(imm, rs1, f3, rd, 0x13)
    elif k == 7:
        f3 = random.choice([1,5,5]); f7 = 0x20 if (f3 == 5 and r(1)) else 0
        w = enc_r(f7, r(5), rs1, f3, rd, 0x13)
    elif k == 8:
        f7 = random.choice([0,0x20,1]); f3 = r(3)
        if f7 == 0x20: f3 = random.choice([0,5])
        w = enc_r(f7, rs2, rs1, f3, rd, 0x33)
    elif k == 9:
        w = (r(4)<<24)|(r(4)<<20)|0x0f
    elif k in (10, 11):
        f3 = random.choice([1,2,3,5,6,7])
        w = (random.choice(csrs)<<20)|(rs1<<15)|(f3<<12)|(rd<<7)|0x73
    words.append((4, w & 0xffffffff))
for _ in range(1500):
    while True:
        h = r(16)
        if (h & 3) != 3: break
    words.append((2, h))

# Sweeps added after review: every CSR number (csrrs a0,N,zero), fences with nonzero
# rd/rs1/fm, fully random words for every major 32-bit opcode, and every 16-bit
# compressed encoding.
for csr in range(4096):
    words.append((4, (csr << 20) | (2 << 12) | (10 << 7) | 0x73))
for _ in range(300):
    words.append((4, (r(12) << 20) | (r(5) << 15) | (r(1) << 12) | (r(5) << 7) | 0x0f))
for op in [o for o in range(0, 128, 4) if (o & 0x1c) != 0x1c]:
    for _ in range(150):
        words.append((4, (r(25) << 7) | op | 3))
for h in range(0x10000):
    if (h & 3) != 3:
        words.append((2, h))

with open("corpus.s", "w") as f:
    f.write('\t.attribute arch, "rv32i2p1_m2p0_c2p0_zicsr2p0_zifencei2p0"\n\t.text\n')
    for n, w in words:
        f.write(f"\t.insn {n}, 0x{w:0{2*n}x}\n")
# corpus.s is regenerated on demand (not committed); corpus.txt.gz feeds the tests.
with gzip.open("corpus.txt.gz", "wt") as f:
    for n, w in words: f.write(f"{n} {w:0{2*n}x}\n")
print(len(words), "encodings")
