# SPDX-License-Identifier: MIT
# wisp-helper: `make` builds build/helper/wisp-helper (helper/build.sh; GCC 11+ or clang with C++17 to_chars, zlib);
# `make check` runs the helper's checks on the bundled WCZ vector. Checks that need FSDB inputs (none ship here):
#   bash helper/tests/direct-inputs.sh build/helper/wisp-helper <good.fsdb> [refused.fsdb...]
B ?= build
all: $(B)/helper/wisp-helper
$(B)/helper/wisp-helper: $(wildcard helper/src/* helper/lib/*/* include/*.h convert/fsdb/*/*) helper/build.sh
	sh helper/build.sh $(B)/helper
check: $(B)/helper/wisp-helper
	bash helper/tests/check.sh $(B)/helper/wisp-helper on vectors/accept/a01-min.wcz
.PHONY: all check
