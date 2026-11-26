// RISC-V instruction disassembler for the "RISC-V" value format.
// Written for this project from the RISC-V ISA specifications (Unprivileged
// ISA 20191213, Privileged ISA 20211203). Covers RV32I, M, Zicsr, Zifencei,
// the machine/supervisor trap instructions and the RV32 C extension (integer
// subset). Output follows GNU objdump's style: comma-separated operands with no
// spaces, decimal immediates, hex for lui/auipc/shift amounts, objdump's
// pseudo-instruction aliases (li, mv, ret, beqz, csrr, ...) unless disabled.
// Pure functions only; no dependencies, so it can be unit-tested under node.

export interface RiscvDisasmOptions {
  // ABI register names (a0, sp, ...) instead of x0..x31. Default true.
  abiNames?: boolean;
  // Use objdump's pseudo-instruction aliases. Default true. false = objdump -M no-aliases.
  aliases?: boolean;
  // Address of the instruction. If given, branch/jump targets print as absolute
  // hex addresses (like objdump). If not, they print as pc+N / pc-N.
  pc?: number;
}

const ABI_NAMES = [
  "zero", "ra", "sp", "gp", "tp", "t0", "t1", "t2",
  "s0", "s1", "a0", "a1", "a2", "a3", "a4", "a5",
  "a6", "a7", "s2", "s3", "s4", "s5", "s6", "s7",
  "s8", "s9", "s10", "s11", "t3", "t4", "t5", "t6",
];

