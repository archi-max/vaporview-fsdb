# SPDX-License-Identifier: MIT
# helper/: the Wisp waveform helper (wisp-helper). Included by the top Makefile; built by helper/build.sh from its own
# sources (src/, lib/), the repository's include/ and the FSDB reader + planner in convert/fsdb/, linking the system libz (zstd's decoder is built in from lib/third_party/zstd). Linux and macOS (the
# helper uses POSIX file and memory interfaces, with Linux and macOS branches): there `all` builds it, so `make check` links it too; `make helper` builds
# only it.
HELPER_DIR := helper
HELPER_SRC := $(wildcard $(HELPER_DIR)/src/*.cpp $(HELPER_DIR)/src/*.h \
  $(HELPER_DIR)/lib/addon/* $(HELPER_DIR)/lib/shim/*.h $(HELPER_DIR)/lib/src/*.h \
  include/*.h $(HELPER_DIR)/lib/third_party/zstd/*.c \
  convert/fsdb/src/*.h convert/fsdb/fplan/*.h convert/fsdb/fplan/fplan.cpp \
  convert/fsdb/side/*.h convert/fsdb/side/proven-words.txt convert/fsdb/side/window-safe-words.txt)
ifneq ($(filter Linux Darwin,$(shell uname -s)),)
all: $(B)/helper/wisp-helper
CHECK_EXTRA += check-helper check-helper-inputs
endif
helper: $(B)/helper/wisp-helper
$(B)/helper/wisp-helper: $(HELPER_SRC) $(HELPER_DIR)/build.sh
	sh $(HELPER_DIR)/build.sh $(B)/helper
.PHONY: helper
# the helper's own checks (bash + the built helper). HELPER_MODE follows build.sh: direct FSDB read is on when the
# converter's reader and planner are in convert/fsdb/.
HELPER_MODE := $(if $(and $(wildcard convert/fsdb/src/sigread.h),$(wildcard convert/fsdb/fplan/fplan.cpp)),on,off)
check-helper: $(B)/helper/wisp-helper $(B)/wcz-from-vcd
	bash $(HELPER_DIR)/tests/check.sh $(B)/helper/wisp-helper $(HELPER_MODE) vectors/accept/a01-min.wcz $(B)/wcz-from-vcd
# Checks with FSDB inputs (thread default under taskset, no values from a refused file). They need FSDB files; none ship with
# the tree, so this target says SKIP unless they are given:
#   make check-helper-inputs HELPER_TEST_GOOD=<good.fsdb> HELPER_TEST_REFUSED="<refused.fsdb>..."
check-helper-inputs: $(B)/helper/wisp-helper
	@if [ -z "$(HELPER_TEST_GOOD)" ] || [ "$(HELPER_MODE)" != on ]; then \
	  echo "SKIP check-helper-inputs: tests/direct-inputs.sh needs FSDB inputs (HELPER_TEST_GOOD, HELPER_TEST_REFUSED; none ship with the tree) and direct FSDB read on (now $(HELPER_MODE))"; \
	else bash $(HELPER_DIR)/tests/direct-inputs.sh $(B)/helper/wisp-helper $(HELPER_TEST_GOOD) $(HELPER_TEST_REFUSED); fi
.PHONY: check-helper check-helper-inputs
