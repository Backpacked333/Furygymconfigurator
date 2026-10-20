"""Inherited, fail-closed seccomp policy; local Unix IPC remains available to CUDA."""

import ctypes
import errno


def block_internet():
    library = ctypes.CDLL("libseccomp.so.2", use_errno=True)
    library.seccomp_init.argtypes = [ctypes.c_uint32]
    library.seccomp_init.restype = ctypes.c_void_p
    library.seccomp_release.argtypes = [ctypes.c_void_p]
    library.seccomp_load.argtypes = [ctypes.c_void_p]
    library.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]

    class Compare(ctypes.Structure):
        _fields_ = [("arg", ctypes.c_uint), ("op", ctypes.c_int),
                    ("datum_a", ctypes.c_uint64), ("datum_b", ctypes.c_uint64)]

    library.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32,
                                               ctypes.c_int, ctypes.c_uint, ctypes.POINTER(Compare)]
    context = library.seccomp_init(0x7FFF0000)
    if not context:
        raise RuntimeError("network-policy-init")
    try:
        deny = 0x00050000 | errno.EPERM
        for family in (2, 10):
            comparison = Compare(0, 4, family, 0)
            syscall = library.seccomp_syscall_resolve_name(b"socket")
            if syscall < 0 or library.seccomp_rule_add_array(context, deny, syscall, 1, ctypes.byref(comparison)) != 0:
                raise RuntimeError("network-policy-rule")
        for name in (b"socketcall", b"io_uring_setup", b"io_uring_enter", b"io_uring_register"):
            syscall = library.seccomp_syscall_resolve_name(name)
            if syscall >= 0 and library.seccomp_rule_add_array(context, deny, syscall, 0, None) != 0:
                raise RuntimeError("network-policy-rule")
        if library.seccomp_load(context) != 0:
            raise RuntimeError("network-policy-load")
    finally:
        library.seccomp_release(context)