// CSR names: every CSR that GNU objdump 2.43.1 names by default (privileged spec 1.12
// and the extensions binutils knows: vector, Zkr, Smstateen, Sstc, Smaia/Ssaia,
// Sscofpmf, Smcntrpmf, hypervisor, debug/trigger). The list was produced by
// disassembling csrrs for all 4096 CSR numbers and is checked by the test corpus.
const CSR_NAMES: Record<number, string> = {
  0x001: "fflags", 0x002: "frm", 0x003: "fcsr", 0x008: "vstart", 0x009: "vxsat", 0x00a: "vxrm",
  0x00f: "vcsr", 0x015: "seed", 0x100: "sstatus", 0x104: "sie", 0x105: "stvec", 0x106: "scounteren",
  0x10a: "senvcfg", 0x10c: "sstateen0", 0x10d: "sstateen1", 0x10e: "sstateen2", 0x10f: "sstateen3",
  0x114: "sieh", 0x140: "sscratch", 0x141: "sepc", 0x142: "scause", 0x143: "stval", 0x144: "sip",
  0x14d: "stimecmp", 0x150: "siselect", 0x151: "sireg", 0x152: "sireg2", 0x153: "sireg3",
  0x154: "siph", 0x155: "sireg4", 0x156: "sireg5", 0x157: "sireg6", 0x15c: "stopei",
  0x15d: "stimecmph", 0x180: "satp", 0x200: "vsstatus", 0x204: "vsie", 0x205: "vstvec",
  0x214: "vsieh", 0x240: "vsscratch", 0x241: "vsepc", 0x242: "vscause", 0x243: "vstval",
  0x244: "vsip", 0x24d: "vstimecmp", 0x250: "vsiselect", 0x251: "vsireg", 0x252: "vsireg2",
  0x253: "vsireg3", 0x254: "vsiph", 0x255: "vsireg4", 0x256: "vsireg5", 0x257: "vsireg6",
  0x25c: "vstopei", 0x25d: "vstimecmph", 0x280: "vsatp", 0x300: "mstatus", 0x301: "misa",
  0x302: "medeleg", 0x303: "mideleg", 0x304: "mie", 0x305: "mtvec", 0x306: "mcounteren",
  0x308: "mvien", 0x309: "mvip", 0x30a: "menvcfg", 0x30c: "mstateen0", 0x30d: "mstateen1",
  0x30e: "mstateen2", 0x30f: "mstateen3", 0x310: "mstatush", 0x313: "midelegh", 0x314: "mieh",
  0x318: "mvienh", 0x319: "mviph", 0x31a: "menvcfgh", 0x31c: "mstateen0h", 0x31d: "mstateen1h",
  0x31e: "mstateen2h", 0x31f: "mstateen3h", 0x320: "mcountinhibit", 0x321: "mcyclecfg",
  0x322: "minstretcfg", 0x340: "mscratch", 0x341: "mepc", 0x342: "mcause", 0x343: "mtval",
  0x344: "mip", 0x34a: "mtinst", 0x34b: "mtval2", 0x350: "miselect", 0x351: "mireg", 0x352: "mireg2",
  0x353: "mireg3", 0x354: "miph", 0x355: "mireg4", 0x356: "mireg5", 0x357: "mireg6", 0x35c: "mtopei",
  0x5a8: "scontext", 0x600: "hstatus", 0x602: "hedeleg", 0x603: "hideleg", 0x604: "hie",
  0x605: "htimedelta", 0x606: "hcounteren", 0x607: "hgeie", 0x608: "hvien", 0x609: "hvictl",
  0x60a: "henvcfg", 0x60c: "hstateen0", 0x60d: "hstateen1", 0x60e: "hstateen2", 0x60f: "hstateen3",
  0x613: "hidelegh", 0x615: "htimedeltah", 0x618: "hvienh", 0x61a: "henvcfgh", 0x61c: "hstateen0h",
  0x61d: "hstateen1h", 0x61e: "hstateen2h", 0x61f: "hstateen3h", 0x643: "htval", 0x644: "hip",
  0x645: "hvip", 0x646: "hviprio1", 0x647: "hviprio2", 0x64a: "htinst", 0x655: "hviph",
  0x656: "hviprio1h", 0x657: "hviprio2h", 0x680: "hgatp", 0x6a8: "hcontext", 0x721: "mcyclecfgh",
  0x722: "minstretcfgh", 0x747: "mseccfg", 0x757: "mseccfgh", 0x7a0: "tselect", 0x7a1: "tdata1",
  0x7a2: "tdata2", 0x7a3: "tdata3", 0x7a4: "tinfo", 0x7a5: "tcontrol", 0x7a8: "mcontext",
  0x7aa: "mscontext", 0x7b0: "dcsr", 0x7b1: "dpc", 0x7b2: "dscratch0", 0x7b3: "dscratch1",
  0xb00: "mcycle", 0xb02: "minstret", 0xb80: "mcycleh", 0xb82: "minstreth", 0xc00: "cycle",
  0xc01: "time", 0xc02: "instret", 0xc20: "vl", 0xc21: "vtype", 0xc22: "vlenb", 0xc80: "cycleh",
  0xc81: "timeh", 0xc82: "instreth", 0xda0: "scountovf", 0xdb0: "stopi", 0xe12: "hgeip",
  0xeb0: "vstopi", 0xf11: "mvendorid", 0xf12: "marchid", 0xf13: "mimpid", 0xf14: "mhartid",
  0xf15: "mconfigptr", 0xfb0: "mtopi",
};
for (let i = 3; i < 32; i++) {
  CSR_NAMES[0xc00 + i] = "hpmcounter" + i;
  CSR_NAMES[0xc80 + i] = "hpmcounter" + i + "h";
  CSR_NAMES[0xb00 + i] = "mhpmcounter" + i;
  CSR_NAMES[0xb80 + i] = "mhpmcounter" + i + "h";
  CSR_NAMES[0x320 + i] = "mhpmevent" + i;
  CSR_NAMES[0x720 + i] = "mhpmevent" + i + "h";
}
for (let i = 0; i < 16; i++) {CSR_NAMES[0x3a0 + i] = "pmpcfg" + i;}
for (let i = 0; i < 64; i++) {CSR_NAMES[0x3b0 + i] = "pmpaddr" + i;}

export function riscvCsrName(csr: number): string {
  return CSR_NAMES[csr] ?? ("0x" + csr.toString(16));
}

function signExtend(value: number, bits: number): number {
  const shift = 32 - bits;
  return (value << shift) >> shift;
}

function bits(word: number, hi: number, lo: number): number {
  return (word >>> lo) & ((1 << (hi - lo + 1)) - 1);
}

function hex(n: number): string {
  return "0x" + (n >>> 0).toString(16);
}

