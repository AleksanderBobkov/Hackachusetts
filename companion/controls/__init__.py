"""Physical controls → commands. Keyboard keys stand in for the hardware buttons in dev;
a USB HID device that emits the same keys maps to the same commands."""

from companion.controls.keys import KeyMapper

__all__ = ["KeyMapper"]
