"""Fix Seeed_Arduino_SSCMA invoke() AT+INVOKE argument mapping.

Upstream builds AT+INVOKE=<N>,<!filter>,<filter>, which turns filter=false into
DIFFERED=1. Stable no-face frames then suppress events and the JPEG stream stalls.

Correct mapping (per SenseCraft docs):
  AT+INVOKE=<N_TIMES>,<DIFFERED>,<RESULT_ONLY>
  DIFFERED    = filter
  RESULT_ONLY = !show
"""

Import("env")  # type: ignore  # noqa: F821 — PlatformIO

from pathlib import Path

BROKEN = (
    "snprintf(cmd, sizeof(cmd), CMD_PREFIX \"%s=%d,%d,%d\" CMD_SUFFIX,\n"
    "             CMD_AT_INVOKE, times, !filter, filter); // AT+INVOKE=1,0,1\\r\\n"
)
FIXED = (
    "snprintf(cmd, sizeof(cmd), CMD_PREFIX \"%s=%d,%d,%d\" CMD_SUFFIX,\n"
    "             CMD_AT_INVOKE, times, filter ? 1 : 0, show ? 0 : 1);"
    " // AT+INVOKE=N,DIFFERED,RESULT_ONLY"
)

libdeps = Path(env["PROJECT_LIBDEPS_DIR"]) / env["PIOENV"]  # type: ignore  # noqa: F821
matches = list(libdeps.glob("**/Seeed_Arduino_SSCMA/src/Seeed_Arduino_SSCMA.cpp"))
if not matches:
    print("patch_sscma_invoke: library not found yet (ok on first resolve)")
else:
    path = matches[0]
    text = path.read_text()
    if FIXED in text:
        print(f"patch_sscma_invoke: already patched {path}")
    elif BROKEN in text:
        path.write_text(text.replace(BROKEN, FIXED, 1))
        print(f"patch_sscma_invoke: patched {path}")
    else:
        print(f"patch_sscma_invoke: unexpected invoke() body in {path}")