// objdump prints an empty predecessor/successor set as "unknown".
const BRANCH_NAMES = ["beq", "bne", null, null, "blt", "bge", "bltu", "bgeu"];
const LOAD_NAMES = ["lb", "lh", "lw", null, "lbu", "lhu", null, null];
const STORE_NAMES = ["sb", "sh", "sw", null, null, null, null, null];
const OP_NAMES = ["add", "sll", "slt", "sltu", "xor", "srl", "or", "and"];
const OP_ALT_NAMES = ["sub", null, null, null, null, "sra", null, null];
const MULDIV_NAMES = ["mul", "mulh", "mulhsu", "mulhu", "div", "divu", "rem", "remu"];
const CSR_OPS = ["", "csrrw", "csrrs", "csrrc", "", "csrrwi", "csrrsi", "csrrci"];
const CSR_SHORT_OPS = ["", "csrw", "csrs", "csrc", "", "csrwi", "csrsi", "csrci"];
const COUNTER_READS: Record<number, string> = {
  0xc00: "rdcycle", 0xc01: "rdtime", 0xc02: "rdinstret",
  0xc80: "rdcycleh", 0xc81: "rdtimeh", 0xc82: "rdinstreth",
};
const CA_NAMES = ["sub", "xor", "or", "and"];
const FENCE_SET = ["unknown", "w", "r", "rw", "o", "ow", "or", "orw", "i", "iw", "ir", "irw", "io", "iow", "ior", "iorw"];

class Disassembler {
  private reg: (n: number) => string;
  private aliases: boolean;
  private pc: number | undefined;

  constructor(opts: RiscvDisasmOptions) {
    const abi = opts.abiNames !== false;
    this.reg = abi ? (n) => ABI_NAMES[n] : (n) => "x" + n;
    this.aliases = opts.aliases !== false;
    this.pc = opts.pc;
  }

  private target(offset: number): string {
    if (this.pc !== undefined) {return hex(this.pc + offset);}
    return offset < 0 ? "pc-" + (-offset) : "pc+" + offset;
  }

  private op(mnemonic: string, ...operands: string[]): string {
    return operands.length ? mnemonic + " " + operands.join(",") : mnemonic;
  }

  decode(word: number): string | null {
    word = word >>> 0;
    if ((word & 3) !== 3) {return this.decodeCompressed(word & 0xffff);}
    if ((word & 0x1c) === 0x1c) {return null;} // 48-bit and longer encodings
    return this.decode32(word);
  }

