import ctypes
import json
import sys
import time
from ctypes import wintypes


sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")


user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)


EnumWindowsProc = ctypes.WINFUNCTYPE(
    wintypes.BOOL,
    wintypes.HWND,
    wintypes.LPARAM,
)


ULONG_PTR = (
    ctypes.c_ulonglong
    if ctypes.sizeof(ctypes.c_void_p) == 8
    else ctypes.c_ulong
)


# ============================================================
# Win32 constants
# ============================================================

SW_RESTORE = 9

INPUT_KEYBOARD = 1

KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

VK_MENU = 0x12


# ============================================================
# Timing
# ============================================================

# Normal delay between Unicode character dispatches.
UNICODE_INPUT_SETTLE_SECONDS = 0.015

# Initial pause after foreground activation.
FOREGROUND_CONFIRM_SECONDS = 0.12

# Give modern applications such as Windows 11 Notepad time
# for their internal editor/control to initialize.
TYPE_TARGET_SETTLE_SECONDS = 0.35

# Extra guard immediately before the first Unicode character.
#
# Cold-started WinUI editors can report as foreground before
# their internal text control is actually ready to consume the
# first injected keystrokes. This delay is paid once per typing
# action, not once per character.
FIRST_CHARACTER_GUARD_SECONDS = 0.18

# Shortcuts require less settling than literal typing.
SHORTCUT_TARGET_SETTLE_SECONDS = 0.15


# ============================================================
# Keyboard maps
# ============================================================

VK_CODES = {
    "ctrl": 0x11,
    "shift": 0x10,

    "a": 0x41,
    "c": 0x43,
    "v": 0x56,
    "x": 0x58,
    "z": 0x5A,
    "y": 0x59,
    "s": 0x53,
    "f": 0x46,
    "n": 0x4E,
    "o": 0x4F,

    "tab": 0x09,
    "enter": 0x0D,
    "escape": 0x1B,

    "up": 0x26,
    "down": 0x28,
    "left": 0x25,
    "right": 0x27,
}


SHORTCUT_KEYS = {
    "ctrl+a": ["ctrl", "a"],
    "ctrl+c": ["ctrl", "c"],
    "ctrl+v": ["ctrl", "v"],
    "ctrl+x": ["ctrl", "x"],
    "ctrl+z": ["ctrl", "z"],
    "ctrl+y": ["ctrl", "y"],
    "ctrl+s": ["ctrl", "s"],
    "ctrl+f": ["ctrl", "f"],
    "ctrl+n": ["ctrl", "n"],
    "ctrl+o": ["ctrl", "o"],

    "tab": ["tab"],
    "shift+tab": ["shift", "tab"],

    "enter": ["enter"],
    "escape": ["escape"],

    "up": ["up"],
    "down": ["down"],
    "left": ["left"],
    "right": ["right"],
}


MODIFIER_KEYS = {
    "ctrl",
    "shift",
}


# ============================================================
# UTF-16 helpers
# ============================================================

def utf16_code_units(text):
    encoded = text.encode(
        "utf-16-le",
        "surrogatepass",
    )

    return [
        encoded[index]
        | (encoded[index + 1] << 8)
        for index in range(0, len(encoded), 2)
    ]


# ============================================================
# Win32 structures
# ============================================================

class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class INPUT_UNION(ctypes.Union):
    _fields_ = [
        ("mi", MOUSEINPUT),
        ("ki", KEYBDINPUT),
        ("hi", HARDWAREINPUT),
    ]


class INPUT(ctypes.Structure):
    _fields_ = [
        ("type", wintypes.DWORD),
        ("union", INPUT_UNION),
    ]


class InputDispatchError(Exception):
    pass


# ============================================================
# Result helpers
# ============================================================

def fail(reason, code=1, **extra):
    print(
        json.dumps(
            {
                "ok": False,
                "reason": reason,
                **extra,
            }
        )
    )

    sys.exit(code)


def ok(**extra):
    print(
        json.dumps(
            {
                "ok": True,
                **extra,
            }
        )
    )

    sys.exit(0)


# ============================================================
# Window helpers
# ============================================================

def get_window_text(hwnd):
    if not hwnd:
        return ""

    length = user32.GetWindowTextLengthW(hwnd)

    if length <= 0:
        return ""

    buffer = ctypes.create_unicode_buffer(length + 1)

    user32.GetWindowTextW(
        hwnd,
        buffer,
        length + 1,
    )

    return buffer.value


