#!/bin/sh
# Run on a host with a RISC-V GNU toolchain (binutils 2.43.1, from riscv64-unknown-elf-gcc 14.2.0);
# RISCV_BIN is its bin folder. Writes expected-<variant>.txt: "<addr> <text>" per line.
set -e
T=${RISCV_BIN:?set RISCV_BIN to the bin folder of a RISC-V GNU toolchain}
$T/riscv64-unknown-elf-as -march=rv32imc_zicsr_zifencei -mabi=ilp32 corpus.s -o corpus.o
for v in default numeric no-aliases numeric,no-aliases; do
  if [ $v = default ]; then M=""; else M="-M $v"; fi
  $T/riscv64-unknown-elf-objdump -d --no-show-raw-insn $M corpus.o \
    | awk -F'\t' '/^ *[0-9a-f]+:\t/ { a=$1; sub(/^ */,"",a); sub(/:$/,"",a); t=$2; for(i=3;i<=NF;i++) t=t " " $i; print a " " t }' \
    | gzip -9 > expected-$(echo $v | tr ',' '_').txt.gz
done
$T/riscv64-unknown-elf-objdump --version | head -1 > objdump-version.txt