  // #region 32-bit
  private decode32(w: number): string | null {
    const r = this.reg;
    const a = this.aliases;
    const opcode = bits(w, 6, 0);
    const rd = bits(w, 11, 7);
    const funct3 = bits(w, 14, 12);
    const rs1 = bits(w, 19, 15);
    const rs2 = bits(w, 24, 20);
    const funct7 = bits(w, 31, 25);
    const immI = signExtend(bits(w, 31, 20), 12);
    const immS = signExtend((bits(w, 31, 25) << 5) | bits(w, 11, 7), 12);
    const immB = signExtend((bits(w, 31, 31) << 12) | (bits(w, 7, 7) << 11) | (bits(w, 30, 25) << 5) | (bits(w, 11, 8) << 1), 13);
    const immJ = signExtend((bits(w, 31, 31) << 20) | (bits(w, 19, 12) << 12) | (bits(w, 20, 20) << 11) | (bits(w, 30, 21) << 1), 21);
    const immU = bits(w, 31, 12);

    switch (opcode) {
      case 0x37: return this.op("lui", r(rd), hex(immU));
      case 0x17: return this.op("auipc", r(rd), hex(immU));
      case 0x6f: {
        if (a && rd === 0) {return this.op("j", this.target(immJ));}
        if (a && rd === 1) {return this.op("jal", this.target(immJ));}
        return this.op("jal", r(rd), this.target(immJ));
      }
      case 0x67: {
        if (funct3 !== 0) {return null;}
        if (a && rd === 0 && rs1 === 1 && immI === 0) {return "ret";}
        if (a && rd === 0) {return immI === 0 ? this.op("jr", r(rs1)) : this.op("jr", `${immI}(${r(rs1)})`);}
        if (a && rd === 1) {return immI === 0 ? this.op("jalr", r(rs1)) : this.op("jalr", `${immI}(${r(rs1)})`);}
        if (a && immI === 0) {return this.op("jalr", r(rd), r(rs1));}
        return this.op("jalr", r(rd), `${immI}(${r(rs1)})`);
      }
      case 0x63: {
        const name = BRANCH_NAMES[funct3];
        if (!name) {return null;}
        const t = this.target(immB);
        if (a) {
          if (rs2 === 0) {
            if (funct3 === 0) {return this.op("beqz", r(rs1), t);}
            if (funct3 === 1) {return this.op("bnez", r(rs1), t);}
            if (funct3 === 4) {return this.op("bltz", r(rs1), t);}
            if (funct3 === 5) {return this.op("bgez", r(rs1), t);}
          }
          if (rs1 === 0) {
            if (funct3 === 4) {return this.op("bgtz", r(rs2), t);}
            if (funct3 === 5) {return this.op("blez", r(rs2), t);}
          }
        }
        return this.op(name, r(rs1), r(rs2), t);
      }
      case 0x03: {
        const name = LOAD_NAMES[funct3];
        if (!name) {return null;}
        return this.op(name, r(rd), `${immI}(${r(rs1)})`);
      }
      case 0x23: {
        const name = STORE_NAMES[funct3];
        if (!name) {return null;}
        return this.op(name, r(rs2), `${immS}(${r(rs1)})`);
      }
      case 0x13: {
        switch (funct3) {
          case 0:
            if (a) {
              if (rd === 0 && rs1 === 0 && immI === 0) {return "nop";}
              if (rs1 === 0) {return this.op("li", r(rd), String(immI));}
              if (immI === 0) {return this.op("mv", r(rd), r(rs1));}
            }
            return this.op("addi", r(rd), r(rs1), String(immI));
          case 2: return this.op("slti", r(rd), r(rs1), String(immI));
          case 3:
            if (a && immI === 1) {return this.op("seqz", r(rd), r(rs1));}
            return this.op("sltiu", r(rd), r(rs1), String(immI));
          case 4:
            if (a && immI === -1) {return this.op("not", r(rd), r(rs1));}
            return this.op("xori", r(rd), r(rs1), String(immI));
          case 6: return this.op("ori", r(rd), r(rs1), String(immI));
          case 7:
            if (a && immI === 255) {return this.op("zext.b", r(rd), r(rs1));}
            return this.op("andi", r(rd), r(rs1), String(immI));
          case 1:
            if (funct7 !== 0) {return null;}
            return this.op("slli", r(rd), r(rs1), hex(rs2));
          case 5:
            if (funct7 === 0x00) {return this.op("srli", r(rd), r(rs1), hex(rs2));}
            if (funct7 === 0x20) {return this.op("srai", r(rd), r(rs1), hex(rs2));}
            return null;
        }
        return null;
      }
      case 0x33: {
        let name: string | null = null;
        if (funct7 === 0x00) {
          name = OP_NAMES[funct3];
        } else if (funct7 === 0x20) {
          name = OP_ALT_NAMES[funct3];
        } else if (funct7 === 0x01) {
          name = MULDIV_NAMES[funct3];
        }
        if (!name) {return null;}
        if (a) {
          if (name === "sub" && rs1 === 0) {return this.op("neg", r(rd), r(rs2));}
          if (name === "sltu" && rs1 === 0) {return this.op("snez", r(rd), r(rs2));}
          if (name === "slt" && rs2 === 0) {return this.op("sltz", r(rd), r(rs1));}
          if (name === "slt" && rs1 === 0) {return this.op("sgtz", r(rd), r(rs2));}
        }
        return this.op(name, r(rd), r(rs1), r(rs2));
      }
      case 0x0f: {
        if (funct3 === 1) {return w === 0x0000100f ? "fence.i" : null;}
        if (funct3 !== 0 || rd !== 0 || rs1 !== 0) {return null;}
        const fm = bits(w, 31, 28);
        const pred = bits(w, 27, 24);
        const succ = bits(w, 23, 20);
        if (fm === 0x8 && pred === 0x3 && succ === 0x3) {return "fence.tso";}
        if (fm !== 0) {return null;}
        if (a && pred === 0xf && succ === 0xf) {return "fence";}
        return this.op("fence", FENCE_SET[pred], FENCE_SET[succ]);
      }
      case 0x73: return this.decodeSystem(w, rd, funct3, rs1, rs2, funct7);
    }
    return null;
  }

  private decodeSystem(w: number, rd: number, funct3: number, rs1: number, rs2: number, funct7: number): string | null {
    const r = this.reg;
    const a = this.aliases;
    if (funct3 === 0) {
      switch (w) {
        case 0x00000073: return "ecall";
        case 0x00100073: return "ebreak";
        case 0x10200073: return "sret";
        case 0x30200073: return "mret";
        case 0x7b200073: return "dret";
        case 0x10500073: return "wfi";
      }
      if (funct7 === 0x09 && rd === 0) {
        if (rs2 !== 0 || !a) {return this.op("sfence.vma", r(rs1), r(rs2));}
        return rs1 !== 0 ? this.op("sfence.vma", r(rs1)) : "sfence.vma";
      }
      return null;
    }
    if (funct3 === 4) {return null;}
    const csrNum = bits(w, 31, 20);
    const csr = riscvCsrName(csrNum);
    const imm = funct3 >= 5;
    const src = imm ? String(rs1) : r(rs1);
    const base = CSR_OPS[funct3];
    if (w === 0xc0001073) {return "unimp";}
    if (a) {
      if (funct3 === 2 && rs1 === 0) {
        if (COUNTER_READS[csrNum]) {return this.op(COUNTER_READS[csrNum], r(rd));}
        return this.op("csrr", r(rd), csr);
      }
      if (rd === 0) {
        return this.op(CSR_SHORT_OPS[funct3], csr, src);
      }
    }
    return this.op(base, r(rd), csr, src);
  }

