"""Shared test environment setup."""

import sys
import types


try:
    import decord  # noqa: F401
except ImportError:
    decord_stub = types.ModuleType("decord")
    decord_stub.VideoReader = object
    decord_stub.cpu = lambda *_args, **_kwargs: None
    sys.modules["decord"] = decord_stub