def get_window_pid(hwnd):
    if not hwnd:
        return 0

    pid = wintypes.DWORD()

    user32.GetWindowThreadProcessId(
        hwnd,
        ctypes.byref(pid),
    )

    return int(pid.value)


def enum_candidate_windows(
    process_id=None,
    title=None,
):
    candidates = []

    title_needle = str(title or "").lower()

    def callback(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True

        text = get_window_text(hwnd)

        if not text:
            return True

        pid = get_window_pid(hwnd)

        process_match = (
            process_id is not None
            and pid == process_id
        )

        title_match = (
            bool(title_needle)
            and title_needle in text.lower()
        )

        if process_match or title_match:
            candidates.append(
                {
                    "hwnd": int(hwnd),
                    "pid": pid,
                    "title": text,
                    "processMatch": process_match,
                    "titleMatch": title_match,
                }
            )

        return True

    user32.EnumWindows(
        EnumWindowsProc(callback),
        0,
    )

    return candidates


def find_window(
    process_id=None,
    title=None,
    timeout_ms=2200,
):
    deadline = time.time() + timeout_ms / 1000

    while time.time() <= deadline:
        candidates = enum_candidate_windows(
            process_id,
            title,
        )

        if candidates:
            candidates.sort(
                key=lambda item: (
                    not item["titleMatch"],
                    not item["processMatch"],
                    item["hwnd"],
                )
            )

            return candidates[0]

        time.sleep(0.05)

    return None


def foreground_matches_target(
    process_id=None,
    title=None,
):
    foreground = user32.GetForegroundWindow()

    if not foreground:
        return {
            "ok": False,
            "foregroundTitle": "",
            "foregroundProcessId": 0,
            "titleMatch": False,
            "processMatch": False,
        }

    foreground_title = get_window_text(
        foreground
    )

    foreground_pid = get_window_pid(
        foreground
    )

    title_needle = str(
        title or ""
    ).lower()

    title_match = (
        bool(title_needle)
        and title_needle
        in foreground_title.lower()
    )

    process_match = (
        process_id is not None
        and foreground_pid
        == int(process_id)
    )

    return {
        "ok": bool(
            title_match
            or process_match
        ),
        "foregroundTitle":
            foreground_title,
        "foregroundProcessId":
            foreground_pid,
        "titleMatch":
            title_match,
        "processMatch":
            process_match,
    }


# ============================================================
# Input construction
# ============================================================

def key_input(
    vk=0,
    scan=0,
    flags=0,
):
    item = INPUT()

    item.type = INPUT_KEYBOARD

    item.union.ki = KEYBDINPUT(
        vk,
        scan,
        flags,
        0,
        0,
    )

    return item


def build_input_array(events):
    count = len(events)

    array_type = INPUT * count
    array = array_type()

    for index, event in enumerate(events):
        array[index] = key_input(
            vk=event.get("vk", 0),
            scan=event.get("scan", 0),
            flags=event.get("flags", 0),
        )

    return array


def send_input(events):
    inputs = build_input_array(events)

    count = len(inputs)

    sent = user32.SendInput(
        count,
        inputs,
        ctypes.sizeof(INPUT),
    )

    if sent != count:
        raise InputDispatchError(
            f"SendInput sent {sent} of {count} events. "
            f"Last error: {ctypes.get_last_error()}."
        )


# ============================================================
# Foreground activation
# ============================================================

def build_foreground_unlock_events():
    return [
        {
            "vk": VK_MENU,
            "scan": 0,
            "flags": 0,
        },
        {
            "vk": VK_MENU,
            "scan": 0,
            "flags": KEYEVENTF_KEYUP,
        },
    ]


def activate_window(
    process_id=None,
    title=None,
):
    window = find_window(
        process_id,
        title,
    )

    if not window:
        return {
            "ok": False,
            "reason":
                "Expected foreground window was not found.",
        }

    hwnd = wintypes.HWND(
        window["hwnd"]
    )

    foreground_before = (
        user32.GetForegroundWindow()
    )

    current_thread = (
        kernel32.GetCurrentThreadId()
    )

    target_thread = (
        user32.GetWindowThreadProcessId(
            hwnd,
            None,
        )
    )

    foreground_thread = (
        user32.GetWindowThreadProcessId(
            foreground_before,
            None,
        )
        if foreground_before
        else 0
    )

    user32.ShowWindow(
        hwnd,
        SW_RESTORE,
    )

    user32.BringWindowToTop(
        hwnd
    )

    if foreground_thread:
        user32.AttachThreadInput(
            current_thread,
            foreground_thread,
            True,
        )

    if target_thread:
        user32.AttachThreadInput(
            current_thread,
            target_thread,
            True,
        )

    try:
        send_input(
            build_foreground_unlock_events()
        )

        user32.SetForegroundWindow(
            hwnd
        )

        user32.SetActiveWindow(
            hwnd
        )

        user32.SetFocus(
            hwnd
        )

    finally:
        if target_thread:
            user32.AttachThreadInput(
                current_thread,
                target_thread,
                False,
            )

        if foreground_thread:
            user32.AttachThreadInput(
                current_thread,
                foreground_thread,
                False,
            )

    time.sleep(
        FOREGROUND_CONFIRM_SECONDS
    )

    match = foreground_matches_target(
        process_id=process_id,
        title=title,
    )

    if not match["ok"]:
        return {
            "ok": False,
            "reason":
                "The intended application is no longer in the foreground.",
            "foregroundTitle":
                match["foregroundTitle"],
            "foregroundProcessId":
                match["foregroundProcessId"],
            "targetTitle":
                window["title"],
            "targetProcessId":
                window["pid"],
        }

    return {
        "ok": True,
        "windowTitle":
            window["title"],
        "processId":
            window["pid"],
        "hwnd":
            window["hwnd"],
    }


# ============================================================
# Unicode typing
# ============================================================

def build_unicode_key_events(text):
    events = []

    for code in utf16_code_units(
        text
    ):
        events.append(
            {
                "vk": 0,
                "scan": code,
                "flags":
                    KEYEVENTF_UNICODE,
            }
        )

        events.append(
            {
                "vk": 0,
                "scan": code,
                "flags":
                    KEYEVENTF_UNICODE
                    | KEYEVENTF_KEYUP,
            }
        )

    return events


def type_text(text):
    events = build_unicode_key_events(
        text
    )

    if not events:
        return

    # Cold-start guard:
    #
    # Wait once immediately before the first Unicode key pair.
    # This gives modern WinUI editors a final opportunity to
    # finish binding their text control after the top-level
    # window has already become foreground.
    time.sleep(
        FIRST_CHARACTER_GUARD_SECONDS
    )

    for index in range(
        0,
        len(events),
        2,
    ):
        send_input(
            events[
                index:
                index + 2
            ]
        )

        time.sleep(
            UNICODE_INPUT_SETTLE_SECONDS
        )


# ============================================================
# Shortcut helpers
# ============================================================

def build_key_down_event(key):
    return {
        "vk": VK_CODES[key],
        "scan": 0,
        "flags": 0,
    }


def build_key_up_event(key):
    return {
        "vk": VK_CODES[key],
        "scan": 0,
        "flags": KEYEVENTF_KEYUP,
    }


def build_shortcut_key_events(
    shortcut
):
    keys = SHORTCUT_KEYS.get(
        shortcut
    )

    if not keys:
        return None

    modifiers = [
        key
        for key in keys[:-1]
        if key in MODIFIER_KEYS
    ]

    primary = keys[-1]

    events = []

    for key in modifiers:
        events.append(
            build_key_down_event(
                key
            )
        )

    events.append(
        build_key_down_event(
            primary
        )
    )

    events.append(
        build_key_up_event(
            primary
        )
    )

    for key in reversed(
        modifiers
    ):
        events.append(
            build_key_up_event(
                key
            )
        )

    return events


def build_shortcut_dispatch_batches(
    shortcut
):
    keys = SHORTCUT_KEYS.get(
        shortcut
    )

    if not keys:
        return None

    modifiers = [
        key
        for key in keys[:-1]
        if key in MODIFIER_KEYS
    ]

    primary = keys[-1]

    batches = []

    for key in modifiers:
        batches.append(
            [
                build_key_down_event(
                    key
                )
            ]
        )

    batches.append(
        [
            build_key_down_event(
                primary
            ),
            build_key_up_event(
                primary
            ),
        ]
    )

    for key in reversed(
        modifiers
    ):
        batches.append(
            [
                build_key_up_event(
                    key
                )
            ]
        )

    return batches


def send_shortcut(shortcut):
    batches = (
        build_shortcut_dispatch_batches(
            shortcut
        )
    )

    if batches is None:
        fail(
            "Unsupported keyboard shortcut.",
            64,
        )

    pressed_modifiers = []

    try:
        for batch in batches:
            send_input(batch)

            if len(batch) == 1:
                modifier = next(
                    (
                        key
                        for key, vk
                        in VK_CODES.items()
                        if (
                            vk == batch[0]["vk"]
                            and key
                            in MODIFIER_KEYS
                        )
                    ),
                    None,
                )

                if (
                    modifier
                    and batch[0]["flags"] == 0
                ):
                    pressed_modifiers.append(
                        modifier
                    )

                if (
                    modifier
                    and batch[0]["flags"]
                    == KEYEVENTF_KEYUP
                    and modifier
                    in pressed_modifiers
                ):
                    pressed_modifiers.remove(
                        modifier
                    )

    finally:
        for key in reversed(
            pressed_modifiers
        ):
            try:
                send_input(
                    [
                        build_key_up_event(
                            key
                        )
                    ]
                )

            except InputDispatchError:
                pass


# ============================================================
# Diagnostics
# ============================================================

def pair_batches(events):
    return [
        events[
            index:
            index + 2
        ]
        for index in range(
            0,
            len(events),
            2,
        )
    ]


def simulate_shortcut_dispatch(
    shortcut,
    fail_after_batches=0,
):
    keys = SHORTCUT_KEYS.get(
        shortcut
    )

    if not keys:
        return None

    modifiers = [
        key
        for key in keys[:-1]
        if key in MODIFIER_KEYS
    ]

    primary = keys[-1]

    sent = []
    pressed_modifiers = []

    try:
        for key in modifiers:
            sent.append(
                [
                    build_key_down_event(
                        key
                    )
                ]
            )

            pressed_modifiers.append(
                key
            )

            if (
                len(sent)
                == fail_after_batches
            ):
                raise InputDispatchError(
                    "simulated dispatch failure"
                )

        sent.append(
            [
                build_key_down_event(
                    primary
                ),
                build_key_up_event(
                    primary
                ),
            ]
        )

        if (
            len(sent)
            == fail_after_batches
        ):
            raise InputDispatchError(
                "simulated dispatch failure"
            )

    except InputDispatchError:
        pass

    finally:
        for key in reversed(
            pressed_modifiers
        ):
            sent.append(
                [
                    build_key_up_event(
                        key
                    )
                ]
            )

    return sent


def input_array_diagnostics(events):
    array = build_input_array(
        events
    )

    return [
        {
            "index": index,

            "vk": int(
                array[index]
                .union
                .ki
                .wVk
            ),

            "scan": int(
                array[index]
                .union
                .ki
                .wScan
            ),

            "flags": int(
                array[index]
                .union
                .ki
                .dwFlags
            ),

            "address":
                ctypes.addressof(
                    array[index]
                ),
        }

        for index
        in range(
            len(array)
        )
    ]


# ============================================================
# Main
# ============================================================

def main():
    try:
        payload = json.loads(
            sys.stdin.read()
            or "{}"
        )

    except json.JSONDecodeError:
        fail(
            "Input payload must be valid JSON.",
            64,
        )

    mode = payload.get(
        "mode"
    )


    # --------------------------------------------------------
    # Activate
    # --------------------------------------------------------

    if mode == "activate":
        result = activate_window(
            payload.get(
                "processId"
            ),
            payload.get(
                "title"
            ),
        )

        if result["ok"]:
            ok(
                **{
                    key: value
                    for key, value
                    in result.items()
                    if key != "ok"
                }
            )

        fail(
            result["reason"]
        )


    # --------------------------------------------------------
    # Type
    # --------------------------------------------------------

    if mode == "type":
        title = payload.get(
            "expectedWindowTitle"
        )

        process_id = payload.get(
            "expectedProcessId"
        )

        if title or process_id:
            result = activate_window(
                process_id,
                title,
            )

            if not result["ok"]:
                print(
                    json.dumps(
                        {
                            **result,
                            "focusMismatch":
                                True,
                        }
                    )
                )

                sys.exit(2)

            # Allow the application's internal editor/control
            # to settle after top-level foreground activation.
            time.sleep(
                TYPE_TARGET_SETTLE_SECONDS
            )

            # Reconfirm immediately before entering the typing
            # stage. If an overlay or another application took
            # focus during the settle period, cancel safely.
            second_check = (
                foreground_matches_target(
                    process_id=
                        process_id,
                    title=
                        title,
                )
            )

            if not second_check["ok"]:
                print(
                    json.dumps(
                        {
                            "ok":
                                False,

                            "focusMismatch":
                                True,

                            "reason":
                                "The intended application "
                                "lost foreground focus before "
                                "typing began.",

                            "foregroundTitle":
                                second_check[
                                    "foregroundTitle"
                                ],

                            "foregroundProcessId":
                                second_check[
                                    "foregroundProcessId"
                                ],
                        }
                    )
                )

                sys.exit(2)

        text = str(
            payload.get("text")
            or ""
        )

        if not text:
            fail(
                "No text was provided.",
                64,
            )

        try:
            type_text(
                text
            )

            ok()

        except InputDispatchError as error:
            fail(
                str(error)
            )


    # --------------------------------------------------------
    # Shortcut
    # --------------------------------------------------------

    if mode == "shortcut":
        title = payload.get(
            "expectedWindowTitle"
        )

        process_id = payload.get(
            "expectedProcessId"
        )

        if title or process_id:
            result = activate_window(
                process_id,
                title,
            )

            if not result["ok"]:
                print(
                    json.dumps(
                        {
                            **result,
                            "focusMismatch":
                                True,
                        }
                    )
                )

                sys.exit(2)

            time.sleep(
                SHORTCUT_TARGET_SETTLE_SECONDS
            )

            second_check = (
                foreground_matches_target(
                    process_id=
                        process_id,
                    title=
                        title,
                )
            )

            if not second_check["ok"]:
                print(
                    json.dumps(
                        {
                            "ok":
                                False,

                            "focusMismatch":
                                True,

                            "reason":
                                "The intended application "
                                "lost foreground focus before "
                                "the shortcut was dispatched.",

                            "foregroundTitle":
                                second_check[
                                    "foregroundTitle"
                                ],

                            "foregroundProcessId":
                                second_check[
                                    "foregroundProcessId"
                                ],
                        }
                    )
                )

                sys.exit(2)

        try:
            send_shortcut(
                str(
                    payload.get(
                        "shortcut"
                    )
                    or ""
                )
            )

            ok()

        except InputDispatchError as error:
            fail(
                str(error)
            )


    # --------------------------------------------------------
    # Text diagnostics
    # --------------------------------------------------------

    if mode == "diagnose_text":
        text = str(
            payload.get("text")
            or ""
        )

        events = (
            build_unicode_key_events(
                text
            )
        )

        ok(
            text=text,

            codeUnits=
                utf16_code_units(
                    text
                ),

            events=events,

            batches=
                pair_batches(
                    events
                ),

            settleMilliseconds=
                int(
                    UNICODE_INPUT_SETTLE_SECONDS
                    * 1000
                ),

            targetSettleMilliseconds=
                int(
                    TYPE_TARGET_SETTLE_SECONDS
                    * 1000
                ),

            firstCharacterGuardMilliseconds=
                int(
                    FIRST_CHARACTER_GUARD_SECONDS
                    * 1000
                ),

            secondForegroundCheck=
                True,

            inputArray=
                input_array_diagnostics(
                    events
                ),

            inputSize=
                ctypes.sizeof(
                    INPUT
                ),

            keybdInputSize=
                ctypes.sizeof(
                    KEYBDINPUT
                ),
        )


    # --------------------------------------------------------
    # Foreground unlock diagnostics
    # --------------------------------------------------------

    if mode == "diagnose_foreground_unlock":
        events = (
            build_foreground_unlock_events()
        )

        ok(
            events=events,

            inputArray=
                input_array_diagnostics(
                    events
                ),

            inputSize=
                ctypes.sizeof(
                    INPUT
                ),
        )


    # --------------------------------------------------------
    # Shortcut diagnostics
    # --------------------------------------------------------

    if mode == "diagnose_shortcut":
        shortcut = str(
            payload.get(
                "shortcut"
            )
            or ""
        )

        events = (
            build_shortcut_key_events(
                shortcut
            )
        )

        if events is None:
            fail(
                "Unsupported keyboard shortcut.",
                64,
            )

        ok(
            shortcut=
                shortcut,

            events=
                events,

            inputArray=
                input_array_diagnostics(
                    events
                ),

            inputSize=
                ctypes.sizeof(
                    INPUT
                ),
        )


    # --------------------------------------------------------
    # Shortcut cleanup diagnostics
    # --------------------------------------------------------

    if mode == "diagnose_shortcut_release":
        shortcut = str(
            payload.get(
                "shortcut"
            )
            or ""
        )

        batches = (
            simulate_shortcut_dispatch(
                shortcut,

                int(
                    payload.get(
                        "failAfterBatches"
                    )
                    or 0
                ),
            )
        )

        if batches is None:
            fail(
                "Unsupported keyboard shortcut.",
                64,
            )

        ok(
            shortcut=
                shortcut,

            batches=
                batches,
        )


    fail(
        "Unsupported input mode.",
        64,
    )


if __name__ == "__main__":
    main()