  // #region Compressed
  private decodeCompressed(h: number): string | null {
    const r = this.reg;
    const a = this.aliases;
    const quadrant = h & 3;
    const funct3 = bits(h, 15, 13);
    const rdP = bits(h, 4, 2) + 8;   // rd' / rs2'
    const rs1P = bits(h, 9, 7) + 8;  // rs1' / rd'
    const rd = bits(h, 11, 7);
    const rs2 = bits(h, 6, 2);
    const c = (name: string, ...ops: string[]) => this.op(name, ...ops);

    if (h === 0) {return a ? "unimp" : "c.unimp";}

    if (quadrant === 0) {
      switch (funct3) {
        case 0: {
          const nzuimm = (bits(h, 10, 7) << 6) | (bits(h, 12, 11) << 4) | (bits(h, 5, 5) << 3) | (bits(h, 6, 6) << 2);
          if (nzuimm === 0) {return null;}
          return c(a ? "addi" : "c.addi4spn", r(rdP), r(2), String(nzuimm));
        }
        case 2: {
          const off = (bits(h, 5, 5) << 6) | (bits(h, 12, 10) << 3) | (bits(h, 6, 6) << 2);
          return c(a ? "lw" : "c.lw", r(rdP), `${off}(${r(rs1P)})`);
        }
        case 6: {
          const off = (bits(h, 5, 5) << 6) | (bits(h, 12, 10) << 3) | (bits(h, 6, 6) << 2);
          return c(a ? "sw" : "c.sw", r(rdP), `${off}(${r(rs1P)})`);
        }
      }
      return null;
    }

    if (quadrant === 1) {
      const imm6 = signExtend((bits(h, 12, 12) << 5) | bits(h, 6, 2), 6);
      const jOff = signExtend((bits(h, 12, 12) << 11) | (bits(h, 8, 8) << 10) | (bits(h, 10, 9) << 8) | (bits(h, 6, 6) << 7) |
                              (bits(h, 7, 7) << 6) | (bits(h, 2, 2) << 5) | (bits(h, 11, 11) << 4) | (bits(h, 5, 3) << 1), 12);
      switch (funct3) {
        case 0:
          // rd=0 or imm=0 encodings are HINTs; print them the way objdump does.
          if (rd === 0) {
            if (imm6 === 0) {return a ? "nop" : c("c.addi", r(0), "0");}
            return a ? c("c.nop", String(imm6)) : c("c.addi", r(0), String(imm6));
          }
          return a ? c("addi", r(rd), r(rd), String(imm6)) : c("c.addi", r(rd), String(imm6));
        case 1: return a ? c("jal", this.target(jOff)) : c("c.jal", this.target(jOff));
        case 2: return c(a && rd !== 0 ? "li" : "c.li", r(rd), String(imm6));
        case 3: {
          if (rd === 2) {
            const imm = signExtend((bits(h, 12, 12) << 9) | (bits(h, 4, 3) << 7) | (bits(h, 5, 5) << 6) | (bits(h, 2, 2) << 5) | (bits(h, 6, 6) << 4), 10);
            // imm=0 is reserved; objdump still prints it, so do the same.
            return a ? c("addi", r(2), r(2), String(imm)) : c("c.addi16sp", r(2), String(imm));
          }
          if (imm6 === 0) {return null;}
          return c(a && rd !== 0 ? "lui" : "c.lui", r(rd), hex(imm6 & 0xfffff));
        }
        case 4: {
          const sub = bits(h, 11, 10);
          const shamt = (bits(h, 12, 12) << 5) | bits(h, 6, 2);
          if (sub === 0 || sub === 1) {
            if (bits(h, 12, 12)) {return null;} // RV32: shamt[5] must be 0
            const name = sub === 0 ? "srli" : "srai";
            if (shamt === 0) {return c("c." + name + "64", r(rs1P));}
            return a ? c(name, r(rs1P), r(rs1P), hex(shamt)) : c("c." + name, r(rs1P), hex(shamt));
          }
          if (sub === 2) {
            return a ? c("andi", r(rs1P), r(rs1P), String(imm6)) : c("c.andi", r(rs1P), String(imm6));
          }
          if (bits(h, 12, 12)) {return null;} // c.subw / c.addw are RV64
          const name = CA_NAMES[bits(h, 6, 5)];
          return a ? c(name, r(rs1P), r(rs1P), r(rdP)) : c("c." + name, r(rs1P), r(rdP));
        }
        case 5: return a ? c("j", this.target(jOff)) : c("c.j", this.target(jOff));
        case 6:
        case 7: {
          const bOff = signExtend((bits(h, 12, 12) << 8) | (bits(h, 6, 5) << 6) | (bits(h, 2, 2) << 5) | (bits(h, 11, 10) << 3) | (bits(h, 4, 3) << 1), 9);
          const name = funct3 === 6 ? "beqz" : "bnez";
          return c(a ? name : "c." + name, r(rs1P), this.target(bOff));
        }
      }
      return null;
    }

    // quadrant 2
    switch (funct3) {
      case 0: {
        const shamt = (bits(h, 12, 12) << 5) | bits(h, 6, 2);
        if (bits(h, 12, 12)) {return null;}
        if (shamt === 0) {return c("c.slli64", r(rd));}
        // rd=0 is a HINT, printed by objdump in the c. form.
        return a && rd !== 0 ? c("slli", r(rd), r(rd), hex(shamt)) : c("c.slli", r(rd), hex(shamt));
      }
      case 2: {
        if (rd === 0) {return null;}
        const off = (bits(h, 3, 2) << 6) | (bits(h, 12, 12) << 5) | (bits(h, 6, 4) << 2);
        return c(a ? "lw" : "c.lwsp", r(rd), `${off}(${r(2)})`);
      }
      case 4: {
        const bit12 = bits(h, 12, 12);
        if (bit12 === 0) {
          if (rs2 === 0) {
            if (rd === 0) {return null;}
            if (!a) {return c("c.jr", r(rd));}
            return rd === 1 ? "ret" : c("jr", r(rd));
          }
          return a && rd !== 0 ? c("mv", r(rd), r(rs2)) : c("c.mv", r(rd), r(rs2));
        }
        if (rs2 === 0) {
          if (rd === 0) {return a ? "ebreak" : "c.ebreak";}
          return c(a ? "jalr" : "c.jalr", r(rd));
        }
        return a && rd !== 0 ? c("add", r(rd), r(rd), r(rs2)) : c("c.add", r(rd), r(rs2));
      }
      case 6: {
        const off = (bits(h, 8, 7) << 6) | (bits(h, 12, 9) << 2);
        return c(a ? "sw" : "c.swsp", r(rs2), `${off}(${r(2)})`);
      }
    }
    return null;
  }
}

// Returns the assembly text, or null if the encoding is not recognized.
// One disassembler per option set; only a pc makes a fresh one.
const cachedDisassemblers = new Map<string, Disassembler>();

export function disassembleRiscv(word: number, opts: RiscvDisasmOptions = {}): string | null {
  if (opts.pc !== undefined) {return new Disassembler(opts).decode(word);}
  const key = (opts.abiNames !== false ? "a" : "n") + (opts.aliases !== false ? "p" : "r");
  let d = cachedDisassemblers.get(key);
  if (d === undefined) {
    d = new Disassembler(opts);
    cachedDisassemblers.set(key, d);
  }
  return d.decode(word);
}

// Formats a binary value string the way the RISC-V value format displays it:
// assembly for known encodings, hex for unknown ones, "x" for x/z values.
export function formatRiscvBinaryString(binaryString: string, is2State: boolean, opts: RiscvDisasmOptions = {}): string {
  if (!is2State) {return "x";}
  const low = binaryString.length > 32 ? binaryString.slice(-32) : binaryString;
  const word = parseInt(low, 2) >>> 0;
  // A 16-bit signal only carries one compressed parcel.
  if (low.length <= 16 && (word & 3) === 3) {return "0x" + word.toString(16).padStart(4, "0");}
  const text = disassembleRiscv(word, opts);
  if (text !== null) {return text;}
  const digits = (word & 3) !== 3 ? 4 : 8;
  return "0x" + ((word & 3) !== 3 ? word & 0xffff : word).toString(16).padStart(digits, "0");
}
